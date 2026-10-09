/**
 * The Roach Worker: a remote store for the recordings of many proxies.
 *
 * Each CI run still runs its own proxy. The proxy calls this Worker to read
 * and write recordings (`src/remote-store.ts`). R2 keeps each recording at
 * `<tenant>/<key>`. D1 keeps one row for each recording, with the time of
 * its last use and the hashes of its request parts.
 *
 * - Each tenant has a token. `ROACH_TENANTS` keeps only the SHA-256 of
 *   each token. A tenant reads and writes only its own recordings.
 * - A miss finds the closest recording in one D1 query on the parts index.
 *   It does not read the recordings themselves.
 * - The scheduled handler deletes recordings that nobody used for
 *   `RECORDING_TTL_DAYS`. A replay or a write counts as a use.
 *
 * "Worker" in `README.md` has the routes and the setup.
 */
import { differingParts, type RequestParts } from "../src/parts.ts";
import {
  RECORDING_KEY,
  RULE_NAME,
  type ClosestRecording,
  type Recording,
} from "../src/store.ts";

/** The bindings and variables of the Worker (`wrangler.jsonc`). */
interface Env {
  RECORDINGS: R2Bucket;
  DB: D1Database;
  /** JSON: the SHA-256 hex of the token of each tenant, by tenant. */
  ROACH_TENANTS?: string;
  /** Days that a recording stays after its last use. */
  RECORDING_TTL_DAYS: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A replay updates `last_used` only when it is older than this. */
const TOUCH_INTERVAL_MS = DAY_MS;
const MAX_RECORDING_BYTES = 10 * 1024 * 1024;
const MAX_QUERY_BYTES = 1024 * 1024;
const MAX_PARTS = 10_000;
const MAX_PART_NAME = 512;
const MAX_SESSION = 1024;
/** Rows that one expiry batch deletes. R2 deletes at most 1000 keys. */
const EXPIRY_BATCH = 500;
const MAX_EXPIRY_BATCHES = 20;
const TENANT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const RECORDINGS_PATH = "/v1/recordings/";

/** An error for a request that the Worker refuses, with its status. */
const refusal = (status: number, message: string) =>
  Object.assign(new Error(message), { name: "Refusal", status });

const isRefusal = (error: unknown): error is Error & { status: number } =>
  error instanceof Error && error.name === "Refusal";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hexOf = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const sha256 = async (text: string) =>
  crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

const bytesOf = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

/** The token hashes of `ROACH_TENANTS`. A bad value throws. */
function parseTenants(value: string | undefined): Array<[string, Uint8Array]> {
  if (!value) throw new Error("ROACH_TENANTS is not set");
  const parsed: unknown = JSON.parse(value);
  if (!isObject(parsed)) throw new Error("ROACH_TENANTS must be an object");
  return Object.entries(parsed).map(([name, hash]) => {
    if (!TENANT_NAME.test(name) || typeof hash !== "string") {
      throw new Error(`ROACH_TENANTS has a bad tenant: ${name}`);
    }
    if (!SHA256_HEX.test(hash)) {
      throw new Error(`ROACH_TENANTS needs the SHA-256 hex of ${name}`);
    }
    return [name, bytesOf(hash)];
  });
}

/** The tenant of the bearer token of `request`. */
async function tenantOf(request: Request, env: Env): Promise<string> {
  const tenants = parseTenants(env.ROACH_TENANTS);
  const token = /^Bearer (\S+)$/.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  if (token) {
    const hash = new Uint8Array(await sha256(token));
    // Compare with every tenant, so the time does not show which matched.
    let found: string | undefined;
    for (const [name, expected] of tenants) {
      if (crypto.subtle.timingSafeEqual(hash, expected)) found = name;
    }
    if (found) return found;
  }
  throw refusal(401, "bad token");
}

/** The body of `request` as text. A body over `limit` bytes is refused. */
async function readBody(request: Request, limit: number): Promise<string> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > limit) throw refusal(413, `body is over ${limit} bytes`);
  const body = await request.arrayBuffer();
  if (body.byteLength > limit) {
    throw refusal(413, `body is over ${limit} bytes`);
  }
  return new TextDecoder().decode(body);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw refusal(400, "body is not JSON");
  }
}

function checkParts(value: unknown): RequestParts {
  if (!isObject(value)) throw refusal(400, "parts must be an object");
  const entries = Object.entries(value);
  if (entries.length > MAX_PARTS) throw refusal(400, "too many parts");
  for (const [name, hash] of entries) {
    if (name.length > MAX_PART_NAME || typeof hash !== "string") {
      throw refusal(400, `bad part: ${name.slice(0, 64)}`);
    }
  }
  return value as RequestParts;
}

function checkSession(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > MAX_SESSION) {
    throw refusal(400, "bad session");
  }
  return value;
}

/** Check the shape of a recording that a proxy sends. */
function checkRecording(value: unknown): Recording {
  const { request, response } = isObject(value) ? value : {};
  checkSession(isObject(value) ? value.session : undefined);
  if (
    !isObject(request) ||
    typeof request.method !== "string" ||
    typeof request.url !== "string" ||
    !isObject(response) ||
    !Number.isInteger(response.status) ||
    !isObject(response.headers) ||
    typeof response.body !== "string" ||
    (response.bodyEncoding !== "utf8" && response.bodyEncoding !== "base64")
  ) {
    throw refusal(400, "body is not a recording");
  }
  checkParts(request.parts);
  return value as Recording;
}

/** The key in the path of `url`, and its rule. */
function keyOf(url: URL): { key: string; rule: string } {
  const key = url.pathname.slice(RECORDINGS_PATH.length);
  const match = RECORDING_KEY.exec(key);
  if (!match) throw refusal(400, "bad key");
  return { key, rule: match[1]! };
}

async function readRecording(
  env: Env,
  ctx: ExecutionContext,
  tenant: string,
  key: string,
): Promise<Response> {
  const object = await env.RECORDINGS.get(`${tenant}/${key}`);
  if (!object) return json({ error: "no recording" }, 404);
  const now = Date.now();
  ctx.waitUntil(
    env.DB.prepare(
      "UPDATE recordings SET last_used = ?1 WHERE tenant = ?2 AND key = ?3 AND last_used < ?4",
    )
      .bind(now, tenant, key, now - TOUCH_INTERVAL_MS)
      .run(),
  );
  return new Response(object.body, {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

async function writeRecording(
  request: Request,
  env: Env,
  tenant: string,
  key: string,
  rule: string,
): Promise<Response> {
  const text = await readBody(request, MAX_RECORDING_BYTES);
  const recording = checkRecording(parseJson(text));
  const objectKey = `${tenant}/${key}`;
  const digest = hexOf(await sha256(text));
  const previous = await env.RECORDINGS.head(objectKey);
  const changed = previous?.customMetadata?.digest !== digest;
  // R2 first: a row always points at a recording that was written. If D1
  // then fails, the object has no row, and the R2 lifecycle rule deletes it.
  if (changed) {
    await env.RECORDINGS.put(objectKey, text, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { digest },
    });
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO recordings (tenant, key, rule, session, last_used)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (tenant, key) DO UPDATE SET
         rule = excluded.rule,
         session = excluded.session,
         last_used = excluded.last_used`,
    ).bind(tenant, key, rule, recording.session ?? null, Date.now()),
    env.DB.prepare("DELETE FROM parts WHERE tenant = ?1 AND key = ?2").bind(
      tenant,
      key,
    ),
    env.DB.prepare(
      `INSERT INTO parts (tenant, key, rule, part, hash)
       SELECT ?1, ?2, ?3, key, value FROM json_each(?4)`,
    ).bind(tenant, key, rule, JSON.stringify(recording.request.parts)),
  ]);
  return json({ changed });
}

/**
 * The recording of `rule` with the most parts equal to `parts`. Recordings
 * of `session` come first. The query reads only the part rows that are
 * equal, through `parts_lookup`.
 */
async function findClosest(
  env: Env,
  tenant: string,
  rule: string,
  parts: RequestParts,
  session: string | null,
): Promise<ClosestRecording | undefined> {
  const best = await env.DB.prepare(
    `WITH wanted (part, hash) AS (SELECT key, value FROM json_each(?3))
     SELECT r.key AS key
     FROM wanted w
     JOIN parts p
       ON p.tenant = ?1 AND p.rule = ?2 AND p.part = w.part AND p.hash = w.hash
     JOIN recordings r ON r.tenant = p.tenant AND r.key = p.key
     GROUP BY r.key
     ORDER BY MAX(?4 IS NOT NULL AND r.session = ?4) DESC, COUNT(*) DESC, r.key
     LIMIT 1`,
  )
    .bind(tenant, rule, JSON.stringify(parts), session)
    .first<{ key: string }>();
  if (!best) return undefined;
  const { results } = await env.DB.prepare(
    "SELECT part, hash FROM parts WHERE tenant = ?1 AND key = ?2",
  )
    .bind(tenant, best.key)
    .all<{ part: string; hash: string }>();
  const theirs = Object.fromEntries(results.map((row) => [row.part, row.hash]));
  return { key: best.key, differs: differingParts(parts, theirs) };
}

async function closest(
  request: Request,
  env: Env,
  tenant: string,
): Promise<Response> {
  const body = parseJson(await readBody(request, MAX_QUERY_BYTES));
  if (!isObject(body) || typeof body.rule !== "string") {
    throw refusal(400, "rule must be a string");
  }
  if (!RULE_NAME.test(body.rule)) throw refusal(400, "bad rule");
  const found = await findClosest(
    env,
    tenant,
    body.rule,
    checkParts(body.parts),
    checkSession(body.session),
  );
  return json({ closest: found ?? null });
}

async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const isRecording = url.pathname.startsWith(RECORDINGS_PATH);
  if (!isRecording && url.pathname !== "/v1/closest") {
    return json({ error: "not found" }, 404);
  }
  const tenant = await tenantOf(request, env);
  if (url.pathname === "/v1/closest") {
    if (request.method !== "POST") return json({ error: "use POST" }, 405);
    return closest(request, env, tenant);
  }
  const { key, rule } = keyOf(url);
  switch (request.method) {
    case "GET":
      return readRecording(env, ctx, tenant, key);
    case "PUT":
      return writeRecording(request, env, tenant, key, rule);
    default:
      return json({ error: "use GET or PUT" }, 405);
  }
}

/**
 * Delete the recordings that nobody used for `RECORDING_TTL_DAYS`, in
 * batches. D1 goes first, so a recording that a replay uses during the
 * delete keeps its row. Rows of `parts` go with their recording.
 */
async function expire(env: Env, now: number): Promise<number> {
  const cutoff = now - env.RECORDING_TTL_DAYS * DAY_MS;
  let deleted = 0;
  for (let batch = 0; batch < MAX_EXPIRY_BATCHES; batch += 1) {
    const { results } = await env.DB.prepare(
      `DELETE FROM recordings
       WHERE last_used < ?1 AND (tenant, key) IN (
         SELECT tenant, key FROM recordings WHERE last_used < ?1 LIMIT ?2
       )
       RETURNING tenant, key`,
    )
      .bind(cutoff, EXPIRY_BATCH)
      .all<{ tenant: string; key: string }>();
    if (results.length === 0) break;
    await env.RECORDINGS.delete(
      results.map((row) => `${row.tenant}/${row.key}`),
    );
    deleted += results.length;
    if (results.length < EXPIRY_BATCH) break;
  }
  return deleted;
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      if (isRefusal(error)) {
        return json({ error: error.message }, error.status);
      }
      throw error;
    }
  },

  async scheduled(controller, env) {
    const deleted = await expire(env, controller.scheduledTime);
    console.log(`Deleted ${deleted} expired recordings`);
  },
} satisfies ExportedHandler<Env>;

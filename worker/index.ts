/**
 * The Roach Worker: a remote store for the recordings of many proxies.
 *
 * Each CI run still runs its own proxy. The proxy calls this Worker to read
 * and write recordings (`src/remote-store.ts`). R2 keeps each recording at
 * `<tenant>/<key>`. An R2 lifecycle rule deletes recordings 30 days after
 * they were written, so nothing here deletes or indexes recordings.
 *
 * - Each tenant has a token. `ROACH_TENANTS` keeps only the SHA-256 of
 *   each token. A tenant reads and writes only its own recordings.
 * - Each read and write sends the Sentry metric `roach.recording`, with the
 *   tenant, the key, the result, and the run of the proxy. A key that only
 *   one run uses is a recording that never replays. See "Worker" in
 *   `README.md`.
 */
import * as Sentry from "@sentry/cloudflare";
import { RECORDING_KEY } from "../src/store.ts";

/** The bindings and variables of the Worker (`wrangler.jsonc`). */
interface Env {
  RECORDINGS: R2Bucket;
  /** JSON: the SHA-256 hex of the token of each tenant, by tenant. */
  ROACH_TENANTS?: string;
  /** Without a DSN, the Worker sends nothing to Sentry. */
  SENTRY_DSN?: string;
}

/** What a request did with a recording. */
type Result = "replayed" | "missed" | "written" | "unchanged";

const MAX_RECORDING_BYTES = 10 * 1024 * 1024;
const TENANT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** The run header that the proxy sends, such as a GitHub Actions run id. */
const RUN_HEADER = "x-roach-run";
const MAX_RUN = 128;
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

/** The body of `request` as text. A body over the limit is refused. */
async function readBody(request: Request): Promise<string> {
  const tooLarge = () =>
    refusal(413, `body is over ${MAX_RECORDING_BYTES} bytes`);
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_RECORDING_BYTES) throw tooLarge();
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_RECORDING_BYTES) throw tooLarge();
  return new TextDecoder().decode(body);
}

/** Refuse a body that is not a recording (`src/store.ts`). */
function checkRecording(text: string): void {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw refusal(400, "body is not JSON");
  }
  const { request, response } = isObject(value) ? value : {};
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
}

/** Count one read or write of a recording in Sentry. */
function countUse(
  tenant: string,
  key: string,
  run: string | null,
  result: Result,
) {
  Sentry.metrics.count("roach.recording", 1, {
    attributes: {
      tenant,
      rule: key.slice(0, key.indexOf("/")),
      key,
      result,
      run: run ?? "unknown",
    },
  });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(RECORDINGS_PATH)) {
    return json({ error: "not found" }, 404);
  }
  const tenant = await tenantOf(request, env);
  const key = url.pathname.slice(RECORDINGS_PATH.length);
  if (!RECORDING_KEY.test(key)) throw refusal(400, "bad key");
  const run = request.headers.get(RUN_HEADER)?.slice(0, MAX_RUN) ?? null;
  const objectKey = `${tenant}/${key}`;

  switch (request.method) {
    case "GET": {
      const object = await env.RECORDINGS.get(objectKey);
      countUse(tenant, key, run, object ? "replayed" : "missed");
      if (!object) return json({ error: "no recording" }, 404);
      return new Response(object.body, {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      });
    }
    case "PUT": {
      const text = await readBody(request);
      checkRecording(text);
      const digest = hexOf(await sha256(text));
      const previous = await env.RECORDINGS.head(objectKey);
      const changed = previous?.customMetadata?.digest !== digest;
      if (changed) {
        await env.RECORDINGS.put(objectKey, text, {
          httpMetadata: { contentType: "application/json" },
          customMetadata: { digest },
        });
      }
      countUse(tenant, key, run, changed ? "written" : "unchanged");
      return json({ changed });
    }
    default:
      return json({ error: "use GET or PUT" }, 405);
  }
}

export default Sentry.withSentry<Env>((env) => ({ dsn: env.SENTRY_DSN }), {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      if (isRefusal(error)) {
        return json({ error: error.message }, error.status);
      }
      throw error;
    }
  },
} satisfies ExportedHandler<Env>);

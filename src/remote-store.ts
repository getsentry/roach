/**
 * The remote store: the recordings are in a Roach Worker (`worker/`).
 *
 * The proxy calls the Worker directly, not through itself, with the token
 * of its tenant. The Worker finds the closest recording of a miss in a
 * database query, so a miss costs one call and not one read per recording.
 * "Worker API" in `README.md` has the routes.
 */
import type { RequestParts } from "./parts.ts";
import {
  formatRecording,
  type ClosestRecording,
  type Recording,
  type RecordingStore,
} from "./store.ts";
import type { RemoteStoreConfig } from "./types.ts";

/** A call that takes longer than this fails. */
const TIMEOUT_MS = 30_000;
/** Writes that run at the same time. */
const WRITE_CONCURRENCY = 8;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The Worker URL. Plain HTTP is only for a local Worker. */
function parseBase(value: string): URL {
  const url = new URL(value.endsWith("/") ? value : `${value}/`);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
  ) {
    throw new Error(`Roach store URL must use https: ${value}`);
  }
  return url;
}

/** The store of the recordings in the Worker of `config`. */
export function createRemoteStore(config: RemoteStoreConfig): RecordingStore {
  const base = parseBase(config.url);

  const call = async (
    method: "GET" | "POST" | "PUT",
    route: string,
    body?: string,
  ): Promise<Response> => {
    const response = await fetch(new URL(`v1/${route}`, base), {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok && !(method === "GET" && response.status === 404)) {
      throw new Error(
        `Roach store ${method} ${route} failed with HTTP ${response.status}: ${await response.text()}`,
      );
    }
    return response;
  };

  const writeOne = async ([key, recording]: [string, Recording]) => {
    const response = await call(
      "PUT",
      `recordings/${key}`,
      formatRecording(recording),
    );
    return ((await response.json()) as { changed: boolean }).changed;
  };

  return {
    async read(key) {
      const response = await call("GET", `recordings/${key}`);
      if (response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
      return (await response.json()) as Recording;
    },

    async write(recordings) {
      let changed = 0;
      for (let at = 0; at < recordings.length; at += WRITE_CONCURRENCY) {
        const results = await Promise.all(
          recordings.slice(at, at + WRITE_CONCURRENCY).map(writeOne),
        );
        changed += results.filter(Boolean).length;
      }
      return changed;
    },

    async closest(rule: string, parts: RequestParts, session) {
      const response = await call(
        "POST",
        "closest",
        JSON.stringify({ rule, parts, session: session ?? null }),
      );
      const { closest } = (await response.json()) as {
        closest: ClosestRecording | null;
      };
      return closest ?? undefined;
    },
  };
}

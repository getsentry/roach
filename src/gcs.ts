/**
 * The GCS store: the recordings of the shared service (`service.ts`) in a
 * Google Cloud Storage bucket.
 *
 * Each recording is the object `<prefix><key>`. A lifecycle rule of the
 * bucket deletes it 30 days after it was written (`deploy/gcp/`), so
 * nothing here deletes recordings.
 *
 * The store calls the JSON API with `fetch`, and takes its access token
 * from the metadata server of the VM. So it needs no key file and no
 * Google SDK. Two standard variables change the hosts, for local tests:
 * `STORAGE_EMULATOR_HOST` (a URL) and `GCE_METADATA_HOST` (a host).
 */
import {
  formatRecording,
  type Recording,
  type RecordingStore,
} from "./store.ts";

/** A call that takes longer than this fails. */
const TIMEOUT_MS = 30_000;
/** Tries of one call. GCS asks clients to retry 429 and 5xx. */
const TRIES = 3;
/** Get a new token when the current one expires within this time. */
const TOKEN_MARGIN_MS = 60_000;

const isTemporary = (status: number) => status === 429 || status >= 500;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `fetch`, with a timeout and retries of temporary failures. */
async function call(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!isTemporary(response.status) || attempt === TRIES) return response;
      await response.body?.cancel();
    } catch (error) {
      if (attempt === TRIES) throw error;
    }
    await wait(250 * 2 ** attempt);
  }
}

/** The access token of the VM service account, from the metadata server. */
function createTokenSource(metadataHost: string): () => Promise<string> {
  let cached: { token: string; expires: number } | undefined;
  return async () => {
    if (cached && cached.expires - TOKEN_MARGIN_MS > Date.now()) {
      return cached.token;
    }
    const response = await call(
      `http://${metadataHost}/computeMetadata/v1/instance/service-accounts/default/token`,
      { headers: { "metadata-flavor": "Google" } },
    );
    if (!response.ok) {
      throw new Error(
        `GCE metadata token failed with HTTP ${response.status}: ${await response.text()}`,
      );
    }
    const body = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    cached = {
      token: body.access_token,
      expires: Date.now() + body.expires_in * 1000,
    };
    return cached.token;
  };
}

/** Where the store sends its calls. */
interface GcsHosts {
  /** The base URL of the storage API. */
  storage: string;
  /** The host of the metadata server. */
  metadata: string;
}

/** The hosts of GCS, or the ones of the standard variables. */
function gcsHosts(env = process.env): GcsHosts {
  return {
    storage: (
      env.STORAGE_EMULATOR_HOST ?? "https://storage.googleapis.com"
    ).replace(/\/$/, ""),
    metadata: env.GCE_METADATA_HOST ?? "metadata.google.internal",
  };
}

/** The store of the recordings in `bucket`, under `prefix`. */
export function createGcsStore(bucket: string, prefix: string): RecordingStore {
  const hosts = gcsHosts();
  const token = createTokenSource(hosts.metadata);
  const bucketPath = `b/${encodeURIComponent(bucket)}/o`;

  const writeOne = async ([key, recording]: [string, Recording]) => {
    const name = encodeURIComponent(`${prefix}${key}`);
    const response = await call(
      `${hosts.storage}/upload/storage/v1/${bucketPath}?uploadType=media&name=${name}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await token()}`,
          "content-type": "application/json",
        },
        body: formatRecording(recording),
      },
    );
    if (!response.ok) {
      throw new Error(
        `GCS write of ${key} failed with HTTP ${response.status}: ${await response.text()}`,
      );
    }
    await response.body?.cancel();
  };

  return {
    async read(key) {
      const name = encodeURIComponent(`${prefix}${key}`);
      const response = await call(
        `${hosts.storage}/storage/v1/${bucketPath}/${name}?alt=media`,
        { headers: { authorization: `Bearer ${await token()}` } },
      );
      if (response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
      if (!response.ok) {
        throw new Error(
          `GCS read of ${key} failed with HTTP ${response.status}: ${await response.text()}`,
        );
      }
      return (await response.json()) as Recording;
    },

    // GCS does not say if an object changed, so each write counts.
    async write(recordings) {
      await Promise.all(recordings.map(writeOne));
      return recordings.length;
    },
  };
}

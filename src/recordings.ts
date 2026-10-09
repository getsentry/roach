/**
 * The file store, and prune.
 *
 * The file store keeps each recording (`store.ts`) in `<directory>/<key>`,
 * so recordings can be committed. For miss diagnosis, it reads all
 * recordings of a rule on the first miss of that rule in a run. That is
 * one read of the local disk per rule. The remote store does the same
 * search in a database query.
 */
import { randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { closestRequest, type RequestParts } from "./parts.ts";
import {
  formatRecording,
  type Recording,
  type RecordingStore,
} from "./store.ts";

const isMissing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

const readText = (file: string) =>
  readFile(file, "utf8").catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });

/** The rule of a key, `<rule>/<hash>.json`. */
const ruleOf = (key: string) => key.slice(0, key.indexOf("/"));

interface IndexEntry {
  key: string;
  session?: string | undefined;
  parts: RequestParts;
}

/**
 * The store of the recordings in `directory`. For miss diagnosis, it reads
 * all recordings of a rule on its first miss of that rule.
 */
export function createFileStore(directory: string): RecordingStore {
  const indexes = new Map<string, Promise<Map<string, IndexEntry>>>();
  const indexOf = (rule: string) => {
    let index = indexes.get(rule);
    if (!index) {
      index = loadIndex(directory, rule);
      indexes.set(rule, index);
    }
    return index;
  };

  return {
    async read(key) {
      const text = await readText(path.join(directory, key));
      return text === undefined ? undefined : (JSON.parse(text) as Recording);
    },

    async write(recordings) {
      const changed = await Promise.all(
        recordings.map(async ([key, recording]) => {
          const file = path.join(directory, key);
          const content = formatRecording(recording);
          // Keep a loaded index current, so later misses compare with it.
          if (indexes.has(ruleOf(key))) {
            (await indexOf(ruleOf(key))).set(key, entryOf(key, recording));
          }
          if ((await readText(file)) === content) return false;
          await mkdir(path.dirname(file), { recursive: true });
          // Write a new file and rename it, so a reader in another run
          // never sees half of a recording.
          const partial = `${file}.${randomBytes(6).toString("hex")}.tmp`;
          await writeFile(partial, content);
          await rename(partial, file);
          return true;
        }),
      );
      return changed.filter(Boolean).length;
    },

    async closest(rule, parts, session) {
      const all = [...(await indexOf(rule)).values()];
      const same = all.filter((entry) => entry.session === session);
      const found = closestRequest(
        parts,
        session !== undefined && same.length > 0 ? same : all,
      );
      return found && { key: found.candidate.key, differs: found.differs };
    },

    async keysOf(session) {
      const entries = await readdir(directory, { withFileTypes: true }).catch(
        (error: unknown) => {
          if (isMissing(error)) return [];
          throw error;
        },
      );
      const keys: string[] = [];
      // Each rule is a directory. Skip other files, such as `.DS_Store`.
      for (const rule of entries.filter((entry) => entry.isDirectory())) {
        for (const entry of (await indexOf(rule.name)).values()) {
          if (entry.session === session) keys.push(entry.key);
        }
      }
      return keys;
    },
  };
}

const entryOf = (key: string, recording: Recording): IndexEntry => ({
  key,
  session: recording.session,
  parts: recording.request.parts,
});

/** Read every recording of one rule, by key. */
async function loadIndex(
  directory: string,
  rule: string,
): Promise<Map<string, IndexEntry>> {
  const names = await readdir(path.join(directory, rule)).catch(
    (error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    },
  );
  const index = new Map<string, IndexEntry>();
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const key = `${rule}/${name}`;
    const text = await readText(path.join(directory, key));
    if (text !== undefined) {
      index.set(key, entryOf(key, JSON.parse(text) as Recording));
    }
  }
  return index;
}

/**
 * Delete the recordings in `directory` that no used file lists. Each used
 * file comes from `usedFile` of one proxy run. Returns how many it deleted.
 * Give it the used files of every run that shares the directory, or it
 * deletes recordings that another run needs.
 */
export async function pruneRecordings(
  directory: string,
  usedFiles: string[],
): Promise<number> {
  const used = new Set<string>();
  for (const file of usedFiles) {
    for (const line of (await readFile(file, "utf8")).split("\n")) {
      if (line) used.add(line);
    }
  }
  const recordings = (await readdir(directory, { recursive: true })).filter(
    (file) => file.endsWith(".json"),
  );
  const unused = recordings.filter((file) => !used.has(file));
  await Promise.all(unused.map((file) => rm(path.join(directory, file))));
  return unused.length;
}

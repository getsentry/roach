/**
 * The file store. It keeps each recording (`store.ts`) in
 * `<directory>/<key>`. The service uses it when its config has
 * `directory`, such as in tests.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  formatRecording,
  type Recording,
  type RecordingStore,
} from "./store.ts";

const readText = (file: string) =>
  readFile(file, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });

/** The store of the recordings in `directory`. */
export function createFileStore(directory: string): RecordingStore {
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
          if ((await readText(file)) === content) return false;
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, content);
          return true;
        }),
      );
      return changed.filter(Boolean).length;
    },
  };
}

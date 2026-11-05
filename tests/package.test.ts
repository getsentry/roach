/**
 * The shape of the npm package `@sentry/roach`. It ships `src/`.
 *
 * The package exports and the action must load only files in `src/`, and
 * each file in `src/` must be one that they load. Service code (the proxy,
 * the recorder, the stores) goes in `service/`, which the package does not
 * ship.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..");
const LOCAL_IMPORT = /\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g;

/** Every local file that `entries` load, with type-only imports, from the root. */
async function importGraph(entries: string[]): Promise<Set<string>> {
  const seen = new Set<string>();
  const pending = [...entries];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await readFile(path.join(ROOT, file), "utf8");
    for (const [, specifier = ""] of source.matchAll(LOCAL_IMPORT)) {
      pending.push(path.posix.join(path.posix.dirname(file), specifier));
    }
  }
  return seen;
}

describe("npm package", () => {
  it("ships in src/ only the files that its exports and the action load", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(ROOT, "package.json"), "utf8"),
    ) as { exports: Record<string, string>; files: string[] };
    expect(manifest.files).toEqual(["src"]);
    const entries = [...Object.values(manifest.exports), "src/action.ts"].map(
      (entry) => path.posix.normalize(entry),
    );
    const graph = await importGraph(entries);
    const shipped = (await readdir(path.join(ROOT, "src"))).map(
      (file) => `src/${file}`,
    );
    expect([...graph].toSorted()).toEqual(shipped.toSorted());
  });
});

/**
 * The shape of the npm tarball of `@sentry/roach`.
 *
 * The `files` list in `package.json` must be the same as the files that the
 * package exports load. A missing file breaks an import of the package. An
 * extra file ships service code (the proxy, the recorder, the stores) that the
 * client does not use.
 */
import { readFile } from "node:fs/promises";
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
  it("ships exactly the files that its exports load", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(ROOT, "package.json"), "utf8"),
    ) as {
      exports: Record<string, string>;
      files: string[];
    };
    const entries = Object.values(manifest.exports).map((entry) =>
      path.posix.normalize(entry),
    );
    const graph = await importGraph(entries);
    expect(manifest.files.toSorted()).toEqual([...graph].toSorted());
  });
});

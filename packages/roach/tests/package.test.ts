/**
 * The shape of the npm package `@sentry/roach`. It ships `src/`.
 *
 * The package exports and the action must load only files in `src/`, Node
 * built-ins, and vitest (an optional peer). So they never load
 * `@sentry/node` or the service (`@sentry/roach-service`), and each file in
 * `src/` must be one that they load.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..");
const IMPORT = /\b(?:from\s+|import\s*\(?\s*)["']([^"']+)["']/g;
const ALLOWED_PACKAGE = /^(?:node:|vitest(?:\/|$))/;

/** The local files and the packages that `entries` load, from the root. */
async function importGraph(entries: string[]) {
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [...entries];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (files.has(file)) continue;
    files.add(file);
    const source = await readFile(path.join(ROOT, file), "utf8");
    for (const [, specifier = ""] of source.matchAll(IMPORT)) {
      if (specifier.startsWith(".")) {
        pending.push(path.posix.join(path.posix.dirname(file), specifier));
      } else {
        packages.add(specifier);
      }
    }
  }
  return { files, packages };
}

describe("npm package", () => {
  it("loads only its own files, Node built-ins, and vitest", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(ROOT, "package.json"), "utf8"),
    ) as {
      exports: Record<string, string>;
      files: string[];
      dependencies?: object;
    };
    expect(manifest.files).toEqual(["src"]);
    expect(manifest.dependencies).toBeUndefined();
    const entries = [...Object.values(manifest.exports), "src/action.ts"].map(
      (entry) => path.posix.normalize(entry),
    );
    const { files, packages } = await importGraph(entries);
    const shipped = (await readdir(path.join(ROOT, "src"))).map(
      (file) => `src/${file}`,
    );
    expect([...files].toSorted()).toEqual(shipped.toSorted());
    expect([...packages].filter((name) => !ALLOWED_PACKAGE.test(name))).toEqual(
      [],
    );
  });
});

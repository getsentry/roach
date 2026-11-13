/**
 * `roach.json`: the run config of a repository. The GitHub Action
 * (`action.ts`) and the vitest integration (`vitest.ts`) both read it, so a
 * repository writes its origins and rules once, as data. See "Config file"
 * in `README.md`.
 */
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  RecordingMode,
  RecordingRule,
  RunCi,
  RunConfig,
} from "./types.ts";
import { VALUE_PATTERNS } from "./values.ts";

/** The Roach service of Sentry. See "Deploy" in `README.md`. */
export const DEFAULT_SERVICE_URL = "https://roach-proxy.getsentry.net";

/** The hosts that do not use the proxy when `roach.json` sets no `noProxy`. */
export const DEFAULT_NO_PROXY = "localhost,127.0.0.1,::1";

/** The name of the config file. */
const FILE_NAME = "roach.json";

/**
 * A changing value in `roach.json`: a regular expression source, or the
 * name of a pattern in `VALUE_PATTERNS`, such as `{ "builtin": "uuid" }`.
 */
type FileValue = string | { builtin: keyof typeof VALUE_PATTERNS };

/** A rule in `roach.json`. */
interface FileRule extends Omit<RecordingRule, "values"> {
  values?: Record<string, FileValue>;
}

/** The content of `roach.json`. */
export interface RoachFile {
  allow: string[];
  rules: FileRule[];
  /** Default: `GITHUB_REPOSITORY`. */
  tenant?: string;
  /**
   * Environment variables that hold credentials, such as
   * `ANTHROPIC_API_KEY`. The run never writes their values.
   */
  secretEnv?: string[];
  /** Hosts that do not use the proxy. Default: loopback. */
  noProxy?: string;
}

const MODES = new Set<string>(["auto", "off", "record", "replay"]);

/** The variable of each field of `RunConfig.ci`. */
const CI_VARIABLES: Record<keyof RunCi, string> = {
  runId: "GITHUB_RUN_ID",
  job: "GITHUB_JOB",
  repo: "GITHUB_REPOSITORY",
  ref: "GITHUB_REF",
};

/** A variable of `env`, or `undefined` when it is not set or is blank. */
export function readEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env[name]?.trim();
  return value === "" ? undefined : value;
}

/**
 * Set the variables `values` in `process.env`. Returns a function that
 * sets each of them back. A variable that was not set before is deleted.
 */
export function swapEnv(values: Record<string, string>): () => void {
  const previous = Object.keys(values).map(
    (name) => [name, process.env[name]] as const,
  );
  Object.assign(process.env, values);
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/**
 * Find `roach.json` in `from` or the closest parent directory, and read
 * it. Throws when no directory has one.
 */
export async function readRoachFile(
  from = process.cwd(),
): Promise<RoachFile & { path: string }> {
  for (let directory = path.resolve(from); ;) {
    const file = path.join(directory, FILE_NAME);
    const found = await access(file).then(
      () => true,
      () => false,
    );
    if (found) {
      const text = await readFile(file, "utf8");
      let parsed: RoachFile;
      try {
        parsed = JSON.parse(text) as RoachFile;
      } catch (error) {
        throw new Error(
          `Roach: ${file} is not valid JSON: ${(error as Error).message}`,
          { cause: error },
        );
      }
      return { ...parsed, path: file };
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`Roach: no ${FILE_NAME} in ${from} or its parents`);
    }
    directory = parent;
  }
}

function resolveValue(rule: string, name: string, value: FileValue): string {
  if (typeof value === "string") return value;
  const pattern = VALUE_PATTERNS[value.builtin];
  if (!pattern) {
    throw new Error(
      `Roach: rule ${rule} value ${name} names no built-in pattern: ${value.builtin}`,
    );
  }
  return pattern;
}

/**
 * The run config of `file` in the environment `env`. Without the write
 * token (`canWrite`), the mode is `replay`. `ROACH_MODE` sets another
 * mode.
 */
export function runConfigOf(
  file: RoachFile,
  {
    canWrite,
    env = process.env,
  }: { canWrite: boolean; env?: NodeJS.ProcessEnv },
): RunConfig {
  const mode = readEnv("ROACH_MODE", env) ?? (canWrite ? "auto" : "replay");
  if (!MODES.has(mode)) {
    throw new Error(
      `Roach: ROACH_MODE must be auto, replay, record, or off, got ${mode}`,
    );
  }
  const tenant = file.tenant ?? env.GITHUB_REPOSITORY;
  if (!tenant) {
    throw new Error(
      `Roach: set tenant in ${FILE_NAME}, or run with GITHUB_REPOSITORY`,
    );
  }
  const config: RunConfig = {
    tenant,
    mode: mode as RecordingMode,
    allow: file.allow,
    rules: file.rules.map(({ values, ...rule }) =>
      values
        ? {
            ...rule,
            values: Object.fromEntries(
              Object.entries(values).map(([name, value]) => [
                name,
                resolveValue(rule.name, name, value),
              ]),
            ),
          }
        : rule,
    ),
    secrets: (file.secretEnv ?? []).flatMap((name) => readEnv(name, env) ?? []),
  };
  const runId = readEnv("GITHUB_RUN_ID", env);
  if (runId) {
    config.name = `${runId}-${readEnv("GITHUB_RUN_ATTEMPT", env) ?? "1"}`;
  }
  const ci = Object.fromEntries(
    Object.entries(CI_VARIABLES).flatMap(([field, name]) => {
      const value = readEnv(name, env);
      return value ? [[field, value]] : [];
    }),
  );
  if (Object.keys(ci).length > 0) config.ci = ci;
  return config;
}

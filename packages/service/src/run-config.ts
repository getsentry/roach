/**
 * The check of the run config that a client sends to the service
 * (`service.ts`), with its limits, the tenant name, and the span
 * attributes of its CI fields.
 */
import { parseOrigins } from "./server.ts";
import { RULE_NAME } from "./store.ts";
import type { RecordingMode, RunCi, RunConfig } from "@sentry/roach/types";
import { invalidValuePatterns } from "@sentry/roach/values";

const MODES = new Set<RecordingMode>(["auto", "off", "record", "replay"]);

const MAX_RUN_NAME = 128;

/**
 * Limits of the config of a run. A holder of the read token can start a
 * run, so they keep the work of a run small: the service makes a
 * certificate for each host that a run tunnels to, and runs each value
 * pattern on each request.
 */
const MAX_RUN_ORIGINS = 32;
const MAX_RULES = 64;
const MAX_RULE_VALUES = 32;
const MAX_RULE_URLS = 32;
const MAX_PATTERN_LENGTH = 2048;

/** The span attribute of each field of `RunConfig.ci`. */
const CI_ATTRIBUTES: Record<keyof RunCi, string> = {
  runId: "roach.ci.run_id",
  job: "roach.ci.job",
  repo: "roach.ci.repo",
  ref: "roach.ci.ref",
};
const MAX_CI_VALUE = 256;

/** Enough for the API keys and OIDC tokens of a CI job. */
const MAX_RUN_SECRETS = 32;
const MAX_SECRET_LENGTH = 16 * 1024;

/**
 * A tenant name: `owner/repo`, with the characters of GitHub names. It is a
 * path in the store, so each part starts with a letter, digit, or `_`, and
 * there are always two parts. Then no tenant is in the directory of another.
 */
export const TENANT_NAME =
  /^[A-Za-z0-9_][\w.-]{0,99}\/[A-Za-z0-9_][\w.-]{0,99}$/;

/** Check the run config of a client. Returns the error, or `undefined`. */
export function invalidRunConfig(
  config: Partial<RunConfig>,
): string | undefined {
  if (!config.mode || !MODES.has(config.mode)) {
    return "mode must be auto, off, record, or replay";
  }
  if (config.name !== undefined) {
    if (typeof config.name !== "string" || config.name.length > MAX_RUN_NAME) {
      return `name must be a string of at most ${MAX_RUN_NAME} characters`;
    }
  }
  if (config.secrets !== undefined) {
    if (
      !Array.isArray(config.secrets) ||
      config.secrets.length > MAX_RUN_SECRETS ||
      !config.secrets.every(
        (secret) =>
          typeof secret === "string" && secret.length <= MAX_SECRET_LENGTH,
      )
    ) {
      return `secrets must be a list of at most ${MAX_RUN_SECRETS} strings of at most ${MAX_SECRET_LENGTH} characters`;
    }
  }
  if (config.ci !== undefined) {
    // A newer client can send more fields. The service ignores them.
    const ci = config.ci as Record<string, unknown> | null;
    if (
      typeof ci !== "object" ||
      ci === null ||
      !Object.keys(CI_ATTRIBUTES).every(
        (field) =>
          ci[field] === undefined ||
          (typeof ci[field] === "string" && ci[field].length <= MAX_CI_VALUE),
      )
    ) {
      return `ci must be an object of strings of at most ${MAX_CI_VALUE} characters`;
    }
  }
  if (!Array.isArray(config.rules) || config.rules.length > MAX_RULES) {
    return `rules must be a list of at most ${MAX_RULES} rules`;
  }
  const names = new Set<string>();
  for (const rule of config.rules) {
    if (typeof rule?.name !== "string" || !RULE_NAME.test(rule.name)) {
      return `rule name must match ${RULE_NAME}`;
    }
    if (names.has(rule.name)) return `rule ${rule.name} is not unique`;
    names.add(rule.name);
    if (typeof rule.match !== "object" || rule.match === null) {
      return `rule ${rule.name} must have match`;
    }
    const { url } = rule.match;
    if (
      url !== undefined &&
      typeof url !== "string" &&
      !(
        Array.isArray(url) &&
        url.length > 0 &&
        url.length <= MAX_RULE_URLS &&
        url.every((prefix) => typeof prefix === "string")
      )
    ) {
      return `match.url of rule ${rule.name} must be a string or a list of 1 to ${MAX_RULE_URLS} strings`;
    }
    // A slow pattern fails only its own requests (`request-key.ts`), so
    // the service takes any pattern that compiles.
    if (rule.values !== undefined) {
      if (typeof rule.values !== "object" || rule.values === null) {
        return `values of rule ${rule.name} must be an object`;
      }
      const values = Object.entries(rule.values);
      if (values.length > MAX_RULE_VALUES) {
        return `rule ${rule.name} can have at most ${MAX_RULE_VALUES} values`;
      }
      for (const [name, source] of values) {
        if (typeof source !== "string" || source.length > MAX_PATTERN_LENGTH) {
          return `value ${name} of rule ${rule.name} must be a pattern of at most ${MAX_PATTERN_LENGTH} characters`;
        }
      }
    }
  }
  const patternError = invalidValuePatterns(
    config.rules.flatMap((rule) => (rule.values ? [rule.values] : [])),
  );
  if (patternError) return patternError;
  if (
    !Array.isArray(config.allow) ||
    config.allow.length === 0 ||
    config.allow.length > MAX_RUN_ORIGINS
  ) {
    return `allow must be a list of 1 to ${MAX_RUN_ORIGINS} origins`;
  }
  for (const origin of config.allow) {
    // The client sends JSON, so check the type at run time.
    if (typeof origin !== "string") return "allow must be a list of origins";
    try {
      parseOrigins([origin.replace(/\/$/, "")]);
    } catch {
      return `${origin} is not an http or https origin`;
    }
  }
  return undefined;
}

/** The span attributes of the CI job of a run. */
export function ciAttributes(ci: RunCi | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(CI_ATTRIBUTES).flatMap(([field, name]) => {
      const value = ci?.[field as keyof RunCi];
      return value ? [[name, value]] : [];
    }),
  );
}

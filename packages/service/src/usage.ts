/**
 * The token usage of a model response, as `gen_ai` span attributes.
 *
 * Sentry calculates the cost of a span in USD (`gen_ai.cost.*`) from these
 * attributes and its own price of the model. So Roach needs no prices, and
 * the client sends nothing extra. A replayed response has the usage of its
 * recording: the cost that the replay saved.
 *
 * The proxy reads the usage fields of two model APIs: Anthropic Messages
 * (`input_tokens`, `cache_read_input_tokens`) and OpenAI Chat Completions
 * (`prompt_tokens`, `prompt_tokens_details`). It reads the whole body, or
 * each event of a stream. A later event gives the total so far, so the last
 * value of each field wins.
 *
 * As in Sentry, `gen_ai.usage.input_tokens` includes the cache tokens.
 * Anthropic counts them apart, so the proxy adds them.
 */
import { isEventStream } from "./streams.ts";

type Fields = Record<string, unknown>;

const isObject = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The JSON objects of a body: the body itself, or each stream event. */
function bodyObjects(contentType: string | undefined, body: string): Fields[] {
  const values = isEventStream(contentType)
    ? body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => parseJson(line.slice(5).trim()))
    : /json/i.test(contentType ?? "")
      ? [parseJson(body)]
      : [];
  return values.filter(isObject);
}

/** The model that a request asks for, from its JSON body. */
function requestModel(body: string): string | undefined {
  const parsed = parseJson(body);
  return isObject(parsed) && typeof parsed.model === "string"
    ? parsed.model
    : undefined;
}

/**
 * The `gen_ai` attributes of one model call, or `undefined` when the
 * response has no usage.
 */
export function usageAttributes(
  requestBody: string,
  contentType: string | undefined,
  responseBody: string,
): Record<string, string | number> | undefined {
  let model: string | undefined;
  const usage: Fields = {};
  for (const object of bodyObjects(contentType, responseBody)) {
    // An Anthropic stream sends the model and the first usage in
    // `message_start`.
    const message = isObject(object.message) ? object.message : object;
    if (typeof message.model === "string") model = message.model;
    for (const source of [message.usage, object.usage]) {
      if (!isObject(source)) continue;
      for (const [name, value] of Object.entries(source)) {
        if (value !== null && value !== undefined) usage[name] = value;
      }
    }
  }

  const details = (name: string, field: string) =>
    isObject(usage[name]) ? count(usage[name][field]) : undefined;
  const cacheRead =
    count(usage.cache_read_input_tokens) ??
    details("prompt_tokens_details", "cached_tokens");
  const cacheWrite = count(usage.cache_creation_input_tokens);
  const input =
    count(usage.prompt_tokens) ??
    addCounts(count(usage.input_tokens), cacheRead, cacheWrite);
  const output = count(usage.completion_tokens) ?? count(usage.output_tokens);
  const reasoning = details("completion_tokens_details", "reasoning_tokens");
  if (input === undefined && output === undefined) return undefined;

  const attributes: Record<string, string | number> = {
    "gen_ai.operation.name": "chat",
  };
  // Sentry prices the response model, or the request model without one. A
  // gateway can name the model in the response in another way than its
  // price list does, so the requested name wins.
  const requested = requestModel(requestBody);
  if (requested) attributes["gen_ai.request.model"] = requested;
  else if (model) attributes["gen_ai.response.model"] = model;
  const set = (name: string, value: number | undefined) => {
    if (value !== undefined) attributes[`gen_ai.usage.${name}`] = value;
  };
  set("input_tokens", input);
  set("output_tokens", output);
  set("cache_read.input_tokens", cacheRead);
  set("cache_creation.input_tokens", cacheWrite);
  set("reasoning.output_tokens", reasoning);
  return attributes;
}

/** The sum of the counts that are set, or `undefined` when none is. */
function addCounts(...values: Array<number | undefined>): number | undefined {
  const set = values.filter((value) => value !== undefined);
  return set.length === 0 ? undefined : set.reduce((sum, v) => sum + v, 0);
}

/**
 * The log line of an unexpected error and the text that goes back to the
 * client. Neither has the message of the error, because it can hold a
 * response body. Only the Sentry event has the full error.
 */

/**
 * The class, code, and HTTP status of an error, for the log. The message
 * can hold a response body, so the log does not get it.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const { code, responseStatus } = error as {
    code?: string;
    responseStatus?: number;
  };
  return [
    error.name,
    code,
    responseStatus === undefined ? undefined : `HTTP ${responseStatus}`,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Log the class of an unexpected error and the id of its Sentry event.
 * Returns the text for the client, which has only the event id.
 */
export function reportInternal(
  what: string,
  error: unknown,
  eventId: string | undefined,
): string {
  const event = eventId ? `, Sentry event ${eventId}` : "";
  process.stderr.write(
    `[roach] ${what} failed: ${describeError(error)}${event}\n`,
  );
  return `internal error${event}`;
}

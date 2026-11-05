/**
 * The errors of the service: an error that is the fault of the client,
 * with its HTTP status (`httpError()`), and the log line and the client
 * text of an unexpected error. Neither of these has the message of an
 * unexpected error, because it can hold a response body. Only the Sentry
 * event has the full error.
 */

/**
 * An error that is the fault of the client. The client gets its message
 * with the HTTP status `status`.
 */
export const httpError = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

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

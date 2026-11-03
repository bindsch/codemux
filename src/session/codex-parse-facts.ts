/**
 * Parser facts shared across the codex session split: the resumable
 * thread-id pattern, the raw-newline rejoin bounds, and the
 * record/bufferable predicates. src/session/codex-session.ts owns the
 * lifecycle.
 */

/** Codex thread ids codemux will resume (§4.5): the fixture's ids are
 * UUIDv7-shaped and fit; claude-family ids stay UUIDs. Anything else is
 * exit 64 before it reaches the wire. */
export const CODEX_THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** Bounds on the raw-newline rejoin buffer, matching openclaw's client:
 * fragments beyond these are the tier-3 fatal they would have been. */
export const PARSE_BUFFER_MAX_BYTES = 8 * 1024 * 1024;
export const PARSE_BUFFER_MAX_LINES = 1_000;

export interface PendingParse {
  text: string;
  lines: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The bufferable parse failures (openclaw's exact rule): an object or
 * array opener whose parse died mid-string. */
export function bufferable(value: string, error: unknown): boolean {
  if (!value.startsWith("{") && !value.startsWith("[")) return false;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Unterminated string") ||
    message.includes("Unexpected end of JSON input")
  );
}

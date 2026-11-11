/** The tier-3 fatal facts of the session process layer, split from
 * src/session/process.ts: the fatal shapes the framer reports, the shared
 * message for classes that carry a codemux-side error, and the
 * bounded excerpt facts every parser pairs with an unusable line. */

/** Bounded excerpt a tier-3 fatal carries (design §4.2). */
export const FATAL_EXCERPT_BYTES = 4096;

const UTF8 = new TextEncoder();
const LOSSY_DECODER = new TextDecoder("utf-8");

export type SessionFatalKind = "line-overflow" | "invalid-utf8" | "handler" | "read-error" | "write-error";

export type SessionFatal =
  | {
      kind: "line-overflow" | "invalid-utf8";
      /** First 4 KiB of the offending bytes, lossily decoded for the report. */
      excerpt: string;
      /** Bytes of the discarded run observed when the fatal fired; an unterminated run is reported at the crossing (docs/session-protocol.md). */
      bytes: number;
    }
  | {
      kind: "handler";
      /** The exception the line handler threw: a codemux defect, reported
       * as itself so the caller never mistakes it for harness output. */
      error: unknown;
      /** Length of the line being processed, for the report. */
      bytes: number;
    }
  | {
      kind: "read-error" | "write-error";
      /** A harness pipe I/O failure, not harness output. */
      error: unknown;
      bytes: number;
    };

/** The codemux-side message for fatal classes that carry an
 * error instead of harness bytes; every driver reports them the same. */
export function codemuxFatalMessage(fatal: Extract<SessionFatal, { error: unknown }>): string {
  const detail = fatal.error instanceof Error ? fatal.error.message : String(fatal.error);
  return fatal.kind === "handler"
    ? `internal error while processing a harness line: ${detail}`
    : fatal.kind === "write-error" ? `writing the harness's stdin failed: ${detail}`
      : `reading the harness's stdout failed: ${detail}`;
}

function excerptOf(bytes: Uint8Array): string {
  return LOSSY_DECODER.decode(bytes.subarray(0, FATAL_EXCERPT_BYTES));
}

/** The bounded facts a tier-3 report carries (§4.2) for a decoded line
 * a session parser cannot use: the first 4 KiB of its UTF-8 bytes and
 * its full byte length. One unit for every layer (review live23: the
 * parsers cut 4096 characters, up to 16 KiB of multibyte text). */
export function unusableFacts(line: string): { excerpt: string; bytes: number } {
  const bytes = UTF8.encode(line);
  return { excerpt: excerptOf(bytes), bytes: bytes.byteLength };
}

export { excerptOf };

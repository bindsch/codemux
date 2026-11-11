/**
 * The error a `codemux complete` server answers with. The body keeps the
 * OpenAI error shape (`{"error": {"message", "type", "code"}}`) so an
 * OpenAI client raises its usual exception, with `type` always
 * `"codemux_error"` so a caller can tell codemux's refusal from the
 * provider's.
 */

export type CompleteErrorCode =
  | "unauthorized"
  | "bad_request"
  | "cannot_translate"
  | "model_not_priced"
  | "budget_exhausted"
  | "cost_unknown"
  | "request_cap_reached"
  | "shutting_down"
  | "not_found"
  | "method_not_allowed"
  | "payload_too_large"
  | "upstream_unreachable"
  | "upstream_malformed";

export class CompleteError extends Error {
  constructor(
    readonly status: number,
    readonly code: CompleteErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CompleteError";
  }
}

export function errorBody(code: CompleteErrorCode, message: string): string {
  return JSON.stringify({ error: { message, type: "codemux_error", code } });
}

/** A 400 for a request field the Anthropic translation cannot carry
 * exactly. */
export function cannotTranslate(message: string): CompleteError {
  return new CompleteError(400, "cannot_translate", message);
}

export function badRequest(message: string): CompleteError {
  return new CompleteError(400, "bad_request", message);
}

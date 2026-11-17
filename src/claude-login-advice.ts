import { SANDBOX_LOGIN_UNAVAILABLE } from "./sandbox-login-policy.js";

/** A native failure must explicitly identify lost authentication. An HTTP
 * status, local expiry, missing file, or ordinary model reply is not proof. */
export function claudeLoginAdvice(failed: boolean, errorText: string, loginStoreDenied = false): string | null {
  if (failed && loginStoreDenied && /authentication failed|failed to authenticate/i.test(errorText)) {
    return `codemux: ${SANDBOX_LOGIN_UNAVAILABLE}`;
  }
  return failed && /(?:not logged in|please (?:run \/login|log in|login)|authentication required|login reached its time limit and cannot be renewed|(?:oauth|refresh) token (?:has (?:expired|been revoked)|is (?:invalid|revoked)))/i.test(errorText)
    ? loginStoreDenied ? `codemux: ${SANDBOX_LOGIN_UNAVAILABLE}`
      : "claude: the harness reported a missing or invalid login; run `claude auth login`."
    : null;
}

export function claudeErrorText(frame: Record<string, unknown>): string {
  return [typeof frame.result === "string" ? frame.result : "",
    ...(Array.isArray(frame.errors) ? frame.errors.filter((error): error is string => typeof error === "string") : [])].join("\n");
}

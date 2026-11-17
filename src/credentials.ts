import { homedir } from "node:os";
import { join } from "node:path";

/** Claude Code's default plaintext credential path. */
export function claudeCredentialTarget(home = homedir()): string {
  return join(home, ".claude", ".credentials.json");
}

/** Parse only the Claude OAuth object, without exposing co-stored credentials. */
export function claudeOauthObject(blob: string): Record<string, unknown> | null {
  try {
    const oauth = JSON.parse(blob)?.claudeAiOauth;
    return typeof oauth === "object" && oauth !== null && !Array.isArray(oauth) ? oauth : null;
  } catch {
    return null;
  }
}

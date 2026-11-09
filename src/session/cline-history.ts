import { join } from "node:path";
import { runCapturedCommand } from "../process-runner.js";
import { CLINE_HISTORY_LIMIT, parseClineHistoryUsage } from "./cline-usage.js";

const CLINE_HISTORY_TIMEOUT_MS = 10_000;

/** Read-only native management command. This does not start a model turn.
 * The caller supplies the same private environment as its active ACP child.
 * An unavailable, oversized or malformed history leaves usage unknown. */
export async function readClineSessionUsage(input: {
  sessionId: string; cwd: string; env: Record<string, string>; home?: string | null;
  execute?: typeof runCapturedCommand;
}) {
  try {
    const result = await (input.execute ?? runCapturedCommand)([
      "cline", ...(input.home ? ["--config", join(input.home, ".cline")] : []),
      "history", "--json", "--limit", String(CLINE_HISTORY_LIMIT),
    ], { cwd: input.cwd, env: { ...input.env, CLINE_SESSION_BACKEND_MODE: "local" }, timeoutMs: CLINE_HISTORY_TIMEOUT_MS });
    return result.success && result.exitCode === 0 ? parseClineHistoryUsage(result.stdout, input.sessionId, input.cwd) : null;
  } catch { return null; }
}

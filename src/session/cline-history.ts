import { join } from "node:path";
import { runCapturedCommand } from "../process-runner.js";
import { CLINE_HISTORY_LIMIT, parseClineHistoryUsage } from "./cline-usage.js";
import type { ResolvedSessionLaunch } from "./spawn.js";
import { assertExecutablesUnchanged } from "../executable-security.js";

const CLINE_HISTORY_TIMEOUT_MS = 10_000;

/** Read-only native management command. This does not start a model turn.
 * Reuses the ACP child's resolved sandbox/env prefix and executable pins.
 * An unavailable, oversized or malformed history leaves usage unknown. */
export async function readClineSessionUsage(input: {
  sessionId: string; cwd: string; launch: ResolvedSessionLaunch; home?: string | null;
  execute?: typeof runCapturedCommand;
}) {
  try {
    const { command, programIndex, env, executablePin } = input.launch;
    const history = [
      ...command.slice(0, programIndex + 1), ...(input.home ? ["--config", join(input.home, ".cline")] : []),
      "history", "--json", "--limit", String(CLINE_HISTORY_LIMIT),
    ];
    assertExecutablesUnchanged(history, "Cline history", executablePin.requiredPaths, executablePin.checks);
    const result = await (input.execute ?? runCapturedCommand)(history, {
      cwd: input.cwd, env, ...executablePin, timeoutMs: CLINE_HISTORY_TIMEOUT_MS,
    });
    return result.success && result.exitCode === 0 ? parseClineHistoryUsage(result.stdout, input.sessionId, input.cwd) : null;
  } catch { return null; }
}

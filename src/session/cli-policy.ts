import { UsageRefusalError } from "../validation.js";
import type { SessionCommandOptions } from "./cli-request.js";

interface RegisteredSessionOptions extends SessionCommandOptions {
  sandboxAccount?: string;
  sandboxAccountId?: string;
  maxBudgetUsd?: string;
}

/** Refuse registered run-only options before resolving session state. */
export function assertSessionOptionsSupported(options: RegisteredSessionOptions): void {
  // Register these options so the refusal names the unsupported flag and
  // exits 64 instead of commander's generic parse error (exit 1).
  if (options.sandboxAccount !== undefined || options.sandboxAccountId !== undefined) {
    throw new UsageRefusalError(
      "--sandbox-account and --sandbox-account-id are not supported for sessions: the per-turn agents spawn several children with no single accounting stream; use run or tui"
    );
  }
  // Claude Code applies this flag only with --print. A multi-turn session
  // cannot carry the limit, whatever the selected agent.
  if (options.maxBudgetUsd !== undefined) {
    throw new UsageRefusalError(
      "--max-budget-usd is not supported for sessions: Claude Code applies the spend limit to headless runs only; use run"
    );
  }
}

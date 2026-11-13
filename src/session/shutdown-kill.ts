import type { SessionChildOutcome } from "./process-outcome.js";

/** 128 + SIGTERM, also used by wrappers that return a numeric status. */
export const SESSION_SIGNAL_EXIT_CODE = 143;

/** Signals sent to a live child, excluding descendant cleanup after exit. */
export class SessionStopSignals {
  private readonly sent = new Set<string>();

  record(signal: string, child: { exitCode: number | null; signalCode: unknown }): void {
    if (child.exitCode === null && child.signalCode === null) this.sent.add(signal);
  }

  matches(outcome: SessionChildOutcome): boolean {
    return outcome.signal === null
      ? outcome.code === SESSION_SIGNAL_EXIT_CODE && this.sent.has("SIGTERM")
      : (outcome.signal === "SIGTERM" || outcome.signal === "SIGKILL") && this.sent.has(outcome.signal);
  }
}

/** Only an idle, caller-requested shutdown can excuse an owned kill. */
export function shutdownKillWarning(
  agent: string,
  outcome: SessionChildOutcome | null,
  signals: SessionStopSignals | undefined,
  reason: string,
  turnOpen: boolean,
  exitCode: number
): string | null {
  if ((reason !== "shutdown" && reason !== "stdin-close") || turnOpen || exitCode !== 0 || outcome === null || !signals?.matches(outcome)) return null;
  const kill = outcome.signal ?? "SIGTERM (exit 143)";
  return `codemux stopped the ${agent} process with ${kill} after the requested shutdown; all turns had completed`;
}

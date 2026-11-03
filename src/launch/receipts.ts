// Ledger receipts for launched runs: completed, interrupted, and failed.
// src/launch.ts owns the launch lifecycle and calls these from its paths;
// every receipt uses the same never-fail append contract.
import type { RunContext } from "../adapters/base.js";
import { appendCallRecord, providerHost } from "../call-log.js";
import { unexpectedErrorExitCode } from "../cli-runtime.js";
import { foldedSinkUsage } from "../plain-unwrap.js";
import { readProviderOverride } from "../provider-override.js";
import {
  CapturedRunFailure,
  SIGNAL_EXIT_CODE,
} from "../process-runner.js";
import { emptyUsage } from "../result-envelope.js";
import type { LaunchOptions } from "../launch.js";
import type { AgentId, RunRequest, RunResult } from "../types.js";

/** Records a processed launch; refusals, capture failures, and signals use other paths. */
export function recordCompletedLaunch(
  request: RunRequest,
  options: LaunchOptions,
  result: RunResult,
  startedAt: number
): void {
  appendCallRecord({
    ts: new Date(startedAt).toISOString(),
    kind: options.kind ?? "run",
    labels: request.labels ?? null, // a check keeps its labels too (doctor --spend selects by machine-check=<date>; round 51)
    agent: request.agent,
    model: request.model ?? null,
    model_effective: result.servedModel ?? null,
    provider: providerHostFor(request.agent),
    session_id: null,
    turn_id: null,
    autonomy: request.autonomy ?? "read-only",
    hermetic: Boolean(request.hermetic),
    sandboxed: Boolean(request.sandboxed),
    exit_code: result.exitCode,
    finish: null,
    duration_ms: Math.max(0, Date.now() - startedAt),
    cwd: request.cwd ?? process.cwd(),
    usage: result.usage ?? emptyUsage(),
  });
}

/** The receipt a signal interrupt owes the ledger: the run was in flight
 * when a signal to codemux stopped it, so the process runner exits 143
 * from inside the run and this launch's recordCompletedLaunch never runs.
 * Called from the runner's onSignaled hook — the one place left with the
 * launch's facts — it writes the signal exit code and whatever usage the
 * stdout fold had already folded (null everywhere else, never a guess)
 * through the same never-fail append. Must not throw: a throw here would
 * only mask the exit it runs inside (review ul6). */
export function appendInterruptedLaunchReceipt(
  request: RunRequest,
  options: LaunchOptions,
  context: RunContext,
  startedAt: number
): void {
  try {
    const folded = foldedSinkUsage(context.stdoutSink);
    appendCallRecord({
      ts: new Date(startedAt).toISOString(),
      kind: options.kind ?? "run",
      labels: request.labels ?? null, // a check keeps its labels too (doctor --spend selects by machine-check=<date>; round 51)
      agent: request.agent,
      model: request.model ?? null,
      model_effective: null,
      provider: providerHostFor(request.agent),
      session_id: null,
      turn_id: null,
      autonomy: request.autonomy ?? "read-only",
      hermetic: Boolean(request.hermetic),
      sandboxed: Boolean(request.sandboxed),
      exit_code: SIGNAL_EXIT_CODE,
      finish: null,
      duration_ms: Math.max(0, Date.now() - startedAt),
      cwd: request.cwd ?? process.cwd(),
      usage: folded ?? emptyUsage(),
    });
  } catch {
    // The never-fail contract, enforced here too: appendCallRecord already
    // swallows its own failures, and anything else (a read of the sink)
    // must not turn the exit path into a crash.
  }
}

/** The receipt a failed launch owes the ledger: the harness ran — its
 * capture rejected (invalid UTF-8 on a stream; the runner wraps that as
 * CapturedRunFailure) or its processRunResult threw (`captured` true, the
 * raw result was in hand) — so the call happened even though the launch
 * rejects and recordCompletedLaunch never runs. A refusal before the spawn
 * (a missing scode, an unresolved binary) is neither: it ran nothing and
 * records nothing, keeping recordCompletedLaunch's contract. The exit code
 * comes from the returned failure result when one exists, or from the CLI
 * error mapping when the launch throws. The usage is what the stdout fold
 * had folded — all-null when no structured stream reported any, never a
 * guess. Must not throw: the rejection it rides cannot gain a second
 * failure (review ul8). */
export function appendFailedLaunchReceipt(
  request: RunRequest,
  options: LaunchOptions,
  context: RunContext,
  startedAt: number,
  error: unknown,
  captured: boolean,
  processed?: RunResult,
  exitCode: number = unexpectedErrorExitCode(error)
): void {
  if (!captured && !(error instanceof CapturedRunFailure)) return;
  try {
    const folded = foldedSinkUsage(context.stdoutSink);
    appendCallRecord({
      ts: new Date(startedAt).toISOString(),
      kind: options.kind ?? "run",
      labels: request.labels ?? null, // a check keeps its labels too (doctor --spend selects by machine-check=<date>; round 51)
      agent: request.agent,
      model: request.model ?? null,
      model_effective: processed?.servedModel ?? null,
      provider: providerHostFor(request.agent),
      session_id: null,
      turn_id: null,
      autonomy: request.autonomy ?? "read-only",
      hermetic: Boolean(request.hermetic),
      sandboxed: Boolean(request.sandboxed),
      exit_code: exitCode,
      finish: null,
      duration_ms: Math.max(0, Date.now() - startedAt),
      cwd: request.cwd ?? process.cwd(),
      usage: processed?.usage ?? folded ?? emptyUsage(),
    });
  } catch {
    // The never-fail contract, as the interrupted receipt enforces it.
  }
}

/** The endpoint identity for the ledger: "default", or the host of the
 * provider override this launch ran against — never the key. A malformed
 * override cannot fail the receipt; it failed the launch itself already. */
function providerHostFor(agent: AgentId): string {
  try {
    return providerHost(readProviderOverride(agent)?.baseUrl ?? null);
  } catch {
    return "default";
  }
}

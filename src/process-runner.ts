import { signalProcess } from "./process-signal.js";
export { signalProcess } from "./process-signal.js";
import { assertExecutablesUnchanged, type ExecutableCheck } from "./executable-security.js";
import { OutputLimitError, readBounded } from "./process-capture.js";
import { trackStdinDelivery } from "./process-stdin.js";
export { MAX_CAPTURE_BYTES } from "./process-capture.js";
import {
  createTerminationTarget,
  waitForDescendantsGrace,
  type TerminationTarget,
} from "./process-tree.js";
import type { RunResult } from "./types.js";

export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_ARGV_PROMPT_BYTES = 32 * 1024;
export const MAX_RUN_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export const FORCE_KILL_DELAY_MS = 2_000;
// After a timeout's SIGKILL escalation, how much longer to keep reading the
// captured pipes before abandoning them. A descendant no signal can reach
// (orphaned into another process group before the first snapshot) may hold
// them open forever; the run must still return.
export const PIPE_GIVE_UP_MS = 1_000;
const SIGNAL_BURST_WINDOW_MS = 1_000;
const TIMEOUT_EXIT_CODE = 124;
// 128 + SIGTERM: the child tree was terminated after a signal to codemux.
export const SIGNAL_EXIT_CODE = 143;
export const OUTPUT_LIMIT_EXIT_CODE = 125;

/** A capture failure of a command that ran: the child was spawned and a
 * stream's output could not be captured (invalid UTF-8). Wrapping marks the
 * rejection — the launcher's ledger receipt keys on it to tell a run whose
 * harness ran from a refusal before the spawn (a missing scode, an
 * unresolved binary), which owes no receipt (review ul8). The message is
 * the wrapped failure's own, so the caller-facing error text is unchanged. */
export class CapturedRunFailure extends Error {
  constructor(failure: unknown) {
    super(failure instanceof Error ? failure.message : String(failure), {
      cause: failure,
    });
    this.name = "CapturedRunFailure";
  }
}

/** An incremental stdout consumer for a run whose harness streams more on
 * stdout than the capture bound can hold (opencode's `--format json`: every
 * tool's output rides the event lines). The runner feeds each decoded chunk
 * to `push` instead of accumulating the stream; the sink keeps only what it
 * needs, and `keptBytes` bounds that residue: past `MAX_CAPTURE_BYTES` the
 * run fails at the capture limit exactly as a whole-stream capture would,
 * with `finish()` as the partial output. */
export interface StdoutSink {
  /** Optional duplex protocol. The runner retains timeout and signal ownership.
   * `cwd` is the directory the child was spawned in, as the caller resolved it. */
  start?(write: (line: string) => void, end: () => void, abort: () => void, cwd?: string): void;
  closeProtocol?(): void | Promise<void>;
  /** Stop an external protocol process immediately on timeout or signal. */
  terminateProtocol?(options?: { timedOut: boolean }): void;
  /** One decoded chunk of the stdout stream, in arrival order. */
  push(chunk: string): void;
  /** The run's stdout once the stream has ended (or been abandoned). */
  finish(options?: { timedOut: boolean; aborted?: boolean }): string;
  /** What the sink is currently keeping, in bytes. */
  keptBytes(): number;
}

/**
 * SIGTERM now, SIGKILL after the grace period. `termScope` decides whether the
 * initial SIGTERM reaches the whole tree (non-interactive runs) or only the
 * child (interactive runs, which get the grace period to shut down their own
 * children). The SIGKILL escalation always covers the tree.
 */
function forceKillAfterGrace(
  target: TerminationTarget,
  termScope: "process" | "tree"
): ReturnType<typeof setTimeout> {
  signalProcess(target, "SIGTERM", termScope);
  return setTimeout(
    () => signalProcess(target, "SIGKILL", "tree"),
    FORCE_KILL_DELAY_MS
  );
}

export function validateTimeout(timeoutMs: number): void {
  if (
    !Number.isFinite(timeoutMs) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_RUN_TIMEOUT_MS
  ) {
    throw new Error(
      `timeoutMs must be an integer from 1 to ${MAX_RUN_TIMEOUT_MS}`
    );
  }
}

export interface CapturedCommandOptions {
  cwd: string;
  env: Record<string, string>;
  stdinInput?: string | null;
  timeoutMs?: number;
  /** Consumes stdout incrementally instead of capturing it whole; stderr is
   * captured normally either way. */
  stdoutSink?: StdoutSink;
  /** Called when a signal to codemux stops the run, right before the
   * runner exits 143. Await adapter cleanup and write the call receipt,
   * since the launch path never resumes. Rejections and waits beyond
   * FORCE_KILL_DELAY_MS are reported without replacing the signal exit. */
  onSignaled?: () => void | Promise<void>;
  /** This launch's own executable resolutions, forwarded to the pre-spawn
   * re-stat: a path with a check re-stats against that identity alone —
   * never another launch's record of a replaced binary — and a required
   * path with no recorded identity is refused instead of skipped. A caller
   * that resolved its own command (the launch paths) passes both; a caller
   * that runs a binary another module resolved passes neither and the
   * re-stat falls back to the process-wide identity list. */
  requiredPaths?: readonly string[];
  checks?: readonly ExecutableCheck[];
}

// Captured commands in flight. While one runs, its own signal handlers own
// the shutdown (terminate the tree, then exit); outside that window, other
// exit-time cleanup (a hermetic home) has to handle a signal itself.
let activeCapturedCommands = 0;
export function hasActiveCapturedCommand(): boolean {
  return activeCapturedCommands > 0;
}

export async function runCapturedCommand(
  command: string[],
  options: CapturedCommandOptions
): Promise<RunResult> {
  if (
    command.length === 0 ||
    typeof command[0] !== "string" ||
    command[0].length === 0 ||
    command.some(
      (argument) => typeof argument !== "string" || argument.includes("\0")
    )
  ) {
    throw new Error("command must contain non-NUL string arguments");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  validateTimeout(timeoutMs);
  const useProcessGroup = process.platform !== "win32";
  assertExecutablesUnchanged(command, "command", options.requiredPaths, options.checks);
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env: options.env,
    detached: useProcessGroup,
  });

  const target = createTerminationTarget(proc, useProcessGroup);
  // Counted only once everything that can throw synchronously is done, so
  // the decrement in the finally block below always balances it.
  activeCapturedCommands++;
  let timedOut = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  let forceKillDeadline = 0;
  let giveUpTimer: ReturnType<typeof setTimeout> | null = null;
  // A Ctrl-C or SIGTERM aimed at codemux is forwarded to the child's whole
  // process group and the run completes normally, so exit handlers (a
  // hermetic home's cleanup) still see the child gone.
  let signaled = false;
  let captureFailed = false;
  let protocolAborted = false;
  let cleanupStarted = false;
  let terminationNote: string | undefined;
  const terminateRun = (): void => {
    const starting = !cleanupStarted && forceKillTimer === null;
    // Arm forced reaping before protocol code can throw. The server still
    // receives SIGTERM before the harness, so it stops accepting work first.
    if (starting) {
      forceKillDeadline = performance.now() + FORCE_KILL_DELAY_MS;
      forceKillTimer = setTimeout(() => signalProcess(target, "SIGKILL", "tree"), FORCE_KILL_DELAY_MS);
      giveUpTimer = setTimeout(() => {
        pipesAbandoned = true;
        giveUpReads();
        giveUpExit();
      }, FORCE_KILL_DELAY_MS + PIPE_GIVE_UP_MS);
    }
    try { options.stdoutSink?.terminateProtocol?.({ timedOut }); }
    catch (error) {
      terminationNote ??= `protocol termination failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (starting) signalProcess(target, "SIGTERM", "tree");
  };
  const onSignal = (): void => {
    if (signaled) return;
    signaled = true;
    terminateRun();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  let pipesAbandoned = false;
  let giveUpReads: () => void = () => {};
  const giveUp = new Promise<void>((resolve) => {
    giveUpReads = resolve;
  });
  // Only the bounded termination deadline abandons the child exit wait.
  let giveUpExit: () => void = () => {};
  const exitGiveUp = new Promise<void>((resolve) => { giveUpExit = resolve; });
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    terminateRun();
  }, timeoutMs);

  const abortCapture = (): void => {
    if (!captureFailed) terminateRun();
    captureFailed = true;
    giveUpReads();
  };

  let firstError: CapturedRunFailure | undefined;
  let firstCaptureError: unknown;
  let failureResult: RunResult | undefined;
  let completedResult: RunResult | undefined;
  const capture = async (
    stream: ReadableStream<Uint8Array>,
    streamName: "stdout" | "stderr"
  ): Promise<{ value?: string; error?: unknown }> => {
    try {
      return {
        value: await readBounded(
          stream,
          streamName,
          giveUp,
          streamName === "stdout" ? options.stdoutSink : undefined,
          () => ({ timedOut, aborted: captureFailed || signaled })
        ),
      };
    } catch (error) {
      firstCaptureError ??= error;
      abortCapture();
      return { error };
    }
  };

  // Stdin failures after the spawn are the run's (rounds 64 to 67): see
  // process-stdin.ts for the rules.
  const stdin = trackStdinDelivery({
    exited: proc.exited,
    superseded: () => captureFailed || timedOut || signaled,
    abort: abortCapture,
  });
  const trackStdin = stdin.track;

  try {
    try {
      // A protocol sink owns stdin itself: only the plain path writes here.
      if (!options.stdoutSink?.start) {
        if (options.stdinInput !== null && options.stdinInput !== undefined) {
          trackStdin(proc.stdin.write(options.stdinInput));
        }
        trackStdin(proc.stdin.end());
      }
      options.stdoutSink?.start?.(
        (line) => { stdin.attempt(() => proc.stdin.write(line)); },
        () => { stdin.attempt(() => proc.stdin.end()); },
        () => { protocolAborted = true; abortCapture(); },
        options.cwd
      );
    } catch (error) {
      // The child is live when the write or start() throws: the same
      // termination a signal gets (SIGTERM, the promised grace, a
      // tree-wide SIGKILL), wait for the exit, then fail the run.
      abortCapture();
      await waitForDescendantsGrace(target, forceKillDeadline);
      signalProcess(target, "SIGKILL", "tree");
      await Promise.race([proc.exited, exitGiveUp]);
      throw new CapturedRunFailure(error);
    }
    const [stdoutResult, stderrResult, exitCode] = await Promise.all([
      capture(proc.stdout as ReadableStream<Uint8Array>, "stdout"),
      capture(proc.stderr as ReadableStream<Uint8Array>, "stderr"),
      // Bun can retain the exit promise while inherited stdio is open, so
      // abandonment must release this wait as well as the readers.
      Promise.race([proc.exited, exitGiveUp.then(() => TIMEOUT_EXIT_CODE)]),
    ]);
    // Every write issued before the exit is in stdin's chain by now, so
    // the wait starts only here: started with the captures it could drain
    // an empty chain before a protocol sink's first write (round 68).
    await Promise.race([stdin.settled(), exitGiveUp]);

    // A stdin failure that came first is the diagnosis.
    if (stdin.failed()) throw new CapturedRunFailure(stdin.error());
    const captureError = firstCaptureError;
    if (captureError instanceof OutputLimitError) {
      firstError = new CapturedRunFailure(captureError);
      const stdout = captureError.streamName === "stdout"
        ? captureError.partialOutput
        : stdoutResult.value ?? "";
      const stderrOutput = captureError.streamName === "stderr"
        ? captureError.partialOutput
        : stderrResult.value ?? "";
      const separator =
        stderrOutput.length > 0 && !stderrOutput.endsWith("\n") ? "\n" : "";
      return failureResult = {
        stdout,
        stderr: `${stderrOutput}${separator}Error: ${captureError.message}\n`,
        exitCode: OUTPUT_LIMIT_EXIT_CODE,
        success: false,
        captureLimitExceeded: true,
      };
    }
    if (captureError) {
      // The command ran and a stream failed to capture: the marker carries
      // that fact to the launch path, whose failure receipt depends on it
      // (review ul8).
      throw new CapturedRunFailure(captureError);
    }

    const abandonedNote = pipesAbandoned
      ? "Note: a process out of the runner's reach kept the output open after " +
        "the timeout; it may still be running\n"
      : "";
    const result = {
      stdout: stdoutResult.value ?? "",
      stderr: timedOut
        ? `${stderrResult.value ?? ""}Error: agent timed out after ${timeoutMs}ms\n${abandonedNote}`
        : signaled
          ? `${stderrResult.value ?? ""}Error: agent interrupted by a signal\n`
          : stderrResult.value ?? "",
      exitCode: timedOut ? TIMEOUT_EXIT_CODE : signaled ? SIGNAL_EXIT_CODE : exitCode,
      success: !timedOut && !signaled && exitCode === 0,
      ...(timedOut ? { timedOut: true as const } : {}),
    };
    if (timedOut) {
      firstError = new CapturedRunFailure(`agent timed out after ${timeoutMs}ms`);
      failureResult = result;
    }
    completedResult = result;
    return result;
  } catch (error) {
    firstError = error instanceof CapturedRunFailure ? error : new CapturedRunFailure(error);
    throw firstError;
  } finally {
    cleanupStarted = true;
    clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (giveUpTimer) clearTimeout(giveUpTimer);
    // The leader may exit on SIGTERM while a descendant closes the pipes
    // early: give the descendants the rest of the promised grace, then kill
    // the whole group, which reaches members the pid walk never saw.
    if (timedOut || signaled || captureFailed) {
      await waitForDescendantsGrace(target, forceKillDeadline);
      signalProcess(target, "SIGKILL", "tree");
    }
    // Protocol cleanup can fail (a full recording disk): the runner's own
    // timers are cleared first. A protocol abort's diagnosis is never replaced.
    firstError ??= protocolAborted ? new CapturedRunFailure("protocol capture aborted") : undefined;
    let cleanupNote: string | undefined;
    try { await options.stdoutSink?.closeProtocol?.(); }
    catch (error) {
      const note = `cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
      cleanupNote = note;
      const retained = failureResult ?? completedResult;
      if (retained) retained.stderr += `${retained.stderr && !retained.stderr.endsWith("\n") ? "\n" : ""}Note: ${note}\n`;
      if (firstError) firstError.message += `; ${note}`;
      else if (!retained) firstError = new CapturedRunFailure(error);
    } finally {
      if (signaled) {
        let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve().then(() => options.onSignaled?.()),
            new Promise<never>((_, reject) => {
              cleanupDeadline = setTimeout(() => reject(new Error(
                "adapter cleanup and interruption receipt remain incomplete after the signal cleanup grace"
              )), FORCE_KILL_DELAY_MS);
            }),
          ]);
        }
        catch (error) { console.error(`Note: cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
        finally { clearTimeout(cleanupDeadline); }
      }
      // Signals must remain handled through asynchronous recording finalization.
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
      activeCapturedCommands--;
    }
    if (terminationNote) {
      if (failureResult) failureResult.stderr += `Note: ${terminationNote}\n`;
      if (firstError) firstError.message += `; ${terminationNote}`;
      if (signaled) console.error(`Note: ${terminationNote}`);
    }
    if (signaled) {
      // The signal meant "stop codemux", not "skip this step": an
      // interrupted version probe must not fall through to the launch. The
      // launch's receipt is written first: recordCompletedLaunch never runs.
      if (cleanupNote) console.error(`Note: ${cleanupNote}`);
      console.error("codemux: interrupted; the agent's process tree was terminated");
      process.exit(SIGNAL_EXIT_CODE);
    }
    if (firstError && !failureResult) throw firstError;
    if (protocolAborted && !failureResult) throw new CapturedRunFailure("protocol capture aborted");
  }
}

/**
 * Wait for a spawned interactive process, shielding it from signals that would
 * otherwise propagate through the process group and kill grandchildren (e.g. a
 * Playwright browser).
 *
 * - SIGINT: swallowed in parent (child receives it from the terminal via the
 *   shared process group). Rapid triple-SIGINT forces a SIGTERM to the child.
 * - SIGTERM/SIGHUP: forwarded to child only (a child-directed
 *   process.kill inside signalProcess), not broadcast, so
 *   the child gets the grace period to shut down its own children. The
 *   SIGKILL escalation after the grace period covers the whole process tree.
 */
export async function guardedWait(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs?: number
): Promise<number> {
  if (timeoutMs !== undefined) validateTimeout(timeoutMs);
  const target = createTerminationTarget(proc);
  let forceKillDeadline = 0;
  const armForceKill = (): ReturnType<typeof setTimeout> => {
    const timer = forceKillAfterGrace(target, "process");
    // Measured from SIGTERM delivery, after the table read inside it, so a
    // slow enumeration cannot eat into the grace period.
    forceKillDeadline = performance.now() + FORCE_KILL_DELAY_MS;
    return timer;
  };
  let sigintCount = 0;
  let sigintTimer: ReturnType<typeof setTimeout> | null = null;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  const onSigint = () => {
    sigintCount++;
    if (sigintCount >= 3) {
      forceKillTimer ??= armForceKill();
      return;
    }
    if (sigintTimer) clearTimeout(sigintTimer);
    sigintTimer = setTimeout(() => {
      sigintCount = 0;
    }, SIGNAL_BURST_WINDOW_MS);
  };
  const onSigterm = () => {
    forceKillTimer ??= armForceKill();
  };
  const onSighup = () => {
    forceKillTimer ??= armForceKill();
  };

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);

  if (timeoutMs !== undefined) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      forceKillTimer ??= armForceKill();
    }, timeoutMs);
  }

  try {
    const exitCode = await proc.exited;
    return timedOut ? TIMEOUT_EXIT_CODE : exitCode;
  } finally {
    if (sigintTimer) clearTimeout(sigintTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      // The child exited on SIGTERM before the grace period ran out, so the
      // scheduled tree-scoped SIGKILL was canceled with it. Its remembered
      // descendants keep the rest of the grace period, then get the SIGKILL
      // they were promised; otherwise they would outlive the run for good.
      // The signal listeners stay installed until this is done, so a second
      // Ctrl-C or SIGTERM in that window cannot kill codemux first. The
      // SIGKILL is unconditional: cheap when nothing is left, and the only
      // escalation there is when the table could not be read.
      await waitForDescendantsGrace(target, forceKillDeadline);
      signalProcess(target, "SIGKILL", "tree");
      // A Ctrl-C during that wait re-armed the burst timer; clear it again
      // so no pending timer keeps the event loop alive after we return.
      if (sigintTimer) clearTimeout(sigintTimer);
    }
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("SIGHUP", onSighup);
  }
}

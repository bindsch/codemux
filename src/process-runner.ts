import { signalProcess } from "./process-signal.js";
export { signalProcess } from "./process-signal.js";
import { assertExecutablesUnchanged, type ExecutableCheck } from "./executable-security.js";
import { captureLimitFailure, OutputLimitError, readBounded } from "./process-capture.js";
import { trackStdinDelivery } from "./process-stdin.js";
import { writeRunStdin } from "./process-stdin-repeat.js";
import {
  beginCapturedCommand,
  endCapturedCommand,
  neverSettles,
  noteSignaledRun,
  signalShutdownPending,
} from "./process-runner-signals.js";
export { hasActiveCapturedCommand, hasActiveSignalOwner } from "./process-runner-signals.js";
export { guardedWait } from "./process-guarded-wait.js";
export { MAX_CAPTURE_BYTES, OUTPUT_LIMIT_EXIT_CODE } from "./process-capture.js";
import {
  createTerminationTarget,
  waitForDescendantsGrace,
  type TerminationTarget,
} from "./process-tree.js";
import type { RunResult } from "./types.js";

export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_ARGV_PROMPT_BYTES = 32 * 1024;
export const MAX_RUN_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// The termination timing constants, the signal exit code, and the signaled
// exit tail live in process-runner-exit.ts (split at the 500-line cap,
// review round 401, item 2); re-exported here so every existing import
// path is unchanged.
export {
  BRIDGE_CLOSE_ABANDON_MS,
  FORCE_KILL_DELAY_MS,
  PIPE_GIVE_UP_MS,
  SIGNAL_EXIT_CODE,
} from "./process-runner-exit.js";
import {
  FORCE_KILL_DELAY_MS,
  PIPE_GIVE_UP_MS,
  SIGNAL_EXIT_CODE,
  SIGNALED_PEER_WAIT_MS,
  exitSignaledRun,
} from "./process-runner-exit.js";

export const TIMEOUT_EXIT_CODE = 124;

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
  /** The adapter's `stdinRepeats`: feed `stdinInput` to the child for its
   * whole lifetime instead of writing it once and half-closing — for a
   * harness that reads EOF as acceptance (aider's canned declines), the
   * repeat is what keeps every yes-default prompt answered no (review
   * round 153; src/process-stdin-repeat.ts). Default false: one write,
   * then the half-close. */
  stdinRepeats?: boolean;
  timeoutMs?: number;
  /** Consumes stdout incrementally instead of capturing it whole; stderr is
   * captured normally either way. */
  stdoutSink?: StdoutSink;
  /** One-shot probes only: complete stdout permits success at the deadline. */
  outputComplete?: (stream: "stdout" | "stderr", output: string, ended: boolean) => boolean;
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
  if (options.outputComplete && options.stdoutSink) throw new Error("outputComplete cannot be combined with stdoutSink");
  // A signaled command is still terminating its tree and exits codemux
  // when it has: a child started now would outlive that exit in its own
  // process group, so nothing starts (review round 169).
  if (signalShutdownPending()) await neverSettles;
  const useProcessGroup = process.platform !== "win32";
  assertExecutablesUnchanged(command, "command", options.requiredPaths, options.checks);
  let timedOut = false;
  let outputCompleted = false;
  let stoppingCompletedLeader = false;
  let leaderExit: number | undefined;
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
  // Failure cleanup kills before closing the protocol; normal cleanup
  // kills afterward, including when a signal arrives during that close.
  let treeEnded = false;
  let terminationNote: string | undefined;
  let pipesAbandoned = false;
  let giveUpReads: () => void = () => {};
  const giveUp = new Promise<void>((resolve) => {
    giveUpReads = resolve;
  });
  // Only the bounded termination deadline abandons the child exit wait.
  let giveUpExit: () => void = () => {};
  const exitGiveUp = new Promise<void>((resolve) => { giveUpExit = resolve; });
  // Null until the spawn returned. No handler can run inside the
  // synchronous stretch that installs it and spawns, but the handler
  // checks anyway, so the type says what the code does (review round 169).
  let target: TerminationTarget | null = null;
  let terminationStarted = false;
  const terminateRun = (): void => {
    if (target === null) return;
    const tree = target;
    // A signal during protocol cleanup still terminates the protocol and
    // records interruption. No tree timer is armed in that window:
    // the finally block waits for this deadline and kills the tree after
    // the bounded protocol close. Earlier termination arms the timers below.
    const firstTermination = !terminationStarted;
    terminationStarted = true;
    // Arm forced reaping before protocol code can throw; the server gets
    // SIGTERM before the harness, so it stops accepting work first.
    if (firstTermination) {
      forceKillDeadline = performance.now() + FORCE_KILL_DELAY_MS;
      if (!cleanupStarted) {
        forceKillTimer = setTimeout(() => signalProcess(tree, "SIGKILL", "tree"), FORCE_KILL_DELAY_MS);
        giveUpTimer = setTimeout(() => {
          pipesAbandoned = true;
          giveUpReads();
          giveUpExit();
        }, FORCE_KILL_DELAY_MS + PIPE_GIVE_UP_MS);
      }
    }
    try { options.stdoutSink?.terminateProtocol?.({ timedOut }); }
    catch (error) {
      terminationNote ??= `protocol termination failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (firstTermination) signalProcess(tree, "SIGTERM", "tree");
  };
  // Bound protocol cleanup after interruptions and capture failures too.
  let closingProtocol = false;
  let protocolGraceTimer: ReturnType<typeof setTimeout> | null = null;
  let expireProtocolGrace: () => void = () => {};
  const protocolGrace = new Promise<void>((resolve) => { expireProtocolGrace = resolve; });
  const armProtocolGrace = (): void => {
    if (closingProtocol) protocolGraceTimer ??= setTimeout(expireProtocolGrace, FORCE_KILL_DELAY_MS);
  };
  const onSignal = (): void => {
    if (signaled) return;
    signaled = true;
    noteSignaledRun();
    terminateRun();
    armProtocolGrace();
  };
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
          () => ({ timedOut, aborted: captureFailed || signaled }),
          (output, ended) => {
            if (!terminationStarted && !signaled && !captureFailed && options.outputComplete) {
              outputCompleted = options.outputComplete(streamName, output, ended);
            }
          }
        ),
      };
    } catch (error) {
      firstCaptureError ??= error;
      abortCapture();
      return { error };
    }
  };

  // Handlers and count before the spawn (review round 169): until the
  // first process.on there is no handler at the operating-system level,
  // so a signal in that window took the default action and left the
  // detached child running, and the private-directory handlers saw zero
  // active commands and exited codemux for it.
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  beginCapturedCommand(onSignal);
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const disarmTimeout = (): void => {
    if (timeoutTimer !== null) clearTimeout(timeoutTimer);
    timeoutTimer = null;
  };
  let spawned: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  try {
    spawned = Bun.spawn(command, {
      cwd: options.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      env: options.env,
      detached: useProcessGroup,
    });
    target = createTerminationTarget(spawned, useProcessGroup);
    timeoutTimer = setTimeout(() => {
      // Only the deadline can accept output from a still-running probe.
      // An already-exited leader keeps its status even if its pipes remain open.
      const leaderRunning = leaderExit === undefined &&
        spawned?.exitCode === null && spawned.signalCode === null;
      stoppingCompletedLeader = Boolean(options.outputComplete && leaderRunning &&
        outputCompleted && !terminationStarted && !signaled && !captureFailed);
      timedOut = !stoppingCompletedLeader && (!options.outputComplete || leaderRunning);
      terminateRun();
    }, timeoutMs);
  } catch (error) {
    // Nothing before this point owns a child except the spawn itself: undo
    // the count and the handlers exactly once (the finally below never
    // ran), kill anything the spawn produced, and let the refusal
    // propagate.
    if (timeoutTimer !== null) clearTimeout(timeoutTimer);
    spawned?.kill("SIGKILL");
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    endCapturedCommand(onSignal);
    throw error;
  }
  const proc = spawned;
  const leaderExited = proc.exited.then((code) => {
    leaderExit = code;
    return code;
  });
  try {
    // Stdin failures after the spawn are the run's (rounds 64 to 67): see
    // process-stdin.ts for the rules.
    const stdin = trackStdinDelivery({
      exited: proc.exited,
      superseded: () => captureFailed || timedOut || signaled,
      abort: abortCapture,
    });
    const trackStdin = stdin.track;
    try {
      // The plain path's stdin carrier — one shot, or the repeating
      // decline feeder an always-decline harness needs (review round
      // 153) — lives beside its repeater in process-stdin-repeat.ts.
      writeRunStdin(options, proc, trackStdin);
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
      // Record the leader independently of the pipes; abandonment still
      // bounds the wait when Bun retains its exit promise with inherited I/O.
      Promise.race([leaderExited, exitGiveUp.then(() => TIMEOUT_EXIT_CODE)]),
    ]);
    // Disarm before stdin settlement so its deadline cannot recast an exit.
    disarmTimeout();
    // Bound stdin settlement too: a descendant can retain its read end.
    let stdinOrphan = false;
    let giveUpStdin: () => void = () => {};
    const stdinGiveUp = new Promise<void>((resolve) => { giveUpStdin = resolve; });
    const stdinGiveUpTimer = setTimeout(() => {
      stdinOrphan = true;
      giveUpStdin();
    }, PIPE_GIVE_UP_MS);
    try {
      await Promise.race([stdin.settled(), exitGiveUp, stdinGiveUp]);
    } finally {
      clearTimeout(stdinGiveUpTimer);
    }

    // A stdin failure that came first is the diagnosis.
    if (stdin.failed()) throw new CapturedRunFailure(stdin.error());
    const captureError = firstCaptureError;
    if (captureError instanceof OutputLimitError) {
      // Both streams can fail past the limit in one run; the failure
      // result keeps each stream's own partial output (process-capture.ts).
      const failure = captureLimitFailure(captureError, stdoutResult, stderrResult);
      firstError = new CapturedRunFailure(captureError);
      return failureResult = failure;
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
    // The input twin of that note: the child is done, a write of its input
    // never settled, and the give-up above returned the run anyway.
    const stdinOrphanNote = stdinOrphan
      ? "Note: a process out of the runner's reach kept the input open after " +
        "the child exited; it may still be running\n"
      : "";
    // The diagnostic starts its own line: a child whose last stderr line
    // had no newline would otherwise share it (review round 265).
    const captured = stderrResult.value ?? "";
    const separated = captured === "" || captured.endsWith("\n") ? captured : `${captured}\n`;
    const leaderCode = leaderExit ?? exitCode;
    const probeSucceeded = stoppingCompletedLeader && !signaled;
    const result = {
      stdout: stdoutResult.value ?? "",
      stderr: timedOut
        ? `${separated}Error: agent timed out after ${timeoutMs}ms\n${abandonedNote}${stdinOrphanNote}`
        : signaled
          ? `${separated}Error: agent interrupted by a signal\n`
          : stdinOrphan
            ? `${separated}${stdinOrphanNote}`
            : captured,
      exitCode: timedOut ? TIMEOUT_EXIT_CODE : signaled ? SIGNAL_EXIT_CODE : probeSucceeded ? 0 : leaderCode,
      success: !timedOut && !signaled && (leaderCode === 0 || probeSucceeded),
      ...(timedOut ? { timedOut: true as const } : {}),
      ...(probeSucceeded ? { stoppedAfterOutput: true as const } : {}),
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
    disarmTimeout();
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (giveUpTimer) clearTimeout(giveUpTimer);
    // Give descendants their remaining grace, then kill the whole group.
    if (terminationStarted) {
      await waitForDescendantsGrace(target, forceKillDeadline);
      signalProcess(target, "SIGKILL", "tree");
      treeEnded = true;
    }
    // Protocol cleanup can fail (a full recording disk): the runner's own
    // timers are cleared first. A protocol abort's diagnosis is never replaced.
    firstError ??= protocolAborted ? new CapturedRunFailure("protocol capture aborted") : undefined;
    let cleanupNote: string | undefined;
    try {
      closingProtocol = true;
      // Every close is bounded, a normal exit's too: the run timeout is
      // cleared by now, so a protocol close that never settled after a
      // clean exit held the command open forever (review round 322).
      armProtocolGrace();
      const closed = (async () => { await options.stdoutSink?.closeProtocol?.(); return true; })();
      if (!(await Promise.race([closed, protocolGrace.then(() => false)]))) {
        throw new Error("protocol cleanup remains incomplete after the cleanup grace");
      }
    } catch (error) {
      const note = `cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
      cleanupNote = note;
      const retained = failureResult ?? completedResult;
      if (retained) retained.stderr += `${retained.stderr && !retained.stderr.endsWith("\n") ? "\n" : ""}Note: ${note}\n`;
      if (firstError) firstError.message += `; ${note}`;
      else if (!retained) firstError = new CapturedRunFailure(error);
    } finally {
      closingProtocol = false;
      if (protocolGraceTimer) clearTimeout(protocolGraceTimer);
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
      endCapturedCommand(onSignal);
    }
    // Normal exit ends ownership too. A signal during protocol cleanup
    // may have armed a deadline since the earlier kill check.
    if (!treeEnded) {
      await waitForDescendantsGrace(target, forceKillDeadline);
      signalProcess(target, "SIGKILL", "tree");
    }
    if (terminationNote) {
      if (failureResult) failureResult.stderr += `Note: ${terminationNote}\n`;
      if (firstError) firstError.message += `; ${terminationNote}`;
      if (signaled) console.error(`Note: ${terminationNote}`);
    }
    if (signaled) {
      await exitSignaledRun({ cleanupNote, peerWaitMs: SIGNALED_PEER_WAIT_MS });
    }
    if (firstError && !failureResult) throw firstError;
    if (protocolAborted && !failureResult) throw new CapturedRunFailure("protocol capture aborted");
  }
}

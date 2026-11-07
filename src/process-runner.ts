import { signalProcess } from "./process-signal.js";
export { signalProcess } from "./process-signal.js";
import { assertExecutablesUnchanged, type ExecutableCheck } from "./executable-security.js";
import { OutputLimitError, readBounded } from "./process-capture.js";
import { trackStdinDelivery } from "./process-stdin.js";
import { writeRunStdin } from "./process-stdin-repeat.js";
import {
  beginCapturedCommand,
  endCapturedCommand,
  finishSignaledRun,
  neverSettles,
  noteSignaledRun,
  signalShutdownPending,
} from "./process-runner-signals.js";
export { hasActiveCapturedCommand } from "./process-runner-signals.js";
export { guardedWait } from "./process-guarded-wait.js";
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
// What a signaled run's cleanup can take once the signal has landed (the
// force-kill delay, the pipe give-up, the protocol cleanup's grace, and
// the interruption receipt's grace), plus a second of margin so a peer
// that used every deadline still runs its last continuation first.
const SIGNALED_PEER_WAIT_MS = FORCE_KILL_DELAY_MS + PIPE_GIVE_UP_MS + 2 * FORCE_KILL_DELAY_MS + 1_000;
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
  // A signaled command is still terminating its tree and exits codemux
  // when it has: a child started now would outlive that exit in its own
  // process group, so nothing starts (review round 169).
  if (signalShutdownPending()) await neverSettles;
  const useProcessGroup = process.platform !== "win32";
  assertExecutablesUnchanged(command, "command", options.requiredPaths, options.checks);
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
  const terminateRun = (): void => {
    if (target === null) return;
    const tree = target;
    const starting = !cleanupStarted && forceKillTimer === null;
    // Arm forced reaping before protocol code can throw. The server still
    // receives SIGTERM before the harness, so it stops accepting work first.
    if (starting) {
      forceKillDeadline = performance.now() + FORCE_KILL_DELAY_MS;
      forceKillTimer = setTimeout(() => signalProcess(tree, "SIGKILL", "tree"), FORCE_KILL_DELAY_MS);
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
    if (starting) signalProcess(tree, "SIGTERM", "tree");
  };
  // After a signal, a timeout, or a capture failure the protocol cleanup
  // gets the same grace the receipt gets: closeProtocol has no deadline of
  // its own, and one that never settled kept the interruption receipt from
  // being written and codemux from exiting (review round 174); after a
  // timeout or a capture failure the same never-settling cleanup held the
  // run open past its own configured end (review round 286).
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
          () => ({ timedOut, aborted: captureFailed || signaled })
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
      timedOut = true;
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
    // The diagnostic starts its own line: a child whose last stderr line
    // had no newline would otherwise share it (review round 265).
    const captured = stderrResult.value ?? "";
    const separated = captured === "" || captured.endsWith("\n") ? captured : `${captured}\n`;
    const result = {
      stdout: stdoutResult.value ?? "",
      stderr: timedOut
        ? `${separated}Error: agent timed out after ${timeoutMs}ms\n${abandonedNote}`
        : signaled
          ? `${separated}Error: agent interrupted by a signal\n`
          : captured,
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
    try {
      closingProtocol = true;
      if (signaled || timedOut || captureFailed) armProtocolGrace();
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
      // Other captured commands got the same signal and are still
      // terminating their own trees: the first to finish must not exit
      // under them (review round 169). This run returns to no caller
      // either way. The last signaled run to finish prints the line and
      // exits. Every step of a signaled run's cleanup is bounded, so the
      // last one arrives; an earlier one still waits no longer than those
      // bounds add up to and then exits itself, so nothing a peer does can
      // hold codemux open after a signal (review rounds 171 and 174).
      if (!finishSignaledRun()) await Bun.sleep(SIGNALED_PEER_WAIT_MS);
      console.error("codemux: interrupted; the agent's process tree was terminated");
      process.exit(SIGNAL_EXIT_CODE);
    }
    if (firstError && !failureResult) throw firstError;
    if (protocolAborted && !failureResult) throw new CapturedRunFailure("protocol capture aborted");
  }
}

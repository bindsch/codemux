import {
  createTerminationTarget,
  rememberDescendants,
  signalDescendant,
  signalDescendants,
  waitForDescendantsGrace,
  type TerminationTarget,
} from "./process-tree.js";
import { readProcessTable } from "./process-table.js";
import type { RunResult } from "./types.js";

export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
export const MAX_ARGV_PROMPT_BYTES = 32 * 1024;
export const MAX_RUN_TIMEOUT_MS = 24 * 60 * 60 * 1000;

const FORCE_KILL_DELAY_MS = 2_000;
// After a timeout's SIGKILL escalation, how much longer to keep reading the
// captured pipes before abandoning them. A descendant no signal can reach
// (orphaned into another process group before the first snapshot) may hold
// them open forever; the run must still return.
const PIPE_GIVE_UP_MS = 1_000;
const SIGNAL_BURST_WINDOW_MS = 1_000;
const TIMEOUT_EXIT_CODE = 124;
export const OUTPUT_LIMIT_EXIT_CODE = 125;

class OutputLimitError extends Error {
  constructor(
    readonly streamName: "stdout" | "stderr",
    readonly partialOutput: string
  ) {
    super(`${streamName} exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit`);
  }
}

/** Read a stream to its end, or until `giveUp` resolves, in which case the
 * read is cancelled and what arrived so far is returned. */
async function readBounded(
  stream: ReadableStream<Uint8Array>,
  streamName: "stdout" | "stderr",
  giveUp: Promise<void> = new Promise(() => {})
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let output = "";
  let gaveUp = false;

  // The give-up reaction is registered ONCE, here — never raced against
  // each read. A chatty command emits thousands of small chunks, and a
  // pending promise per chunk pins all of them in memory until the capture
  // ends. Cancelling the reader resolves the pending read as done, which
  // is what ends the loop on a timeout.
  giveUp.then(() => {
    gaveUp = true;
    reader.cancel().catch(() => {
      // The lock may already be released after a natural end.
    });
  }, () => {
    gaveUp = true;
    reader.cancel().catch(() => {});
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (gaveUp) {
          // A give-up cancellation can leave an incomplete multibyte
          // character buffered, and flushing a fatal decoder throws on
          // one. Every complete character was already emitted, so the
          // incomplete suffix is all that is lost: drop it and return the
          // timeout result instead of rejecting the whole capture. A
          // natural end with a partial character is genuinely invalid
          // UTF-8 and still throws.
          try {
            return output + decoder.decode();
          } catch {
            return output;
          }
        }
        return output + decoder.decode();
      }
      const remaining = MAX_CAPTURE_BYTES - bytesRead;
      bytesRead += value.byteLength;
      if (value.byteLength > remaining) {
        output += decoder.decode(value.subarray(0, remaining), { stream: true });
        await reader.cancel();
        throw new OutputLimitError(streamName, output);
      }
      output += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`${streamName} is not valid UTF-8`, { cause: error });
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Signal the child. `scope: "tree"` also signals its process group (when it
 * leads one) and every descendant found by walking the process table;
 * `scope: "process"` signals the child alone but still records its
 * descendants so a later tree-scoped escalation can reach them.
 *
 * The table is read BEFORE the first signal is delivered, deliberately. An
 * agent that exits promptly on SIGTERM (the common case) reparents its
 * escaped descendants within milliseconds, after which no walk rooted at
 * the child can find them; the snapshot must come first or the tree kill
 * has nothing to remember. The cost is that the signal waits for one table
 * read: tens of milliseconds normally, and never more than
 * PROCESS_TABLE_TIMEOUT_MS on macOS (Linux reads `/proc` in memory).
 */
function signalProcess(
  target: TerminationTarget,
  signal: NodeJS.Signals,
  scope: "process" | "tree"
): void {
  const { proc, processGroup } = target;
  if (process.platform !== "win32") {
    const groupSignaled = processGroup && scope === "tree" ? proc.pid : null;
    let leftToGroup: number[] = [];
    if (scope === "tree") {
      leftToGroup = signalDescendants(target, signal, groupSignaled);
    } else {
      rememberDescendants(target, readProcessTable());
    }
    if (groupSignaled !== null) {
      try {
        process.kill(-proc.pid, signal);
        return;
      } catch (error) {
        // The group signal did not go out. ESRCH means the group is gone
        // (the child exited between the timer and delivery); anything else
        // is reported. Either way the members left to it are reached one by
        // one: a member that moved to another group since the snapshot is
        // still alive, and ESRCH per pid is harmless.
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          console.error(
            `codemux: could not send ${signal} to process group ${proc.pid}: ` +
              (error instanceof Error ? error.message : String(error))
          );
        }
        for (const pid of leftToGroup) signalDescendant(pid, signal);
      }
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // Signaling an already-exited process is harmless.
  }
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
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env: options.env,
    detached: useProcessGroup,
  });

  if (options.stdinInput !== null && options.stdinInput !== undefined) {
    proc.stdin.write(options.stdinInput);
  }
  proc.stdin.end();

  const target = createTerminationTarget(proc, useProcessGroup);
  let timedOut = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  let forceKillDeadline = 0;
  let giveUpTimer: ReturnType<typeof setTimeout> | null = null;
  let pipesAbandoned = false;
  let giveUpReads: () => void = () => {};
  const giveUp = new Promise<void>((resolve) => {
    giveUpReads = resolve;
  });
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    forceKillTimer = forceKillAfterGrace(target, "tree");
    forceKillDeadline = performance.now() + FORCE_KILL_DELAY_MS;
    giveUpTimer = setTimeout(() => {
      pipesAbandoned = true;
      giveUpReads();
    }, FORCE_KILL_DELAY_MS + PIPE_GIVE_UP_MS);
  }, timeoutMs);

  const capture = async (
    stream: ReadableStream<Uint8Array>,
    streamName: "stdout" | "stderr"
  ): Promise<{ value?: string; error?: unknown }> => {
    try {
      return { value: await readBounded(stream, streamName, giveUp) };
    } catch (error) {
      signalProcess(target, "SIGKILL", "tree");
      // This capture already failed (output limit, invalid UTF-8): arm
      // abandonment now so the other stream is released at once instead
      // of stalling an already-failed run until the timeout fires.
      giveUpReads();
      return { error };
    }
  };

  try {
    const [stdoutResult, stderrResult, exitCode] = await Promise.all([
      capture(proc.stdout as ReadableStream<Uint8Array>, "stdout"),
      capture(proc.stderr as ReadableStream<Uint8Array>, "stderr"),
      proc.exited,
    ]);

    const captureError = stdoutResult.error ?? stderrResult.error;
    if (captureError instanceof OutputLimitError) {
      const stdout = captureError.streamName === "stdout"
        ? captureError.partialOutput
        : stdoutResult.value ?? "";
      const stderrOutput = captureError.streamName === "stderr"
        ? captureError.partialOutput
        : stderrResult.value ?? "";
      const separator =
        stderrOutput.length > 0 && !stderrOutput.endsWith("\n") ? "\n" : "";
      return {
        stdout,
        stderr: `${stderrOutput}${separator}Error: ${captureError.message}\n`,
        exitCode: OUTPUT_LIMIT_EXIT_CODE,
        success: false,
      };
    }
    if (captureError) {
      throw captureError;
    }

    const abandonedNote = pipesAbandoned
      ? "Note: a process out of the runner's reach kept the output open after " +
        "the timeout; it may still be running\n"
      : "";
    return {
      stdout: stdoutResult.value ?? "",
      stderr: timedOut
        ? `${stderrResult.value ?? ""}Error: agent timed out after ${timeoutMs}ms\n${abandonedNote}`
        : stderrResult.value ?? "",
      exitCode: timedOut ? TIMEOUT_EXIT_CODE : exitCode,
      success: !timedOut && exitCode === 0,
    };
  } finally {
    clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (giveUpTimer) clearTimeout(giveUpTimer);
    // The process-group leader may exit on SIGTERM while a descendant ignores
    // it and closes the captured pipes, which resolves the capture before the
    // grace timer fires. Give the descendants the rest of the grace period
    // they were promised, then kill the tree unconditionally: the group
    // SIGKILL reaches a member the pid walk never saw (or could not see), as
    // it did in 0.5.0, so none can escape the timeout.
    if (timedOut) {
      await waitForDescendantsGrace(target, forceKillDeadline);
      signalProcess(target, "SIGKILL", "tree");
    }
  }
}

/**
 * Wait for a spawned interactive process, shielding it from signals that would
 * otherwise propagate through the process group and kill grandchildren (e.g. a
 * Playwright browser).
 *
 * - SIGINT: swallowed in parent (child receives it from the terminal via the
 *   shared process group). Rapid triple-SIGINT forces a SIGTERM to the child.
 * - SIGTERM/SIGHUP: forwarded to child only (proc.kill), not broadcast, so
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

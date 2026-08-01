import type { RunResult } from "./types.js";

export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
export const MAX_ARGV_PROMPT_BYTES = 32 * 1024;
export const MAX_RUN_TIMEOUT_MS = 24 * 60 * 60 * 1000;

const FORCE_KILL_DELAY_MS = 2_000;
const SIGNAL_BURST_WINDOW_MS = 1_000;
const TIMEOUT_EXIT_CODE = 124;
const OUTPUT_LIMIT_EXIT_CODE = 125;

class OutputLimitError extends Error {
  constructor(
    readonly streamName: "stdout" | "stderr",
    readonly partialOutput: string
  ) {
    super(`${streamName} exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit`);
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  streamName: "stdout" | "stderr"
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let output = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
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

function signalProcess(
  proc: ReturnType<typeof Bun.spawn>,
  signal: NodeJS.Signals,
  processGroup = false
): void {
  if (processGroup && process.platform !== "win32") {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // The child may have exited between the timer and signal delivery.
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // Signalling an already-exited process is harmless.
  }
}

function forceKillAfterGrace(
  proc: ReturnType<typeof Bun.spawn>,
  processGroup = false
): ReturnType<typeof setTimeout> {
  signalProcess(proc, "SIGTERM", processGroup);
  return setTimeout(
    () => signalProcess(proc, "SIGKILL", processGroup),
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

  let timedOut = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    forceKillTimer = forceKillAfterGrace(proc, useProcessGroup);
  }, timeoutMs);

  const capture = async (
    stream: ReadableStream<Uint8Array>,
    streamName: "stdout" | "stderr"
  ): Promise<{ value?: string; error?: unknown }> => {
    try {
      return { value: await readBounded(stream, streamName) };
    } catch (error) {
      signalProcess(proc, "SIGKILL", useProcessGroup);
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

    return {
      stdout: stdoutResult.value ?? "",
      stderr: timedOut
        ? `${stderrResult.value ?? ""}Error: agent timed out after ${timeoutMs}ms\n`
        : stderrResult.value ?? "",
      exitCode: timedOut ? TIMEOUT_EXIT_CODE : exitCode,
      success: !timedOut && exitCode === 0,
    };
  } finally {
    clearTimeout(timeoutTimer);
    // The process-group leader may exit on SIGTERM while a descendant ignores
    // it and closes the captured pipes. Kill the group once more before
    // cancelling the grace timer so that descendant cannot escape the timeout.
    if (timedOut) signalProcess(proc, "SIGKILL", useProcessGroup);
    if (forceKillTimer) clearTimeout(forceKillTimer);
  }
}

/**
 * Wait for a spawned interactive process, shielding it from signals that would
 * otherwise propagate through the process group and kill grandchildren (e.g. a
 * Playwright browser).
 *
 * - SIGINT: swallowed in parent (child receives it from the terminal via the
 *   shared process group). Rapid triple-SIGINT forces a SIGTERM to the child.
 * - SIGTERM/SIGHUP: forwarded to child only (proc.kill), not broadcast.
 */
export async function guardedWait(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs?: number
): Promise<number> {
  if (timeoutMs !== undefined) validateTimeout(timeoutMs);
  let sigintCount = 0;
  let sigintTimer: ReturnType<typeof setTimeout> | null = null;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  const onSigint = () => {
    sigintCount++;
    if (sigintCount >= 3) {
      forceKillTimer ??= forceKillAfterGrace(proc);
      return;
    }
    if (sigintTimer) clearTimeout(sigintTimer);
    sigintTimer = setTimeout(() => {
      sigintCount = 0;
    }, SIGNAL_BURST_WINDOW_MS);
  };
  const onSigterm = () => {
    forceKillTimer ??= forceKillAfterGrace(proc);
  };
  const onSighup = () => {
    forceKillTimer ??= forceKillAfterGrace(proc);
  };

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);

  if (timeoutMs !== undefined) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      forceKillTimer ??= forceKillAfterGrace(proc);
    }, timeoutMs);
  }

  try {
    const exitCode = await proc.exited;
    return timedOut ? TIMEOUT_EXIT_CODE : exitCode;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("SIGHUP", onSighup);
    if (sigintTimer) clearTimeout(sigintTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
  }
}

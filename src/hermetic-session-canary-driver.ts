/**
 * The child driver of the hermetic session canary (lane H4): starts one
 * codemux session CLI child, speaks the codemux-live-session/1 JSONL
 * grammar to it (the user frame with the question, the shutdown frame
 * after the first turn_completed), captures the events the canary's
 * verdicts read — session id, private home, assistant text, rejection
 * reason, completion, end reason — and bounds the whole exchange by a
 * wall deadline that kills the child tree. Split from
 * src/hermetic-session-canary.ts at the 500-line cap; the canary's
 * three-session verdicts and cleanup live there.
 */

import { join } from "node:path";
import { FORCE_KILL_DELAY_MS, signalProcess } from "./process-runner.js";
import { createTerminationTarget } from "./process-tree.js";

const ROOT = join(import.meta.dir, "..");

/** The codemux the canary's sessions run: this checkout's own entry
 * point through the running bun, the same invocation the machine
 * check's spend probe uses (src/doctor-spend.ts), so a check started
 * from any cwd drives this build's session CLI, never whatever codemux
 * sits on PATH. The object is the seam the tests point at a fake. */
export const sessionCanaryCommand = (): string[] => [
  process.execPath,
  "--no-env-file",
  "--no-install",
  `--config=${join(ROOT, "bunfig.runtime.toml")}`,
  join(ROOT, "src", "index.ts"),
];
export const sessionCanary = { command: sessionCanaryCommand };

export interface SessionRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when the canary stopped the child itself (deadline). */
  stopped: boolean;
  /** A protocol-level failure message, before any verdict is tried. */
  failure: string | null;
  sessionId?: string;
  privateHome?: string;
  assistantText: string;
  rejection?: string;
  completed: boolean;
  ended?: { reason: unknown; exitCode: unknown };
}

const SESSION_OUTPUT_LIMIT = 512 * 1024;
const SESSION_STDERR_LIMIT = 8 * 1024;
/** Wall allowance past the child's own --timeout before the canary kills
 * the session: the session's end path (shutdown frame, drain, exit)
 * needs room the turn itself did not spend. */
export const SESSION_KILL_GRACE_MS = 30_000;

/** A shared no-op for the fire-and-forget rejections a killed child's
 * streams produce; one function, not one closure per call site. */
const swallow = (): void => {};

/** Drives one codemux session child. The session's own --timeout covers
 * the turn; this wall deadline covers the child. */
export async function runCanarySession(
  argv: string[],
  env: NodeJS.ProcessEnv,
  prompt: string,
  timeoutMs: number,
  killGraceMs: number
): Promise<SessionRun> {
  const run: SessionRun = {
    exitCode: null, stdout: "", stderr: "", stopped: false, failure: null,
    assistantText: "", completed: false,
  };
  let proc;
  try {
    proc = Bun.spawn([...sessionCanary.command(), ...argv], {
      cwd: process.cwd(),
      env: env as Record<string, string | undefined>,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    run.failure = `the codemux session child could not start (${reason})`;
    return run;
  }
  const target = createTerminationTarget(proc, true);
  const timers: ReturnType<typeof setTimeout>[] = [];
  const stop = (): void => {
    if (run.stopped) return;
    run.stopped = true;
    run.failure = "the session ran past its deadline and was stopped";
    signalProcess(target, "SIGTERM", "tree");
    timers.push(setTimeout(() => signalProcess(target, "SIGKILL", "tree"), FORCE_KILL_DELAY_MS));
  };
  timers.push(setTimeout(stop, timeoutMs + killGraceMs));

  let shutdownSent = false;
  const sendShutdown = (): void => {
    if (shutdownSent) return;
    shutdownSent = true;
    try {
      proc.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      void Promise.resolve(proc.stdin.end()).catch(swallow);
    } catch {
      // A child that closed stdin is judged by its exit, not here.
    }
  };

  const stdoutDecoder = new TextDecoder();
  let stdoutHeld = "";
  let stdoutPending = "";
  const onLine = (line: string): void => {
    if (line.trim() === "") return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (event["type"]) {
      case "session_started":
        if (typeof event["session_id"] === "string" && run.sessionId === undefined) {
          run.sessionId = event["session_id"];
        }
        if (typeof event["private_home"] === "string" && run.privateHome === undefined) {
          run.privateHome = event["private_home"];
        }
        return;
      case "assistant_message":
        if (typeof event["text"] === "string") run.assistantText += event["text"];
        return;
      case "input_rejected":
        if (run.rejection === undefined) run.rejection = String(event["reason"] ?? "unknown reason");
        return;
      case "turn_completed":
        run.completed = true;
        sendShutdown();
        return;
      case "session_ended":
        if (run.ended === undefined) {
          run.ended = { reason: event["reason"], exitCode: event["exit_code"] };
        }
        return;
    }
  };
  const drainStdout = (async () => {
    const reader = proc.stdout.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = stdoutDecoder.decode(value, { stream: true });
        if (stdoutHeld.length < SESSION_OUTPUT_LIMIT) {
          stdoutHeld = (stdoutHeld + text).slice(0, SESSION_OUTPUT_LIMIT);
        }
        stdoutPending += text;
        for (;;) {
          const newline = stdoutPending.indexOf("\n");
          if (newline === -1) break;
          const line = stdoutPending.slice(0, newline);
          stdoutPending = stdoutPending.slice(newline + 1);
          onLine(line);
        }
      }
      if (stdoutPending.trim() !== "") onLine(stdoutPending);
    } finally {
      run.stdout = stdoutHeld;
      reader.releaseLock();
    }
  })();
  const drainStderr = (async () => {
    const decoder = new TextDecoder();
    const reader = proc.stderr.getReader();
    let held = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (held.length < SESSION_STDERR_LIMIT) {
          held = (held + decoder.decode(value, { stream: true })).slice(0, SESSION_STDERR_LIMIT);
        }
      }
    } finally {
      run.stderr = held;
      reader.releaseLock();
    }
  })();

  try {
    proc.stdin.write(`${JSON.stringify({ type: "user", text: prompt })}\n`);
  } catch {
    // Judged by the exit: a child that closed stdin before the question.
  }
  const giveUp = new Promise<null>((resolve) => {
    timers.push(setTimeout(() => resolve(null), timeoutMs + killGraceMs + FORCE_KILL_DELAY_MS + 5_000));
  });
  run.exitCode = await Promise.race([proc.exited, giveUp]);
  for (const timer of timers) clearTimeout(timer);
  if (run.exitCode === null) {
    signalProcess(target, "SIGKILL", "tree");
  }
  await Promise.allSettled([drainStdout, drainStderr]);
  void proc.stdout.cancel().catch(swallow);
  void proc.stderr.cancel().catch(swallow);
  return run;
}

/**
 * The child driver of the hermetic session canary (lane H4): starts one
 * codemux session CLI child, speaks the codemux-live-session/1 JSONL
 * grammar to it (the user frame with the question, the shutdown frame
 * after the first turn_completed), captures the events the canary's
 * verdicts read — session id, private home, assistant text, rejection
 * reason, completion, end reason — and bounds the whole exchange by a
 * wall deadline that kills the child tree. Split from
 * src/hermetic-session-canary.ts at the 500-line cap; the canary's
 * session verdicts and cleanup live there and in hermetic-session-canary-home.ts.
 */

import { claudeCredentialTarget } from "./credentials.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { FORCE_KILL_DELAY_MS, signalProcess } from "./process-runner.js";
import { createTerminationTarget } from "./process-tree.js";
import { StreamMarkerScan } from "./stream-marker-scan.js";

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
/** The seams the tests point elsewhere: the codemux command the canary
 * drives, and the Claude credential mirror the claude control copies
 * (src/hermetic-session-canary.ts). The test preload points the mirror at
 * a scratch path, so no in-process test reads the operator's real login. */
export const sessionCanaryCredentialSource = (): string => claudeCredentialTarget(process.env.HOME || homedir());
export const sessionCanary = {
  command: sessionCanaryCommand,
  credentialSource: sessionCanaryCredentialSource,
};

export interface SessionRun {
  exitCode: number | null;
  stdout: string;
  /** Marker evidence from the entire stream, including the discarded suffix. */
  markerEvidence?: string;
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

/** Protocol failures precede any judgment of model context or home state. */
export function canarySessionProtocolProblem(run: SessionRun, label: string): string | null {
  const where = `the ${label}`;
  if (run.failure !== null) {
    return `${where} failed: ${run.failure}` +
      (run.rejection === undefined ? "" : ` (input rejected: ${run.rejection})`);
  }
  if (run.exitCode !== 0) return `${where} exited ${run.exitCode ?? "without an exit status"}`;
  if (run.sessionId === undefined) return `${where} printed no session_started event naming its session id`;
  if (!run.completed) {
    return `${where} ended without completing the turn` +
      (run.rejection === undefined ? "" : ` (input rejected: ${run.rejection})`);
  }
  if (run.ended === undefined) return `${where} exited without a session_ended event`;
  if (run.ended.reason !== "shutdown") return `${where} ended with reason '${String(run.ended.reason)}', not 'shutdown'`;
  if (run.ended.exitCode !== 0) return `${where} ended with exit_code '${String(run.ended.exitCode)}', not 0`;
  return null;
}

const SESSION_OUTPUT_LIMIT = 512 * 1024;
const SESSION_STDERR_LIMIT = 8 * 1024;
export const SESSION_DRAIN_GRACE_MS = 1_000;
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
  const markerScan = new StreamMarkerScan();
  const stdoutReader = proc.stdout.getReader();
  const stderrReader = proc.stderr.getReader();
  let stdoutHeld = "";
  let stderrHeld = "";
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
    const reader = stdoutReader;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = stdoutDecoder.decode(value, { stream: true });
        markerScan.push(text);
        run.markerEvidence = markerScan.evidence();
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
    const reader = stderrReader;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (stderrHeld.length < SESSION_STDERR_LIMIT) {
          stderrHeld = (stderrHeld + decoder.decode(value, { stream: true })).slice(0, SESSION_STDERR_LIMIT);
        }
      }
    } finally {
      run.stderr = stderrHeld;
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
  if (run.exitCode === null || run.stopped) {
    signalProcess(target, "SIGKILL", "tree");
  }
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const drained = await Promise.race([
    Promise.allSettled([drainStdout, drainStderr]).then(() => true),
    new Promise<false>((resolve) => {
      drainTimer = setTimeout(() => resolve(false), SESSION_DRAIN_GRACE_MS);
    }),
  ]);
  clearTimeout(drainTimer);
  if (!drained) {
    run.failure ??= "the session output pipes remained open after exit";
    signalProcess(target, "SIGKILL", "tree");
    // Cancel the locked readers, not the streams. Never await a descendant's EOF.
    void stdoutReader.cancel().catch(swallow);
    void stderrReader.cancel().catch(swallow);
  }
  run.stdout = stdoutHeld;
  run.stderr = stderrHeld;
  return run;
}

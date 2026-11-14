// The probe runner for the live gate. Kept separate from
// scripts/live-gate.ts (the entry hub) so no module in scripts/live-gate/
// imports the hub back: a static cycle there deadlocks bun's loader when the
// hub is the entry file.

import { appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { FORCE_KILL_DELAY_MS, PIPE_GIVE_UP_MS, signalProcess } from "../../src/process-runner.js";
import { createTerminationTarget, waitForDescendantsGrace, type TerminationTarget } from "../../src/process-tree.js";
import { providerQuotaRefusal } from "./quota.js";

const STDERR_LIMIT = 160;
const DIAGNOSTIC_LINE_LIMIT = 4096;
const STDOUT_LIMIT = 80;
const CAPTURE_LIMIT = 512 * 1024;
const ROOT = resolve(import.meta.dir, "../..");
export const DEFAULT_CODEMUX = join(ROOT, "bin/codemux");

/** This checkout's own launcher: when --codemux names it, discovery and
 * capabilities may come from the in-process adapter registry (the
 * checkout and the build are the same code). Any other path is a
 * candidate and answers `list --json` instead (candidate.ts). */
export function isDefaultCodemux(codemux: string): boolean {
  return codemux === DEFAULT_CODEMUX;
}

export interface ProbeResult {
  status: "PASS" | "FAIL" | "SKIP" | "UNSUPPORTED";
  seconds: number;
  stderr: string;
  note?: string;
  /** The last non-Warning stderr line's quota classification; null when
   * it was no refusal. Runner-built PASS results omit this field. */
  quotaRefusal?: string | null;
}

export interface CapturedOutput {
  exit: number | null;
  stdout: string;
}

export type Verifier = (captured: CapturedOutput) => string | null;

export function escapeControls(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => {
    if (character === "\t") return "\\t";
    if (character === "\r") return "\\r";
    return `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`;
  });
}

// Banner lines stay discarded; Warning: lines are kept in the row's note so a
// stale-contract warning can no longer hide behind a PASS (audit finding 4).
// Every completed line is classified on its own, whatever came before it:
// once an ordinary line was stored, a later Warning: used to be dropped
// (review round 5, edges finding 5). Warnings are capped so a chatty
// harness cannot grow the note without bound.
const STDERR_WARNING_CAP = 3;

/** A stdin end or a reader cancel that fails after the child is gone never
 * fails the probe itself: every rejection the runner can outlive lands on
 * this no-op handler (round 11, edges 10). */
const ignoreRejection = (): void => {};

/** Streams one probe output to its consumer and, when a path is given, to
 * the report file — at most CAPTURE_LIMIT bytes of it: a noisy or broken
 * harness must not be able to exhaust the disk under a probe that is
 * still inside its timeout (review round 286). Returns whether the file
 * write dropped bytes. */
async function drain(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  consume: (chunk: string) => void,
  path?: string,
): Promise<boolean> {
  const decoder = new TextDecoder();
  let written = 0;
  let fileTruncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (path && !fileTruncated) {
        const room = CAPTURE_LIMIT - written;
        if (value.length <= room) {
          appendFileSync(path, value);
          written += value.length;
        } else {
          if (room > 0) appendFileSync(path, value.subarray(0, room));
          fileTruncated = true;
        }
      }
      consume(decoder.decode(value, { stream: true }));
    }
    consume(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return fileTruncated;
}

/** A scripted stdin exchange for a probe whose child must keep reading
 * while it works: `open` is written once at spawn, stdin stays open, and
 * `next` is called with each completed stdout line. The bytes `next`
 * returns are written and stdin is then ended — that answer is the
 * exchange's last frame; null writes nothing and keeps the pipe open. The
 * fixed `stdin` string closes stdin at once, which a session driver reads
 * as EOF and answers by draining the session (docs/sessions.md, "End
 * conditions and failures") instead of running the turn at all. */
export interface StdinScript {
  open: string;
  next(line: string): string | null;
}

interface ProbeExecution {
  expected?: string;
  verify?: Verifier;
  stdin?: string | StdinScript;
  /** Extra environment for this probe alone (the loopback probes' override
   * variables), merged over the runner's own. */
  env?: Record<string, string>;
  /** A probe whose proof is not the child's exit status (the loopback
   * fake's request log is): any exit reaches the verifier, which sees the
   * exit itself and decides. */
  allowAnyExit?: boolean;
}

export class ProbeRunner {
  private readonly active = new Map<TerminationTarget, (reason: string) => void>();
  interrupted: NodeJS.Signals | undefined;

  interrupt(signal: NodeJS.Signals): void {
    const repeated = this.interrupted !== undefined;
    this.interrupted ??= signal;
    for (const [target, stop] of this.active) {
      stop("interrupted");
      if (repeated) signalProcess(target, "SIGKILL", "tree");
    }
  }

  /** Exact-output probe: trimmed stdout must equal `expected` and the exit
   * must be 0. Keeps the bounded streaming compare so a runaway reply never
   * lands in memory. */
  run(command: string[], expected: string, timeout: number, outputPath?: string, stdin?: string | StdinScript): Promise<ProbeResult> {
    return this.execute(command, { expected, timeout, outputPath, stdin });
  }

  /** Structural probe: the verifier decides over the captured stdout; the
   * exit must still be 0 unless `extra.allowAnyExit` moves the whole
   * judgment to the verifier. Full stdout is bounded at CAPTURE_LIMIT. */
  capture(command: string[], verify: Verifier, timeout: number, outputPath?: string, stdin?: string | StdinScript, extra: { env?: Record<string, string>; allowAnyExit?: boolean } = {}): Promise<ProbeResult> {
    return this.execute(command, { verify, timeout, outputPath, stdin, ...extra });
  }

  private async execute(command: string[], execution: ProbeExecution & { timeout: number; outputPath?: string }): Promise<ProbeResult> {
    const { expected, verify, stdin, timeout, outputPath, env, allowAnyExit } = execution;
    const start = performance.now();
    let quotaRefusal: string | null = null;
    const failed = (stderr: string, note?: string): ProbeResult => ({
      status: "FAIL", seconds: (performance.now() - start) / 1000, stderr, ...(note === undefined ? {} : { note }),
      quotaRefusal,
    });
    const warnings: string[] = [];
    const stdoutPath = outputPath && `${outputPath}.out`;
    const stderrPath = outputPath && `${outputPath}.err`;
    if (stdoutPath) writeFileSync(stdoutPath, "");
    if (stderrPath) writeFileSync(stderrPath, "");
    if (this.interrupted) return failed("interrupted before probe started");
    let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      proc = Bun.spawn(command, {
        cwd: ROOT, stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe", detached: true,
        // No `env` key inherits this process's environment; a probe with
        // its own variables gets them merged over that, never a stripped
        // environment (the probes are codemux runs, which need PATH).
        ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
      });
    } catch {
      return failed("could not start the probe command");
    }
    // The probe is registered in `active` BEFORE its stdin write (review
    // round 13, edges 4): the write is the one await between spawn and
    // registration, and an interrupt inside it could not stop the child
    // it arrived for — the child ran on to completion or its own
    // timeout. Everything `stop` touches is initialized above the write,
    // so a stop fired mid-write is safe.
    let reason = "";
    let deadline = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
    let giveUpExit: () => void = () => {};
    const abandonedExit = new Promise<void>((done) => { giveUpExit = done; });
    const target = createTerminationTarget(proc, true);
    const stdoutReader = proc.stdout.getReader();
    const stderrReader = proc.stderr.getReader();
    const stop = (message: string): void => {
      if (reason) return;
      reason = message;
      deadline = performance.now() + FORCE_KILL_DELAY_MS;
      killTimer = setTimeout(() => signalProcess(target, "SIGKILL", "tree"), FORCE_KILL_DELAY_MS);
      giveUpTimer = setTimeout(() => {
        void stdoutReader.cancel().catch(ignoreRejection);
        void stderrReader.cancel().catch(ignoreRejection);
        giveUpExit();
      }, FORCE_KILL_DELAY_MS + PIPE_GIVE_UP_MS);
      signalProcess(target, "SIGTERM", "tree");
    };
    this.active.set(target, stop);
    // The deadline is armed BEFORE any stdin write: a child that never
    // reads its stdin, or fills stdout while this side still writes, must
    // still die at the probe's timeout (round 31, edges 2).
    const timeoutTimer = setTimeout(() => stop("timeout"), timeout * 1000);
    const script = typeof stdin === "string" ? undefined : stdin;
    if (typeof stdin === "string") {
      // A child that already closed or exited before the write lands
      // throws here (EPIPE); the probe is still judged by its exit code
      // and output, never by this write, so the failure is contained
      // instead of rejecting the whole probe with a generic error
      // (review round 11, edges 10). The end is not awaited: the drain
      // below reads stdout while the bytes flush.
      try {
        proc.stdin.write(stdin);
        void Promise.resolve(proc.stdin.end()).catch(ignoreRejection);
      } catch {
        // The stdin bytes did not land; the run proceeds.
      }
    } else if (stdin !== undefined) {
      // A script opens with its first frame and keeps the pipe open; its
      // last frame ends it, so an EPIPE here is contained the same way.
      try {
        proc.stdin.write(stdin.open);
      } catch {
        // The stdin bytes did not land; the run proceeds.
      }
    }
    // An interrupt that arrived during the write already stopped the
    // child through the registration above; one that arrived before it
    // (between the pre-spawn check and the registration, or before
    // interrupt() saw this target) is caught here. `stop` is idempotent,
    // so the second call is the no-op.
    if (this.interrupted) stop("interrupted");

    // Keep a bounded preview while writing the response to the report
    // file, capped at CAPTURE_LIMIT bytes (review round 286).
    let output = "";
    let captured = "";
    let truncated = false;
    let preview = "";
    let mismatch = false;
    let trailingWhitespace = false;
    // The script answers completed stdout lines: a line still missing its
    // newline waits, exactly like the child's own line grammar. A write
    // after the child closed stdin is contained the same way as the open
    // write — the probe is judged by the captured output, never by it.
    let scriptPending = "";
    const feedScript = (chunk: string): void => {
      scriptPending += chunk;
      for (;;) {
        const newline = scriptPending.indexOf("\n");
        if (newline === -1) break;
        const line = scriptPending.slice(0, newline);
        scriptPending = scriptPending.slice(newline + 1);
        const answer = script?.next(line);
        if (answer === null || answer === undefined) continue;
        try {
          proc.stdin.write(answer);
          // A last frame that never landed never fails the probe.
          Promise.resolve(proc.stdin.end()).catch(ignoreRejection);
        } catch {
          // The last frame did not land; the run proceeds.
        }
      }
    };
    const stdout = drain(stdoutReader, (chunk) => {
      if (script !== undefined) feedScript(chunk);
      preview += chunk.slice(0, STDOUT_LIMIT - preview.length);
      if (expected === undefined) {
        // Truncated only when a chunk actually dropped bytes (review
        // round 4, edges finding 5): a reply that ended exactly at the
        // limit is complete, not a prefix.
        if (captured.length < CAPTURE_LIMIT) {
          const room = CAPTURE_LIMIT - captured.length;
          captured += chunk.slice(0, room);
          if (chunk.length > room) truncated = true;
        } else if (chunk.length > 0) {
          truncated = true;
        }
        return;
      }
      for (const character of chunk) {
        if (mismatch) break;
        if (character.trim() === "") {
          if (output) trailingWhitespace = true;
        } else if (trailingWhitespace || character !== expected[output.length]) {
          mismatch = true;
        } else {
          output += character;
        }
      }
    }, stdoutPath);
    let stderr = "";
    let pendingLine = "";
    const finishLine = (): void => {
      const line = pendingLine;
      pendingLine = "";
      const trimmed = line.trim();
      if (trimmed === "" || /^Running with/.test(trimmed)) return;
      // Only the last non-Warning stderr line decides: a refusal followed
      // by unrelated output is a behavior failure, not an account state.
      if (!/^Warning:/i.test(trimmed)) quotaRefusal = providerQuotaRefusal(trimmed);
      if (/^Warning:/.test(trimmed)) {
        if (warnings.length < STDERR_WARNING_CAP) warnings.push(escapeControls(trimmed).slice(0, STDERR_LIMIT));
      } else if (!stderr) {
        stderr = escapeControls(trimmed).slice(0, STDERR_LIMIT);
      }
    };
    const errors = drain(stderrReader, (chunk) => {
      for (const character of chunk) {
        if (character === "\n") {
          finishLine();
        } else if (pendingLine.length < DIAGNOSTIC_LINE_LIMIT && (pendingLine || character.trim())) {
          pendingLine += character;
        }
      }
    }, stderrPath);
    try {
      const [exit, stdoutFileTruncated, stderrFileTruncated] = await Promise.all([
        Promise.race([proc.exited, abandonedExit]), stdout, errors,
      ]);
      finishLine();
      const note = [
        ...warnings,
        ...(truncated ? [`stdout truncated at ${CAPTURE_LIMIT} characters`] : []),
        ...(stdoutFileTruncated ? [`stdout report file truncated at ${CAPTURE_LIMIT} bytes`] : []),
        ...(stderrFileTruncated ? [`stderr report file truncated at ${CAPTURE_LIMIT} bytes`] : []),
      ].join("; ");
      if (reason) return failed(reason, note);
      if (expected !== undefined) {
        const passed = exit === 0 && !mismatch && output === expected;
        return passed
          ? { status: "PASS", seconds: (performance.now() - start) / 1000, stderr: "", ...(note === "" ? {} : { note }) }
          : failed(reason || stderr || `exit ${exit ?? "without a status"}${preview ? `; stdout: ${escapeControls(preview)}` : ""}`, note === "" ? undefined : note);
      }
      // A capture that dropped bytes is a FAIL (review round 4, edges
      // finding 5): the verifier judged a prefix, so a PASS here could
      // mean the proof simply sat beyond the limit. The report file keeps
      // the first CAPTURE_LIMIT bytes (drain caps its appends).
      if (truncated) {
        return failed("stdout exceeded the capture limit; the verifier saw a prefix only", note === "" ? undefined : note);
      }
      const verifierFailure = exit === 0 || allowAnyExit === true ? verify?.({ exit: exit ?? null, stdout: captured }) ?? null : null;
      const passed = (exit === 0 || allowAnyExit === true) && verifierFailure === null;
      return passed
        ? { status: "PASS", seconds: (performance.now() - start) / 1000, stderr: "", ...(note === "" ? {} : { note }) }
        : failed(verifierFailure || stderr || `exit ${exit ?? "without a status"}${preview ? `; stdout: ${escapeControls(preview)}` : ""}`, note === "" ? undefined : note);
    } catch {
      stop("could not capture probe output");
      void stdoutReader.cancel().catch(ignoreRejection);
      void stderrReader.cancel().catch(ignoreRejection);
      await Promise.race([proc.exited, abandonedExit]).catch(ignoreRejection);
      finishLine();
      return failed(reason || stderr, warnings[0]);
    } finally {
      // A script whose last frame never fired (the child exited before any
      // line matched) leaves the write end open; close it so nothing
      // dangles past the probe. An already-ended sink is a no-op; a
      // rejection is ignored like every other the runner outlives.
      if (script !== undefined) {
        try {
          Promise.resolve(proc.stdin.end()).catch(ignoreRejection);
        } catch {
          // Already closed; nothing to do.
        }
      }
      clearTimeout(timeoutTimer);
      if (reason) {
        await waitForDescendantsGrace(target, deadline);
        signalProcess(target, "SIGKILL", "tree");
      }
      clearTimeout(killTimer);
      clearTimeout(giveUpTimer);
      this.active.delete(target);
    }
  }
}

export async function runPool(tasks: (() => Promise<void>)[], jobs: number): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, async () => {
    while (next < tasks.length) await tasks[next++]!();
  }));
}

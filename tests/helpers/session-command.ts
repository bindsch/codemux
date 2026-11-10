/**
 * The in-process harness for `codemux session` command tests: drives
 * registerSessionCommand through commander inside the coverage process,
 * with `process.exit` throwing a sentinel that carries its code (a 64
 * exit throws a UsageRefusalError-shaped sentinel so the action's own
 * catch re-exits 64, matching the CLI's contract), the session registry
 * path mocked at a per-run temp file (the real path lives under the
 * operator's home, which an in-process run must never write), and the
 * fake-harness PATH from tests/helpers/cli.ts.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { Command } from "commander";
import { spyOn } from "bun:test";
import { getDefaultConfig } from "../../src/config.js";
import { UsageRefusalError } from "../../src/validation.js";
import { registerSessionCommand } from "../../src/session/cli.js";
import * as registryModule from "../../src/session/registry.js";
import { resetQuotaGateState } from "../../src/quota-gate.js";
import { createFakeBinaryEnv } from "./cli.js";

export class ExitSentinel extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

/** A 64 exit re-thrown as a usage refusal, so the action's catch maps it
 * back to 64 (unexpectedErrorExitCode) instead of swallowing it as 1. */
export class UsageExitSentinel extends UsageRefusalError {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

export const exitSentinelCode = (thrown: unknown): number | null =>
  thrown instanceof ExitSentinel || thrown instanceof UsageExitSentinel
    ? thrown.code
    : null;

export interface SessionOutcome {
  stdout: string;
  stderr: string;
  warnings: string[];
  /** Every code passed to process.exit, in call order: an exit the
   * action's own catch re-exits (a direct 66 or 78, a clean 0) keeps its
   * original code here, while `exitCode` holds the final one. */
  exitCalls: number[];
  exitCode: number | undefined;
}

export interface SessionRunOptions {
  /** The registry file the command reads and writes (default: a fresh
   * temp file). The parent directory is created; seed it with
   * seedRegistry for resume tests. */
  registryFile?: string;
  /** Swapped in as process.stdin for the action's lifetime. */
  stdin?: PassThrough;
  /** Runs the real quota gate (deletes CODEMUX_TEST_NO_QUOTA_GATE). */
  quotaGate?: boolean;
  /** Applied to process.env for the action's lifetime. */
  env?: Record<string, string | undefined>;
  /** Extra mocks to install (each receives the run's teardown). */
  setup?: () => () => void;
  /** Runs while the action is in flight: receives the captured stdout
   * chunks and the swapped stdin, so a drive test can wait for events
   * and write the next input before the action resolves. */
  drive?: (handles: { chunks: string[]; stdin: PassThrough }) => Promise<void>;
}

export async function runSessionCommand(
  args: string[],
  binaries: Record<string, string> = {},
  options: SessionRunOptions = {}
): Promise<SessionOutcome> {
  const fake = createFakeBinaryEnv(binaries);
  const registryFile =
    options.registryFile ?? join(mkdtempSync(join(tmpdir(), "codemux-session-reg-")), "live-sessions.json");
  mkdirSync(dirname(registryFile), { recursive: true, mode: 0o700 });
  const program = new Command();
  program.exitOverride();
  registerSessionCommand(program, getDefaultConfig(), () => {});
  const stderrLines: string[] = [];
  const warnings: string[] = [];
  const stdoutChunks: string[] = [];
  const exitCalls: number[] = [];
  const originalEnv = { ...process.env };
  const originalExitCode = process.exitCode;
  const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
  const error = spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    stderrLines.push(values.map(String).join(" "));
  });
  const warn = spyOn(console, "warn").mockImplementation((...values: unknown[]) => {
    warnings.push(values.map(String).join(" "));
  });
  // The caller lane writes with the callback form and awaits it before
  // the next event (src/session/driver-io.ts defaultEventSink), so the
  // mock must flush: capture the chunk, then fire the callback on a
  // later tick the way a drained pipe does. A mock that only returns
  // true wedges the lane after the first event.
  const write = spyOn(process.stdout, "write").mockImplementation(((
    chunk: Uint8Array | string,
    callback?: (error: Error | null | undefined) => void
  ) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    if (typeof callback === "function") {
      queueMicrotask(() => callback(null));
    }
    return true;
  }) as typeof process.stdout.write);
  const exit = spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
    const resolved = typeof code === "number" ? code : 0;
    exitCalls.push(resolved);
    throw resolved === 64 ? new UsageExitSentinel(64) : new ExitSentinel(resolved);
  }) as typeof process.exit);
  const registryPath = spyOn(registryModule, "sessionRegistryPath").mockReturnValue(registryFile);
  // A real-gate run deletes the hermeticity variable for its lifetime;
  // the saved value (the preload's nonce) is restored in the finally so
  // later in-process tests keep the seam.
  const savedNoQuotaGate = process.env.CODEMUX_TEST_NO_QUOTA_GATE;
  if (options.quotaGate === true) {
    resetQuotaGateState();
    delete process.env.CODEMUX_TEST_NO_QUOTA_GATE;
  }
  const teardowns: Array<() => void> = [];
  process.env.PATH = fake.env.PATH;
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (options.stdin !== undefined) {
    Object.defineProperty(process, "stdin", { value: options.stdin, configurable: true });
  }
  if (options.setup !== undefined) teardowns.push(options.setup());
  const parse = program.parseAsync(["node", "codemux", "session", ...args]);
  // Mark the rejection handled while the drive callback polls, so an
  // early refusal does not log as unhandled before the await below.
  parse.catch(() => {});
  if (options.drive !== undefined) {
    await options.drive({ chunks: stdoutChunks, stdin: options.stdin ?? new PassThrough() });
  }
  try {
    await parse;
    const resolved = process.exitCode;
    return {
      stdout: stdoutChunks.join(""),
      stderr: stderrLines.join("\n"),
      warnings,
      exitCalls,
      exitCode: typeof resolved === "number" ? resolved : undefined,
    };
  } catch (thrown) {
    const code = exitSentinelCode(thrown);
    if (code !== null) {
      return { stdout: stdoutChunks.join(""), stderr: stderrLines.join("\n"), warnings, exitCalls, exitCode: code };
    }
    throw thrown;
  } finally {
    for (const teardown of teardowns.reverse()) teardown();
    if (options.stdin !== undefined && originalStdin !== undefined) {
      Object.defineProperty(process, "stdin", originalStdin);
    }
    if (options.quotaGate === true) process.env.CODEMUX_TEST_NO_QUOTA_GATE = savedNoQuotaGate;
    for (const name of new Set([...Object.keys(originalEnv), ...Object.keys(process.env)])) {
      const before = originalEnv[name];
      const now = process.env[name];
      if (before === undefined) delete process.env[name];
      else if (now !== before) process.env[name] = before;
    }
    // Bun does not clear a numeric exit code when assigned undefined.
    process.exitCode = originalExitCode ?? 0;
    error.mockRestore();
    warn.mockRestore();
    write.mockRestore();
    exit.mockRestore();
    registryPath.mockRestore();
    if (options.quotaGate === true) resetQuotaGateState();
    fake.cleanup();
  }
}

/** Parsed JSONL events from a finished session's stdout. Strict: a
 * malformed or truncated line throws, so corrupted output fails the test. */
export const outcomeEvents = (chunks: string[]): Record<string, unknown>[] =>
  chunks
    .join("")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/** The events a live session has printed so far, for drive polls. A poll can
 * land between two chunks of one event, so only newline-terminated lines
 * count; the unterminated tail is the write in flight and is read on the
 * next poll. Parse the finished stdout with outcomeEvents. */
export const polledEvents = (chunks: string[]): Record<string, unknown>[] => {
  const text = chunks.join("");
  return outcomeEvents([text.slice(0, text.lastIndexOf("\n") + 1)]);
};

export async function waitForEvent(
  chunks: string[],
  label: string,
  predicate: (event: Record<string, unknown>) => boolean,
  deadlineMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const found = polledEvents(chunks).find(predicate);
    if (found !== undefined) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${label}; saw: ${polledEvents(chunks).map((event) => event.type).join(",")}`
      );
    }
    await Bun.sleep(10);
  }
}

/** One ended session record, in the registry's own shape (the fields the
 * resume guards compare). `overrides` replace fields verbatim. */
export function claudeRecord(
  id: string,
  workdir: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    agent: "claude",
    created_at: "2026-10-04T10:00:00.000Z",
    last_activity: "2026-10-04T10:05:00.000Z",
    cwd: workdir,
    hermetic: false,
    project_settings: false,
    harness_home: join(homedir(), ".claude"),
    model: null,
    autonomy: "high",
    sandboxed: false,
    sandbox_trust: "standard",
    sandbox_no_net: false,
    sandbox_scrub_env: false,
    pass_env: [],
    playwright_mcp: false,
    owner_pid: 999999,
    owner_start: null,
    ended: "2026-10-04T10:05:00.000Z",
    ...overrides,
  };
}

export function seedRegistry(
  registryFile: string,
  sessions: Record<string, unknown>[],
): string {
  mkdirSync(dirname(registryFile), { recursive: true, mode: 0o700 });
  writeFileSync(registryFile, `${JSON.stringify({ version: 1, sessions })}\n`, { mode: 0o600 });
  return registryFile;
}

// Canonical: on macOS the temp root is a symlink (/var -> /private/var) and
// the session CLI records the canonical cwd, so a seeded registry record
// built from the raw path would never match the resumed cwd.
export const tempWorkdir = (label: string): string =>
  realpathSync(mkdtempSync(join(tmpdir(), `codemux-${label}-`)));

export const removeDir = (dir: string): void => {
  rmSync(dir, { recursive: true, force: true });
};

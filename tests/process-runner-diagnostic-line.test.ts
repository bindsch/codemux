/**
 * The timeout and signal diagnostics a captured run appends to the child's
 * stderr start on their own line (review round 265): a child whose last
 * stderr line had no newline used to share it with "Error: agent timed
 * out", merging two diagnostics into one line for line-oriented readers.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCapturedCommand } from "../src/process-runner.js";

test("a timeout diagnostic never shares the child's unterminated stderr line", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codemux-diag-line-"));
  try {
    const result = await runCapturedCommand(
      [process.execPath, "-e", "process.stderr.write('boom'); setTimeout(() => {}, 10000);"],
      { cwd, env: { PATH: process.env.PATH ?? "" }, timeoutMs: 300 }
    );
    expect(result.exitCode).toBe(124);
    expect(result.stderr.startsWith("boom\nError: agent timed out after 300ms\n")).toBe(true);
    // A terminated last line gains no blank line.
    const terminated = await runCapturedCommand(
      [process.execPath, "-e", "process.stderr.write('boom\\n'); setTimeout(() => {}, 10000);"],
      { cwd, env: { PATH: process.env.PATH ?? "" }, timeoutMs: 300 }
    );
    expect(terminated.stderr.startsWith("boom\nError: agent timed out after 300ms\n")).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 20_000);

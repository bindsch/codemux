/**
 * A credential store that is a FIFO never blocks the machine check (review
 * round 50): the reader opens only bounded regular files, so a FIFO at the
 * claude mirror path reads as unknown at once instead of waiting for a writer.
 * The open is non-blocking and every check runs on the descriptor (review
 * round 108), so a FIFO behind a symlink and an oversized store read the same
 * way, with no second lookup of the path between the check and the read.
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeLoginState, codexLoginState, kimiLoginState } from "../src/harness-health.js";

test("a FIFO at the claude mirror path is unknown and the read returns at once", () => {
  const home = mkdtempSync(join(tmpdir(), "codemux-doctor-fifo-"));
  try {
    mkdirSync(join(home, ".claude"));
    const fifo = join(home, ".claude", ".credentials.json");
    const made = Bun.spawnSync(["mkfifo", fifo]);
    if (made.exitCode !== 0) return; // no mkfifo here: nothing to prove
    const started = performance.now();
    const state = claudeLoginState(home);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(state.state).toBe("unknown");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a symlink to a FIFO at the kimi store is unknown and the read returns at once", () => {
  const home = mkdtempSync(join(tmpdir(), "codemux-doctor-fifo-"));
  try {
    mkdirSync(join(home, ".kimi-code", "credentials"), { recursive: true });
    const fifo = join(home, "pipe");
    const made = Bun.spawnSync(["mkfifo", fifo]);
    if (made.exitCode !== 0) return; // no mkfifo here: nothing to prove
    symlinkSync(fifo, join(home, ".kimi-code", "credentials", "kimi-code.json"));
    const started = performance.now();
    const state = kimiLoginState(home, {});
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(state.state).toBe("unknown");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a store over the size bound is unknown; a dangling link and a missing parent are no credential", () => {
  const home = mkdtempSync(join(tmpdir(), "codemux-doctor-fifo-"));
  try {
    expect(kimiLoginState(home, {}).state).toBe("no-credential");
    mkdirSync(join(home, ".kimi-code", "credentials"), { recursive: true });
    const store = join(home, ".kimi-code", "credentials", "kimi-code.json");
    symlinkSync(join(home, "absent"), store);
    expect(kimiLoginState(home, {}).state).toBe("no-credential");
    rmSync(store);
    writeFileSync(store, JSON.stringify({ refresh_token: "r", padding: "x".repeat(1_048_576) }));
    expect(kimiLoginState(home, {}).state).toBe("unknown");
    // A file where the store's directory should be is no credential either.
    writeFileSync(join(home, ".codex"), "");
    expect(codexLoginState(home, {}).state).toBe("no-credential");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

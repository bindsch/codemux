/**
 * A credential store that is a FIFO never blocks the machine check (review
 * round 50): the reader opens only bounded regular files, so a FIFO at the
 * claude mirror path reads as unknown at once instead of waiting for a writer.
 * The open is non-blocking and every check runs on the descriptor (review
 * round 108), so a FIFO behind a symlink and an oversized store read the same
 * way, with no second lookup of the path between the check and the read.
 */

import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agyLoginState,
  claudeLoginState,
  codexLoginState,
  copilotLoginState,
  geminiLoginState,
  gooseLoginState,
  kimiLoginState,
  zaiLoginState,
} from "../src/harness-health.js";

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

test("a store that exists but cannot be inspected is unknown, never a missing login (round 307)", () => {
  // A stat failure that is not absence — here a parent directory without
  // execute permission — used to read as no-credential for every store
  // checked by existence, so doctor prescribed a login for a store it
  // simply could not reach. The unreadable store is `unknown` now.
  const home = mkdtempSync(join(tmpdir(), "codemux-doctor-unreadable-"));
  try {
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(join(home, ".gemini", "oauth_creds.json"), "{}");
    writeFileSync(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "t");
    chmodSync(join(home, ".gemini"), 0o600);
    expect(geminiLoginState(home, {}).state).toBe("unknown");
    expect(agyLoginState(home, {}).state).toBe("unknown");
    // The store one level down, blocked on its own directory.
    chmodSync(join(home, ".gemini"), 0o755);
    chmodSync(join(home, ".gemini", "antigravity-cli"), 0o600);
    expect(agyLoginState(home, {}).state).toBe("unknown");
    chmodSync(join(home, ".gemini", "antigravity-cli"), 0o755);
    // Reachable again: the same store reads as a login.
    expect(geminiLoginState(home, {}).state).toBe("logged-in");
    expect(agyLoginState(home, {}).state).toBe("logged-in");

    mkdirSync(join(home, ".config", "goose"), { recursive: true });
    writeFileSync(join(home, ".config", "goose", "config.yaml"), "provider: x\n");
    chmodSync(join(home, ".config", "goose"), 0o600);
    expect(gooseLoginState(home, {}).state).toBe("unknown");
    chmodSync(join(home, ".config", "goose"), 0o755);

    mkdirSync(join(home, ".copilot"), { recursive: true });
    writeFileSync(join(home, ".copilot", "config.json"), "{}");
    chmodSync(join(home, ".copilot"), 0o600);
    expect(copilotLoginState(home, {}).state).toBe("unknown");
    chmodSync(join(home, ".copilot"), 0o755);

    writeFileSync(join(home, ".zai"), "k");
    chmodSync(home, 0o600);
    expect(zaiLoginState(home, {}).state).toBe("unknown");
    chmodSync(home, 0o755);
    // With the store reachable, an env key still wins over the file.
    expect(zaiLoginState(home, { ZAI_API_KEY: "k" }).state).toBe("logged-in");
    expect(zaiLoginState(home, {}).state).not.toBe("unknown");
  } finally {
    chmodSync(home, 0o755);
    rmSync(home, { recursive: true, force: true });
  }
});

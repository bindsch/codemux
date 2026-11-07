/**
 * A credential store that is a FIFO never blocks the machine check (review
 * round 50): the reader opens only bounded regular files, so a FIFO at the
 * claude mirror path reads as unknown at once instead of waiting for a writer.
 * The open is non-blocking and every check runs on the descriptor (review
 * round 108), so a FIFO behind a symlink and an oversized store read the same
 * way, with no second lookup of the path between the check and the read.
 */

import { expect, spyOn, test } from "bun:test";
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

test("a tokenless claude mirror is no credential even with a future expiry (round 331)", () => {
  const home = mkdtempSync(join(tmpdir(), "codemux-doctor-mirror-"));
  try {
    mkdirSync(join(home, ".claude"));
    const mirror = join(home, ".claude", ".credentials.json");
    const future = Date.now() + 3_600_000;
    // The stub shape Claude Code leaves once the Keychain owns the
    // credential, and a mirror missing the field outright: neither can
    // authenticate a sandboxed launch.
    writeFileSync(mirror, JSON.stringify({ claudeAiOauth: { accessToken: "", expiresAt: future } }));
    expect(claudeLoginState(home).state).toBe("no-credential");
    writeFileSync(mirror, JSON.stringify({ claudeAiOauth: { expiresAt: future } }));
    expect(claudeLoginState(home).state).toBe("no-credential");
    // A present token beside the future expiry is the working login, and
    // an expired one stays expired: presence never overrides the expiry.
    writeFileSync(mirror, JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token", expiresAt: future } }));
    expect(claudeLoginState(home).state).toBe("logged-in");
    writeFileSync(mirror, JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token", expiresAt: Date.now() - 1 } }));
    expect(claudeLoginState(home).state).toBe("expired");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("empty codex token strings are no credential (round 331)", () => {
  const home = mkdtempSync(join(tmpdir(), "codemux-doctor-codex-"));
  try {
    mkdirSync(join(home, ".codex"));
    const auth = join(home, ".codex", "auth.json");
    writeFileSync(auth, JSON.stringify({ tokens: { refresh_token: "" } }));
    expect(codexLoginState(home, {}).state).toBe("no-credential");
    writeFileSync(auth, JSON.stringify({ tokens: { access_token: "", refresh_token: "" } }));
    expect(codexLoginState(home, {}).state).toBe("no-credential");
    // A non-empty token field is still a login, empty ones beside it aside.
    writeFileSync(auth, JSON.stringify({ tokens: { access_token: "", refresh_token: "r" } }));
    expect(codexLoginState(home, {}).state).toBe("logged-in");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a linked or foreign-owned zai key file is no credential (round 331)", () => {
  if (process.platform === "win32") return;
  const home = mkdtempSync(join(tmpdir(), "codemux-doctor-zai-"));
  try {
    const target = join(home, "key");
    writeFileSync(target, "k", { mode: 0o600 });
    symlinkSync(target, join(home, ".zai"));
    // The launch path refuses a final symlink; so does the login read.
    expect(zaiLoginState(home, {}).state).toBe("no-credential");
    rmSync(join(home, ".zai"));
    writeFileSync(join(home, ".zai"), "k", { mode: 0o600 });
    // Ownership: the adapter requires the current user, so a key owned by
    // someone else is refused here too, without reading its value.
    const real = process.getuid!();
    const foreign = real === 12345 ? 12346 : 12345;
    const getuid = spyOn(process, "getuid").mockReturnValue(foreign);
    try {
      expect(zaiLoginState(home, {}).state).toBe("no-credential");
    } finally {
      getuid.mockRestore();
    }
    expect(zaiLoginState(home, {}).state).toBe("logged-in");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

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

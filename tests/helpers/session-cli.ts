/**
 * Shared fixtures for the session-cli test files (split out of
 * tests/session-cli.test.ts): the fake-harness environments, the
 * stdio-driven `codemux session` child, and the seeded claude record.
 * Helpers used by a single test file stay inline in that file.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeBinaryEnv } from "./cli.js";
import { sessionRegistryPath } from "../../src/session/registry.js";

export const FAKE = fileURLToPath(new URL("../fixtures/live/fake-claude-session.ts", import.meta.url));
export const FAKE_CODEX = fileURLToPath(new URL("../fixtures/live/fake-codex-app-server.ts", import.meta.url));
const FAKE_AGY = fileURLToPath(new URL("../fixtures/live/fake-agy-session.ts", import.meta.url));

/** The fake harness binary env: the named binary execs the
 * scenario-driven fake. A pinned `version` is answered by the wrapper
 * itself — the version probe's environment is allowlisted, so a
 * FAKE_VERSION variable would never reach it. */
function fakeHarnessEnv(
  binary: "claude" | "codex" | "agy" | "opencode" | "aider" | "kimi",
  script: string,
  extra: { version?: string; env?: Record<string, string> } = {}
): {
  env: Record<string, string>;
  stateDir: string;
  cleanup: () => void;
} {
  const preamble =
    extra.version === undefined
      ? ""
      : `if [ "$1" = "--version" ]; then printf '${extra.version}\\n'; exit 0; fi\n`;
  const fake = createFakeBinaryEnv({
    [binary]: `${preamble}exec bun '${script}' "$@"`,
  });
  const stateDir = mkdtempSync(join(tmpdir(), "session-cli-state-"));
  return {
    env: { ...fake.env, FAKE_STATE_DIR: stateDir, ...(extra.env ?? {}) },
    stateDir,
    cleanup: () => {
      fake.cleanup();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

export function fakeClaudeEnv(extra: { version?: string; env?: Record<string, string> } = {}) {
  return fakeHarnessEnv("claude", FAKE, extra);
}

export function fakeCodexEnv(extra: { version?: string; env?: Record<string, string> } = {}) {
  return fakeHarnessEnv("codex", FAKE_CODEX, extra);
}

export function fakeAgyEnv(extra: { version?: string; env?: Record<string, string> } = {}) {
  return fakeHarnessEnv("agy", FAKE_AGY, extra);
}

/** Seed a registry holding one ended claude record created at `autonomy`
 * in `workdir`, owned by a dead pid, so a `--resume` of `id` passes the
 * guard bundle. */
export function seedClaudeRecord(
  home: string,
  workdir: string,
  id: string,
  autonomy: "read-only" | "low" | "medium" | "high"
): string {
  const registryPath = sessionRegistryPath(home);
  mkdirSync(dirname(registryPath), { recursive: true, mode: 0o700 });
  writeFileSync(
    registryPath,
    `${JSON.stringify({
      version: 1,
      sessions: [
        {
          id,
          agent: "claude",
          created_at: "2026-10-04T10:00:00.000Z",
          last_activity: "2026-10-04T10:05:00.000Z",
          cwd: workdir,
          hermetic: false,
          harness_home: join(home, ".claude"),
          model: null,
          autonomy,
          sandboxed: false,
          sandbox_trust: "standard",
          sandbox_no_net: false,
          sandbox_scrub_env: false,
          pass_env: ["FAKE_CWD", "FAKE_STATE_DIR"],
          playwright_mcp: false,
          owner_pid: 999999,
          owner_start: null,
          ended: "2026-10-04T10:05:00.000Z",
        },
      ],
    })}\n`,
    { mode: 0o600 }
  );
  return registryPath;
}

const FAKE_OPENCODE = fileURLToPath(new URL("../fixtures/live/fake-opencode-run.ts", import.meta.url));
const FAKE_AIDER = fileURLToPath(new URL("../fixtures/live/fake-aider-run.ts", import.meta.url));
export const FAKE_KIMI = fileURLToPath(new URL("../fixtures/live/fake-kimi-run.ts", import.meta.url));

export function fakeOpenCodeEnv(extra: { version?: string; env?: Record<string, string> } = {}) {
  return fakeHarnessEnv("opencode", FAKE_OPENCODE, { version: "1.18.18", ...extra });
}

export function fakeAiderEnv(extra: { version?: string; env?: Record<string, string> } = {}) {
  return fakeHarnessEnv("aider", FAKE_AIDER, { version: "aider 0.86.2", ...extra });
}

export function fakeKimiEnv(extra: { version?: string; env?: Record<string, string> } = {}) {
  return fakeHarnessEnv("kimi", FAKE_KIMI, { version: "2.5.2", ...extra });
}

/** One `codemux session` child driven over stdio, with the parsed event
 * stream and helpers to wait and send (the happy-path shape, factored for
 * the turn-per-process agents). */
export async function driveSession(
  args: string[],
  env: Record<string, string>
): Promise<{
  events: Record<string, any>[];
  waitFor: (label: string, pred: (event: Record<string, any>) => boolean) => Promise<Record<string, any>>;
  send: (message: unknown) => void;
  exit: Promise<[number, void]>;
  proc: Bun.Subprocess;
}> {
  const proc = Bun.spawn([join(import.meta.dir, "..", "..", "bin", "codemux"), ...args], {
    cwd: join(import.meta.dir, "..", ".."),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env: { ...process.env, CODEMUX_NO_KEYCHAIN_SYNC: "1", ...env } as Record<string, string>,
  });
  const events: Record<string, any>[] = [];
  const stdoutDone = (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() !== "") events.push(JSON.parse(line) as Record<string, any>);
        newline = buffer.indexOf("\n");
      }
    }
  })();
  const waitFor = async (label: string, pred: (event: Record<string, any>) => boolean) => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const found = events.find(pred);
      if (found !== undefined) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${label}; saw: ${events.map((event) => event.type).join(",")}`
        );
      }
      await Bun.sleep(10);
    }
  };
  return {
    events,
    waitFor,
    send: (message: unknown) => {
      (proc.stdin as { write: (text: string) => unknown }).write(`${JSON.stringify(message)}\n`);
    },
    exit: Promise.all([proc.exited, stdoutDone]),
    proc,
  };
}


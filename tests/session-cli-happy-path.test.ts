/**
 * Deterministic happy paths through `codemux session` with fake harnesses
 * on PATH (split from tests/session-cli.test.ts), plus the recorded-home
 * and registry-path seams.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeFamilyHarnessHome } from "../src/session/cli.js";
import {
  driveSession,
  fakeAgyEnv,
  fakeAiderEnv,
  fakeClaudeEnv,
  fakeCodexEnv,
  fakeKimiEnv,
  fakeOpenCodeEnv,
} from "./helpers/session-cli.js";

describe("CLI - session happy path", () => {
  test("drives one turn over stdio and ends cleanly on shutdown", async () => {
    const fake = fakeClaudeEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    try {
      const proc = Bun.spawn(
        [
          join(import.meta.dir, "..", "bin", "codemux"),
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          // The launch environment is allowlisted; the fake's state
          // variables reach the harness only through the sanctioned
          // passthrough, which is exactly the seam under test here.
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          stdin: "pipe",
          env: {
            ...process.env,
            CODEMUX_NO_KEYCHAIN_SYNC: "1",
            HOME: isolatedHome,
            XDG_CONFIG_HOME: join(isolatedHome, ".config"),
            ...fake.env,
            FAKE_CWD: workdir,
          } as Record<string, string>,
        }
      );
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

      // The fake emits system/init per turn and nothing at spawn, so the
      // first user line is what produces session_started: send it before
      // waiting (the CLI relays stdin the moment the harness spawns, and
      // the driver must open the turn at the init frame).
      const stdin = proc.stdin;
      stdin.write(`${JSON.stringify({ type: "user", text: "scenario:basic hello" })}\n`);
      const started = await waitFor("session_started", (event) => event.type === "session_started");
      expect(started.agent).toBe("claude");
      expect(started.autonomy).toBe("high");
      expect(started.protocol).toBe("codemux-live-session/1");
      expect(typeof started.session_id).toBe("string");

      const echo = await waitFor("user_message", (event) => event.type === "user_message");
      expect(echo.text).toBe("scenario:basic hello");
      const completed = await waitFor("turn_completed", (event) => event.type === "turn_completed");
      expect(completed.finish).toBe("end");

      stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      const [exitCode] = await Promise.all([proc.exited, stdoutDone]);
      const ended = events[events.length - 1] as Record<string, any> | undefined;
      expect(ended?.type).toBe("session_ended");
      expect(ended?.reason).toBe("shutdown");
      expect(ended?.resumable).toBe(true);
      expect(exitCode).toBe(0);

      // The harness saw the real session argv (§4.7): the carrier, the
      // codemux session id, and high's grants — spawned directly, no scode.
      const argv = (readFileSync(join(fake.stateDir, "argv.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as { args: string[] }))
        .find((entry) => !entry.args.includes("--version"));
      expect(argv).toBeDefined();
      if (argv !== undefined) {
        expect(argv.args).toContain("-p");
        expect(argv.args).toContain("--permission-prompt-tool");
        expect(argv.args[argv.args.indexOf("--permission-prompt-tool") + 1]).toBe("stdio");
        expect(argv.args).toContain("--allowedTools");
        expect(argv.args.join(" ")).not.toContain("dangerously");
        const idAt = argv.args.indexOf("--session-id");
        expect(idAt).not.toBe(-1);
        expect(argv.args[idAt + 1]).toBe(started.session_id);
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });

  test("codex: drives one turn over the app-server protocol and ends cleanly", async () => {
    const fake = fakeCodexEnv({ version: "codex-cli 0.159.3" });
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    try {
      const proc = Bun.spawn(
        [
          join(import.meta.dir, "..", "bin", "codemux"),
          "session", "-a", "codex", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          stdin: "pipe",
          env: {
            ...process.env,
            CODEMUX_NO_KEYCHAIN_SYNC: "1",
            HOME: isolatedHome,
            XDG_CONFIG_HOME: join(isolatedHome, ".config"),
            ...fake.env,
            FAKE_CWD: workdir,
          } as Record<string, string>,
        }
      );
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

      const started = await waitFor("session_started", (event) => event.type === "session_started");
      expect(started.agent).toBe("codex");
      expect(started.session_id).toBe("0123456789abcdef");
      expect(started.capabilities.user_during_turn).toBe("queue");
      expect(started.capabilities.file_changes).toBe("native");

      const stdin = proc.stdin;
      stdin.write(`${JSON.stringify({ type: "user", text: "scenario:basic hello" })}\n`);
      const echo = await waitFor("user_message", (event) => event.type === "user_message");
      expect(echo.text).toBe("scenario:basic hello");
      expect(echo.turn_id).toBe("t1");
      const completed = await waitFor("turn_completed", (event) => event.type === "turn_completed");
      expect(completed.finish).toBe("end");

      stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      const [exitCode] = await Promise.all([proc.exited, stdoutDone]);
      const ended = events[events.length - 1] as Record<string, any> | undefined;
      expect(ended?.type).toBe("session_ended");
      expect(ended?.reason).toBe("shutdown");
      expect(ended?.resumable).toBe(true);
      expect(exitCode).toBe(0);

      // The harness spawn is exactly `codex app-server` (§4.7): one
      // dedicated app-server per session, everything else on JSON-RPC.
      const argv = (readFileSync(join(fake.stateDir, "argv.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as { args: string[] }))
        .find((entry) => !entry.args.includes("--version"));
      expect(argv).toBeDefined();
      expect(argv?.args).toEqual(["app-server"]);
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });
});

describe("claudeFamilyHarnessHome", () => {
  test("CLAUDE_CONFIG_DIR is honored only when it is passed through", () => {
    // The recorded home must be the child's actual home: without the
    // passthrough the execution environment strips the variable, so an
    // honored redirect would record a home the child never ran against —
    // a lie the resume guards would then judge against.
    const original = process.env.CLAUDE_CONFIG_DIR;
    const redirect = mkdtempSync(join(tmpdir(), "codemux-claude-redirect-"));
    process.env.CLAUDE_CONFIG_DIR = redirect;
    try {
      expect(claudeFamilyHarnessHome(["OTHER_VAR"])).toBe(join(homedir(), ".claude"));
      expect(claudeFamilyHarnessHome(["CLAUDE_CONFIG_DIR"])).toBe(redirect);
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = original;
      rmSync(redirect, { recursive: true, force: true });
    }
  });
});

describe("CLI - registry path seam", () => {
  test("no test spells the default registry layout by hand", () => {
    // Linux CI fix (0.9.0): seven tests seeded the registry under
    // `Library/Application Support` while the CLI, on Linux, reads
    // `~/.local/state` — so a seeded entry read as missing (66, not 78).
    // Every test must take the default path from sessionRegistryPath,
    // the seam the CLI itself uses.
    const testsDir = dirname(fileURLToPath(import.meta.url));
    const handSpelled = /["']Application Support["'],\s*["']codemux["']|["']\.local["'],\s*["']state["'],\s*["']codemux["']/;
    const offenders = readdirSync(testsDir)
      .filter((name) => name.endsWith(".test.ts"))
      .filter((name) => handSpelled.test(readFileSync(join(testsDir, name), "utf8")));
    expect(offenders).toEqual([]);
  });
});

test("all seven harnesses report harness_exit on session_ended (al38)", async () => {
  const cases = [
    ["claude", fakeClaudeEnv], ["zai", fakeClaudeEnv], ["codex", fakeCodexEnv],
    ["agy", fakeAgyEnv], ["opencode", fakeOpenCodeEnv],
    ["aider", fakeAiderEnv], ["kimi", fakeKimiEnv],
  ] as const;
  for (const [agent, makeFake] of cases) {
    const fake = agent === "codex" ? fakeCodexEnv({ version: "codex-cli 0.159.3" }) : makeFake();
    const home = mkdtempSync(join(tmpdir(), "session-ended-al38-"));
    const workdir = join(home, "work");
    mkdirSync(workdir);
    try {
      const session = await driveSession([
        "session", "-a", agent, "--no-sandbox", "--auto", "high",
        "--cwd", workdir, "--shutdown-grace", "1", "--pass-env", "FAKE_STATE_DIR",
      ], { ...fake.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"), ZAI_API_KEY: "fake-key" });
      try {
        session.send({ type: "user", text: "scenario:basic one" });
        await session.waitFor(`${agent} completion`, (event) => event.type === "turn_completed");
        session.send({ type: "shutdown" });
        await session.exit;
        const endings = session.events.filter((event) => event.type === "session_ended");
        expect(endings, agent).toHaveLength(1);
        expect(endings[0]!.harness_exit, agent).toEqual({ code: 0, signal: null });
        expect(endings[0]!.shutdown_requested, agent).toBe(true);
        expect(endings[0]!.exit_code, agent).toBe(0);
        expect(session.proc.exitCode, agent).toBe(0);
      } finally {
        session.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  }
}, 30_000);


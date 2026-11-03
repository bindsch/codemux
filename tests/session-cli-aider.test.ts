/**
 * aider sessions (split from tests/session-cli.test.ts): the per-turn
 * history file, the provider override's model flags, and the
 * passed-through home-variable rules.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli } from "./helpers/cli.js";
import { readRegistry, sessionRegistryPath } from "../src/session/registry.js";
import { driveSession, fakeAiderEnv } from "./helpers/session-cli.js";

describe("CLI - aider sessions", () => {
  test("drives a session over the per-turn history file and records ~/.aider as the home", async () => {
    const fake = fakeAiderEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    try {
      const session = await driveSession(
        [
          "session", "-a", "aider", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR",
        ],
        { HOME: isolatedHome, FAKE_STATE_DIR: fake.stateDir, ...fake.env }
      );
      try {
        session.send({ type: "user", text: "scenario:basic one" });
        const started = await session.waitFor(
          "session_started",
          (event) => event.type === "session_started"
        );
        expect(started.agent).toBe("aider");
        expect(started.session_id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        );
        expect(started.model).toBeNull();
        const message = await session.waitFor(
          "assistant_message",
          (event) => event.type === "assistant_message"
        );
        expect(message.text).toBe("Done: scenario:basic one");
        const completed = await session.waitFor(
          "turn_completed",
          (event) => event.type === "turn_completed"
        );
        expect(completed.finish).toBe("end");

        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);

        // The exchange lives in the per-session history file codemux
        // owns, and the turn spawned with no model flags at all (the
        // adapter leaves aider's own default alone without an override).
        const registry = readRegistry(
          sessionRegistryPath(isolatedHome)
        );
        expect(registry.outcome).toBe("ok");
        const entry =
          registry.outcome === "ok"
            ? registry.file.sessions.find((r) => r.id === started.session_id)
            : undefined;
        expect(entry?.agent).toBe("aider");
        expect(entry?.harness_home).toBe(join(isolatedHome, ".aider"));
        expect(
          existsSync(join(isolatedHome, ".aider", ".codemux", "sessions", started.session_id, "history.md"))
        ).toBe(true);
        const argv = JSON.parse(
          readFileSync(join(fake.stateDir, "argv.jsonl"), "utf8").split("\n")[0] as string
        ) as { args: string[] };
        // Exact flags: aiderBaseFlags always carries --model-settings-file
        // and --model-metadata-file, which a startsWith match would hit.
        expect(argv.args).not.toContain("--model");
        expect(argv.args).not.toContain("--weak-model");
      } finally {
        await session.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("a provider override carries the wire model and the weak model on the same endpoint", async () => {
    const fake = fakeAiderEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    try {
      const session = await driveSession(
        [
          "session", "-a", "aider", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR",
        ],
        {
          HOME: isolatedHome,
          FAKE_STATE_DIR: fake.stateDir,
          ...fake.env,
          CODEMUX_AIDER_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
          CODEMUX_AIDER_PROVIDER_API_KEY: "e2e-key-do-not-print",
          CODEMUX_AIDER_PROVIDER_MODEL: "clawvm-qwen32b-coder",
        }
      );
      try {
        session.send({ type: "user", text: "scenario:basic one" });
        const completed = await session.waitFor(
          "turn_completed",
          (event) => event.type === "turn_completed"
        );
        expect(completed.finish).toBe("end");
        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);
        // The wire model is openai/-prefixed and the weak model rides
        // the same endpoint (aider's ChatSummary runs through it) — the
        // run path's mapping, unchanged by the session boundary.
        const argv = JSON.parse(
          readFileSync(join(fake.stateDir, "argv.jsonl"), "utf8").split("\n")[0] as string
        ) as { args: string[] };
        expect(argv.args[argv.args.indexOf("--model") + 1]).toBe("openai/clawvm-qwen32b-coder");
        expect(argv.args[argv.args.indexOf("--weak-model") + 1]).toBe("openai/clawvm-qwen32b-coder");
      } finally {
        await session.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("a bad passed-through CODEX_HOME never ends a non-codex session (review D8, correctness 2)", async () => {
    // codexHarnessHome's CODEX_HOME validation (absolute, unpadded) ran
    // for EVERY agent at session setup, so an aider session with
    // --pass-env CODEX_HOME and a relative value exited 64 on a codex
    // rule its harness never reads. Only a codex session validates the
    // variable now; this session runs a full turn to a clean end.
    const fake = fakeAiderEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    try {
      const session = await driveSession(
        [
          "session", "-a", "aider", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "CODEX_HOME,FAKE_STATE_DIR",
        ],
        {
          HOME: isolatedHome,
          CODEX_HOME: "rel/path",
          FAKE_STATE_DIR: fake.stateDir,
          ...fake.env,
        }
      );
      try {
        session.send({ type: "user", text: "scenario:basic one" });
        const completed = await session.waitFor(
          "turn_completed",
          (event) => event.type === "turn_completed"
        );
        expect(completed.finish).toBe("end");
        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);
      } finally {
        await session.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("a bad passed-through CLAUDE_CONFIG_DIR never ends a non-claude-family session (review D8, correctness 2)", async () => {
    // The CODEX_HOME finding's mirror, found in the same-class audit:
    // assertAbsoluteClaudeConfigDir ran eagerly for EVERY agent at
    // session setup, so an aider session with --pass-env
    // CLAUDE_CONFIG_DIR and a relative value exited 64 on a claude
    // rule its harness never reads. Only claude and zai sessions
    // validate the variable now; this session runs a full turn to a
    // clean end.
    const fake = fakeAiderEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    try {
      const session = await driveSession(
        [
          "session", "-a", "aider", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "CLAUDE_CONFIG_DIR,FAKE_STATE_DIR",
        ],
        {
          HOME: isolatedHome,
          CLAUDE_CONFIG_DIR: "rel/path",
          FAKE_STATE_DIR: fake.stateDir,
          ...fake.env,
        }
      );
      try {
        session.send({ type: "user", text: "scenario:basic one" });
        const completed = await session.waitFor(
          "turn_completed",
          (event) => event.type === "turn_completed"
        );
        expect(completed.finish).toBe("end");
        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);
      } finally {
        await session.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("a failed start record removes the fresh session's history directory (review D2, correctness-2 3)", async () => {
    // recordBeforeSpawn creates ~/.aider/.codemux/sessions/<uuid>/ before
    // the registry write; when that write fails the CLI exits, and the
    // directory used to stay behind with nothing pointing at it until the
    // 28-day sweep. The failure path now removes it.
    const fake = fakeAiderEnv();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "codemux-aider-recordfail-")));
    const workdir = join(home, "work");
    mkdirSync(workdir);
    try {
      // The untrusted registry (mode 0644) fails the start record — the
      // live22 pattern.
      const registryPath = sessionRegistryPath(home);
      mkdirSync(dirname(registryPath), { recursive: true, mode: 0o700 });
      writeFileSync(registryPath, '{"version":1,"sessions":[]}\n', { mode: 0o644 });
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "aider", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
        ],
        { ...fake.env, HOME: home },
        { stdin: "" }
      );
      expect(exitCode, stderr).toBe(1);
      expect(stderr).toContain("cannot record the session in the registry");
      // No orphaned session directory: nothing was recorded, so nothing
      // stays under the sessions parent.
      const sessionsDir = join(home, ".aider", ".codemux", "sessions");
      const left = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];
      expect(left).toEqual([]);
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});


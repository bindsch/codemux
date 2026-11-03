/**
 * zai sessions against the Z.AI endpoint (split from the "CLI - zai
 * sessions" block of tests/session-cli.test.ts): the provider identity,
 * the model mapping, and the run itself.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./helpers/cli.js";
import { readRegistry, sessionRegistryPath } from "../src/session/registry.js";
import { driveSession, fakeClaudeEnv } from "./helpers/session-cli.js";

describe("CLI - zai sessions", () => {
  test("a session under the claude override carries the modelPicker mapping on --settings", async () => {
    // Claude Code 2.1.280 (the session floor) validates --model against
    // its own model catalog before any request leaves the client, and a
    // provider-format id is not in it: an override session would die on
    // its first turn with zero requests reaching the endpoint. The
    // session's argv carries the same mapping the run path carries —
    // --model names what the endpoint serves, --settings tells the
    // binary which catalog tier to assume for it, and the wire id is
    // unchanged. Without an override nothing is added (the regression:
    // the plain session's argv never grows a --settings).
    const fake = fakeClaudeEnv();
    const plain = fakeClaudeEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-picker-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    const overrideEnv = {
      CODEMUX_CLAUDE_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
      CODEMUX_CLAUDE_PROVIDER_API_KEY: "e2e-key-do-not-print",
      CODEMUX_CLAUDE_PROVIDER_MODEL: "clawvm-qwen32b-coder",
    };
    const firstSpawnArgs = (dir: string): string[] => {
      const lines = readFileSync(join(dir, "argv.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "");
      expect(lines.length).toBeGreaterThan(0);
      return (JSON.parse(lines[0] ?? "") as { args: string[] }).args;
    };
    try {
      for (const [harnessFake, env] of [
        [fake, overrideEnv] as const,
        [plain, {}] as const,
      ]) {
        const session = await driveSession(
          [
            "session", "-a", "claude", "--no-sandbox", "--auto", "high",
            "--cwd", workdir, "--shutdown-grace", "2",
            "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
          ],
          {
            HOME: isolatedHome,
            XDG_CONFIG_HOME: join(isolatedHome, ".config"),
            FAKE_STATE_DIR: harnessFake.stateDir,
            FAKE_CWD: workdir,
            ...harnessFake.env,
            ...env,
          }
        );
        try {
          session.send({ type: "user", text: "scenario:basic hello" });
          await session.waitFor(
            "turn_completed",
            (event) => event.type === "turn_completed"
          );
          session.send({ type: "shutdown" });
          const [exitCode] = await session.exit;
          expect(exitCode).toBe(0);
        } finally {
          await session.proc.kill();
        }
      }
      const args = firstSpawnArgs(fake.stateDir);
      expect(args[args.indexOf("--model") + 1]).toBe("clawvm-qwen32b-coder");
      const settings = args[args.indexOf("--settings") + 1] ?? "";
      expect(JSON.parse(settings)).toEqual({
        modelPicker: {
          options: [{ model: "clawvm-qwen32b-coder", behavesAs: "claude-sonnet-5" }],
        },
      });
      expect(firstSpawnArgs(plain.stateDir)).not.toContain("--settings");
    } finally {
      fake.cleanup();
      plain.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("a zai session with a provider-format model carries the picker mapping; the default carries none", async () => {
    // The same catalog check the claude override answers (2.1.280+, the
    // session floor): a zai -m glm-5.3 (the worker/judge tiers) used to
    // ride a bare --model and die client-side with zero requests. The
    // session argv now carries the same --settings row the run path
    // carries, and a default-model session (opus, a catalog alias) never
    // grows one.
    const glm = fakeClaudeEnv();
    const plain = fakeClaudeEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-zai-picker-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    const firstSpawnArgs = (dir: string): string[] => {
      const lines = readFileSync(join(dir, "argv.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "");
      expect(lines.length).toBeGreaterThan(0);
      return (JSON.parse(lines[0] ?? "") as { args: string[] }).args;
    };
    try {
      for (const [harnessFake, extraArgs] of [
        [glm, ["-m", "glm-5.3"]] as const,
        [plain, []] as const,
      ]) {
        const session = await driveSession(
          [
            "session", "-a", "zai", "--no-sandbox", "--auto", "high",
            "--cwd", workdir, "--shutdown-grace", "2",
            "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
            ...extraArgs,
          ],
          {
            HOME: isolatedHome,
            XDG_CONFIG_HOME: join(isolatedHome, ".config"),
            ZAI_API_KEY: "zai-test-key",
            FAKE_STATE_DIR: harnessFake.stateDir,
            FAKE_CWD: workdir,
            ...harnessFake.env,
          }
        );
        try {
          session.send({ type: "user", text: "scenario:basic hello" });
          await session.waitFor(
            "turn_completed",
            (event) => event.type === "turn_completed"
          );
          session.send({ type: "shutdown" });
          const [exitCode] = await session.exit;
          expect(exitCode).toBe(0);
        } finally {
          await session.proc.kill();
        }
      }
      const args = firstSpawnArgs(glm.stateDir);
      expect(args[args.indexOf("--model") + 1]).toBe("glm-5.3");
      const settings = args[args.indexOf("--settings") + 1] ?? "";
      expect(JSON.parse(settings)).toEqual({
        modelPicker: {
          options: [{ model: "glm-5.3", behavesAs: "claude-sonnet-5" }],
        },
      });
      const plainArgs = firstSpawnArgs(plain.stateDir);
      // A default-model session names no model on argv at all (the binary
      // picks its own default), and never grows a --settings.
      expect(plainArgs).not.toContain("--model");
      expect(plainArgs).not.toContain("--settings");
    } finally {
      glm.cleanup();
      plain.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("the provider identity records the base URL without its query, and a rotated key still resumes (review D10, security)", async () => {
    // A gateway key can ride the override's base URL query (`?key=…`).
    // The raw value used to reach the registry verbatim and came back in
    // every resume-refusal message, so the secret sat on disk (0600, but
    // on disk) and in logs. The record, the comparison, and the refusal
    // surface all carry the identity form now — query and fragment
    // stripped — so a key rotation between the session and its resume
    // still matches while a different endpoint still refuses, and the
    // refusal names only the identities.
    const fake = fakeClaudeEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-identity-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    const overrideAt = (baseUrl: string): Record<string, string> => ({
      CODEMUX_CLAUDE_PROVIDER_BASE_URL: baseUrl,
      CODEMUX_CLAUDE_PROVIDER_API_KEY: "e2e-key-do-not-print",
      CODEMUX_CLAUDE_PROVIDER_MODEL: "clawvm-qwen32b-coder",
    });
    try {
      const session = await driveSession(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        {
          HOME: isolatedHome,
          XDG_CONFIG_HOME: join(isolatedHome, ".config"),
          FAKE_STATE_DIR: fake.stateDir,
          FAKE_CWD: workdir,
          ...fake.env,
          ...overrideAt("http://127.0.0.1:9/v1?key=e2e-secret"),
        }
      );
      let sessionId = "";
      try {
        session.send({ type: "user", text: "scenario:basic hello" });
        const started = await session.waitFor(
          "session_started",
          (event) => event.type === "session_started"
        );
        sessionId = started.session_id as string;
        await session.waitFor("turn_completed", (event) => event.type === "turn_completed");
        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);
      } finally {
        await session.proc.kill();
      }
      // The record carries the identity, and the raw registry file — the
      // thing that lands on disk — never holds the query key.
      const registryPath = sessionRegistryPath(isolatedHome);
      const registry = readRegistry(registryPath);
      expect(registry.outcome).toBe("ok");
      const entry =
        registry.outcome === "ok"
          ? registry.file.sessions.find((r) => r.id === sessionId)
          : undefined;
      expect(entry?.provider_base_url).toBe("http://127.0.0.1:9/v1");
      expect(readFileSync(registryPath, "utf8")).not.toContain("e2e-secret");

      // The same endpoint under a rotated key resumes — a full turn, not
      // just the guards: the comparison runs on the identity form, so the
      // query cannot split what the identity joins.
      const rotatedSession = await driveSession(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--resume", sessionId,
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        {
          HOME: isolatedHome,
          XDG_CONFIG_HOME: join(isolatedHome, ".config"),
          FAKE_STATE_DIR: fake.stateDir,
          FAKE_CWD: workdir,
          ...fake.env,
          ...overrideAt("http://127.0.0.1:9/v1?key=rotated-other"),
        }
      );
      try {
        rotatedSession.send({ type: "user", text: "scenario:basic again" });
        const started = await rotatedSession.waitFor(
          "session_started",
          (event) => event.type === "session_started"
        );
        expect(started.session_id).toBe(sessionId);
        await rotatedSession.waitFor(
          "turn_completed",
          (event) => event.type === "turn_completed"
        );
        rotatedSession.send({ type: "shutdown" });
        const [exitCode] = await rotatedSession.exit;
        expect(exitCode).toBe(0);
      } finally {
        await rotatedSession.proc.kill();
      }

      // A different endpoint still refuses, naming the two identities —
      // and neither side of the message carries the query key.
      const other = await runCli(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--resume", sessionId,
        ],
        {
          ...fake.env,
          HOME: isolatedHome,
          XDG_CONFIG_HOME: join(isolatedHome, ".config"),
          ...overrideAt("http://127.0.0.1:10/v1?key=attacker-key"),
        }
      );
      expect(other.exitCode).toBe(78);
      expect(other.stderr).toContain("created against the provider override at http://127.0.0.1:9/v1");
      expect(other.stderr).toContain("cannot resume against the provider override at http://127.0.0.1:10/v1");
      expect(other.stderr).not.toContain("e2e-secret");
      expect(other.stderr).not.toContain("attacker-key");
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("a zai session without an API key refuses before spawn", async () => {
    const fake = fakeClaudeEnv();
    const home = mkdtempSync(join(tmpdir(), "codemux-zai-nokey-"));
    try {
      const { stderr, exitCode } = await runCli(
        ["session", "-a", "zai", "--no-sandbox", "--auto", "high"],
        { ...fake.env, HOME: home, ZAI_API_KEY: "" }
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Z.AI API key not found.");
      expect(stderr).not.toContain("at getZaiApiKey");
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a zai session runs the claude binary against the Z.AI endpoint", async () => {
    const fake = fakeClaudeEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    try {
      const proc = Bun.spawn(
        [
          join(import.meta.dir, "..", "bin", "codemux"),
          "session", "-a", "zai", "--no-sandbox", "--auto", "high",
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
            ZAI_API_KEY: "zai-test-key",
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

      // Same shape as the claude happy path: the per-turn init means the
      // first user line is what produces session_started.
      const stdin = proc.stdin;
      stdin.write(`${JSON.stringify({ type: "user", text: "scenario:basic hello" })}\n`);
      const started = await waitFor("session_started", (event) => event.type === "session_started");
      expect(started.agent).toBe("zai");
      expect(started.autonomy).toBe("high");

      const completed = await waitFor("turn_completed", (event) => event.type === "turn_completed");
      expect(completed.finish).toBe("end");

      stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      const [exitCode] = await Promise.all([proc.exited, stdoutDone]);
      const ended = events[events.length - 1] as Record<string, any> | undefined;
      expect(ended?.type).toBe("session_ended");
      expect(ended?.reason).toBe("shutdown");
      expect(exitCode).toBe(0);

      // The Z.AI identity rode the adapter's env, not the argv: the fake
      // saw the endpoint and the token, and never the raw key.
      const env = (readFileSync(join(fake.stateDir, "env.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, any>))
        .find(() => true);
      expect(env?.anthropic_base_url).toBe("https://api.z.ai/api/anthropic");
      expect(env?.anthropic_auth_token).toBe(true);
      expect(env?.zai_api_key_present).toBe(false);

      // The registry entry names zai against the shared claude home —
      // the store is one, the identity is not (§4.8).
      const read = readRegistry(
        sessionRegistryPath(isolatedHome)
      );
      expect(read.outcome).toBe("ok");
      const entry =
        read.outcome === "ok"
          ? read.file.sessions.find((r) => r.id === started.session_id)
          : undefined;
      expect(entry?.agent).toBe("zai");
      expect(entry?.harness_home).toBe(join(isolatedHome, ".claude"));
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });
});

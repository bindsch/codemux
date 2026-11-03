/**
 * agy sessions over the NDJSON loop (split from
 * tests/session-cli.test.ts): refusals, the argv contract, and the
 * registry record.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./helpers/cli.js";
import { readRegistry, sessionRegistryPath } from "../src/session/registry.js";
import { fakeAgyEnv } from "./helpers/session-cli.js";

describe("CLI - agy sessions", () => {
  test("an agy harness below the session floor is refused before spawn", async () => {
    const fake = fakeAgyEnv({ version: "1.2.13" });
    try {
      const { stderr, exitCode } = await runCli(
        ["session", "-a", "agy", "--no-sandbox", "--auto", "high"],
        fake.env
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("1.2.14");
    } finally {
      fake.cleanup();
    }
  });

  test("--turn-timeout is refused: agy sessions cannot interrupt a turn", async () => {
    const fake = fakeAgyEnv();
    try {
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "agy", "--no-sandbox", "--auto", "high",
          "--turn-timeout", "30",
        ],
        fake.env
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain("--turn-timeout requires an agent whose sessions support interrupt");
    } finally {
      fake.cleanup();
    }
  });

  test("a --resume id that is not an agy conversation id refuses with 64", async () => {
    const fake = fakeAgyEnv();
    try {
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "agy", "--no-sandbox", "--auto", "high",
          "--resume", "bad id",
        ],
        fake.env
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain("agy conversation id");
    } finally {
      fake.cleanup();
    }
  });

  test("an agy executable project config is refused before spawn", async () => {
    const fake = fakeAgyEnv();
    const home = mkdtempSync(join(tmpdir(), "codemux-agy-projcfg-"));
    const workdir = join(home, "work");
    mkdirSync(join(workdir, ".agents"), { recursive: true });
    writeFileSync(join(workdir, ".agents", "skills.json"), "{}\n");
    try {
      const { stderr, exitCode } = await runCli(
        ["session", "-a", "agy", "--no-sandbox", "--auto", "high", "--cwd", workdir],
        { ...fake.env, HOME: home }
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain("refuses repository executable configuration");
      expect(stderr).toContain("skills.json");
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("drives one turn over the NDJSON loop and records the conversation", async () => {
    const fake = fakeAgyEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    try {
      const proc = Bun.spawn(
        [
          join(import.meta.dir, "..", "bin", "codemux"),
          "session", "-a", "agy", "--no-sandbox", "--auto", "high",
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

      // The identity is deferred: send the first turn before waiting for
      // session_started, because the first result is what names the
      // conversation (§4.7's agy model).
      const stdin = proc.stdin;
      stdin.write(`${JSON.stringify({ type: "user", text: "scenario:basic hello" })}\n`);

      const started = await waitFor("session_started", (event) => event.type === "session_started");
      expect(started.agent).toBe("agy");
      expect(started.session_id).toBe("conv-fake-1");
      expect(started.capabilities.user_during_turn).toBe(false);
      expect(started.capabilities.interrupt).toBe(false);
      expect(started.capabilities.resume).toBe(true);

      const echo = await waitFor("user_message", (event) => event.type === "user_message");
      expect(echo.text).toBe("scenario:basic hello");
      expect(echo.session_id).toBe("");
      const completed = await waitFor("turn_completed", (event) => event.type === "turn_completed");
      expect(completed.finish).toBe("end");

      stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      const [exitCode] = await Promise.all([proc.exited, stdoutDone]);
      const ended = events[events.length - 1] as Record<string, any> | undefined;
      expect(ended?.type).toBe("session_ended");
      expect(ended?.reason).toBe("shutdown");
      expect(ended?.resumable).toBe(true);
      expect(exitCode).toBe(0);

      // The harness saw the NDJSON loop argv exactly (§4.7): the io
      // pair, slash commands off, and high's bypass — spawned directly,
      // no scode.
      const argv = (readFileSync(join(fake.stateDir, "argv.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as { args: string[] }))
        .find((entry) => !entry.args.includes("--version"));
      expect(argv).toBeDefined();
      // The wrapper execs the fake with the session args, so the binary
      // name itself is not among them — same convention as the codex
      // test's ["app-server"].
      expect(argv?.args).toEqual([
        "--disable-slash-commands",
        "--input-format=stream-json",
        "--output-format=stream-json",
        "--dangerously-skip-permissions",
      ]);

      // The registry entry names agy under the antigravity home (§4.8).
      const read = readRegistry(
        sessionRegistryPath(isolatedHome)
      );
      expect(read.outcome).toBe("ok");
      const entry =
        read.outcome === "ok"
          ? read.file.sessions.find((r) => r.id === "conv-fake-1")
          : undefined;
      expect(entry?.agent).toBe("agy");
      expect(entry?.harness_home).toBe(join(isolatedHome, ".gemini", "antigravity-cli"));
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });
});


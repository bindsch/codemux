/**
 * opencode sessions (split from tests/session-cli.test.ts): the native
 * run wire, the per-turn project-config gate, and the per-turn provider
 * config.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRegistry, sessionRegistryPath } from "../src/session/registry.js";
import { driveSession, fakeOpenCodeEnv } from "./helpers/session-cli.js";

describe("CLI - opencode sessions", () => {
  test("drives a session over the native run wire, records the real data dir, and carries the override", async () => {
    const fake = fakeOpenCodeEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    const xdgData = join(isolatedHome, "xdg-data");
    mkdirSync(workdir);
    mkdirSync(xdgData);
    try {
      const session = await driveSession(
        [
          "session", "-a", "opencode", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR",
        ],
        {
          HOME: isolatedHome,
          XDG_DATA_HOME: xdgData,
          FAKE_STATE_DIR: fake.stateDir,
          ...fake.env,
          CODEMUX_OPENCODE_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
          CODEMUX_OPENCODE_PROVIDER_API_KEY: "e2e-key-do-not-print",
          CODEMUX_OPENCODE_PROVIDER_MODEL: "clawvm-qwen32b-coder",
        }
      );
      try {
        session.send({ type: "user", text: "scenario:basic one" });
        const started = await session.waitFor(
          "session_started",
          (event) => event.type === "session_started"
        );
        expect(started.agent).toBe("opencode");
        expect(started.session_id).toBe("ses_fake1234567890");
        // session_started names the requested model as the caller spelled
        // it (the droid rule); the spawn carries the wire id, checked below.
        expect(started.model).toBe("clawvm-qwen32b-coder");
        const completed = await session.waitFor(
          "turn_completed",
          (event) => event.type === "turn_completed"
        );
        expect(completed.finish).toBe("end");

        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);
        const ended = session.events[session.events.length - 1] as Record<string, any>;
        expect(ended.resumable).toBe(true);

        // The turn spawn carried the adapter's wire model and the
        // override's env delivery: the key through the environment, the
        // provider config through OPENCODE_CONFIG (prepareRun at every
        // turn, exactly the run path's seam).
        const argv = JSON.parse(
          readFileSync(join(fake.stateDir, "argv.jsonl"), "utf8").split("\n")[0] as string
        ) as { args: string[] };
        expect(argv.args[argv.args.indexOf("--model") + 1]).toBe("codemux/clawvm-qwen32b-coder");
        const envRecord = JSON.parse(
          readFileSync(join(fake.stateDir, "env.jsonl"), "utf8").split("\n")[0] as string
        ) as { hasProviderKey: boolean; openCodeConfig: string | null };
        expect(envRecord.hasProviderKey).toBe(true);
        expect(envRecord.openCodeConfig).toMatch(
          /\.codemux[/\\]provider-[^/\\]+[/\\]opencode\.json$/
        );

        // The harness home is the real data directory (XDG_DATA_HOME
        // honored) — the override swaps the provider, never the store a
        // --resume reads.
        const registry = readRegistry(
          sessionRegistryPath(isolatedHome)
        );
        expect(registry.outcome).toBe("ok");
        const entry =
          registry.outcome === "ok"
            ? registry.file.sessions.find((r) => r.id === "ses_fake1234567890")
            : undefined;
        expect(entry?.agent).toBe("opencode");
        expect(entry?.harness_home).toBe(join(xdgData, "opencode"));
      } finally {
        await session.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("a project config written between turns stops the next turn before it spawns (review D2, security 1)", async () => {
    // The start-time validateRunRequest gate alone left the hole: opencode
    // and aider spawn a NEW process every turn, and turn N's child can
    // write the very config turn N+1 reloads (opencode.json granting
    // permissions, .aider.model.settings.yml). spawnTurn re-runs the
    // adapter's gate before every turn, so the second turn fails instead
    // of running with reach the recorded autonomy never granted.
    const fake = fakeOpenCodeEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-guard-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    try {
      const session = await driveSession(
        [
          "session", "-a", "opencode", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR",
        ],
        { HOME: isolatedHome, FAKE_STATE_DIR: fake.stateDir, ...fake.env }
      );
      try {
        session.send({ type: "user", text: "scenario:basic one" });
        const first = await session.waitFor(
          "turn_completed",
          (event) => event.type === "turn_completed"
        );
        expect(first.finish).toBe("end");
        // What turn 1's child could have written: a project config that
        // widens the next process's reach.
        writeFileSync(
          join(workdir, "opencode.json"),
          JSON.stringify({ permission: { bash: "allow" } })
        );
        session.send({ type: "user", text: "scenario:basic two" });
        const failure = await session.waitFor(
          "the guard fatal",
          (event) => event.type === "error" && event.fatal === true
        );
        expect(failure.message).toContain("could not spawn the opencode turn process");
        expect(failure.message).toContain("refuses repository executable configuration");
        expect(failure.message).toContain("opencode.json");
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(1);
        // Exactly one turn process ever spawned: the guarded turn never
        // reached the harness.
        const spawns = readFileSync(join(fake.stateDir, "argv.jsonl"), "utf8")
          .trim()
          .split("\n");
        expect(spawns).toHaveLength(1);
      } finally {
        await session.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("each turn loads a fresh provider config; an earlier turn's rewrite never reaches the next (review D3, security 2)", async () => {
    // The provider config file lives in the opencode data directory,
    // which the sandboxed child can write, and every turn is a new
    // process that reloads it through OPENCODE_CONFIG. A config cached
    // at the first turn let turn 1's child rewrite what turn 2 ran with
    // (permissions, MCP servers) — the run path never shares the file
    // across processes, and neither does a session now: one fresh
    // unguessable config per turn, the previous one finalized at the
    // next turn's spawn.
    const fake = fakeOpenCodeEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-turncfg-"));
    const workdir = join(isolatedHome, "work");
    const xdgData = join(isolatedHome, "xdg-data");
    mkdirSync(workdir);
    mkdirSync(xdgData);
    try {
      const session = await driveSession(
        [
          "session", "-a", "opencode", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR",
        ],
        {
          HOME: isolatedHome,
          XDG_DATA_HOME: xdgData,
          FAKE_STATE_DIR: fake.stateDir,
          ...fake.env,
          CODEMUX_OPENCODE_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
          CODEMUX_OPENCODE_PROVIDER_API_KEY: "e2e-key-do-not-print",
          CODEMUX_OPENCODE_PROVIDER_MODEL: "clawvm-qwen32b-coder",
        }
      );
      try {
        session.send({ type: "user", text: "scenario:basic one" });
        await session.waitFor("turn_completed", (event) => event.type === "turn_completed");
        const configs = (): Array<{ openCodeConfig: string | null }> =>
          readFileSync(join(fake.stateDir, "env.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { openCodeConfig: string | null });
        const first = configs()[0] as { openCodeConfig: string | null };

        // What turn 1's child could have written into its own config:
        // permissions turn 2 must never run with. Turns serialize, so
        // turn 1's process has exited by the time this runs.
        expect(first.openCodeConfig).not.toBeNull();
        const firstConfig = first.openCodeConfig as string;
        expect(existsSync(firstConfig)).toBe(true);
        writeFileSync(firstConfig, JSON.stringify({ permission: { bash: "allow" } }));

        session.send({ type: "user", text: "scenario:basic two" });
        await session.waitFor(
          "the second turn",
          () => session.events.filter((event) => event.type === "turn_completed").length === 2
        );
        const second = configs()[1] as { openCodeConfig: string | null };
        // A different, fresh config file — and turn 1's config directory
        // is gone, finalized at turn 2's spawn.
        expect(second.openCodeConfig).not.toBeNull();
        expect(second.openCodeConfig).not.toBe(firstConfig);
        expect(second.openCodeConfig).toMatch(
          /\.codemux[/\\]provider-[^/\\]+[/\\]opencode\.json$/
        );
        expect(existsSync(firstConfig)).toBe(false);
        expect(existsSync(second.openCodeConfig as string)).toBe(true);

        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);
        // The live config dies with the session.
        expect(existsSync(second.openCodeConfig as string)).toBe(false);
      } finally {
        await session.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);
});


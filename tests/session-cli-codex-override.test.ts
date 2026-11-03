/**
 * codex sessions under a provider override (split from
 * tests/session-cli.test.ts): the session-keyed harness home, the
 * settled config.toml, and the concurrent-resume race on that config.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRegistry, sessionRegistryPath } from "../src/session/registry.js";
import { driveSession, fakeCodexEnv } from "./helpers/session-cli.js";

describe("CLI - codex sessions under a provider override", () => {
  const THREAD_ID = "0123456789abcdef";

  /** The env both override-session tests run under: one endpoint, one
   * key, one model, isolated HOME. */
  const overrideEnv = (
    fake: ReturnType<typeof fakeCodexEnv>,
    isolatedHome: string,
    workdir: string
  ): Record<string, string> => {
    const env: Record<string, string> = {
      HOME: isolatedHome,
      XDG_CONFIG_HOME: join(isolatedHome, ".config"),
      ...fake.env,
      FAKE_STATE_DIR: fake.stateDir,
      FAKE_CWD: workdir,
      CODEMUX_CODEX_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
      CODEMUX_CODEX_PROVIDER_API_KEY: "e2e-key-do-not-print",
      CODEMUX_CODEX_PROVIDER_MODEL: "clawvm-qwen32b-coder",
    };
    return env;
  };

  /** One `codexHome` record per harness spawn, in spawn order (the
   * version probe never reaches the fake: the wrapper answers it). */
  const recordedHomes = (fake: { stateDir: string }): string[] =>
    readFileSync(join(fake.stateDir, "env.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => (JSON.parse(line) as { codexHome: string | null }).codexHome as string);

  test("the session's home is keyed by session id, settled at the resumable end (review D1)", async () => {
    const fake = fakeCodexEnv({ version: "codex-cli 0.159.3" });
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    const baseUrl = "http://127.0.0.1:9/v1";
    try {
      const session = await driveSession(
        [
          "session", "-a", "codex", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        overrideEnv(fake, isolatedHome, workdir)
      );
      try {
        session.send({ type: "user", text: "scenario:basic hello" });
        const started = await session.waitFor(
          "session_started",
          (event) => event.type === "session_started"
        );
        expect(started.agent).toBe("codex");
        expect(started.session_id).toBe(THREAD_ID);
        // The override's model is the reported one, raw.
        expect(started.model).toBe("clawvm-qwen32b-coder");
        const completed = await session.waitFor(
          "turn_completed",
          (event) => event.type === "turn_completed"
        );
        expect(completed.finish).toBe("end");

        // While the session runs, its home is run-shaped (review D1): a
        // fresh directory under .codemux-provider, not the keyed path —
        // the id that keys it only arrives at thread/start.
        const liveHome = recordedHomes(fake)[0] as string;
        expect(liveHome.startsWith(join(isolatedHome, ".codex", ".codemux-provider") + "/")).toBe(true);
        expect(liveHome.split("/").pop()).toMatch(/^run-\d+-/);
        expect(existsSync(join(liveHome, "config.toml"))).toBe(true);

        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);

        // The registry recorded the keyed path the resume's guard will
        // compare (the driver's seam), never the live run-shaped name.
        const hash = createHash("sha256").update(baseUrl).digest("hex").slice(0, 12);
        const keyed = join(isolatedHome, ".codex", ".codemux-provider", `session-home-${hash}-${THREAD_ID}`);
        const registry = readRegistry(
          sessionRegistryPath(isolatedHome)
        );
        expect(registry.outcome).toBe("ok");
        const entry =
          registry.outcome === "ok"
            ? registry.file.sessions.find((r) => r.id === THREAD_ID)
            : undefined;
        expect(entry?.harness_home).toBe(keyed);

        // The resumable end settled the home onto its key: the run-shaped
        // name is gone, the keyed directory holds the config, and nothing
        // else is left under the parent.
        expect(existsSync(liveHome)).toBe(false);
        const config = readFileSync(join(keyed, "config.toml"), "utf8");
        expect(config).toContain(`base_url = "${baseUrl}"`);
        expect(config).toContain(`model = "clawvm-qwen32b-coder"`);
        expect(readdirSync(join(isolatedHome, ".codex", ".codemux-provider"))).toEqual([
          `session-home-${hash}-${THREAD_ID}`,
        ]);

        // The spawn delivered CODEX_HOME through env(1) (the run path's
        // launch shape), and thread/start carried no model — wireModel
        // null under an override.
        const requests = readFileSync(join(fake.stateDir, "requests.jsonl"), "utf8")
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
        const start = requests.find((request) => request.method === "thread/start");
        expect(start).toBeDefined();
        expect(start?.params.model).toBeUndefined();
      } finally {
        await session.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("the settled config.toml is pinned whole — the MULTI_AGENT=off variant carries no storage key", async () => {
    // Ask 5's premise was a response-storage knob; no supported codex
    // release has one (verified against the 0.159.3 generated config
    // schema and the 0.160.1 binary), and codex already sends store:
    // false on every Responses request, so the config carries no storage
    // key at all. Pinning the entire settled file — not just substrings —
    // means a future edit cannot add one, or drop the key exclusion,
    // unnoticed.
    const fake = fakeCodexEnv({ version: "codex-cli 0.159.3" });
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-config-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    const baseUrl = "http://127.0.0.1:9/v1";
    const hash = createHash("sha256").update(baseUrl).digest("hex").slice(0, 12);
    const keyed = join(
      isolatedHome, ".codex", ".codemux-provider", `session-home-${hash}-${THREAD_ID}`
    );
    try {
      const session = await driveSession(
        [
          "session", "-a", "codex", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        {
          ...overrideEnv(fake, isolatedHome, workdir),
          CODEMUX_CODEX_PROVIDER_MULTI_AGENT: "off",
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
      expect(readFileSync(join(keyed, "config.toml"), "utf8")).toBe(
        [
          "# Written by codemux for one launch; removed when the run ends.",
          'model_provider = "codemux"',
          'model = "clawvm-qwen32b-coder"',
          "features.multi_agent = false",
          "[shell_environment_policy]",
          'exclude = ["CODEMUX_CODEX_PROVIDER_API_KEY"]',
          "[model_providers.codemux]",
          'name = "codemux provider override"',
          `base_url = "${baseUrl}"`,
          'env_key = "CODEMUX_CODEX_PROVIDER_API_KEY"',
          'wire_api = "responses"',
          "",
        ].join("\n")
      );
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("a resume reopens the session-keyed home, rewrites the config, and keeps it at its end", async () => {
    const fake = fakeCodexEnv({ version: "codex-cli 0.159.3" });
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    const baseUrl = "http://127.0.0.1:9/v1";
    const hash = createHash("sha256").update(baseUrl).digest("hex").slice(0, 12);
    const keyed = join(isolatedHome, ".codex", ".codemux-provider", `session-home-${hash}-${THREAD_ID}`);
    const args = [
      "session", "-a", "codex", "--no-sandbox", "--auto", "high",
      "--cwd", workdir, "--shutdown-grace", "2",
      "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
    ];
    try {
      // Session one: run to a resumable end, leaving the home on its key.
      const first = await driveSession(args, overrideEnv(fake, isolatedHome, workdir));
      try {
        first.send({ type: "user", text: "scenario:basic hello" });
        await first.waitFor("turn_completed", (event) => event.type === "turn_completed");
        first.send({ type: "shutdown" });
        expect((await first.exit)[0]).toBe(0);
      } finally {
        await first.proc.kill();
      }
      const configInode = statSync(join(keyed, "config.toml")).ino;

      // Session two: the resume. Its guard passes only because the
      // recorded harness_home is the keyed path this resume computes
      // (review D1: one session's home, keyed by endpoint AND id).
      const second = await driveSession([...args, "--resume", THREAD_ID], overrideEnv(fake, isolatedHome, workdir));
      try {
        second.send({ type: "user", text: "scenario:basic again" });
        const started = await second.waitFor(
          "session_started",
          (event) => event.type === "session_started"
        );
        expect(started.session_id).toBe(THREAD_ID);
        await second.waitFor("turn_completed", (event) => event.type === "turn_completed");
        second.send({ type: "shutdown" });
        const [exitCode] = await second.exit;
        expect(exitCode).toBe(0);
      } finally {
        await second.proc.kill();
      }

      // The resumed process ran in the keyed home (env(1) delivered it),
      // resumed the thread rather than starting one, and the resume's
      // config rewrite replaced the file (a new inode — never a write
      // through whatever the old session's child left at the name).
      const homes = recordedHomes(fake);
      expect(homes).toHaveLength(2);
      expect(homes[1]).toBe(keyed);
      const requests = readFileSync(join(fake.stateDir, "requests.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
      const resumed = requests.find((request) => request.method === "thread/resume");
      expect(resumed).toBeDefined();
      expect(statSync(join(keyed, "config.toml")).ino).not.toBe(configInode);
      // The resumed session's own resumable end keeps the home — it IS
      // the state the next resume needs — and leaves nothing else.
      expect(existsSync(keyed)).toBe(true);
      expect(readdirSync(join(isolatedHome, ".codex", ".codemux-provider"))).toEqual([
        `session-home-${hash}-${THREAD_ID}`,
      ]);
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("a resume refused session_busy never rewrote the live session's config (review D5, correctness 3)", async () => {
    // The finding's race — two resumes of one id whose lock-free lookups
    // BOTH pass, the loser reaching its home open before the winner's
    // claim — is closed at the top since review round 13 (edges 3): the
    // claim now runs before the launch preparation, so no probe, home
    // open, or config write sits between the lookup and the claim, and a
    // resume that cannot own the session refuses having opened nothing.
    // What the finding protected is pinned here with the deterministic
    // staging the new order allows: the winner claims and goes live
    // first; the loser — a second resume of the id the winner holds — is
    // refused session_busy at its guard, never spawns a child, and the
    // live session's config.toml stays byte-for-byte and inode-for-inode
    // its own prepareConfig's write.
    const fake = fakeCodexEnv({ version: "codex-cli 0.159.3" });
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    const baseUrl = "http://127.0.0.1:9/v1";
    const hash = createHash("sha256").update(baseUrl).digest("hex").slice(0, 12);
    const keyed = join(isolatedHome, ".codex", ".codemux-provider", `session-home-${hash}-${THREAD_ID}`);
    const args = [
      "session", "-a", "codex", "--no-sandbox", "--auto", "high",
      "--cwd", workdir, "--shutdown-grace", "2",
      "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
    ];
    try {
      // Session one: fresh, run to a resumable end so the keyed home
      // exists with its config and the record is ended.
      const first = await driveSession(args, overrideEnv(fake, isolatedHome, workdir));
      try {
        first.send({ type: "user", text: "scenario:basic hello" });
        await first.waitFor("turn_completed", (event) => event.type === "turn_completed");
        first.send({ type: "shutdown" });
        expect((await first.exit)[0]).toBe(0);
      } finally {
        await first.proc.kill();
      }

      // The winner: the resume that claims and goes live — the second
      // env.jsonl entry is its keyed-home child.
      const winner = await driveSession([...args, "--resume", THREAD_ID], overrideEnv(fake, isolatedHome, workdir));
      try {
        winner.send({ type: "user", text: "scenario:basic again" });
        await winner.waitFor("session_started", (event) => event.type === "session_started");
        expect(recordedHomes(fake)).toHaveLength(2);
        expect(recordedHomes(fake)[1]).toBe(keyed);

        // What the loser must not touch, while the winner is live.
        const configBefore = readFileSync(join(keyed, "config.toml"), "utf8");
        const inodeBefore = statSync(join(keyed, "config.toml")).ino;

        // The loser: a second resume of the id the winner holds. It runs
        // under the same fake PATH, so had it opened the home or spawned
        // a child, env.jsonl would carry a third record.
        const loser = Bun.spawn(
          [join(import.meta.dir, "..", "bin", "codemux"), ...args, "--resume", THREAD_ID],
          {
            cwd: join(import.meta.dir, ".."),
            stdout: "ignore",
            stderr: "pipe",
            stdin: "ignore",
            env: {
              ...process.env,
              CODEMUX_NO_KEYCHAIN_SYNC: "1",
              ...overrideEnv(fake, isolatedHome, workdir),
            } as Record<string, string>,
          }
        );
        const loserStderr = new Response(loser.stderr).text();
        expect(await loser.exited).toBe(78);
        expect(await loserStderr).toContain("session_busy");

        // The live session's config is byte-for-byte what its own
        // prepareConfig wrote, still the same file, and the loser never
        // spawned a child.
        expect(readFileSync(join(keyed, "config.toml"), "utf8")).toBe(configBefore);
        expect(statSync(join(keyed, "config.toml")).ino).toBe(inodeBefore);
        expect(recordedHomes(fake)).toHaveLength(2);

        winner.send({ type: "shutdown" });
        expect((await winner.exit)[0]).toBe(0);
      } finally {
        await winner.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("a session that never adopted a thread id leaves no home behind", async () => {
    // The settle rule's other arm: a fresh session whose handshake never
    // completes (the fake stalls the initialize) adopts no id, so its end
    // removes the home instead of settling it onto a key.
    const fake = fakeCodexEnv({ version: "codex-cli 0.159.3" });
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-home-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    try {
      const session = await driveSession(
        [
          "session", "-a", "codex", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD,FAKE_STALL_INIT",
        ],
        { ...overrideEnv(fake, isolatedHome, workdir), FAKE_STALL_INIT: "1" }
      );
      try {
        // Wait for the spawn to make its home (the fake records it on
        // start), then end the session before any session_started can
        // exist. A fixed 500 ms sleep failed under a host load average of
        // 40, before the fake had written its record.
        const deadline = Date.now() + 10_000;
        while (!existsSync(join(fake.stateDir, "env.jsonl")) && Date.now() < deadline) {
          await Bun.sleep(25);
        }
        const homes = recordedHomes(fake);
        expect(homes).toHaveLength(1);
        expect(homes[0]?.split("/").pop()).toMatch(/^run-\d+-/);
        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);
        // Nothing survives: no run-shaped dir, no session-keyed one.
        const parent = join(isolatedHome, ".codex", ".codemux-provider");
        expect(existsSync(homes[0] as string)).toBe(false);
        expect(existsSync(parent) ? readdirSync(parent) : []).toEqual([]);
      } finally {
        await session.proc.kill();
      }
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 30_000);
});


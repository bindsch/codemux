import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import * as sessionHome from "../src/session/opencode-home.js";
import { opencodeLaunchFixture } from "./helpers/session-opencode-launch.js";
import { outcomeEvents, waitForEvent } from "./helpers/session-command.js";
import { registerNoLeakedSignals } from "./helpers/signal-listeners.js";

registerNoLeakedSignals();
type Fixture = ReturnType<typeof opencodeLaunchFixture>;
type Turn = Awaited<ReturnType<Fixture["run"]>>;
const mode = (path: string): number => statSync(path).mode & 0o777;
function started(turn: Turn) {
  expect(turn.exitCode, turn.stderr).toBe(0);
  expect(turn.stderr).toBe("");
  expect(turn.driveError).toBeUndefined();
  expect(turn.events.find((event) => event.type === "turn_completed")?.finish).toBe("end");
  const event = turn.events.find((entry) => entry.type === "session_started")!;
  return { id: event.session_id as string, home: event.private_home as string | null };
}

test("OpenCode launcher keeps private native state across turns, resume, and final", async () => {
  const s = opencodeLaunchFixture();
  try {
    const first = started(await s.run(["--hermetic"], async ({ chunks, stdin }) => {
      for (let turn = 1; turn <= 2; turn++) {
        stdin.write('{"type":"user","text":"scenario:basic synthetic turn"}\n');
        await waitForEvent(chunks, `turn ${turn}`, (event) => event.type === "turn_completed" && event.turn_id === `t${turn}`, 3_000);
      }
    }));
    const expected = join(s.parent, `session-${first.id}`);
    expect(first.home).toBe(expected);
    expect(s.record().harness_home).toBe(expected);
    expect(s.record().hermetic).toBe(true);
    expect([mode(s.parent), mode(expected)]).toEqual([0o700, 0o700]);
    expect(mode(join(expected, ".local", "share", "opencode", "auth.json"))).toBe(0o600);
    expect(existsSync(join(s.dataDir, "opencode.db"))).toBe(false);
    const consumer = join(expected, "consumer-state");
    writeFileSync(consumer, "kept", { mode: 0o600 });
    const resumed = started(await s.run(["--hermetic", "--resume", first.id]));
    expect(resumed).toEqual(first);
    expect(readFileSync(consumer, "utf8")).toBe("kept");
    const observations = s.observations();
    expect(observations.map((entry) => entry.previous)).toEqual([false, true, true]);
    expect(observations[0]!.dataHome).not.toBe(join(expected, ".local", "share"));
    for (const observation of observations.slice(1)) expect(observation.dataHome).toBe(join(expected, ".local", "share"));
    expect(new Set(observations.map((entry) => entry.home)).size).toBe(3);
    expect(new Set(observations.map((entry) => entry.configHome)).size).toBe(3);
    const policies = s.sandboxes();
    for (const argv of policies.slice(1)) {
      expect(argv).toContain(expected);
      expect(argv).not.toContain(observations[0]!.dataHome.replace(/\/\.local\/share$/, ""));
    }
    const final = await s.run(["--hermetic", "--resume", first.id, "--final"]);
    expect(started(final)).toEqual(first);
    expect(final.events.at(-1)?.resumable).toBe(false);
    expect(existsSync(expected)).toBe(false);
    expect(readdirSync(s.parent)).toEqual([]);
  } finally { s.cleanup(); }
});

test("OpenCode preview prints the actual native resume and provider carriers without a turn", async () => {
  const s = opencodeLaunchFixture();
  s.env.CODEMUX_OPENCODE_PROVIDER_BASE_URL = "http://127.0.0.1:9/v1";
  s.env.CODEMUX_OPENCODE_PROVIDER_API_KEY = "synthetic-key";
  s.env.CODEMUX_OPENCODE_PROVIDER_MODEL = "synthetic-model";
  try {
    const first = started(await s.run(["--hermetic"]));
    const registry = readFileSync(s.registryFile, "utf8");
    const database = readFileSync(join(first.home!, ".local", "share", "opencode", "opencode.db"));
    const preview = await s.launch(["--hermetic", "--resume", first.id, "--print-sandbox", "--tools", "none"]);
    expect(preview.exitCode, preview.stderr).toBe(0);
    const argv = preview.stdout.trim().split("\n");
    expect(argv).toContain("--session");
    expect(argv).toContain(first.id);
    expect(argv).toContain(`XDG_DATA_HOME=${join(first.home!, ".local", "share")}`);
    expect(argv).toContain('OPENCODE_PERMISSION={"*":"deny"}');
    expect(argv).toContain("codemux/synthetic-model");
    expect(argv.some((arg) => arg.startsWith("OPENCODE_CONFIG="))).toBe(true);
    expect(preview.stdout).not.toContain("synthetic-key");
    expect(s.observations()).toHaveLength(1);
    expect(s.sandboxes()).toHaveLength(1);
    expect(readFileSync(s.registryFile, "utf8")).toBe(registry);
    expect(readFileSync(join(first.home!, ".local", "share", "opencode", "opencode.db"))).toEqual(database);
    expect(readdirSync(s.parent)).toEqual([`session-${first.id}`]);
  } finally { s.cleanup(); }
});

test("OpenCode fresh preview creates no temporary homes, registry, or native process", async () => {
  const s = opencodeLaunchFixture();
  try {
    const preview = await s.launch(["--hermetic", "--print-sandbox"]);
    expect(preview.exitCode, preview.stderr).toBe(0);
    expect(preview.stdout).toContain("XDG_DATA_HOME=");
    expect(preview.stdout).toContain("--pure\nrun\n--format\njson");
    expect(existsSync(s.registryFile)).toBe(false);
    expect(existsSync(join(s.state, "observations.jsonl"))).toBe(false);
    expect(existsSync(s.parent)).toBe(false);
    expect(s.sandboxes()).toEqual([]);
  } finally { s.cleanup(); }
});

test("OpenCode launcher delivers tools none on resume and restores default tools", async () => {
  const s = opencodeLaunchFixture();
  try {
    const first = started(await s.run(["--hermetic", "--tools", "none"]));
    const plantedConfig = join(first.home!, ".config", "opencode");
    mkdirSync(plantedConfig, { recursive: true });
    writeFileSync(join(plantedConfig, "opencode.json"), '{"agent":{"build":{"permission":{"bash":"allow"}}}}');
    started(await s.run(["--hermetic", "--resume", first.id, "--tools", "none"]));
    started(await s.run(["--hermetic", "--resume", first.id, "--tools", "default"]));
    const [initial, denied, restored] = s.observations();
    for (const observation of [initial!, denied!]) {
      expect(observation.config?.permission).toBe("deny");
      expect(observation.permission).toBe('{"*":"deny"}');
      expect(observation.configHome).not.toBe(join(first.home!, ".config"));
    }
    expect(restored!.config?.permission).toBeUndefined();
    expect(restored!.permission).toBeNull();
  } finally { s.cleanup(); }
});

test("OpenCode launcher carries trusted native Playwright MCP configuration on resume", async () => {
  const s = opencodeLaunchFixture();
  try {
    const first = started(await s.run(["--enable-playwright-mcp"]));
    expect(first.home).toBeNull();
    expect(s.record().playwright_mcp).toBe(true);
    started(await s.run(["--enable-playwright-mcp", "--resume", first.id]));
    for (const observation of s.observations()) {
      expect(observation.config?.mcp?.playwright).toMatchObject({ type: "local", enabled: true });
      expect(observation.config?.mcp?.playwright.command).toHaveLength(1);
      expect(observation.config?.mcp?.playwright.command[0]).toEndWith("/playwright-mcp");
    }
    const calls = readFileSync(join(s.state, "argv.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls[1].args).toContain("--session");
    expect(calls[1].args).toContain(first.id);
  } finally { s.cleanup(); }
});

test("OpenCode launcher interruption leaves the session usable for the next turn", async () => {
  const s = opencodeLaunchFixture();
  try {
    const outcome = await s.run(["--hermetic"], async ({ chunks, stdin }) => {
      stdin.write('{"type":"user","text":"scenario:wait canceled"}\n');
      await waitForEvent(chunks, "native start", (event) => event.type === "session_started", 3_000);
      stdin.write('{"type":"interrupt"}\n');
      await waitForEvent(chunks, "interrupted completion", (event) => event.type === "turn_completed", 3_000);
      stdin.write('{"type":"user","text":"scenario:basic next turn"}\n');
      await waitForEvent(chunks, "second completion", (event) => event.type === "turn_completed" && event.turn_id === "t2", 3_000);
    });
    expect(outcome.exitCode, outcome.stderr).toBe(0);
    expect(outcome.driveError).toBeUndefined();
    const turns = outcomeEvents([outcome.stdout]).filter((event) => event.type === "turn_completed");
    expect(turns.map((event) => event.finish)).toEqual(["interrupted", "end"]);
    expect(s.observations()).toHaveLength(2);
    expect(outcome.events.at(-1)?.resumable).toBe(true);
  } finally { s.cleanup(); }
});

test("OpenCode launcher rejects a replaced Playwright executable after asynchronous preparation", async () => {
  const s = opencodeLaunchFixture();
  const prepare = OpencodeAdapter.prototype.prepareRun;
  try {
    const outcome = await s.launch(["--enable-playwright-mcp"], {
      stdin: new PassThrough(),
      setup: () => {
        const mock = spyOn(OpencodeAdapter.prototype, "prepareRun").mockImplementation(function (this: OpencodeAdapter, request) {
          const context = prepare.call(this, request);
          const executable = Bun.which("playwright-mcp", { PATH: this.executionPathEnv() })!;
          writeFileSync(executable, "#!/bin/sh\nexit 98\n", { mode: 0o700 });
          return context;
        });
        return () => mock.mockRestore();
      },
      drive: async ({ chunks, stdin }) => {
        try {
          stdin.write('{"type":"user","text":"scenario:basic refused"}\n');
          await waitForEvent(chunks, "refused spawn", (event) => event.type === "session_ended", 3_000);
        } finally { stdin.end('{"type":"shutdown"}\n'); }
      },
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain("changed");
    expect(existsSync(join(s.state, "observations.jsonl"))).toBe(false);
    expect(s.sandboxes()).toEqual([]);
  } finally { s.cleanup(); }
});

test("OpenCode launcher turn timeout interrupts the native child", async () => {
  const s = opencodeLaunchFixture();
  try {
    // The deadline must outlast the fake's start-up: a kill before its
    // step_start (the line that names the session) fails the first turn
    // instead of interrupting it. 0.1 s lost that race under a loaded gate.
    const outcome = await s.run(["--hermetic", "--turn-timeout", "2"], async ({ chunks, stdin }) => {
      stdin.write('{"type":"user","text":"scenario:wait timeout"}\n');
      // Under the suite's 10 s per-test timeout (package.json), so this
      // wait's own message is the one a missed deadline reports.
      await waitForEvent(chunks, "deadline completion", (event) => event.type === "turn_completed", 7_000);
    });
    expect(outcome.exitCode, outcome.stderr).toBe(0);
    expect(outcome.driveError).toBeUndefined();
    expect(outcome.events.find((event) => event.type === "turn_completed")?.finish).toBe("interrupted");
    expect(outcome.events.at(-1)?.resumable).toBe(true);
  } finally { s.cleanup(); }
});

test("OpenCode refused caller block cleans the unspawned provider and turn homes", async () => {
  const s = opencodeLaunchFixture();
  s.env.CODEMUX_OPENCODE_PROVIDER_BASE_URL = "http://127.0.0.1:9/v1";
  s.env.CODEMUX_OPENCODE_PROVIDER_API_KEY = "synthetic-key";
  s.env.CODEMUX_OPENCODE_PROVIDER_MODEL = "synthetic-model";
  try {
    const providerParent = join(s.dataDir, ".codemux");
    const outcome = await s.run(["--hermetic", "--sandbox-block", providerParent]);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.driveError).toBeUndefined();
    expect(outcome.stdout).toContain("--sandbox-block");
    expect(existsSync(join(s.state, "observations.jsonl"))).toBe(false);
    expect(readdirSync(providerParent)).toEqual([]);
    expect(readdirSync(s.parent)).toEqual([]);
  } finally { s.cleanup(); }
});

test("OpenCode failed final cleanup retains resumable state and gets no generic CLI removal", async () => {
  const s = opencodeLaunchFixture();
  const open = sessionHome.openOpenCodeSessionHome;
  try {
    const first = started(await s.run(["--hermetic"]));
    let attempts = 0;
    const failed = await s.run(["--hermetic", "--resume", first.id, "--final"], undefined, {
      setup: () => {
        const mock = spyOn(sessionHome, "openOpenCodeSessionHome").mockImplementation((input) => {
          const home = open(input);
          home.remove = () => { attempts++; return false; };
          return home;
        });
        return () => mock.mockRestore();
      },
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.driveError).toBeUndefined();
    expect(attempts).toBe(2);
    expect(failed.events.at(-1)?.resumable).toBe(true);
    expect(existsSync(first.home!)).toBe(true);
    expect(s.record().ended).toBeTruthy();
    expect(started(await s.run(["--hermetic", "--resume", first.id, "--final"]))).toEqual(first);
    expect(existsSync(first.home!)).toBe(false);
  } finally { s.cleanup(); }
});

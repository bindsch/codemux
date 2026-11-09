/** Launcher-level session tests for the turn-per-process agents: the
 * seven second-wave drivers (cursor, droid, pi, qwen, gemini, copilot,
 * goose) and hermetic aider through the real `codemux session` command
 * over the scenario fakes — fresh, resume, and --final sharing one
 * settled private home (tests/helpers/session-turn-launch.ts), the
 * no-home hermetic modes (qwen; cursor plain), and the override
 * refusals the driver arm owns. */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRegistry } from "../src/session/registry.js";
import { readProviderOverride } from "../src/provider-override.js";
import { piNativeSessionDir } from "../src/pi-launch.js";
import { runSessionCommand } from "./helpers/session-command.js";
import { refusingCall } from "./helpers/session-cli-hermetic.js";
import { HOME_AGENTS, stateRoot, turnLaunchFixture } from "./helpers/session-turn-launch.js";
import { registerNoLeakedSignals } from "./helpers/signal-listeners.js";

registerNoLeakedSignals();

/** The fixture env with undefined entries dropped, for env readers. */
const definedOnly = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));

const mode = (path: string): number => statSync(path).mode & 0o777;
type Fixture = ReturnType<typeof turnLaunchFixture>;
type Turn = Awaited<ReturnType<Fixture["run"]>>;

function started(turn: Turn) {
  expect(turn.exitCode, turn.stderr).toBe(0);
  expect(turn.stderr).toBe("");
  expect(turn.driveError).toBeUndefined();
  expect(turn.events.find((event) => event.type === "turn_completed")?.finish).toBe("end");
  expect(turn.events.find((event) => event.type === "assistant_message")?.text)
    .toStartWith("Done:");
  const event = turn.events.find((entry) => entry.type === "session_started")!;
  expect(typeof event?.session_id).toBe("string");
  return {
    id: event.session_id as string,
    home: event.private_home as string | null,
    ended: turn.events.at(-1)!,
  };
}

/** goose's hermetic mode has no home content to carry, so its provider is
 * the override alone — the adapter's validation wants the full triple
 * (base URL, key, model). */
const armGooseOverride = (fixture: Fixture): void => {
  fixture.env.CODEMUX_GOOSE_PROVIDER_BASE_URL = "http://127.0.0.1:9/v1";
  fixture.env.CODEMUX_GOOSE_PROVIDER_API_KEY = "synthetic-provider-key";
  fixture.env.CODEMUX_GOOSE_PROVIDER_MODEL = "synthetic-model";
};

describe("turn-per-process sessions through the launcher", () => {
  test.each(HOME_AGENTS)("%s: fresh, resume, and final share the settled private home", async (agent) => {
    const s = turnLaunchFixture(agent);
    if (agent === "goose") armGooseOverride(s);
    try {
      const first = started(await s.run(["--hermetic"]));
      const expected = join(s.parent, `session-${first.id}`);
      expect(first.home).toBe(expected);
      expect(existsSync(expected)).toBe(true);
      expect(mode(s.parent)).toBe(0o700);
      expect(mode(expected)).toBe(0o700);
      const record = s.record();
      expect(record.hermetic).toBe(true);
      expect(record.agent).toBe(agent);
      expect(record.harness_home).toBe(expected);
      expect(record.ended).toBeTruthy();
      // Regression (the codex family's): the record must match what a
      // resume's resolveSessionContext computes for the same id — under
      // goose's provider override, which the record's provider identity
      // pins (read the way the CLI reads it, from the environment).
      const override = agent === "goose"
        ? readProviderOverride("goose", { ...process.env, ...definedOnly(s.env) })
        : null;
      const resolved = refusingCall(() => s.context(first.id, true, override));
      expect(resolved.code).toBeNull();
      expect(resolved.value?.harnessHome).toBe(record.harness_home);
      expect(resolved.value?.resumeProbe.harnessHome).toBe(record.harness_home);

      const initial = s.observations()[0]!;
      // The deferred identities (droid, goose) name no id at spawn, so
      // the home starts run-shaped and settles at the adopt; everyone
      // else (pi, gemini, copilot, aider) opens the settled name.
      if (s.deferred) {
        expect(initial.redirected.startsWith(`${s.parent}/`)).toBe(true);
        expect(initial.redirected).not.toBe(expected);
        expect(existsSync(initial.redirected)).toBe(false);
      } else {
        expect(initial.redirected).toBe(expected);
      }
      expect(initial.mode).toBe(0o700);
      expect(initial.previous).toBeNull();
      expect(initial.state).not.toBeNull();
      // A consumer file written inside the home survives the resume —
      // the session's state is the home's, not a fresh copy per turn.
      const consumer = join(expected, "synthetic-consumer-state");
      writeFileSync(consumer, "kept\n", { mode: 0o600 });

      const resumed = started(await s.run(["--hermetic", "--resume", first.id]));
      expect([resumed.id, resumed.home]).toEqual([first.id, expected]);
      expect(s.record().harness_home).toBe(record.harness_home);
      expect(existsSync(expected)).toBe(true);
      expect(readFileSync(consumer, "utf8")).toBe("kept\n");
      const second = s.observations()[1]!;
      expect(second.redirected).toBe(expected);
      expect(second.previous).toBe(initial.state);
      expect(second.state).toBe(initial.state);

      const final = started(await s.run(["--hermetic", "--resume", first.id, "--final"]));
      expect([final.id, final.home]).toEqual([first.id, expected]);
      const last = s.observations()[2]!;
      expect(last.redirected).toBe(expected);
      expect(existsSync(expected)).toBe(false);
      expect(readdirSync(s.parent)).toEqual([]);
      // The final's removal settled removed, so the record answers not
      // resumable — for the agents whose DRIVER owns the removal. Aider's
      // is CLI-owned (cli.ts's finally removes the home after the
      // children settle), so its end event answers before the removal;
      // a later --resume then refuses at the transcript guard, the
      // codex/kimi/agy rule.
      if (agent !== "aider") expect(final.ended.resumable).toBe(false);
      // Every turn went through the fake sandbox at read-only autonomy.
      const sandboxes = readFileSync(join(s.state, "scode.txt"), "utf8")
        .split("BEGIN\n").filter(Boolean).map((block) => block.trim().split("\n"));
      expect(sandboxes).toHaveLength(3);
      for (const argv of sandboxes) expect(argv).toContain("--ro");
    } finally { s.cleanup(); }
  }, 30_000);

  test("aider: the hermetic home carries the history file flat inside it", async () => {
    const s = turnLaunchFixture("aider");
    try {
      const first = started(await s.run(["--hermetic"]));
      const expected = join(s.parent, `session-${first.id}`);
      // The history file is the home's first content (aider-session.ts):
      // flat at <home>/history.md, so a failed start record's removal
      // takes the whole home.
      expect(existsSync(join(expected, "history.md"))).toBe(true);
      const resumed = started(await s.run(["--hermetic", "--resume", first.id]));
      expect(resumed.home).toBe(expected);
      expect(existsSync(join(expected, "history.md"))).toBe(true);
      const final = started(await s.run(["--hermetic", "--resume", first.id, "--final"]));
      expect(final.home).toBe(expected);
      expect(existsSync(expected)).toBe(false);
    } finally { s.cleanup(); }
  }, 30_000);

  test("qwen: hermetic runs with no private home; --final decides about nothing", async () => {
    const s = turnLaunchFixture("qwen");
    try {
      const first = started(await s.run(["--hermetic"]));
      expect(first.home).toBeNull();
      expect(s.record().hermetic).toBe(true);
      expect(s.record().harness_home).toBe(stateRoot(s.home, "qwen"));
      expect(existsSync(s.parent)).toBe(false);
      const final = started(await s.run(["--hermetic", "--resume", first.id, "--final"]));
      expect([final.id, final.home]).toEqual([first.id, null]);
      // No home existed to remove, but --final still stamps the record
      // final (turn-driver-core.ts: a null home removes vacuously), so
      // the end answers not resumable — the caller asked to end finally,
      // and the record obeys.
      expect(final.ended.resumable).toBe(false);
    } finally { s.cleanup(); }
  }, 30_000);

  test("cursor: a plain session runs and resumes against the recorded brand home", async () => {
    const s = turnLaunchFixture("cursor");
    try {
      const first = started(await s.run([]));
      expect(first.home).toBeNull();
      const record = s.record();
      expect(record.hermetic).toBe(false);
      expect(record.harness_home).toBe(stateRoot(s.home, "cursor"));
      const resumed = started(await s.run(["--resume", first.id]));
      expect([resumed.id, resumed.home]).toEqual([first.id, null]);
      expect(s.record().harness_home).toBe(record.harness_home);
      // No redirect: every turn ran under the fixture home itself.
      for (const observation of s.observations()) {
        expect(observation.redirected).toBe(s.home);
      }
    } finally { s.cleanup(); }
  }, 30_000);
});

describe("turn-per-process override refusals", () => {
  test("goose: --hermetic without the provider override refuses with 64 and opens no home", async () => {
    const s = turnLaunchFixture("goose");
    try {
      const outcome = await runSessionCommand(s.args(["--hermetic"]), s.binaries,
        { registryFile: s.registryFile, env: s.env, setup: s.setup });
      expect(outcome.exitCode).toBe(64);
      expect(outcome.stderr).toContain("goose --hermetic requires the provider override");
      expect(existsSync(s.parent)).toBe(false);
      expect(existsSync(join(s.state, "homes.jsonl"))).toBe(false);
      const read = readRegistry(s.registryFile);
      expect(read.outcome === "ok" ? read.file.sessions : []).toEqual([]);
    } finally { s.cleanup(); }
  });

  test("pi: a plain session with the override set runs on the native session store", async () => {
    const s = turnLaunchFixture("pi");
    s.env.CODEMUX_PI_PROVIDER_BASE_URL = "http://127.0.0.1:9/v1";
    s.env.CODEMUX_PI_PROVIDER_API_KEY = "synthetic-provider-key";
    s.env.CODEMUX_PI_PROVIDER_MODEL = "synthetic-model";
    try {
      const first = started(await s.run([]));
      expect(first.home).toBeNull();
      expect(s.record().hermetic).toBe(false);
      expect(s.record().harness_home).toBe(stateRoot(s.home, "pi"));
      expect(existsSync(s.parent)).toBe(false);
      const resumed = started(await s.run(["--resume", first.id]));
      expect(resumed.home).toBeNull();
      // Both turns name the override's model selector and the one native
      // session store under the recorded harness home: the plain session
      // keeps its conversation in pi's own store, not a private home.
      const native = piNativeSessionDir(stateRoot(s.home, "pi"), s.workdir);
      const turns = readFileSync(join(s.state, "argv.jsonl"), "utf8")
        .trim().split("\n").map((line) => (JSON.parse(line) as { args: string[] }).args);
      expect(turns).toHaveLength(2);
      for (const args of turns) {
        expect(args[args.indexOf("--session-dir") + 1]).toBe(native);
        expect(args[args.indexOf("--model") + 1]).toBe("codemux/synthetic-model");
      }
    } finally { s.cleanup(); }
  }, 30_000);

  test("pi: an override hermetic session without --model refuses with 64", async () => {
    const s = turnLaunchFixture("pi");
    s.env.CODEMUX_PI_PROVIDER_BASE_URL = "http://127.0.0.1:9/v1";
    s.env.CODEMUX_PI_PROVIDER_API_KEY = "synthetic-provider-key";
    try {
      const outcome = await runSessionCommand(s.args(["--hermetic"]), s.binaries,
        { registryFile: s.registryFile, env: s.env, setup: s.setup });
      expect(outcome.exitCode).toBe(64);
      expect(outcome.stderr).toContain("pi needs a model for the provider override");
      expect(existsSync(s.parent)).toBe(false);
    } finally { s.cleanup(); }
  });
});

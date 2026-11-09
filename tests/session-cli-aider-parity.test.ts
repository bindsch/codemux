/** Public session-command integration over the existing fake PATH launcher. */
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { aiderSessionModelSettingsPath } from "../src/session/aider-model-settings.js";
import { outcomeEvents, runSessionCommand, waitForEvent } from "./helpers/session-command.js";
import { turnLaunchFixture } from "./helpers/session-turn-launch.js";
import { registerNoLeakedSignals } from "./helpers/signal-listeners.js";

registerNoLeakedSignals();

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
const capSettings = (cap: number) => [{ name: "aider/extra_params", extra_params: { max_tokens: cap } }];
type Observation = {
  args: string[]; yesAlways: string | null; settingsPath: string;
  settings: unknown; settingsMode: number;
};

function fixture() {
  const s = turnLaunchFixture("aider");
  const observer = join(import.meta.dir, "fixtures/live/fake-aider-parity-observe.ts");
  s.binaries.aider = s.binaries.aider!.replace("exec bun ", `exec bun --preload ${quote(observer)} `);
  return Object.assign(s, {
    observed: (): Observation[] => readFileSync(join(s.state, "parity.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line)),
  });
}
type Fixture = ReturnType<typeof fixture>;
type Turn = Awaited<ReturnType<Fixture["run"]>>;

function started(turn: Turn) {
  expect(turn.exitCode, turn.stderr).toBe(0);
  expect(turn.stderr).toBe("");
  expect(turn.driveError).toBeUndefined();
  expect(turn.events.at(-1)?.type).toBe("session_ended");
  expect(turn.events.filter((event) => event.type === "turn_completed").map((event) => event.finish))
    .toEqual(["end"]);
  const event = turn.events.find((entry) => entry.type === "session_started")!;
  expect((event.capabilities as { interrupt: boolean }).interrupt).toBe(true);
  return { id: event.session_id as string, home: event.private_home as string | null };
}

function provider(s: Fixture, cap: number) {
  Object.assign(s.env, {
    CODEMUX_AIDER_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
    CODEMUX_AIDER_PROVIDER_API_KEY: "synthetic-provider-key",
    CODEMUX_AIDER_PROVIDER_MODEL: "synthetic-model",
    CODEMUX_AIDER_PROVIDER_MAX_OUTPUT_TOKENS: String(cap),
  });
}

const completed = (chunks: string[], id: string) => waitForEvent(chunks, id,
  (event) => event.type === "turn_completed" && event.turn_id === id, 3_000);

async function drive(s: Fixture, flags: string[], body: (chunks: string[], stdin: PassThrough) => Promise<void>) {
  const stdin = new PassThrough();
  let driveError: unknown;
  const outcome = await runSessionCommand(s.args(flags), s.binaries, {
    env: s.env, registryFile: s.registryFile, setup: s.setup, stdin,
    drive: async ({ chunks }) => {
      try { await body(chunks, stdin); }
      catch (error) { driveError = error; }
      finally { stdin.end(JSON.stringify({ type: "shutdown" }) + "\n"); }
    },
  });
  expect(driveError).toBeUndefined();
  expect(outcome.exitCode, outcome.stderr).toBe(0);
  expect(outcome.stderr).toBe("");
  return outcomeEvents([outcome.stdout]);
}

const send = (stdin: PassThrough, message: Record<string, string>) => stdin.write(JSON.stringify(message) + "\n");

async function preview(s: Fixture, flags: string[]) {
  let detail = "";
  const result = await runSessionCommand(s.args([...flags, "--print-sandbox"]), s.binaries, {
    env: s.env, registryFile: s.registryFile,
    setup: () => {
      const restore = s.setup();
      const stderr = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
        detail += chunk.toString();
        return true;
      }) as typeof process.stderr.write);
      return () => { stderr.mockRestore(); restore(); };
    },
  });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(detail).toContain('placeholder prompt "codemux session"');
  return result.stdout.trim().split("\n");
}

describe("Aider parity through the session launcher", () => {
  test.each([false, true])("tools can be removed on each resume and restored; hermetic=%s", async (hermetic) => {
    const s = fixture();
    const mode = [...(hermetic ? ["--hermetic"] : []), "--auto", "high"];
    try {
      const first = started(await s.run([...mode, "--tools", "none"]));
      expect(started(await s.run([...mode, "--resume", first.id, "--tools", "none"]))).toEqual(first);
      expect(started(await s.run([...mode, "--resume", first.id, "--tools", "default"]))).toEqual(first);
      const observations = s.observed();
      expect(observations).toHaveLength(3);
      for (const { args } of observations.slice(0, 2)) {
        expect(flag(args, "--chat-mode")).toBe("ask");
        expect(flag(args, "--map-tokens")).toBe("0");
        for (const option of ["--no-git", "--no-detect-urls", "--no-auto-lint",
          "--no-auto-test", "--no-suggest-shell-commands"]) expect(args).toContain(option);
      }
      const restored = observations[2]!.args;
      expect(restored).not.toContain("--no-git");
      expect(restored).not.toContain("--chat-mode");
      expect(restored).toContain("--restore-chat-history");
      expect(observations.map(({ args }) => flag(args, "--chat-history-file")))
        .toEqual(Array(3).fill(flag(restored, "--chat-history-file")));
    } finally { s.cleanup(); }
  });

  test.each([false, true])("deny overrides native grants at the child; hermetic=%s", async (hermetic) => {
    const s = fixture();
    // Inject a grant after the launcher's environment filtering so the
    // actual command prefix must override it at the child boundary.
    s.binaries.scode = 'export AIDER_YES_ALWAYS=true\n' + s.binaries.scode;
    const flags = [...(hermetic ? ["--hermetic"] : []), "--auto", "high"];
    try {
      const first = started(await s.run([...flags, "--permission-policy", "deny"]));
      started(await s.run([...flags, "--resume", first.id, "--permission-policy", "deny"]));
      started(await s.run([...flags, "--resume", first.id, "--permission-policy", "default"]));
      const observations = s.observed();
      expect(observations).toHaveLength(3);
      for (const observation of observations.slice(0, 2)) {
        expect(observation.yesAlways).toBe("false");
        expect(observation.args).not.toContain("--yes-always");
      }
      expect(observations[2]!.yesAlways).toBe("true");
      expect(observations[2]!.args).toContain("--yes-always");
      const declines = readFileSync(join(s.state, "declines.jsonl"), "utf8").trim().split("\n");
      expect(declines).toHaveLength(3);
      for (const line of declines) expect(JSON.parse(line).input).toMatch(/^(n\n)+$/);
    } finally { s.cleanup(); }
  });

  test.each(["interrupt", "timeout"])("%s stops an active child, rolls history back, and permits another turn", async (kind) => {
    const s = fixture();
    try {
      const flags = ["--hermetic", ...(kind === "timeout" ? ["--turn-timeout", "1"] : [])];
      let history = "";
      const events = await drive(s, flags, async (chunks, stdin) => {
        send(stdin, { type: "user", text: "scenario:basic previous" });
        await completed(chunks, "t1");
        history = flag(s.observed()[0]!.args, "--chat-history-file")!;
        const before = readFileSync(history, "utf8");
        send(stdin, { type: "user", text: "scenario:wait canceled" });
        const deadline = Date.now() + 3_000;
        while (!readFileSync(history, "utf8").includes("scenario:wait canceled")) {
          if (Date.now() > deadline) throw new Error("synthetic turn did not reach its history write");
          await Bun.sleep(10);
        }
        if (kind === "interrupt") send(stdin, { type: "interrupt" });
        expect((await completed(chunks, "t2")).finish).toBe("interrupted");
        expect(readFileSync(history, "utf8")).toBe(before);
        send(stdin, { type: "user", text: "scenario:basic after" });
        expect((await completed(chunks, "t3")).finish).toBe("end");
      });
      expect(events.filter((event) => event.type === "turn_completed").map((event) => event.finish))
        .toEqual(["end", "interrupted", "end"]);
      expect(events.at(-1)?.resumable).toBe(true);
      expect(events.filter((event) => event.type === "input_rejected")).toEqual([]);
      expect(s.observed()).toHaveLength(3);
      expect(readFileSync(history, "utf8")).not.toContain("canceled");
      const id = events.find((event) => event.type === "session_started")!.session_id as string;
      expect(started(await s.run(["--hermetic", "--resume", id])).id).toBe(id);
    } finally { s.cleanup(); }
  });

  test.each([false, true])("output caps reach every child and can change on resume; hermetic=%s", async (hermetic) => {
    const s = fixture();
    const flags = hermetic ? ["--hermetic"] : [];
    provider(s, 512);
    try {
      const events = await drive(s, flags, async (chunks, stdin) => {
        send(stdin, { type: "user", text: "scenario:basic first cap" });
        await completed(chunks, "t1");
        writeFileSync(s.observed()[0]!.settingsPath, JSON.stringify(capSettings(999999)));
        send(stdin, { type: "user", text: "scenario:basic second cap" });
        await completed(chunks, "t2");
      });
      const id = events.find((event) => event.type === "session_started")!.session_id as string;
      provider(s, 32);
      started(await s.run([...flags, "--resume", id]));
      const observations = s.observed();
      expect(observations.map((entry) => entry.settings)).toEqual([capSettings(512), capSettings(512), capSettings(32)]);
      for (const observation of observations) {
        expect(observation.settingsMode).toBe(0o600);
        expect(observation.settingsPath).toBe(aiderSessionModelSettingsPath(flag(observation.args, "--chat-history-file")!));
        expect(observation.args.filter((arg) => arg === "--model-settings-file")).toHaveLength(1);
        expect(flag(observation.args, "--model")).toBe("openai/synthetic-model");
        expect(flag(observation.args, "--weak-model")).toBe("openai/synthetic-model");
        expect(observation.args).not.toContain("synthetic-provider-key");
      }
    } finally { s.cleanup(); }
  });

  test.each([false, true])("sandbox previews are pure before launch and resume; hermetic=%s", async (hermetic) => {
    const s = fixture();
    provider(s, 512);
    const flags = [...(hermetic ? ["--hermetic"] : []), "--auto", "high", "--tools", "none",
      "--permission-policy", "deny"];
    try {
      const fresh = await preview(s, flags);
      const history = flag(fresh, "--chat-history-file")!;
      expect(fresh).toContain("--message=codemux session");
      expect(fresh).toContain("AIDER_YES_ALWAYS=false");
      expect(fresh).toContain("--no-git");
      expect(fresh).not.toContain("--yes-always");
      expect(flag(fresh, "--model")).toBe("openai/synthetic-model");
      expect(flag(fresh, "--model-settings-file")).toBe(aiderSessionModelSettingsPath(history));
      expect(existsSync(dirname(history))).toBe(false);
      expect(existsSync(s.registryFile)).toBe(false);
      expect(readdirSync(s.state)).toEqual([]);
      const first = started(await s.run(flags));
      const observation = s.observed()[0]!;
      const realHistory = flag(observation.args, "--chat-history-file")!;
      const before = [s.registryFile, realHistory, observation.settingsPath].map((path) => readFileSync(path, "utf8"));
      const resumed = await preview(s, [...flags, "--resume", first.id]);
      expect(flag(resumed, "--chat-history-file")).toBe(realHistory);
      expect(flag(resumed, "--model-settings-file")).toBe(observation.settingsPath);
      expect([s.registryFile, realHistory, observation.settingsPath].map((path) => readFileSync(path, "utf8"))).toEqual(before);
      expect(s.observed()).toHaveLength(1);
      if (hermetic) expect(resumed).toContain(`HOME=${first.home}`);
    } finally { s.cleanup(); }
  });
});

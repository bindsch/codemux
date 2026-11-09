import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { AGY_MIRROR_PATH } from "../src/agy-keychain.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { runSessionCommand } from "./helpers/session-command.js";
import { HERMETIC_AGENTS, hermeticFixture, refusingCall } from "./helpers/session-cli-hermetic.js";
import { registerNoLeakedSignals } from "./helpers/signal-listeners.js";

registerNoLeakedSignals();

const mode = (path: string): number => statSync(path).mode & 0o777;
type Fixture = ReturnType<typeof hermeticFixture>;
type Turn = Awaited<ReturnType<Fixture["run"]>>;

function started(turn: Turn) {
  expect(turn.exitCode, turn.stderr).toBe(0);
  expect(turn.stderr).toBe("");
  expect(turn.driveError).toBeUndefined();
  expect(turn.events.find((event) => event.type === "turn_completed")?.finish).toBe("end");
  expect(turn.events.at(-1)?.type).toBe("session_ended");
  const event = turn.events.find((entry) => entry.type === "session_started")!;
  expect(typeof event?.session_id).toBe("string");
  return { id: event.session_id as string, home: event.private_home as string };
}

function assertPrivateFiles(s: Fixture, home: string) {
  expect(mode(s.parent)).toBe(0o700);
  expect(mode(home)).toBe(0o700);
  expect(mode(join(home, "synthetic-session-state"))).toBe(0o600);
  if (s.agent === "codex") {
    expect(mode(join(home, ".codex"))).toBe(0o700);
    expect(mode(join(home, ".codex", "config.toml"))).toBe(0o600);
    expect(statSync(join(home, ".codex", "auth.json")).ino)
      .toBe(statSync(join(s.home, ".codex", "auth.json")).ino);
  } else if (s.agent === "kimi") {
    expect(mode(join(home, ".kimi-code"))).toBe(0o700);
    expect(mode(join(home, "skills-dir"))).toBe(0o700);
    for (const name of ["config.toml", "region", "device_id"]) {
      expect(mode(join(home, ".kimi-code", name))).toBe(0o600);
    }
    expect(readFileSync(join(home, ".kimi-code", "region"), "utf8")).toBe("synthetic-region");
  } else {
    expect(mode(s.harnessHome(home))).toBe(0o700);
    expect(mode(join(home, AGY_MIRROR_PATH))).toBe(0o600);
  }
}

describe("hermetic sessions through the launcher", () => {
  test("codex: run finalization preserves the session home for resume", async () => {
    const s = hermeticFixture("codex");
    const getRunEnv = CodexAdapter.prototype.getRunEnv;
    let finalized = 0;
    try {
      const first = started(await s.run(["--hermetic"], {
        setup: () => {
          const restore = s.setup();
          const env = spyOn(CodexAdapter.prototype, "getRunEnv").mockImplementation(function (this: CodexAdapter, request, context) {
            const result = getRunEnv.call(this, request, context);
            if (context?.hermeticHome !== undefined) {
              context.hermeticHome.finalize();
              finalized++;
            }
            return result;
          });
          return () => { env.mockRestore(); restore(); };
        },
      }));
      expect(finalized).toBeGreaterThan(0);
      expect(existsSync(first.home)).toBe(true);
      expect(started(await s.run(["--hermetic", "--resume", first.id, "--final"]))).toEqual(first);
      expect(existsSync(first.home)).toBe(false);
    } finally { s.cleanup(); }
  }, 30_000);

  test.each(HERMETIC_AGENTS)("%s: fresh, resume, and final share the settled private home", async (agent) => {
    const s = hermeticFixture(agent);
    try {
      const first = started(await s.run(["--hermetic"]));
      const expected = join(s.parent, `session-${first.id}`);
      expect(first.home).toBe(expected);
      expect(existsSync(expected)).toBe(true);
      assertPrivateFiles(s, expected);
      const record = s.record();
      expect(record.hermetic).toBe(true);
      expect(record.agent).toBe(agent);
      expect(record.harness_home).toBe(s.harnessHome(expected));
      expect(record.ended).toBeTruthy();

      // Regression: passing the parent to settledPrivateHomePath dropped
      // one directory. The real record must match resolveSessionContext.
      const resolved = refusingCall(() => s.context(first.id));
      expect(resolved.code).toBeNull();
      expect(resolved.value?.harnessHome).toBe(record.harness_home);
      expect(resolved.value?.resumeProbe.harnessHome).toBe(record.harness_home);

      const initial = s.observations()[0]!;
      expect(dirname(initial.home)).toBe(s.parent);
      expect(basename(initial.home)).toMatch(/^run-/);
      expect(initial.mode).toBe(0o700);
      expect(initial.previous).toBeNull();
      expect(existsSync(initial.home)).toBe(false);
      const policy = agent === "agy" ? join(s.harnessHome(expected), "settings.json")
        : join(expected, agent === "codex" ? ".codex" : ".kimi-code", "config.toml");
      const contents = agent === "agy" ? '{"synthetic_policy":true}\n'
        : `${readFileSync(policy, "utf8")}\n# synthetic consumer policy\n`;
      writeFileSync(policy, contents, { mode: 0o600 });

      const resumed = started(await s.run(["--hermetic", "--resume", first.id]));
      expect(resumed).toEqual(first);
      expect(s.record().harness_home).toBe(record.harness_home);
      expect(existsSync(expected)).toBe(true);
      expect(readFileSync(policy, "utf8")).toBe(contents);
      const second = s.observations()[1]!;
      expect(second.home).toBe(expected);
      expect(second.previous).toBe(initial.state);
      expect(second.state).toBe(initial.state);
      if (agent === "codex") expect(second.codexHome).toBe(join(expected, ".codex"));
      if (agent === "kimi") expect(second.kimiHome).toBe(s.harnessHome(expected));

      const final = started(await s.run(["--hermetic", "--resume", first.id, "--final"]));
      expect(final).toEqual(first);
      const last = s.observations()[2]!;
      expect(last.home).toBe(expected);
      expect(last.previous).toBe(initial.state);
      expect(existsSync(expected)).toBe(false);
      expect(readdirSync(s.parent)).toEqual([]);
      // Every command went through the fake sandbox at read-only autonomy.
      const sandboxes = readFileSync(join(s.state, "scode.txt"), "utf8")
        .split("BEGIN\n").filter(Boolean).map((block) => block.trim().split("\n"));
      expect(sandboxes).toHaveLength(3);
      for (const argv of sandboxes) expect(argv).toContain("--ro");
    } finally { s.cleanup(); }
  }, 30_000);

  test("codex: provider override writes config inside the private CODEX_HOME", async () => {
    const s = hermeticFixture("codex");
    s.env.CODEMUX_CODEX_PROVIDER_BASE_URL = "http://127.0.0.1:9/v1";
    s.env.CODEMUX_CODEX_PROVIDER_API_KEY = "synthetic-provider-key";
    s.env.CODEMUX_CODEX_PROVIDER_MODEL = "synthetic-model";
    try {
      const first = started(await s.run(["--hermetic"]));
      const path = join(first.home, ".codex", "config.toml");
      const config = readFileSync(path, "utf8");
      expect(config).toContain('model = "synthetic-model"');
      expect(config).toContain('base_url = "http://127.0.0.1:9/v1"');
      expect(config).toContain('env_key = "CODEMUX_CODEX_PROVIDER_API_KEY"');
      expect(config).not.toContain("synthetic-provider-key");
      expect(mode(path)).toBe(0o600);
      expect(existsSync(join(first.home, ".codex", "auth.json"))).toBe(false);
      expect(existsSync(join(s.home, ".codex", ".codemux-provider"))).toBe(false);
      expect(s.observations()[0]?.config).toBe(config);
      expect(s.observations()[0]?.hasProviderKey).toBe(true);
      expect(s.record().harness_home).toBe(first.home);
      const final = started(await s.run(["--hermetic", "--resume", first.id, "--final"]));
      expect(final).toEqual(first);
      expect(s.observations()[1]?.codexHome).toBe(join(first.home, ".codex"));
      expect(s.observations()[1]?.config).toBe(config);
      expect(s.observations()[1]?.hasProviderKey).toBe(true);
      expect(existsSync(first.home)).toBe(false);
    } finally { s.cleanup(); }
  }, 30_000);

  test("the shared launcher blocks operator config and permits only the private Claude home", async () => {
    const s = hermeticFixture("codex");
    try {
      const outcome = await runSessionCommand([
        "-a", "claude", "-s", "--hermetic", "--auto", "read-only", "--cwd", s.workdir,
        "--print-sandbox",
      ], { claude: "printf '2.1.280\\n'", scode: "exit 99" }, {
        registryFile: s.registryFile, env: s.env, setup: s.setup,
      });
      expect(outcome.exitCode, outcome.stderr).toBe(0);
      const argv = outcome.stdout.trim().split("\n");
      const values = (flag: string) => argv.filter((_, index) => argv[index - 1] === flag);
      expect(values("--block")).toEqual([join(s.home, ".claude"), join(s.home, ".claude.json")]);
      const allowed = values("--allow");
      expect(allowed).toHaveLength(1);
      expect(dirname(allowed[0]!)).toBe(join(s.home, ".claude", ".codemux-hermetic"));
      expect(basename(allowed[0]!)).toMatch(/^session-/);
      expect(argv.indexOf("--block")).toBeLessThan(argv.indexOf("--allow"));
      expect(existsSync(allowed[0]!)).toBe(false);
      expect(existsSync(s.registryFile)).toBe(false);
    } finally { s.cleanup(); }
  });
});

describe("hermetic resume refusals", () => {
  test("agy: a surviving private home without login is refused before another spawn", async () => {
    const s = hermeticFixture("agy");
    try {
      const first = started(await s.run(["--hermetic"]));
      renameSync(join(first.home, AGY_MIRROR_PATH), join(s.root, "saved-mirror"));
      s.env.GEMINI_API_KEY = undefined;
      const outcome = await s.run(["--hermetic", "--resume", first.id]);
      expect(outcome.exitCode).toBe(64);
      // The verify names the login arm the home was populated with (the
      // API-key arm here) and refuses; the shared tail is the contract.
      expect(outcome.stderr).toContain("cannot resume unauthenticated");
      expect(s.observations()).toHaveLength(1);
      expect(existsSync(first.home)).toBe(true);
      expect(s.record().ended).toBeTruthy();
    } finally { s.cleanup(); }
  }, 30_000);

  test.each(HERMETIC_AGENTS)("%s: removing --hermetic refuses with 78 before another launch", async (agent) => {
    const s = hermeticFixture(agent);
    try {
      const first = started(await s.run(["--hermetic"]));
      const before = readFileSync(s.registryFile, "utf8");
      const refused = refusingCall(() => s.context(first.id, false));
      expect(refused.code).toBe(78);
      expect(refused.message).toContain("hermetic");
      const cli = await runSessionCommand(s.args(["--resume", first.id]), s.binaries,
        { registryFile: s.registryFile, env: s.env, setup: s.setup });
      expect(cli.exitCalls[0]).toBe(78);
      expect(cli.stdout).toBe("");
      expect(readFileSync(s.registryFile, "utf8")).toBe(before);
      expect(s.observations()).toHaveLength(1);
      expect(existsSync(first.home)).toBe(true);
    } finally { s.cleanup(); }
  }, 30_000);

  test.each(HERMETIC_AGENTS)("%s: adding --hermetic to a plain record refuses with 78", async (agent) => {
    const s = hermeticFixture(agent);
    try {
      const first = started(await s.run([]));
      expect(first.home).toBeNull();
      expect(s.record().hermetic).toBe(false);
      const refused = refusingCall(() => s.context(first.id));
      expect(refused.code).toBe(78);
      expect(refused.message).toContain("cannot resume");
      const cli = await runSessionCommand(s.args(["--resume", first.id, "--hermetic"]), s.binaries,
        { registryFile: s.registryFile, env: s.env, setup: s.setup });
      expect(cli.exitCalls[0]).toBe(78);
      expect(cli.stdout).toBe("");
      expect(s.observations()).toHaveLength(1);
      expect(existsSync(s.parent)).toBe(false);
    } finally { s.cleanup(); }
  }, 30_000);

  test.each(HERMETIC_AGENTS)("%s: a missing private home refuses with 78 and is not recreated", async (agent) => {
    const s = hermeticFixture(agent);
    try {
      const first = started(await s.run(["--hermetic"]));
      renameSync(first.home, join(s.root, "saved-private-home"));
      const refused = refusingCall(() => s.context(first.id));
      expect(refused.code).toBe(78);
      expect(refused.message).toContain("transcript");
      const cli = await runSessionCommand(s.args(["--resume", first.id, "--hermetic"]), s.binaries,
        { registryFile: s.registryFile, env: s.env, setup: s.setup });
      expect(cli.exitCalls[0]).toBe(78);
      expect(cli.stdout).toBe("");
      expect(existsSync(first.home)).toBe(false);
      expect(s.observations()).toHaveLength(1);
    } finally { s.cleanup(); }
  }, 30_000);
});

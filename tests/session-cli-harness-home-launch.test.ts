import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { providerOverrideEnvNames } from "../src/provider-override.js";
import * as processTable from "../src/process-table.js";
import * as cliHomes from "../src/session/cli-homes.js";
import * as registry from "../src/session/registry.js";
import * as runtime from "../src/cli-runtime.js";
import { ClaudeCredentialAdapter } from "../src/adapters/claude-credentials.js";
import { ZaiAdapter } from "../src/adapters/zai.js";
import { outcomeEvents, removeDir, runSessionCommand, tempWorkdir, waitForEvent } from "./helpers/session-command.js";
import { type HomeObservation } from "./helpers/session-cli-hermetic.js";
import { registerNoLeakedSignals } from "./helpers/signal-listeners.js";

registerNoLeakedSignals();

type Agent = "claude" | "zai" | "codex";
const AGENTS: Agent[] = ["claude", "zai", "codex"];
const PASS_ENV = ["FAKE_STATE_DIR", "CODEMUX_TEST_SCODE_ARGV"];
const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
const CODEX_LOGIN = '{"token":"synthetic-file-login"}\n';
const claudeLogin = (access: string, refresh = ""): string =>
  `${JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh }, mcpOAuth: { s: { refreshToken: "synthetic-mcp" } } })}\n`;
const accessOnly = (access: string) => ({ claudeAiOauth: { accessToken: access, refreshToken: "" } });
const jsonLines = <T>(path: string): T[] => existsSync(path)
  ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as T)
  : [];

function fixture(agent: Agent) {
  const root = tempWorkdir(`caller-launch-${agent}`);
  const home = join(root, "operator");
  const workdir = join(root, "work");
  const state = join(root, "state");
  const caller = join(root, "caller");
  const registryFile = join(home, ".codemux", "live-sessions.json");
  for (const path of [home, workdir, state, join(home, ".claude"), join(home, ".codex")]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const loginName = agent === "codex" ? "auth.json" : ".credentials.json";
  const sourceLogin = join(home, agent === "codex" ? ".codex" : ".claude", loginName);
  const targetLogin = join(caller, agent === "codex" ? ".codex" : "", loginName);
  writeFileSync(sourceLogin, agent === "codex" ? CODEX_LOGIN : claudeLogin("synthetic-access-a"), { mode: 0o600 });
  writeFileSync(join(home, ".claude", "settings.json"), '{"operator_only":true}\n');
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "operator-only"\n');
  const env: Record<string, string | undefined> = {
    HOME: home, USERPROFILE: undefined,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local", "state"),
    CODEMUX_NO_KEYCHAIN_SYNC: "1", FAKE_STATE_DIR: state,
    CODEMUX_TEST_SCODE_ARGV: join(state, "scode.txt"),
    CODEX_HOME: undefined, CLAUDE_CONFIG_DIR: undefined, KIMI_CODE_HOME: undefined,
    CODEX_API_KEY: undefined, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined,
    ZAI_API_KEY: agent === "zai" ? "synthetic-zai-token" : undefined,
    CODEMUX_CODEX_PROVIDER_MULTI_AGENT: undefined, CODEMUX_CODEX_PROVIDER_STORE: undefined,
    CODEMUX_ALLOW_UNTESTED_HARNESS: undefined,
  };
  for (const id of AGENTS) {
    for (const name of Object.values(providerOverrideEnvNames(id))) env[name] = undefined;
  }
  const script = join(import.meta.dir, "fixtures", "live",
    agent === "codex" ? "fake-codex-app-server.ts" : "fake-claude-session.ts");
  const observer = join(import.meta.dir, "helpers", "session-cli-hermetic-observe.ts");
  const binaries = {
    [agent === "codex" ? "codex" : "claude"]:
      "export CODEMUX_NO_KEYCHAIN_SYNC=1\n" +
      `if [ "$1" = "--version" ]; then printf '${agent === "codex" ? "codex-cli 0.159.3" : "2.1.280"}\\n'; exit 0; fi\n` +
      `exec bun --preload ${quote(observer)} ${quote(script)} "$@"`,
    scode: "export CODEMUX_NO_KEYCHAIN_SYNC=1\n" +
      'printf "%s\\n" "$HOME" "$XDG_CONFIG_HOME" >> "$CODEMUX_TEST_SCODE_ARGV.home"\n' +
      "printf 'BEGIN\\n' >> \"$CODEMUX_TEST_SCODE_ARGV\"\nprintf '%s\\n' \"$@\" >> \"$CODEMUX_TEST_SCODE_ARGV\"\n" +
      'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\n' +
      '[ "$#" -gt 0 ] || exit 99\nshift\nexec "$@"',
  };
  const setup = () => {
    const mocks = [
      spyOn(cliHomes, "codexHarnessHome").mockReturnValue(join(home, ".codex")),
      spyOn(cliHomes, "claudeFamilyHarnessHome").mockImplementation((pass) =>
        pass.includes("CLAUDE_CONFIG_DIR") && process.env.CLAUDE_CONFIG_DIR
          ? process.env.CLAUDE_CONFIG_DIR : join(home, ".claude")),
      spyOn(processTable, "readProcessTable").mockReturnValue(new Map()),
    ];
    return () => { for (const mock of mocks) mock.mockRestore(); };
  };
  const args = (flags: string[]) => [
    "-a", agent, "-s", "--auto", "read-only", "--cwd", workdir,
    "--timeout", "5", "--shutdown-grace", "1", "--pass-env", PASS_ENV.join(","), ...flags,
  ];
  const invoke = (flags: string[]) => runSessionCommand(args(flags), binaries, { registryFile, env, setup });
  const run = async (flags: string[], turns = 1) => {
    const stdin = new PassThrough();
    let driveError: unknown;
    const result = await runSessionCommand(args(flags), binaries, {
      registryFile, env, setup, stdin,
      drive: async ({ chunks }) => {
        try {
          for (let index = 0; index < turns; index++) {
            stdin.write(`${JSON.stringify({ type: "user", text: `scenario:basic synthetic turn ${index + 1}` })}\n`);
            await waitForEvent(chunks, `turn ${index + 1}`, (event) =>
              event.type === "session_ended" ||
              outcomeEvents(chunks).filter((entry) => entry.type === "turn_completed").length > index, 3_000);
          }
        } catch (error) { driveError = error; }
        finally { stdin.end(`${JSON.stringify({ type: "shutdown" })}\n`); }
      },
    });
    return { ...result, driveError, events: outcomeEvents([result.stdout]) };
  };
  return {
    agent, root, home, workdir, caller, state, registryFile, sourceLogin, targetLogin, env, run, invoke,
    flags: ["--harness-home", caller],
    observations: () => jsonLines<HomeObservation>(join(state, "homes.jsonl")),
    record: () => {
      const result = registry.readRegistry(registryFile);
      if (result.outcome !== "ok" || result.file.sessions.length !== 1) throw new Error("expected one session");
      return result.file.sessions[0]!;
    },
    cleanup: () => removeDir(root),
  };
}

type Fixture = ReturnType<typeof fixture>;
type Turn = Awaited<ReturnType<Fixture["run"]>>;

function started(turn: Turn, turns = 1): string {
  expect(turn.exitCode, turn.stderr).toBe(0);
  expect(turn.stderr).toBe("");
  expect(turn.driveError).toBeUndefined();
  const completed = turn.events.filter((event) => event.type === "turn_completed");
  expect(completed).toHaveLength(turns);
  for (const event of completed) expect(event.finish).toBe("end");
  expect(turn.events.at(-1)?.type).toBe("session_ended");
  const event = turn.events.find((entry) => entry.type === "session_started")!;
  expect(typeof event?.session_id).toBe("string");
  return event.session_id as string;
}

function sandboxPolicy(argv: string[], s: Fixture) {
  const values = (flag: string) => argv.filter((_, index) => argv[index - 1] === flag);
  expect(values("--allow")).toEqual([s.caller]);
  const blocks = values("--block");
  for (const path of [".claude", ".claude.json", ".codex", ".kimi-code", ".gemini", ".zai"]) {
    expect(blocks).toContain(join(s.home, path));
  }
  expect(argv.lastIndexOf("--block")).toBeLessThan(argv.indexOf("--allow"));
  expect(argv).toContain("--ro");
}

test("Claude OAuth-token authentication needs no file login", async () => {
  const s = fixture("claude");
  try {
    renameSync(s.sourceLogin, join(s.root, "saved-login"));
    s.env.CLAUDE_CODE_OAUTH_TOKEN = "synthetic-oauth-token";
    started(await s.run(s.flags));
    expect(existsSync(s.targetLogin)).toBe(false);
  } finally { s.cleanup(); }
});

// Review R420 M1: the Claude copy is rebuilt after async preflight, so a
// rename refresh of the operator mirror in that window reaches the child.
test("claude rebuilds the access-only login after async sandbox preflight", async () => {
  const s = fixture("claude");
  const original = runtime.assertCompatibleScode;
  const preflight = spyOn(runtime, "assertCompatibleScode").mockImplementation(async (...args) => {
    await original(...args);
    writeFileSync(join(s.root, "staged-login"), claudeLogin("synthetic-access-b"), { mode: 0o600 });
    renameSync(join(s.root, "staged-login"), s.sourceLogin);
  });
  try {
    started(await s.run(s.flags));
    expect(JSON.parse(readFileSync(s.targetLogin, "utf8"))).toEqual(accessOnly("synthetic-access-b"));
    expect(statSync(s.targetLogin).ino).not.toBe(statSync(s.sourceLogin).ino);
  } finally { preflight.mockRestore(); s.cleanup(); }
});

// Review R420 B1: a refresh-token mirror refuses the caller-home launch, and
// the sandboxed guard runs for --harness-home sessions too.
test("claude refuses a caller-home launch whose mirror carries a refresh token", async () => {
  const s = fixture("claude");
  try {
    writeFileSync(s.sourceLogin, claudeLogin("synthetic-access-a", "synthetic-refresh"), { mode: 0o600 });
    const outcome = await s.invoke(s.flags);
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.stderr).toContain("holds a refresh token");
    expect(existsSync(s.targetLogin)).toBe(false);
    expect(s.observations()).toHaveLength(0);
  } finally { s.cleanup(); }
});

test.each(["claude", "zai"] as Agent[])("%s runs the sandboxed mirror guard for a caller home", async (agent) => {
  const s = fixture(agent);
  const proto = agent === "zai" ? ZaiAdapter.prototype : ClaudeCredentialAdapter.prototype;
  const guard = spyOn(proto, "prepareSandbox");
  try {
    started(await s.run(s.flags));
    expect(guard).toHaveBeenCalledTimes(1);
    const context = guard.mock.calls[0]![0] as { passthroughEnv?: string[] };
    expect(context.passthroughEnv).not.toContain("CLAUDE_CONFIG_DIR");
  } finally { guard.mockRestore(); s.cleanup(); }
});

test("codex rechecks the login after async sandbox preflight", async () => {
  const agent: Agent = "codex";
  const s = fixture(agent);
  const original = runtime.assertCompatibleScode;
  let changed = false;
  const preflight = spyOn(runtime, "assertCompatibleScode").mockImplementation(async (...args) => {
    await original(...args);
    if (existsSync(s.targetLogin) && !changed) {
      renameSync(s.targetLogin, join(s.root, "saved-private-login"));
      writeFileSync(s.targetLogin, "planted-after-preflight");
      changed = true;
    }
  });
  try {
    const outcome = await s.invoke(s.flags);
    expect(changed).toBe(true);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("login link changed");
    expect(s.observations()).toHaveLength(0);
  } finally { preflight.mockRestore(); s.cleanup(); }
});

test.each(["claude", "zai"] as Agent[])("%s cannot drop caller isolation through the same config path", async (agent) => {
  const s = fixture(agent);
  try {
    s.env.CLAUDE_CONFIG_DIR = join(s.root, "alternate-profile");
    mkdirSync(s.env.CLAUDE_CONFIG_DIR, { recursive: true });
    if (agent === "claude") writeFileSync(join(s.env.CLAUDE_CONFIG_DIR, ".credentials.json"), claudeLogin("alternate-access"), { mode: 0o600 });
    const pass = ["--pass-env", [...PASS_ENV, "CLAUDE_CONFIG_DIR"].join(",")];
    const id = started(await s.run([...s.flags, ...pass]));
    s.env.CLAUDE_CONFIG_DIR = s.caller;
    const outcome = await s.invoke(["--resume", id, ...pass]);
    expect(outcome.exitCalls[0]).toBe(78);
    expect(outcome.stderr).toContain("cannot gain or lose --harness-home");
    expect(s.observations()).toHaveLength(1);
  } finally { s.cleanup(); }
});

test("Claude secure storage stays inside the caller home", async () => {
  const s = fixture("claude");
  try {
    const secure = join(s.root, "alternate-secure-storage");
    s.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = secure;
    const outcome = await s.invoke([
      ...s.flags, "--print-sandbox", "--pass-env", [...PASS_ENV, "CLAUDE_SECURESTORAGE_CONFIG_DIR"].join(","),
    ]);
    expect(outcome.exitCode, outcome.stderr).toBe(0);
    const argv = outcome.stdout.trim().split("\n");
    expect(argv).toContain(`CLAUDE_SECURESTORAGE_CONFIG_DIR=${s.caller}`);
    expect(argv.filter((_, index) => argv[index - 1] === "--block")).toContain(secure);
  } finally { s.cleanup(); }
});

test("Claude copies only the independently redirected secure-storage login", async () => {
  const s = fixture("claude");
  const secure = join(s.root, "alternate-secure-storage");
  mkdirSync(secure);
  const login = join(secure, ".credentials.json");
  writeFileSync(login, claudeLogin("synthetic-alternate-access"), { mode: 0o600 });
  s.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = secure;
  try {
    started(await s.run(s.flags));
    expect(JSON.parse(readFileSync(s.targetLogin, "utf8"))).toEqual(accessOnly("synthetic-alternate-access"));
    expect(statSync(s.targetLogin).ino).not.toBe(statSync(login).ino);
  } finally { s.cleanup(); }
});

test("a legacy record with the same path cannot gain caller-owned mode", async () => {
  const s = fixture("claude");
  try {
    const id = started(await s.run(s.flags));
    const file = JSON.parse(readFileSync(s.registryFile, "utf8"));
    delete file.sessions[0].caller_owned_home;
    writeFileSync(s.registryFile, JSON.stringify(file));
    const outcome = await s.invoke([...s.flags, "--resume", id]);
    expect(outcome.exitCalls[0]).toBe(78);
    expect(outcome.stderr).toContain("cannot gain or lose --harness-home");
    expect(s.observations()).toHaveLength(1);
    file.sessions[0].caller_owned_home = "true";
    writeFileSync(s.registryFile, JSON.stringify(file));
    expect(registry.readRegistry(s.registryFile).outcome).toBe("corrupt");
  } finally { s.cleanup(); }
});

describe("caller harness homes through the session CLI", () => {
  test.each(AGENTS)("%s: two turns, restart, and final preserve the caller home", async (agent) => {
    const s = fixture(agent);
    try {
      const initial = await s.run(s.flags, 2);
      const id = started(initial, 2);
      expect(initial.events.find((event) => event.type === "session_started")?.private_home).toBe(s.caller);
      const first = s.observations()[0]!;
      expect(first.home).toBe(s.caller);
      expect(first.previous).toBeNull();
      expect(first.mode).toBe(0o700);
      expect(s.record().hermetic).toBe(false);
      expect(s.record().caller_owned_home).toBe(true);
      expect(s.record().harness_home).toBe(s.caller);
      expect(s.record().ended).toBeTruthy();
      const configRoot = agent === "codex" ? join(s.caller, ".codex") : s.caller;
      const policy = join(configRoot, agent === "codex" ? "config.toml" : "settings.json");
      expect(existsSync(policy)).toBe(false);
      expect(readdirSync(configRoot).filter((name) => ![".cache", ".config", ".local"].includes(name)).sort()).toEqual(agent === "codex" ? ["auth.json"]
        : agent === "claude" ? [".credentials.json", "synthetic-session-state"] : ["synthetic-session-state"]);
      const contents = agent === "codex" ? 'model = "caller-model"\n' : '{"caller_policy":true}\n';
      writeFileSync(policy, contents, { mode: 0o600 });
      const instructions = join(configRoot, agent === "codex" ? "AGENTS.md" : "CLAUDE.md");
      writeFileSync(instructions, "Caller instructions persist.\n");
      if (agent === "zai") {
        expect(existsSync(s.targetLogin)).toBe(false);
      } else if (agent === "claude") {
        expect(JSON.parse(readFileSync(s.targetLogin, "utf8"))).toEqual(accessOnly("synthetic-access-a"));
        expect(statSync(s.targetLogin).nlink).toBe(1);
      } else {
        expect(lstatSync(s.targetLogin).isSymbolicLink()).toBe(false);
        expect(statSync(s.targetLogin).ino).toBe(statSync(s.sourceLogin).ino);
        expect(statSync(s.targetLogin).dev).toBe(statSync(s.sourceLogin).dev);
        expect(statSync(s.targetLogin).nlink).toBeGreaterThanOrEqual(2);
      }
      expect(started(await s.run([...s.flags, "--resume", id]))).toBe(id);
      expect(started(await s.run([...s.flags, "--resume", id, "--final"]))).toBe(id);
      expect(readFileSync(policy, "utf8")).toBe(contents);
      expect(readFileSync(instructions, "utf8")).toBe("Caller instructions persist.\n");
      expect(readFileSync(join(s.caller, "synthetic-session-state"), "utf8")).toBe(first.state);
      expect(s.record().harness_home).toBe(s.caller);
      expect(s.record().hermetic).toBe(false);
      const observations = s.observations();
      expect(observations).toHaveLength(3);
      expect(readFileSync(join(s.state, "scode.txt.home"), "utf8").trim().split("\n"))
        .toEqual(Array.from({ length: 3 }, () => [s.home, join(s.home, ".config")]).flat());
      for (const [index, observation] of observations.entries()) {
        expect(observation.home).toBe(s.caller);
        expect(observation.state).toBe(first.state);
        expect(observation.previous).toBe(index === 0 ? null : first.state);
        if (agent === "codex") expect(observation.codexHome).toBe(join(s.caller, ".codex"));
      }
      const commands = jsonLines<{ args: string[]; pid: number }>(join(s.state, "argv.jsonl"));
      expect(commands).toHaveLength(3);
      expect(new Set(commands.map((command) => command.pid)).size).toBe(3);
      for (const { args } of commands) {
        for (const flag of ["--safe-mode", "--strict-mcp-config", "--disable-slash-commands", "--ignore-rules", "--ignore-user-config"]) {
          expect(args).not.toContain(flag);
        }
        if (agent !== "codex") expect(args[args.indexOf("--setting-sources") + 1]).toBe("user");
      }
      if (agent === "codex") {
        for (const { args } of commands) expect(args).toEqual(["app-server", "-c", 'cli_auth_credentials_store="file"']);
        const requests = jsonLines<{ method: string; params: Record<string, unknown> }>(join(s.state, "requests.jsonl"));
        const threads = requests.filter(({ method }) => method === "thread/start" || method === "thread/resume");
        expect(threads.map(({ method }) => method)).toEqual(["thread/start", "thread/resume", "thread/resume"]);
        // A caller home enables its config. Hermetic project-doc overrides would silently suppress it.
        for (const { params } of threads) expect(params).not.toHaveProperty("config");
        expect(requests.filter(({ method }) => method === "turn/start")).toHaveLength(4);
      } else {
        const environments = jsonLines<{ claude_config_dir: string; anthropic_auth_token: boolean }>(join(s.state, "env.jsonl"));
        expect(environments).toHaveLength(3);
        for (const environment of environments) {
          expect(environment.claude_config_dir).toBe(s.caller);
          expect(environment.anthropic_auth_token).toBe(agent === "zai");
        }
      }
      const sandboxes = readFileSync(join(s.state, "scode.txt"), "utf8")
        .split("BEGIN\n").filter(Boolean).map((block) => block.trim().split("\n"));
      expect(sandboxes).toHaveLength(3);
      for (const argv of sandboxes) sandboxPolicy(argv, s);
    } finally { s.cleanup(); }
  }, 30_000);

  test("codex: provider settings use argv and preserve the seeded caller config", async () => {
    const s = fixture("codex");
    s.env.CODEMUX_CODEX_PROVIDER_BASE_URL = "http://127.0.0.1:9/v1";
    s.env.CODEMUX_CODEX_PROVIDER_API_KEY = "synthetic-provider-key";
    s.env.CODEMUX_CODEX_PROVIDER_MODEL = "synthetic-provider-model";
    const config = join(s.caller, ".codex", "config.toml");
    const contents = 'model = "caller-model"\nproject_doc_max_bytes = 12345\n';
    mkdirSync(join(s.caller, ".codex"), { recursive: true, mode: 0o700 });
    writeFileSync(config, contents, { mode: 0o600 });
    try {
      const id = started(await s.run(s.flags));
      expect(started(await s.run([...s.flags, "--resume", id, "--final"]))).toBe(id);
      expect(readFileSync(config, "utf8")).toBe(contents);
      expect(existsSync(s.targetLogin)).toBe(false);
      expect(existsSync(join(s.home, ".codex", ".codemux-provider"))).toBe(false);
      expect(s.record().harness_home).toBe(s.caller);
      expect(s.record().hermetic).toBe(false);
      const commands = jsonLines<{ args: string[] }>(join(s.state, "argv.jsonl"));
      expect(commands).toHaveLength(2);
      for (const { args } of commands) {
        expect(args).toContain('cli_auth_credentials_store="file"');
        expect(args).toContain('model="synthetic-provider-model"');
        expect(args.join(" ")).toContain('base_url="http://127.0.0.1:9/v1"');
        expect(args.join(" ")).toContain('env_key="CODEMUX_CODEX_PROVIDER_API_KEY"');
        expect(args.join(" ")).not.toContain("synthetic-provider-key");
      }
      for (const observation of s.observations()) {
        expect(observation.home).toBe(s.caller);
        expect(observation.codexHome).toBe(join(s.caller, ".codex"));
        expect(observation.config).toBe(contents);
        expect(observation.hasProviderKey).toBe(true);
      }
    } finally { s.cleanup(); }
  }, 30_000);

  test.each(AGENTS)("%s: print-sandbox grants the root, blocks operator homes, and creates nothing", async (agent) => {
    const s = fixture(agent);
    try {
      const before = readdirSync(s.root);
      const outcome = await s.invoke([...s.flags, "--print-sandbox"]);
      expect(outcome.exitCode, outcome.stderr).toBe(0);
      sandboxPolicy(outcome.stdout.trim().split("\n"), s);
      expect(existsSync(s.caller)).toBe(false);
      expect(existsSync(s.registryFile)).toBe(false);
      expect(s.observations()).toEqual([]);
      expect(readdirSync(s.root)).toEqual(before);
    } finally { s.cleanup(); }
  });

  test.each(AGENTS)("%s: resume refuses an omitted, remapped, or missing caller home", async (agent) => {
    const s = fixture(agent);
    try {
      const id = started(await s.run(s.flags));
      const before = readFileSync(s.registryFile, "utf8");
      const remapped = join(s.root, "other-caller");
      for (const flags of [["--resume", id], ["--harness-home", remapped, "--resume", id]]) {
        const outcome = await s.invoke(flags);
        expect(outcome.exitCalls[0], outcome.stderr).toBe(78);
        expect(outcome.stderr).toContain("home");
        expect(outcome.stdout).toBe("");
      }
      expect(existsSync(remapped)).toBe(false);
      renameSync(s.caller, join(s.root, "saved-caller"));
      const missing = await s.invoke([...s.flags, "--resume", id]);
      expect(missing.exitCalls[0], missing.stderr).toBe(78);
      expect(missing.stderr).toContain("missing");
      expect(existsSync(s.caller)).toBe(false);
      expect(readFileSync(s.registryFile, "utf8")).toBe(before);
      expect(s.observations()).toHaveLength(1);
    } finally { s.cleanup(); }
  }, 30_000);

  test.each(AGENTS)("%s: replacing the caller root with a symlink refuses before restart", async (agent) => {
    const s = fixture(agent);
    try {
      const id = started(await s.run(s.flags));
      const before = readFileSync(s.registryFile, "utf8");
      const saved = join(s.root, "saved-caller");
      renameSync(s.caller, saved);
      symlinkSync(saved, s.caller);
      const outcome = await s.invoke([...s.flags, "--resume", id]);
      expect(outcome.exitCalls[0], outcome.stderr).toBe(64);
      expect(outcome.stderr).toContain("symlink");
      expect(readFileSync(s.registryFile, "utf8")).toBe(before);
      expect(s.observations()).toHaveLength(1);
      expect(readFileSync(join(saved, "synthetic-session-state"), "utf8")).toBe(s.observations()[0]!.state);
    } finally { s.cleanup(); }
  }, 30_000);

  test("claude: a replaced private login is rebuilt and a symlinked one refuses before restart", async () => {
    const s = fixture("claude");
    try {
      const id = started(await s.run(s.flags));
      writeFileSync(s.targetLogin, claudeLogin("planted-access", "planted-refresh"), { mode: 0o600 });
      expect(started(await s.run([...s.flags, "--resume", id]))).toBe(id);
      expect(JSON.parse(readFileSync(s.targetLogin, "utf8"))).toEqual(accessOnly("synthetic-access-a"));
      renameSync(s.targetLogin, join(s.root, "replacement-login"));
      symlinkSync(s.sourceLogin, s.targetLogin);
      const symlinked = await s.invoke([...s.flags, "--resume", id]);
      expect(symlinked.exitCode).not.toBe(0);
      expect(symlinked.stderr).toContain("not a regular file");
      expect(s.observations()).toHaveLength(2);
      expect(readFileSync(s.sourceLogin, "utf8")).toBe(claudeLogin("synthetic-access-a"));
    } finally { s.cleanup(); }
  }, 30_000);

  test("codex: replaced and symlinked private logins refuse before restart", async () => {
    const agent: Agent = "codex";
    const s = fixture(agent);
    try {
      const id = started(await s.run(s.flags));
      renameSync(s.targetLogin, join(s.root, "saved-login"));
      writeFileSync(s.targetLogin, "replacement-login", { mode: 0o600 });
      const replaced = await s.invoke([...s.flags, "--resume", id]);
      expect(replaced.exitCalls[0], replaced.stderr).toBe(64);
      expect(replaced.stderr).toContain("login link changed");
      expect(readFileSync(s.targetLogin, "utf8")).toBe("replacement-login");
      renameSync(s.targetLogin, join(s.root, "replacement-login"));
      symlinkSync(s.sourceLogin, s.targetLogin);
      const symlinked = await s.invoke([...s.flags, "--resume", id]);
      expect(symlinked.exitCalls[0], symlinked.stderr).toBe(64);
      expect(symlinked.stderr).toContain("login link changed");
      expect(s.observations()).toHaveLength(1);
      expect(readFileSync(s.sourceLogin, "utf8")).toBe(CODEX_LOGIN);
    } finally { s.cleanup(); }
  }, 30_000);
});

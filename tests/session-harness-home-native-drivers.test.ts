import { expect, spyOn, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import * as processTable from "../src/process-table.js";
import * as runtime from "../src/cli-runtime.js";
import * as cliHomes from "../src/session/cli-homes.js";
import { readRegistry } from "../src/session/registry.js";
import { providerOverrideEnvNames } from "../src/provider-override.js";
import { outcomeEvents, polledEvents, runSessionCommand, waitForEvent } from "./helpers/session-command.js";
import { registerNoLeakedSignals } from "./helpers/signal-listeners.js";

registerNoLeakedSignals();
type Agent = "kimi" | "opencode" | "agy" | "aider";
const agents: Agent[] = ["kimi", "opencode", "agy", "aider"];
const configPaths: Record<Agent, string> = {
  kimi: ".kimi-code/config.toml", opencode: ".config/opencode/opencode.json",
  agy: ".gemini/antigravity-cli/settings.json", aider: ".aider.conf.yml",
};
const versions: Record<Agent, string> = { kimi: "2.5.2", opencode: "1.19.5", agy: "1.5.3", aider: "aider 0.86.2" };
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const lines = (path: string): Record<string, any>[] => existsSync(path)
  ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

function fixture(agent: Agent) {
  const root = mkdtempSync(resolve("scratch/fix/native-driver-"));
  const operator = join(root, "operator"), caller = join(root, "caller"), cwd = join(root, "work"), state = join(root, "state");
  const registryFile = join(root, "registry", "sessions.json");
  for (const path of [operator, caller, cwd, state]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const config = join(caller, configPaths[agent]);
  mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
  const contents = agent === "kimi" ? '# caller marker\ndefault_model = "caller-model"\n'
    : agent === "aider" ? "# caller marker\nmodel: caller-model\n" : '{"caller_marker":true}\n';
  writeFileSync(config, contents);
  writeFileSync(join(caller, "caller-skill.md"), "Caller skill remains accessible.\n");
  const sourceLogin = join(operator, ".local", "share", "opencode", "auth.json");
  mkdirSync(dirname(sourceLogin), { recursive: true, mode: 0o700 });
  writeFileSync(sourceLogin, '{}\n', { mode: 0o600 });
  const env: Record<string, string | undefined> = {
    HOME: operator, USERPROFILE: undefined, XDG_CONFIG_HOME: join(operator, ".config"),
    XDG_DATA_HOME: join(operator, ".local", "share"), XDG_STATE_HOME: join(operator, ".local", "state"),
    XDG_CACHE_HOME: join(operator, ".cache"), KIMI_CODE_HOME: undefined, OPENCODE_CONFIG_DIR: undefined,
    OPENCODE_CONFIG: undefined, OPENCODE_CONFIG_CONTENT: undefined, OPENCODE_PERMISSION: undefined,
    CODEMUX_NO_KEYCHAIN_SYNC: "1", CODEMUX_ALLOW_UNTESTED_HARNESS: undefined,
    FAKE_STATE_DIR: state, FAKE_NATIVE_AGENT: agent, CODEMUX_TEST_SCODE_ARGV: join(state, "scode.txt"),
    KIMI_API_KEY: "synthetic-kimi-key", GEMINI_API_KEY: "synthetic-gemini-key", OPENAI_API_KEY: "synthetic-openai-key",
  };
  for (const id of agents) for (const name of Object.values(providerOverrideEnvNames(id))) env[name] = undefined;
  const script = join(import.meta.dir, "fixtures", "live", `fake-${agent === "agy" ? "agy-session" : `${agent}-run`}.ts`);
  const observer = join(import.meta.dir, "helpers", "session-harness-home-native-observe.ts");
  const binaries = {
    [agent]: `if [ "$1" = "--version" ]; then printf '%s\\n' '${versions[agent]}'; exit 0; fi\n` +
      `exec bun --preload ${quote(observer)} ${quote(script)} "$@"`,
    scode: 'if [ "$1" = "--help" ]; then printf "%s\\n" "--keep-env"; exit 0; fi\n' +
      'printf "BEGIN\\n" >> "$CODEMUX_TEST_SCODE_ARGV"\nprintf "%s\\n" "$@" >> "$CODEMUX_TEST_SCODE_ARGV"\n' +
      'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\n[ "$#" -gt 0 ] || exit 99\nshift\nexec "$@"',
  };
  const args = (flags: string[]) => ["-a", agent, "-s", "--auto", "low", "--cwd", cwd, "--timeout", "5",
    "--shutdown-grace", "0.1", "--no-author-prefix", "--pass-env", "FAKE_STATE_DIR,FAKE_NATIVE_AGENT,CODEMUX_TEST_SCODE_ARGV", ...flags];
  const setup = () => {
    const mocks = [spyOn(processTable, "readProcessTable").mockReturnValue(new Map()),
      spyOn(cliHomes, "kimiHarnessHome").mockReturnValue(join(operator, ".kimi-code")),
      spyOn(cliHomes, "aiderHarnessHome").mockReturnValue(join(operator, ".aider")),
      spyOn(cliHomes, "agyHarnessHome").mockReturnValue(join(operator, ".gemini", "antigravity-cli"))];
    return () => { for (const mock of mocks) mock.mockRestore(); };
  };
  const invoke = (flags: string[]) => runSessionCommand(args(flags), binaries, { registryFile, env, setup });
  const run = async (flags: string[], turns = 1) => {
    const stdin = new PassThrough();
    let driveError: unknown;
    const result = await runSessionCommand(args(flags), binaries, { registryFile, env, setup, stdin,
      drive: async ({ chunks }) => {
        try {
          for (let index = 0; index < turns; index++) {
            stdin.write(JSON.stringify({ type: "user", text: `scenario:basic turn ${index + 1}` }) + "\n");
            await waitForEvent(chunks, "turn completion", (event) => event.type === "session_ended" ||
              polledEvents(chunks).filter((entry) => entry.type === "turn_completed").length > index, 3000);
          }
        } catch (error) { driveError = error; }
        finally { stdin.end('{"type":"shutdown"}\n'); }
      } });
    return { ...result, driveError, events: outcomeEvents([result.stdout]) };
  };
  const record = () => {
    const registry = readRegistry(registryFile);
    if (registry.outcome !== "ok" || registry.file.sessions.length !== 1) throw new Error("expected one session record");
    return registry.file.sessions[0]!;
  };
  return { root, operator, caller, cwd, state, config, contents, registryFile, sourceLogin, env, run, invoke, record,
    flags: ["--harness-home", caller], observations: () => lines(join(state, "native-homes.jsonl")),
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function started(result: Awaited<ReturnType<ReturnType<typeof fixture>["run"]>>, turns = 1): string {
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.driveError, result.stderr).toBeUndefined();
  expect(result.events.filter((event) => event.type === "turn_completed")).toHaveLength(turns);
  for (const event of result.events.filter((event) => event.type === "turn_completed")) expect(event.finish).toBe("end");
  const event = result.events.find((event) => event.type === "session_started");
  expect(typeof event?.session_id).toBe("string");
  return event!.session_id as string;
}

test.each(agents)("%s CLI keeps caller config, root and registry across two turns, restart and final", async (agent) => {
  const s = fixture(agent);
  try {
    const first = await s.run(s.flags, 2);
    const id = started(first, 2);
    expect(first.events.find((event) => event.type === "session_started")?.private_home).toBe(s.caller);
    expect(s.record().harness_home).toBe(s.caller);
    expect(s.record().caller_owned_home).toBe(true);
    expect(s.record().hermetic).toBe(false);
    expect(started(await s.run([...s.flags, "--resume", id]))).toBe(id);
    expect(started(await s.run([...s.flags, "--resume", id, "--final"]))).toBe(id);
    expect(readFileSync(s.config, "utf8")).toBe(s.contents);
    expect(readFileSync(join(s.caller, "caller-skill.md"), "utf8")).toBe("Caller skill remains accessible.\n");
    expect(s.record().harness_home).toBe(s.caller);
    expect(s.record().final).not.toBe(true);
    const observations = s.observations();
    expect(observations).toHaveLength(agent === "agy" ? 3 : 4);
    for (const observation of observations) {
      expect(observation.home).toBe(s.caller);
      expect(observation.config).toBe(s.contents);
      expect(observation.skill).toBe("Caller skill remains accessible.\n");
      for (const flag of ["--safe-mode", "--disable-slash-commands", "--skills-dir"]) expect(observation.args).not.toContain(flag);
      if (agent === "aider") for (const flag of ["--config", "--env-file"]) expect(observation.args).not.toContain(flag);
    }
    const sandboxes = readFileSync(join(s.state, "scode.txt"), "utf8").split("BEGIN\n").filter(Boolean);
    expect(sandboxes).toHaveLength(observations.length);
    for (const block of sandboxes) expect(block).toContain(`--allow\n${s.caller}\n`);
    const omitted = await s.invoke(["--resume", id]);
    expect(omitted.exitCalls[0], omitted.stderr).toBe(78);
    expect(omitted.stderr).toContain("home");
  } finally { s.cleanup(); }
}, 30_000);

test("OpenCode CLI provider overrides merge with caller customization each turn", async () => {
  const s = fixture("opencode");
  Object.assign(s.env, { CODEMUX_OPENCODE_PROVIDER_BASE_URL: "https://provider.invalid/v1",
    CODEMUX_OPENCODE_PROVIDER_API_KEY: "synthetic-provider-key", CODEMUX_OPENCODE_PROVIDER_MODEL: "example" });
  try {
    started(await s.run(s.flags, 2), 2);
    const observations = s.observations();
    expect(observations).toHaveLength(2);
    expect(new Set(observations.map((value) => value.providerPath)).size).toBe(2);
    for (const observation of observations) {
      expect(observation.providerPath.startsWith(`${s.caller}/`)).toBe(true);
      expect(observation.provider).toContain("provider.invalid");
      expect(observation.providerKey).toBe(true);
      expect(observation.config).toBe(s.contents);
      expect(observation.provider).not.toContain("synthetic-provider-key");
      expect(existsSync(observation.providerPath)).toBe(false);
    }
    expect(readFileSync(s.config, "utf8")).toBe(s.contents);
    expect(existsSync(join(s.operator, ".local", "share", "opencode", ".codemux"))).toBe(false);
  } finally { s.cleanup(); }
}, 15_000);

test.each(agents)("%s CLI sandbox preview carries caller home without creating it", async (agent) => {
  const s = fixture(agent);
  const previewHome = join(s.root, "preview-caller");
  try {
    const result = await s.invoke(["--harness-home", previewHome, "--print-sandbox"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(`HOME=${previewHome}`);
    expect(result.stdout).toContain(`--allow\n${previewHome}\n`);
    expect(existsSync(previewHome)).toBe(false);
    expect(existsSync(s.registryFile)).toBe(false);
    expect(s.observations()).toHaveLength(0);
  } finally { s.cleanup(); }
});

test("Aider caller history remains outside the stale disposable-history sweep", async () => {
  const s = fixture("aider");
  const history = join(s.caller, ".aider", ".codemux", "sessions", "11111111-2222-3333-4444-555555555555", "history.md");
  mkdirSync(dirname(history), { recursive: true, mode: 0o700 });
  writeFileSync(history, "Caller-owned prior conversation.\n", { mode: 0o600 });
  const old = new Date(Date.now() - 40 * 86_400_000);
  utimesSync(history, old, old);
  try {
    started(await s.run(s.flags));
    expect(readFileSync(history, "utf8")).toBe("Caller-owned prior conversation.\n");
  } finally { s.cleanup(); }
});

test.each(agents)("%s CLI refuses caller root replacement during asynchronous sandbox preflight", async (agent) => {
  const s = fixture(agent);
  const original = runtime.assertCompatibleScode;
  let changed = false;
  const preflight = spyOn(runtime, "assertCompatibleScode").mockImplementation(async (...args) => {
    const version = await original(...args);
    if (!changed) {
      renameSync(s.caller, join(s.root, "saved-caller"));
      changed = true;
    }
    return version;
  });
  try {
    const result = await s.run(s.flags);
    expect(changed).toBe(true);
    expect(result.exitCode, result.stderr).not.toBe(0);
    expect(s.observations()).toHaveLength(0);
    expect(readFileSync(join(s.root, "saved-caller", configPaths[agent]), "utf8")).toBe(s.contents);
  } finally { preflight.mockRestore(); s.cleanup(); }
}, 15_000);

// Review R420 audit (M1 class): kimi replaces token files by rename. A caller
// home shares the dedicated store by one directory symlink, and the sandbox
// grants exactly that store beneath the blocked operator brand home.
test("kimi file login shares the real credential store and the sandbox grants only that store", async () => {
  const s = fixture("kimi");
  try {
    s.env.KIMI_API_KEY = undefined; s.env.OPENAI_API_KEY = undefined;
    const store = join(s.operator, ".kimi-code", "credentials");
    mkdirSync(store, { recursive: true, mode: 0o700 });
    writeFileSync(join(store, "kimi-code.json"), '{"synthetic":"token"}\n', { mode: 0o600 });
    started(await s.run(s.flags));
    const shared = join(s.caller, ".kimi-code", "credentials");
    expect(lstatSync(shared).isSymbolicLink()).toBe(true);
    expect(readlinkSync(shared)).toBe(store);
    const block = readFileSync(join(s.state, "scode.txt"), "utf8").split("BEGIN\n").filter(Boolean)[0]!;
    expect(block).toContain(`--block\n${join(s.operator, ".kimi-code")}\n`);
    expect(block).toContain(`--allow\n${s.caller}\n--allow\n${store}\n`);
  } finally { s.cleanup(); }
});

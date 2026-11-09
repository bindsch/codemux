import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { turnLaunchFixture, type TurnLaunchAgent } from "./helpers/session-turn-launch.js";
import { runSessionCommand } from "./helpers/session-command.js";
import { registerNoLeakedSignals } from "./helpers/signal-listeners.js";
import { prepareSessionEnvironment } from "../src/session/cli-environment.js";
import { GeminiAdapter } from "../src/adapters/gemini.js";
import { withKeepEnvExemption } from "../src/sandbox.js";
import * as runtime from "../src/cli-runtime.js";

registerNoLeakedSignals();
const agents: TurnLaunchAgent[] = ["cursor", "droid", "pi", "qwen", "gemini", "copilot", "goose"];

function fixture(agent: TurnLaunchAgent) {
  const f = turnLaunchFixture(agent);
  const caller = join(f.root, "caller");
  const brand = agent === "pi" ? ".pi/agent" : agent === "droid" ? ".factory"
    : agent === "goose" ? "config" : `.${agent}`;
  const callerConfig = join(caller, brand, agent === "goose" ? "config.yaml" : "settings.json");
  mkdirSync(join(caller, brand), { recursive: true });
  const original = agent === "goose" ? "caller_setting: retained\n" : '{"caller_setting":"retained"}\n';
  writeFileSync(callerConfig, original);
  for (const path of [".cursor/auth.json", ".config/cursor/auth.json", ".qwen/oauth_creds.json", ".config/goose/secrets.yaml"]) {
    mkdirSync(join(f.home, path, ".."), { recursive: true });
    // Qwen's caller home receives only access fields rebuilt from a parseable login (qwen-access-login.ts).
    writeFileSync(join(f.home, path), path.endsWith("oauth_creds.json") ? JSON.stringify({ access_token: "synthetic-access",
      token_type: "Bearer", refresh_token: "synthetic-refresh-value", expiry_date: Date.now() + 3_600_000 }) : "synthetic-login");
  }
  for (const name of ["COPILOT_HOME", "GEMINI_CLI_HOME", "PI_CODING_AGENT_DIR", "GOOSE_PATH_ROOT", "CURSOR_CONFIG_DIR", "FACTORY_HOME_OVERRIDE"]) {
    f.env[name] = undefined;
  }
  if (agent === "copilot") {
    f.env.CODEMUX_COPILOT_PROVIDER_BASE_URL = "http://127.0.0.1:9/v1";
    f.env.CODEMUX_COPILOT_PROVIDER_API_KEY = "synthetic-key";
    f.env.CODEMUX_COPILOT_PROVIDER_MODEL = "fixture-model";
  }
  if (agent === "goose") {
    // Goose caller homes require the override: no secrets.yaml is linked (review R420 audit).
    f.env.CODEMUX_GOOSE_PROVIDER_BASE_URL = "http://127.0.0.1:9/v1";
    f.env.CODEMUX_GOOSE_PROVIDER_API_KEY = "synthetic-key";
    f.env.CODEMUX_GOOSE_PROVIDER_MODEL = "fixture-model";
  }
  return { ...f, caller, callerConfig, original, flags: ["--harness-home", caller] };
}

test.each(agents)("%s CLI keeps caller content and identity through restart and final", async (agent) => {
  const f = fixture(agent);
  try {
    const first = await f.run(f.flags);
    expect(first.exitCode, first.stderr).toBe(0);
    expect(first.driveError).toBeUndefined();
    expect(first.events.find((event) => event.type === "turn_completed")?.finish).toBe("end");
    const started = first.events.find((event) => event.type === "session_started")!;
    expect(started.private_home).toBe(f.caller);
    expect(f.record()).toMatchObject({ harness_home: f.caller, caller_owned_home: true, hermetic: false });
    const resumed = await f.run([...f.flags, "--resume", started.session_id as string, "--final"]);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expect(resumed.driveError).toBeUndefined();
    expect(resumed.events.find((event) => event.type === "session_started"))
      .toMatchObject({ session_id: started.session_id, private_home: f.caller });
    expect(resumed.events.at(-1)).toMatchObject({ type: "session_ended", resumable: true });
    expect(readFileSync(f.callerConfig, "utf8")).toBe(f.original);
    const observations = f.observations();
    expect(observations).toHaveLength(2);
    for (const observation of observations) expect(observation.home).toBe(f.caller);
    const commands = readFileSync(join(f.state, "argv.jsonl"), "utf8").trim().split("\n")
      .map((line) => (JSON.parse(line) as { args: string[] }).args);
    for (const argv of commands) {
      expect(argv).not.toContain("--safe-mode");
      expect(argv).not.toContain("--no-custom-instructions");
      expect(argv).not.toContain("--no-context-files");
    }
    if (agent === "qwen") expect(readFileSync(join(f.caller, ".qwen", "oauth_creds.json"), "utf8")).not.toContain("synthetic-refresh-value");
    if (agent === "goose") expect(existsSync(join(f.caller, "config", "secrets.yaml"))).toBe(false);
    if (agent === "copilot") {
      const rpc = readFileSync(join(f.state, "rpc.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      for (const frame of rpc.filter((entry) => ["session.create", "session.resume"].includes(entry.method))) {
        expect(frame.params.configDir).toBe(join(f.caller, ".copilot"));
        expect(frame.params.enableSkills).toBe(true);
        expect(frame.params.enableConfigDiscovery).toBe(true);
      }
    }
    const scode = readFileSync(join(f.state, "scode.txt"), "utf8");
    expect(scode).toContain(`--allow\n${f.caller}\n`);
    expect(scode).toContain(`--block\n${join(f.home, ".claude")}\n`);
  } finally { f.cleanup(); }
}, 20_000);

test.each(agents)("%s caller preview creates no caller state", async (agent) => {
  const f = fixture(agent);
  const absent = join(f.root, "absent-caller");
  try {
    const result = await runSessionCommand(f.args(["--harness-home", absent, "--print-sandbox"]), f.binaries,
      { registryFile: f.registryFile, env: f.env, setup: f.setup });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(`HOME=${absent}`);
    expect(result.stdout).not.toContain("--safe-mode");
    expect(result.stdout).not.toContain("--no-custom-instructions");
    expect(existsSync(absent)).toBe(false);
  } finally { f.cleanup(); }
});

test("native authentication remains injected when caller-home environments are scrubbed", () => {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "synthetic-native-key";
  try {
    const adapter = new GeminiAdapter({ GEMINI_API_KEY: "synthetic-native-key" });
    const prepared = prepareSessionEnvironment({ adapter, runLike: { agent: "gemini", prompt: "synthetic" },
      passthroughEnv: [], sandboxed: true, sandboxOptions: { scrubEnv: true }, override: null, callerHomeAgent: "gemini" });
    expect(prepared.needsKeepEnvPreflight).toBe(true);
    const built = prepared.buildSessionEnvironment(undefined);
    expect(built.runEnv.GEMINI_API_KEY).toBe("synthetic-native-key");
    expect(built.env.GEMINI_API_KEY).toBe("synthetic-native-key");
    expect(withKeepEnvExemption({ scrubEnv: true }, built.runEnv, false).keepEnv).toContain("GEMINI_API_KEY");
  } finally {
    if (previous === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous;
  }
});

test("native key is preserved by the CLI sandbox policy without exposing its value", async () => {
  const f = fixture("gemini");
  f.env.GEMINI_API_KEY = "synthetic-native-key";
  f.binaries.scode = 'if [ "$1" = "--help" ]; then printf "%s\\n" "--keep-env"; exit 0; fi\n' + f.binaries.scode;
  const preflight = spyOn(runtime, "assertScodeKeepEnvSupport").mockResolvedValue(undefined);
  try {
    const result = await runSessionCommand(f.args([...f.flags, "--print-sandbox", "--sandbox-scrub-env"]), f.binaries,
      { registryFile: f.registryFile, env: f.env, setup: f.setup });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("GEMINI_API_KEY");
    expect(result.stdout).not.toContain("synthetic-native-key");
    expect(preflight).toHaveBeenCalled();
  } finally { preflight.mockRestore(); f.cleanup(); }
});

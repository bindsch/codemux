import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BaseAdapter } from "../src/adapters/base.js";
import { CopilotAdapter } from "../src/adapters/copilot.js";
import { callerHarnessHomeEnvAssignments, openCallerHarnessHome } from "../src/session/harness-home.js";
import { createTurnAgentDriver, TURN_AGENT_PROFILES, type TurnAgentDriverArmInput } from "../src/session/turn-driver-launch.js";
import type { TurnAgentDriverOptions, TurnAgentId, TurnCommandInput } from "../src/session/turn-driver-types.js";
import { buildCopilotRpcLaunch } from "../src/session/copilot-rpc-config.js";
import { prepareCallerTurnContext } from "../src/session/turn-driver-caller-context.js";
import { prepareGeminiSessionSettings } from "../src/session/gemini-settings.js";
import { readRegistry } from "../src/session/registry.js";
import * as spawn from "../src/session/spawn.js";
import * as mcp from "../src/mcp.js";
import * as processTable from "../src/process-table.js";
import type { PiMcpRunContext } from "../src/pi-mcp-launch.js";
import { engineSession, fakeTurnProcess, wireProfile } from "./helpers/session-turn-engine.js";
import { createFakeBinaryEnv } from "./helpers/cli.js";
import { removeDir, tempWorkdir } from "./helpers/session-command.js";

const AGENTS: TurnAgentId[] = ["copilot", "cursor", "droid", "gemini", "goose", "openhands", "pi", "qwen"];
const ID = "11111111-1111-4111-8111-111111111111";
const override = { agent: "pi" as const, baseUrl: "https://provider.test/v1", apiKey: "synthetic", model: "model" };
let saved: NodeJS.ProcessEnv;
let root: string;
let fake: ReturnType<typeof createFakeBinaryEnv>;
let restoreProcessTable: () => void;

beforeEach(() => {
  saved = { ...process.env };
  root = tempWorkdir("caller-turn-drivers");
  fake = createFakeBinaryEnv({});
  for (const name of Object.keys(process.env)) if (name.startsWith("CODEMUX_") && name.includes("_PROVIDER_")) delete process.env[name];
  process.env.PATH = fake.env.PATH;
  process.env.HOME = join(root, "operator");
  mkdirSync(process.env.HOME, { recursive: true });
  mkdirSync(join(root, "work"));
  const table = spyOn(processTable, "readProcessTable").mockReturnValue(new Map());
  restoreProcessTable = () => table.mockRestore();
});
afterEach(() => {
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
  Object.assign(process.env, saved);
  fake.cleanup();
  restoreProcessTable();
  removeDir(root);
});

function home(agent: TurnAgentId) {
  return openCallerHarnessHome({ agent, dir: join(root, "caller"), cwd: join(root, "work"),
    sourceHome: join(root, "operator"), sourceEnv: {}, blockedPaths: [], apiKeyAuth: true, providerOverride: true });
}
function adapter(): BaseAdapter {
  return { validateRunRequest() {}, prepareRun: () => ({}), cleanupRun() {}, getEnvOmissions: () => [],
    getEnv: () => ({}), executionPathEnv: () => fake.env.PATH } as unknown as BaseAdapter;
}
function input(agent: TurnAgentId, caller = home(agent)): TurnAgentDriverArmInput {
  return { agent, adapter: agent === "copilot" ? new CopilotAdapter({ PATH: fake.env.PATH!, HOME: join(root, "operator") }) : adapter(),
    options: { final: true }, runLike: { agent, prompt: "synthetic", cwd: join(root, "work"), autonomy: "high" },
    resumeId: undefined, model: undefined, modelAlias: null, autonomy: "high", effort: undefined,
    workdir: join(root, "work"), passthroughEnv: [], sandboxTrust: "standard", sandboxNoNet: false,
    sandboxScrubEnv: false, sandboxBlock: [], requestedAutonomy: "high", sessionTimeoutMs: null,
    shutdownGraceMs: 1, registryPath: join(root, "registry.json"), harnessHome: caller.dir, callerHome: caller,
    providerBaseUrl: null, hermetic: false, turnState: { launch: null }, turnSandboxOptions: () => undefined,
    buildSessionEnvironment: () => ({ runEnv: {}, env: { PATH: fake.env.PATH!, HOME: join(root, "operator") } }) };
}
function command(callerHome: string): TurnCommandInput {
  return { text: "synthetic prompt", sessionId: ID, firstTurn: true, hermeticHome: null, callerHome, autonomy: "high" };
}

describe("caller roots reach every turn driver", () => {
  test.each(AGENTS)("%s passes its caller root through turns and a resumed driver", async (agent) => {
    const caller = home(agent);
    const inputs: TurnCommandInput[] = [];
    for (const resumeSessionId of [null, ID]) {
      const children: ReturnType<typeof fakeTurnProcess>[] = [];
      const profile = wireProfile({ sessionId: ID }, { agent, identity: TURN_AGENT_PROFILES[agent].identity,
        buildTurnCommand: (value) => { inputs.push(value); return [agent]; } });
      const h = engineSession({ options: { profile, mintedSessionId: ID, resumeSessionId,
        privateHome: caller, hermetic: false, harnessHome: caller.dir,
        spawnTurn: async (build) => { build({}); const child = fakeTurnProcess(); children.push(child); return child; } } });
      try {
        for (let turn = 0; turn < 2; turn++) {
          h.user("synthetic");
          for (let tick = 0; tick < 8; tick++) await Promise.resolve();
          expect(children).toHaveLength(turn + 1);
          children[turn]!.exit(0);
          await h.until(() => h.events.filter((event) => event.type === "turn_completed").length === turn + 1);
        }
        expect(await h.wait("session_started")).toMatchObject({ private_home: caller.dir });
        h.shutdown();
        expect(await h.code()).toBe(0);
      } finally { h.dispose(); }
    }
    expect(inputs.map((value) => value.callerHome)).toEqual([caller.dir, caller.dir, caller.dir, caller.dir]);
    expect(inputs.map((value) => value.firstTurn)).toEqual([true, false, false, false]);
    expect(inputs.every((value) => value.hermeticHome === null)).toBe(true);
  });

  test.each(AGENTS)("%s keeps one root on repeated launches and rechecks after preflight", async (agent) => {
    const caller = home(agent);
    const verify = spyOn(caller, "verify");
    const argv: string[][] = [];
    const spawnMock = spyOn(spawn, "spawnSessionChild").mockImplementation(async (args, env, options) => {
      await Promise.resolve();
      expect(env.HOME).toBe(join(root, "operator"));
      expect(options.validateBeforeSpawn).toBe(caller.verify);
      options.validateBeforeSpawn!();
      argv.push(args);
      return fakeTurnProcess();
    });
    const arm = createTurnAgentDriver(input(agent, caller));
    const options = (arm.driver as unknown as { options: TurnAgentDriverOptions }).options;
    try {
      for (const firstTurn of [true, false]) {
        await options.spawnTurn((extras) => options.profile.buildTurnCommand({ ...command(caller.dir), firstTurn, ...extras }));
      }
      expect(arm.privateHome).toBe(caller);
      expect(options.final).toBe(false);
      expect(verify).toHaveBeenCalledTimes(4);
      for (const args of argv) {
        expect(args.slice(0, 1 + callerHarnessHomeEnvAssignments(caller).length)).toEqual(["env", ...callerHarnessHomeEnvAssignments(caller)]);
        expect(args).not.toContain("--safe-mode");
        expect(args).not.toContain("--no-context-files");
        expect(args).not.toContain("--no-custom-instructions");
        if (agent === "pi") expect(args).toContain("rpc");
        if (agent === "gemini") expect(args).toContain("--acp");
        if (agent === "copilot") expect(args).toContain("--stdio");
        if (agent === "openhands") {
          expect(args).toContain("--override-with-envs");
          expect(args[args.indexOf("--file") + 1]!.startsWith(join(caller.dir, ".openhands"))).toBe(true);
        }
      }
    } finally {
      arm.driver.dispose();
      if (agent === "openhands") for (let index = 0; index < 2; index++) TURN_AGENT_PROFILES.openhands.parseTurnOutput!("", null);
      spawnMock.mockRestore(); verify.mockRestore();
    }
  });

  test.each(AGENTS)("%s records the caller root and preserves it even with final=true", async (agent) => {
    const caller = home(agent);
    const removed = spyOn(caller, "remove");
    const registryPath = join(root, "registry.json");
    const marker = join(caller.dir, "caller-skill.txt");
    writeFileSync(marker, "caller content");
    const h = engineSession({ options: { profile: wireProfile({}, { agent }), mintedSessionId: ID,
      privateHome: caller, final: true, hermetic: false, registryPath, harnessHome: caller.dir, cwd: join(root, "work") } });
    try {
      expect(await h.wait("session_started")).toMatchObject({ private_home: caller.dir });
      h.shutdown();
      expect(await h.code()).toBe(0);
      expect(removed).not.toHaveBeenCalled();
      expect(readFileSync(marker, "utf8")).toBe("caller content");
      const registry = readRegistry(registryPath);
      expect(registry.outcome).toBe("ok");
      if (registry.outcome === "ok") expect(registry.file.sessions[0]).toMatchObject({ harness_home: caller.dir, caller_owned_home: true });
    } finally { h.dispose(); removed.mockRestore(); }
  });

  test("Copilot RPC points config discovery, hooks and skills at the caller brand root", () => {
    const caller = home("copilot");
    const config = buildCopilotRpcLaunch({ adapter: new CopilotAdapter({}), request: { agent: "copilot", prompt: "" },
      turn: command(caller.dir), harnessHome: caller.dir });
    expect(config.config).toMatchObject({ configDir: join(caller.dir, ".copilot"), enableConfigDiscovery: true,
      enableFileHooks: true, enableSkills: true, enableOnDemandInstructionDiscovery: true });
    for (const key of ["pluginDirectories", "skillDirectories", "instructionDirectories"]) expect(config.config).not.toHaveProperty(key);
    expect(config.argv).not.toContain("--no-custom-instructions");
  });
});

describe("caller preparation preserves native customization", () => {
  test("preparation rejects a symlink ancestor before creating descendants outside the caller root", () => {
    const caller = home("gemini");
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(caller.dir, ".pi"));
    expect(() => prepareCallerTurnContext({ agent: "pi", adapter: adapter(), request: { agent: "pi", prompt: "synthetic" },
      home: caller, override: null, model: undefined })).toThrow("must not contain symlinks");
    expect(existsSync(join(outside, "agent"))).toBe(false);
  });

  test("Pi Playwright preparation keeps caller settings and print preparation stays write-free", () => {
    const caller = home("pi");
    const executable = join(root, "playwright-mcp");
    const trusted = spyOn(mcp, "buildPlaywrightSandboxMcp").mockReturnValue({
      args: ["--mcp-config", JSON.stringify({ mcpServers: { playwright: { command: executable, args: [] } } })],
      check: { path: executable } as never,
    });
    try {
      const request = { agent: "pi" as const, prompt: "synthetic", sandboxed: true, enablePlaywrightMcp: true };
      for (const printOnly of [false, true]) {
        const context = prepareCallerTurnContext({ agent: "pi", adapter: adapter(), request, home: caller,
          override: null, model: undefined, printOnly }) as PiMcpRunContext;
        expect(context.piMcpExtension!.path.startsWith(caller.dir)).toBe(true);
        expect(existsSync(context.piMcpExtension!.path)).toBe(!printOnly);
        context.piMcpExtension!.directory.finalize();
        context.piProviderAgentDir!.finalize();
        expect(existsSync(caller.dir)).toBe(true);
      }
    } finally { trusted.mockRestore(); }
  });

  test.each(AGENTS)("%s print preparation creates no state", (agent) => {
    const caller = openCallerHarnessHome({ agent, dir: join(root, "preview"), cwd: join(root, "work"),
      sourceHome: join(root, "operator"), sourceEnv: {}, blockedPaths: [], apiKeyAuth: true, providerOverride: true, printOnly: true });
    const context = prepareCallerTurnContext({ agent, adapter: adapter(), request: { agent, prompt: "synthetic", effort: "high" },
      home: caller, override, model: "model", printOnly: true });
    context.piProviderAgentDir?.finalize();
    context.geminiHermeticHome?.finalize();
    context.droidProviderSettings?.finalize();
    context.qwenEffortSettings?.finalize();
    expect(existsSync(caller.dir)).toBe(false);
  });

  test("Pi preserves models and settings while applying an explicit provider override", () => {
    const caller = home("pi");
    const path = join(caller.dir, ".pi", "agent", "models.json");
    const settings = join(caller.dir, ".pi", "agent", "settings.json");
    writeFileSync(path, JSON.stringify({ providers: { caller: { baseUrl: "https://caller.test" } }, keep: true }));
    writeFileSync(settings, "caller settings");
    const context = prepareCallerTurnContext({ agent: "pi", adapter: adapter(), request: { agent: "pi", prompt: "" },
      home: caller, override, model: "model" });
    expect(context.piProviderAgentDir?.path).toBe(join(caller.dir, ".pi", "agent"));
    context.piProviderAgentDir?.finalize();
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ keep: true,
      providers: { caller: { baseUrl: "https://caller.test" }, codemux: { baseUrl: override.baseUrl } } });
    expect(readFileSync(path, "utf8")).not.toContain("synthetic");
    expect(readFileSync(settings, "utf8")).toBe("caller settings");
  });

  test.each(["null", "[]", '{"providers":null}', '{"providers":[]}'])("Pi refuses malformed caller models %s", (content) => {
    const caller = home("pi");
    writeFileSync(join(caller.dir, ".pi", "agent", "models.json"), content);
    expect(() => prepareCallerTurnContext({ agent: "pi", adapter: adapter(), request: { agent: "pi", prompt: "" },
      home: caller, override, model: "model" })).toThrow(/must contain an object/);
  });

  test("Pi creates only its provider entry when models.json is absent and needs a model", () => {
    const caller = home("pi");
    expect(() => prepareCallerTurnContext({ agent: "pi", adapter: adapter(), request: { agent: "pi", prompt: "" },
      home: caller, override: { ...override, model: undefined }, model: undefined })).toThrow("needs a model");
    prepareCallerTurnContext({ agent: "pi", adapter: adapter(), request: { agent: "pi", prompt: "" }, home: caller, override, model: undefined });
    expect(existsSync(join(caller.dir, ".pi", "agent", "models.json"))).toBe(true);
  });

  test("Gemini ordinary preparation leaves settings byte-identical", () => {
    const caller = home("gemini");
    const request = { agent: "gemini" as const, prompt: "" };
    const prepared = prepareCallerTurnContext({ agent: "gemini", adapter: adapter(), request, home: caller, override: null, model: undefined });
    const path = join(caller.dir, ".gemini", "settings.json");
    const content = '{ "tools": { "core": ["caller-tool"] }, "skills": true }\n';
    writeFileSync(path, content);
    const result = prepareGeminiSessionSettings({ request, prepared, privateHome: caller.dir, override: null, callerOwned: true });
    expect(result.geminiHome).toBe(caller.dir);
    expect(readFileSync(path, "utf8")).toBe(content);
    prepared.geminiHermeticHome?.finalize();
    expect(existsSync(caller.dir)).toBe(true);
  });

  test("Droid and Qwen explicit settings stay beneath the caller root", () => {
    for (const agent of ["droid", "qwen"] as const) {
      const caller = home(agent);
      const context = prepareCallerTurnContext({ agent, adapter: adapter(), request: { agent, prompt: "", effort: "high" },
        home: caller, override, model: "model" });
      const artifact = context.droidProviderSettings ?? context.qwenEffortSettings!;
      expect(artifact.path.startsWith(caller.dir)).toBe(true);
      expect(readFileSync(artifact.path, "utf8")).not.toContain("synthetic");
      artifact.finalize();
      expect(existsSync(caller.dir)).toBe(true);
    }
  });

  test("Droid refuses an override without its model", () => {
    expect(() => prepareCallerTurnContext({ agent: "droid", adapter: adapter(), request: { agent: "droid", prompt: "" },
      home: home("droid"), override: { ...override, model: undefined }, model: undefined })).toThrow("needs a model");
  });
});

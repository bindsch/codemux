// In-process coverage of the cline arm of createTurnAgentDriver with a
// caller-owned --harness-home: the overlay assignments ride after the
// caller-home environment, the driver's config home is the caller root,
// and every turn keeps the caller's own settings files. The CLI arm of the
// same feature is tests/session-cli-cline-harness-home.test.ts (spawned,
// so it adds no in-process coverage). No harness or provider is used.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClineAdapter } from "../src/adapters/cline.js";
import { callerHarnessHomeEnvAssignments, openCallerHarnessHome } from "../src/session/harness-home.js";
import { createTurnAgentDriver, type TurnAgentDriverArmInput } from "../src/session/turn-driver-launch.js";
import type { TurnAgentDriverOptions } from "../src/session/turn-driver-types.js";
import type { ClineRunContext } from "../src/cline-config.js";
import * as spawn from "../src/session/spawn.js";
import * as processTable from "../src/process-table.js";
import { fakeTurnProcess } from "./helpers/session-turn-engine.js";
import { createFakeBinaryEnv } from "./helpers/cli.js";
import { removeDir, tempWorkdir } from "./helpers/session-command.js";

const ID = "11111111-1111-4111-8111-111111111111";
let saved: NodeJS.ProcessEnv;
let root: string;
let fake: ReturnType<typeof createFakeBinaryEnv>;
let restoreProcessTable: () => void;

beforeEach(() => {
  saved = { ...process.env };
  root = tempWorkdir("cline-turn-launch");
  fake = createFakeBinaryEnv({});
  for (const name of Object.keys(process.env)) if (name.startsWith("CODEMUX_") && name.includes("_PROVIDER_")) delete process.env[name];
  Object.assign(process.env, {
    PATH: fake.env.PATH, HOME: join(root, "operator"),
    CODEMUX_CLINE_PROVIDER_BASE_URL: "https://provider.test/v1",
    CODEMUX_CLINE_PROVIDER_API_KEY: "synthetic-key",
    CODEMUX_CLINE_PROVIDER_MODEL: "synthetic-model",
  });
  mkdirSync(process.env.HOME!, { recursive: true });
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

test("a cline caller home names the overlay paths after its own environment on every turn", async () => {
  const caller = openCallerHarnessHome({ agent: "cline", dir: join(root, "caller"), cwd: join(root, "work"),
    sourceHome: join(root, "operator"), sourceEnv: {}, blockedPaths: [], apiKeyAuth: true, providerOverride: true });
  const settings = join(caller.dir, ".cline", "data", "settings");
  mkdirSync(settings, { recursive: true });
  const global = join(settings, "global-settings.json");
  writeFileSync(global, '{"caller":true}\n');
  const adapter = new ClineAdapter(process.env);
  const input: TurnAgentDriverArmInput = {
    agent: "cline", adapter, options: { final: false },
    runLike: { agent: "cline", prompt: "synthetic", cwd: join(root, "work"), autonomy: "high", tools: "none" },
    resumeId: undefined, model: undefined, modelAlias: null, autonomy: "high", effort: undefined,
    workdir: join(root, "work"), passthroughEnv: [], sandboxTrust: "standard", sandboxNoNet: false,
    sandboxScrubEnv: false, sandboxBlock: [], requestedAutonomy: "high", sessionTimeoutMs: null,
    shutdownGraceMs: 1, registryPath: join(root, "registry.json"), harnessHome: caller.dir, callerHome: caller,
    providerBaseUrl: null, hermetic: false, turnState: { launch: null }, turnSandboxOptions: () => undefined,
    // The launch environment carries the prepared context's own variables,
    // the way the real builder folds getRunEnv in.
    buildSessionEnvironment: (context) => ({ runEnv: {},
      env: { PATH: fake.env.PATH!, HOME: join(root, "operator"), ...(context as ClineRunContext).clineConfig?.env } }),
  };
  const argv: string[][] = [];
  const spawnMock = spyOn(spawn, "spawnSessionChild").mockImplementation(async (args) => {
    argv.push(args);
    return fakeTurnProcess();
  });
  const arm = createTurnAgentDriver(input);
  const options = (arm.driver as unknown as { options: TurnAgentDriverOptions & { configHome: () => string | null } }).options;
  try {
    for (const firstTurn of [true, false]) {
      await options.spawnTurn((extras) => options.profile.buildTurnCommand({
        text: "synthetic prompt", sessionId: ID, firstTurn, hermeticHome: null, callerHome: caller.dir, autonomy: "high", ...extras,
      }));
    }
    expect(options.configHome()).toBe(caller.dir);
    expect(argv).toHaveLength(2);
    const homeAssignments = callerHarnessHomeEnvAssignments(caller);
    for (const args of argv) {
      expect(args.slice(0, 1 + homeAssignments.length)).toEqual(["env", ...homeAssignments]);
      const overlays = args.filter((arg) => /^CLINE_(PROVIDER|GLOBAL|MCP)_SETTINGS_PATH=/.test(arg));
      expect(overlays.length).toBeGreaterThan(0);
      for (const overlay of overlays) {
        expect(overlay.slice(overlay.indexOf("=") + 1).startsWith(join(caller.dir, ".cline"))).toBe(true);
        expect(args.indexOf(overlay)).toBeGreaterThan(homeAssignments.length);
      }
    }
    expect(readFileSync(global, "utf8")).toBe('{"caller":true}\n');
  } finally {
    arm.driver.dispose();
    spawnMock.mockRestore();
  }
});

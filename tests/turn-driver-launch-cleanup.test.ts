// Review M1 and m6 (scratch/fix/review-owner-integration.md): a per-turn
// adapter context prepared but never stored in the turn state is released
// when a later step of the same spawn throws, for the second-wave arm
// (turn-driver-launch.ts) and the opencode arm (turn-driver-spawn.ts)
// alike -- both run the one shared chain, prepareTurnContext.
import { describe, expect, test } from "bun:test";
import type { BaseAdapter, RunContext } from "../src/adapters/base.js";
import { createTurnAgentDriver, type TurnAgentDriverArmInput } from "../src/session/turn-driver-launch.js";
import { buildSessionTurnSpawn, prepareTurnContext, type SessionTurnState } from "../src/session/turn-driver-spawn.js";
import type { SessionCommandOptions } from "../src/session/cli-request.js";
import type { RunRequest } from "../src/types.js";

interface FakeAdapter { adapter: BaseAdapter; cleaned: RunContext[]; prepared: RunContext[] }

function fakeAdapter(): FakeAdapter {
  const cleaned: RunContext[] = [];
  const prepared: RunContext[] = [];
  const adapter = {
    validateRunRequest: () => undefined,
    prepareRun: () => { const context = { harnessVersion: `turn-${prepared.length + 1}` } as RunContext; prepared.push(context); return context; },
    cleanupRun: (context?: RunContext) => { if (context) cleaned.push(context); },
    getEnv: () => ({}),
    getEnvOmissions: () => [],
    executionPathEnv: () => ({}),
  } as unknown as BaseAdapter;
  return { adapter, cleaned, prepared };
}

const previousContext = { harnessVersion: "turn-0" } as RunContext;
const refuseEnv = (): never => { throw new Error("synthetic env refusal"); };
const runLike = { agent: "cursor", prompt: "", cwd: "/" } as unknown as RunRequest;

describe("a throw before the turn context is stored releases it", () => {
  test("second-wave arm: the env build throws after prepareRun", () => {
    const fake = fakeAdapter();
    const turnState: SessionTurnState = { launch: { env: {}, sandboxOptions: undefined, context: previousContext } };
    const input = {
      agent: "cursor", adapter: fake.adapter, options: {} as SessionCommandOptions, runLike,
      resumeId: undefined, model: undefined, modelAlias: null, autonomy: "low", effort: undefined,
      workdir: "/", passthroughEnv: [], sandboxTrust: "standard", sandboxNoNet: false, sandboxScrubEnv: false,
      sandboxBlock: [], requestedAutonomy: "low", sessionTimeoutMs: null, shutdownGraceMs: 10,
      registryPath: "/nonexistent/registry", harnessHome: "/nonexistent/home", providerBaseUrl: null,
      hermetic: false, buildSessionEnvironment: refuseEnv, turnState, turnSandboxOptions: () => undefined,
    } as unknown as TurnAgentDriverArmInput;
    const { driver } = createTurnAgentDriver(input);
    const spawnTurn = (driver as unknown as { options: { spawnTurn: (build: () => string[]) => Promise<unknown> } }).options.spawnTurn;
    expect(() => spawnTurn(() => ["cursor-agent"])).toThrow("synthetic env refusal");
    expect(fake.prepared).toHaveLength(1);
    // The previous turn's context is finalized, then this turn's own.
    expect(fake.cleaned).toEqual([previousContext, fake.prepared[0]!]);
    expect(turnState.launch?.context).toBe(previousContext);
  });

  test("opencode arm: the env build throws after prepareRun", () => {
    const fake = fakeAdapter();
    const { spawnTurn, turnState } = buildSessionTurnSpawn({
      agentId: "opencode", adapter: fake.adapter, options: {} as SessionCommandOptions,
      runLike: { ...runLike, agent: "opencode" } as RunRequest, override: null, hermetic: false,
      experimentProjectSettings: false, buildSessionEnvironment: refuseEnv, sandboxOptions: undefined,
      workdir: "/", requestedAutonomy: "low", shutdownGraceMs: 10, sessionPrivateHome: null,
      driverRef: () => { throw new Error("driver not reached"); },
    });
    turnState.launch = { env: {}, sandboxOptions: undefined, context: previousContext };
    expect(() => spawnTurn(["opencode"])).toThrow("synthetic env refusal");
    expect(fake.cleaned).toEqual([previousContext, fake.prepared[0]!]);
  });

  test("the chain keeps the original error when the cleanup also fails", () => {
    const failing = { cleanupRun: () => { throw new Error("cleanup failed too"); } } as unknown as BaseAdapter;
    const turnState: SessionTurnState = { launch: null };
    expect(() => prepareTurnContext(failing, turnState, () => ({}), refuseEnv)).toThrow("synthetic env refusal");
    expect(turnState.launch).toBeNull();
  });
});

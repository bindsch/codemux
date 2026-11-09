/**
 * The launcher arm for the seven second-wave session agents
 * (cursor, droid, pi, qwen, gemini, copilot, goose): the profile table,
 * the session id mint for the minted identities, the private home open,
 * the per-turn spawn closure with its adapter chain, and the shared
 * driver's construction (turn-driver.ts). Everything cli-drivers.ts
 * needs for these agents arrives through createTurnAgentDriver, so its
 * arm table stays one branch per agent family.
 */

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { applyCopilotProjectSandbox } from "../copilot-project-settings.js";
import type { CopilotRunContext } from "../copilot-usage.js";
import { CopilotRpcSessionDriver } from "./copilot-rpc-driver.js";
import type { TurnAgentDriverOptions } from "./turn-driver-types.js";
import type { BaseAdapter, RunContext } from "../adapters/base.js";
import { droidProviderModelId } from "../droid-provider.js";
import { UsageRefusalError } from "../validation.js";
import { assertNoCallerBlockOverStateDirs, type SandboxOptions, type ScodeTrustLevel } from "../sandbox.js";
import type { ClineRunContext } from "../cline-config.js";
import { CLINE_ACP_DRIVER_PROFILE } from "./cline-session.js";
import { ClineSessionDriver } from "./cline-driver.js";
import { prepareClineSessionSettings } from "./cline-settings.js";
import { readClineSessionUsage } from "./cline-history.js";

/** The overlay paths a cline caller home omits from the inherited environment
 * and then names again, after the omissions, so only codemux's paths apply. */
function clineOverlayAssignments(env: Readonly<Record<string, string>>): string[] {
  return ["CLINE_PROVIDER_SETTINGS_PATH", "CLINE_GLOBAL_SETTINGS_PATH", "CLINE_MCP_SETTINGS_PATH"]
    .filter((name) => env[name] !== undefined).map((name) => `${name}=${env[name]}`);
}
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
} from "../types.js";
import { CURSOR_DRIVER_PROFILE } from "./cursor-driver.js";
import { DROID_DRIVER_PROFILE } from "./droid-driver.js";
import { PI_DRIVER_PROFILE } from "./pi-driver.js";
import { QWEN_DRIVER_PROFILE } from "./qwen-driver.js";
import { prepareQwenSessionPlaywright } from "./qwen-playwright.js";
import { GEMINI_ACP_DRIVER_PROFILE, GeminiAcpSessionDriver } from "./gemini-acp-driver.js";
import { prepareGeminiSessionSettings } from "./gemini-settings.js";
import { PiRpcSessionDriver } from "./pi-rpc-driver.js";
import { piNativeSessionDir } from "../pi-launch.js";
import type { PiMcpRunContext } from "../pi-mcp-launch.js";
import { piProviderModelSelector } from "../pi-provider.js";
import { COPILOT_DRIVER_PROFILE } from "./copilot-driver.js";
import { GOOSE_DRIVER_PROFILE } from "./goose-driver.js";
import { OPENHANDS_DRIVER_PROFILE } from "./openhands-driver.js";
import { callerHarnessHomeEnvAssignments, type CallerHarnessHome } from "./harness-home.js";
import { prepareCallerTurnContext } from "./turn-driver-caller-context.js";
import { TurnAgentSessionDriver } from "./turn-driver.js";
import type { TurnAgentId, TurnProviderExtras } from "./turn-driver-core.js";
import {
  openTurnAgentPrivateHome,
  turnAgentHermeticTurnContext,
  turnSessionProviderOverride,
} from "./turn-driver-homes.js";
import type { SessionPrivateHome } from "./private-home-types.js";
import type { SessionProcess } from "./process.js";
import { spawnSessionChild } from "./spawn.js";
import { prepareTurnContext, type SessionTurnState } from "./turn-driver-spawn.js";
import type { SessionEnvironmentBuilder } from "./cli-launch.js";
import type { SessionCommandOptions } from "./cli-request.js";

/** One profile per agent (src/session/<agent>-driver.ts): the only
 * per-agent code the shared engine runs on. */
export const TURN_AGENT_PROFILES: Readonly<Record<TurnAgentId, typeof CURSOR_DRIVER_PROFILE>> = {
  cline: CLINE_ACP_DRIVER_PROFILE,
  cursor: CURSOR_DRIVER_PROFILE,
  droid: DROID_DRIVER_PROFILE,
  pi: PI_DRIVER_PROFILE,
  qwen: QWEN_DRIVER_PROFILE,
  gemini: GEMINI_ACP_DRIVER_PROFILE,
  copilot: COPILOT_DRIVER_PROFILE,
  goose: GOOSE_DRIVER_PROFILE,
  openhands: OPENHANDS_DRIVER_PROFILE,
};

/** The per-turn extras that need no file write: qwen's captured
 * Playwright server and pi's MCP extension. Shared by the real turn
 * below and the --print-sandbox preview (cli-spawn-prep.ts), so the
 * printed argv is the one a turn would exec (review m4). Gemini's
 * settings are files a print must not write, so they stay out. */
export function turnArgvExtras(
  agent: TurnAgentId, runLike: RunRequest, prepared: RunContext, adapter: BaseAdapter
): TurnProviderExtras {
  if (agent === "qwen") return prepareQwenSessionPlaywright(runLike, prepared, adapter.executionPathEnv());
  if (agent === "pi") return { mcpExtensionPath: (prepared as PiMcpRunContext).piMcpExtension?.path };
  return {};
}

/** Copilot's project-settings blocks on one turn's sandbox options (the
 * real turn and the preview alike, review m4). */
export function applyTurnProjectSandbox(
  agent: TurnAgentId, runLike: RunRequest, sandboxOptions: SandboxOptions | undefined,
  harnessHome: string, privateHomeDir: string | null, prepared: RunContext
): void {
  if (agent !== "copilot" || !runLike.experimentProjectSettings) return;
  if (privateHomeDir === null || sandboxOptions === undefined) {
    throw new UsageRefusalError("copilot project sessions require a private home and sandbox");
  }
  const artifacts = prepared as CopilotRunContext;
  applyCopilotProjectSandbox(sandboxOptions, harnessHome, privateHomeDir,
    [artifacts.copilotProviderFile?.path, artifacts.copilotUsageFile?.path]
      .filter((path): path is string => path !== undefined).map(dirname));
}

/** Whether an agent id is one of the seven (the dispatch gate in
 * cli-drivers.ts). */
export function isTurnAgent(agentId: AgentId): agentId is TurnAgentId {
  return agentId in TURN_AGENT_PROFILES;
}

export interface TurnAgentDriverArmInput {
  agent: TurnAgentId;
  adapter: BaseAdapter;
  options: SessionCommandOptions;
  runLike: RunRequest;
  resumeId: string | undefined;
  model: string | undefined;
  modelAlias: string | null;
  autonomy: AutonomyLevel;
  effort: ReasoningEffort | undefined;
  workdir: string;
  passthroughEnv: string[];
  sandboxTrust: ScodeTrustLevel;
  sandboxNoNet: boolean;
  sandboxScrubEnv: boolean;
  sandboxBlock: readonly string[];
  requestedAutonomy: AutonomyLevel;
  sessionTimeoutMs: number | null;
  turnTimeoutMs?: number | null;
  shutdownGraceMs: number;
  registryPath: string;
  harnessHome: string;
  callerHome?: CallerHarnessHome | null;
  providerBaseUrl: string | null;
  hermetic: boolean;
  buildSessionEnvironment: SessionEnvironmentBuilder;
  /** The shared turn state (turn-driver-spawn.ts): the per-turn
   * context stored here is what the CLI's end path finalizes. */
  turnState: SessionTurnState;
  turnSandboxOptions: (
    runEnv: Record<string, string>
  ) => SandboxOptions | undefined;
}

/**
 * Build the turn agents' driver arm. Refusals throw UsageRefusalError
 * — never usageError — because this runs after a resume's claim, and
 * only a throw reaches the CLI catch that releases it.
 */
export function createTurnAgentDriver(
  input: TurnAgentDriverArmInput
): {
  driver: TurnAgentSessionDriver;
  privateHome: SessionPrivateHome | null;
  /** The minted or resumed session id (null for the deferred
   * identities until the first turn's output names it). */
  sessionId: string | null;
} {
  const {
    agent,
    adapter,
    options,
    runLike,
    resumeId,
    model,
    modelAlias,
    autonomy,
    effort,
    workdir,
    passthroughEnv,
    sandboxTrust,
    sandboxNoNet,
    sandboxScrubEnv,
    sandboxBlock,
    requestedAutonomy,
    sessionTimeoutMs,
    turnTimeoutMs,
    shutdownGraceMs,
    registryPath,
    harnessHome,
    providerBaseUrl,
    hermetic,
    buildSessionEnvironment,
    turnState,
    turnSandboxOptions,
    callerHome = null,
  } = input;
  const profile = TURN_AGENT_PROFILES[agent];
  // The override the home populate and the per-turn chain share
  // (turn-driver-homes.ts): the four agents whose home or argv an
  // override changes. A partial override refuses here — before any
  // home is created.
  const validatedOverride =
    agent === "droid" || agent === "pi" || agent === "goose" || agent === "gemini" || agent === "qwen" || agent === "cline"
      ? turnSessionProviderOverride(agent)
      : null;
  // The session id: the minted identities mint here (the aider
  // precedent — the home, the registry record, and the first turn's
  // --session-id all name one id), a resume reuses the recorded id, and
  // the deferred identities (droid, goose) wait for the first turn's
  // output object to name the harness's own mint.
  const sessionId =
    profile.identity === "minted" || resumeId !== undefined
      ? (resumeId ?? randomUUID())
      : null;
  const privateHome = callerHome ?? openTurnAgentPrivateHome({
    agent,
    hermetic,
    resumeSessionId: resumeId ?? null,
    sessionId,
    passthroughEnv,
    override: validatedOverride,
    model,
    permissionPolicy: options.permissionPolicy === "deny" ? "deny" : "default",
  });
  let driver: TurnAgentSessionDriver;
  // The per-turn spawn: one adapter context per turn (the opencode
  // rule, review D3) — the previous turn's artifacts are finalized
  // here, the new ones prepared with hermetic OFF (the session home is
  // this session's own, synthesized below; prepareRun must not mint a
  // run-shaped one) — then the env assembly, then the command builder
  // with the per-turn provider artifacts, then the spawn. The builder
  // form is the whole point: droid's BYOK settings file must exist
  // before the argv names it.
  const spawnTurn = (
    buildArgv: (extras: TurnProviderExtras) => string[],
    abandoned?: () => boolean
  ): Promise<SessionProcess> => {
    // The per-turn validation gate (review D2, security 1): turn N may
    // have written config granting reach the recorded autonomy does
    // not; the spawn refuses to run a tree `run` would have refused.
    adapter.validateRunRequest(runLike);
    callerHome?.verify();
    // The shared chain (turn-driver-spawn.ts): a throw in the settings
    // step or the env build, before the new context is stored, releases
    // that context instead of leaking it (review M1).
    const { prepared, extras, launch } = prepareTurnContext(adapter, turnState, () => callerHome === null ? adapter.prepareRun({ ...runLike, hermetic: false,
      experimentProjectSettings: agent === "copilot" ? false : runLike.experimentProjectSettings,
      resultJson: agent === "copilot" ? false : runLike.resultJson })
      : prepareCallerTurnContext({ agent, adapter, request: runLike, home: callerHome,
        override: validatedOverride, model }), (prepared) => {
      const context = agent === "cline"
        ? prepareClineSessionSettings({ request: runLike, prepared, privateHome, environment: process.env })
        : privateHome === null || callerHome !== null ? prepared
          : { ...prepared, ...turnAgentHermeticTurnContext(agent, privateHome) };
      const extras: TurnProviderExtras = agent === "gemini"
        ? prepareGeminiSessionSettings({
          request: runLike, prepared, privateHome: privateHome?.dir ?? null,
          override: validatedOverride, permissionPolicy: options.permissionPolicy,
          callerOwned: callerHome !== null,
        }) : turnArgvExtras(agent, runLike, prepared, adapter);
      const { runEnv, env } = buildSessionEnvironment(context);
      const launch = {
        env,
        sandboxOptions: turnSandboxOptions(runEnv),
        // The stored context is the prepared one alone: the synthesized
        // home fields are no-op-finalize session state, and cleanupRun
        // must finalize only what a turn created.
        context: prepared,
      };
      if (agent === "cline" && launch.sandboxOptions !== undefined) {
        const state = (context as ClineRunContext).clineConfig?.home;
        if (state) {
          const policy = launch.sandboxOptions, directories = [...(policy.harnessStateDirs ?? []), state];
          assertNoCallerBlockOverStateDirs(policy.blockPaths ?? [], directories);
          policy.blockPaths = [...(policy.blockPaths ?? []), ...(privateHome?.blockedPaths ?? [])];
          policy.harnessStateDirs = directories;
        }
      }
      turnState.launch = launch;
      return { prepared, extras, launch };
    });
    applyTurnProjectSandbox(agent, runLike, launch.sandboxOptions, harnessHome, privateHome?.dir ?? null, prepared);
    if (agent === "pi" && validatedOverride !== null) {
      const selectedModel = model ?? validatedOverride.model;
      if (selectedModel === undefined) throw new UsageRefusalError("pi provider override needs a model");
      extras.providerModelId = piProviderModelSelector(selectedModel);
      if (!hermetic) extras.sessionDir = piNativeSessionDir(callerHome === null ? harnessHome : join(callerHome.dir, ".pi", "agent"), workdir);
    }
    if (agent === "droid" && validatedOverride !== null) {
      // The run path's exact pair: --settings at the settings file this
      // turn's prepareRun wrote, -m at the BYOK entry's id (the raw
      // spelling stays the driver's reported model).
      extras.providerSettingsPath = prepared.droidProviderSettings?.path;
      const droidModel = model ?? validatedOverride.model;
      if (droidModel !== undefined) {
        extras.providerModelId = droidProviderModelId(droidModel);
      }
    }
    const command = buildArgv(extras);
    const argv = callerHome === null ? command : ["env", ...callerHarnessHomeEnvAssignments(callerHome),
      ...(prepared.qwenEffortSettings ? [`QWEN_CODE_SYSTEM_SETTINGS_PATH=${prepared.qwenEffortSettings.path}`] : []),
      ...(agent === "cline" ? clineOverlayAssignments(launch.env) : []), ...command];
    return spawnSessionChild(argv, launch.env, {
      cwd: workdir,
      sandboxed: Boolean(options.sandbox),
      autonomy: requestedAutonomy,
      sandboxOptions: launch.sandboxOptions,
      graceMs: shutdownGraceMs,
      envOmissions: adapter.getEnvOmissions(),
      extraExecutableChecks: prepared.playwrightMcpCheck == null ? [] : [prepared.playwrightMcpCheck],
      abandoned,
      validateBeforeSpawn: callerHome?.verify,
    }, {
      onLine: (line) => driver.handleHarnessLine(line),
      onBytes: agent === "copilot" ? (bytes) => (driver as CopilotRpcSessionDriver).handleHarnessBytes(bytes) : undefined,
      onStdoutEnd: agent === "copilot" ? () => (driver as CopilotRpcSessionDriver).handleHarnessEnd() : undefined,
      onFatal: (fatal) => driver.handleFatal(fatal),
    });
  };
  const driverOptions: TurnAgentDriverOptions = {
    profile,
    resumeSessionId: resumeId ?? null,
    // The minted identities run their fresh session under the id minted
    // above (the home and the record already name it); a resume ignores
    // it in favor of resumeSessionId, and a deferred fresh identity has
    // none (the first turn's output names the harness's own mint).
    mintedSessionId: sessionId,
    autonomy,
    model,
    modelAlias,
    effort,
    tools: runLike.tools,
    cwd: workdir,
    hermetic,
    sandboxed: Boolean(options.sandbox),
    sandboxTrust,
    sandboxNoNet,
    sandboxScrubEnv,
    sandboxBlock,
    passEnv: passthroughEnv,
    authorPrefix: Boolean(options.authorPrefix),
    sessionTimeoutMs,
    turnTimeoutMs,
    registryPath,
    harnessHome,
    providerBaseUrl,
    spawnTurn,
    spawnGraceMs: shutdownGraceMs,
    privateHome,
    // --final reaches the driver only for a hermetic session (the
    // claude-family rule): the end path removes the private home — the
    // whole two-attempt sequence — BEFORE the end stamp, and only a
    // removal that settled removed makes the resumable verdict say
    // false. qwen and cursor have no home to remove; final on them
    // decides about nothing.
    final: Boolean(options.final) && hermetic,
    projectSettings: runLike.experimentProjectSettings === true,
    playwrightMcp: runLike.enablePlaywrightMcp === true,
  };
  if (agent === "cline") {
    driver = new ClineSessionDriver({
      ...driverOptions, configHome: () => privateHome?.dir ?? null,
      permissionPolicy: options.permissionPolicy === "deny" ? "deny" : "default",
      readUsage: (sessionId) => readClineSessionUsage({
        sessionId, cwd: workdir, home: privateHome?.dir, env: turnState.launch?.env ?? {},
      }),
    });
  } else if (agent === "copilot") {
    driver = new CopilotRpcSessionDriver({
      ...driverOptions, adapter, request: runLike, context: () => turnState.launch?.context,
      permissionPolicy: options.permissionPolicy === "deny" ? "deny" : "default",
      turnTimeoutMs: input.turnTimeoutMs ?? null,
    });
  } else if (agent === "gemini") {
    // The ACP channel (session/new, session/load, prompt, cancel) carries
    // the turn; --policy deny rides the transport's deny replies.
    driver = new GeminiAcpSessionDriver({
      ...driverOptions,
      permissionPolicy: options.permissionPolicy === "deny" ? "deny" : "default",
      turnTimeoutMs: input.turnTimeoutMs ?? null,
    });
  } else if (agent === "pi") {
    // The native RPC mode (prompt/steer/abort) carries the turn.
    driver = new PiRpcSessionDriver({ ...driverOptions, turnTimeoutMs: input.turnTimeoutMs ?? null });
  } else {
    driver = new TurnAgentSessionDriver(driverOptions);
  }
  return { driver, privateHome, sessionId };
}

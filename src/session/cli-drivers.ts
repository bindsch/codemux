// Per-agent session driver construction: the wire models, the
// turn-per-process spawn closure (turn-driver-spawn.ts), and the
// codex/agy/opencode/kimi/aider/claude/second-wave driver arms — the
// seven turn-per-process agents through turn-driver-launch.ts.
// src/session/cli.ts owns the command, the record claims, and the
// spawn.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AiderAdapter } from "../adapters/aider.js";
import type { BaseAdapter } from "../adapters/base.js";
import { OpencodeAdapter } from "../adapters/opencode.js";
import type { ProviderOverride } from "../provider-override.js";
import type { SandboxOptions, ScodeTrustLevel } from "../sandbox.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
} from "../types.js";
import { AiderSessionDriver } from "./aider-driver.js";
import { AgySessionDriver } from "./agy-driver.js";
import {
  AIDER_SESSION_ID_PATTERN,
  aiderSessionHistoryPath,
} from "./aider-session.js";
import { aiderHarnessHome } from "./cli-homes.js";
import { openSessionPrivateHome } from "./private-home.js";
import { settledPrivateHomePath } from "./private-home-key.js";
import { CodexSessionDriver } from "./codex-driver.js";
import type { CodexSessionCatalog } from "./codex-catalog.js";
import { codexSessionProviderHomePath } from "../codex-provider.js";
import type { CodexSessionProviderHome } from "../codex-provider.js";
import { KimiSessionDriver } from "./kimi-driver.js";
import { OpenCodeSessionDriver } from "./opencode-driver.js";
import { ClaudeSessionDriver } from "./driver.js";
import { buildSessionTurnSpawn } from "./turn-driver-spawn.js";
import { createTurnAgentDriver, isTurnAgent } from "./turn-driver-launch.js";
import type { SessionEnvironmentBuilder } from "./cli-launch.js";
import type { SessionCommandOptions } from "./cli-request.js";
import type { ClaudeSessionBuilt } from "./claude-session/builders.js";
import type { SessionPrivateHome } from "./private-home-types.js";
import type { ProjectSettingsSessionDir } from "../claude-project-config.js";
import type { SessionDriver } from "./stdin-frame.js";
import { isCallerHarnessHome } from "./harness-home.js";

export function createSessionDriver({
  options,
  agentId,
  adapter,
  override,
  codexHome,
  codexOverride,
  codexSessionHome,
  codexSessionCatalog = null,
  resumeId,
  claudeFamilyAgent,
  claudeBuilt,
  model,
  modelAlias,
  autonomy,
  effort,
  workdir,
  passthroughEnv,
  enablePlaywrightMcp,
  experimentProjectSettings,
  sandboxTrust,
  sandboxNoNet,
  sandboxScrubEnv,
  sandboxBlock,
  permissionTimeoutMs,
  turnTimeoutMs,
  sessionTimeoutMs,
  shutdownGraceMs,
  requestedAutonomy,
  sandboxOptions,
  runLike,
  registryPath,
  harnessHome,
  providerBaseUrl,
  buildSessionEnvironment,
  removeFinalProjectDir,
  hermetic,
  sessionPrivateHome,
  kimiSourceBrandHome,
  sessionProjectDir,
}: {
  options: SessionCommandOptions;
  agentId: AgentId;
  adapter: BaseAdapter;
  override: ProviderOverride | null;
  codexHome: () => string;
  codexOverride: (ProviderOverride & { baseUrl: string; apiKey: string }) | null;
  codexSessionHome: CodexSessionProviderHome | null;
  codexSessionCatalog?: CodexSessionCatalog | null;
  resumeId: string | undefined;
  claudeFamilyAgent: "claude" | "zai";
  claudeBuilt: ClaudeSessionBuilt | null;
  model: string | undefined;
  /** The `-m` value as typed when it resolved through config.models, else
   * null (design P5): reported as `model_alias` by every driver and
   * recorded with every ledger line and registry record. */
  modelAlias: string | null;
  autonomy: AutonomyLevel;
  effort: ReasoningEffort | undefined;
  workdir: string;
  passthroughEnv: string[];
  enablePlaywrightMcp: boolean;
  experimentProjectSettings: boolean;
  sandboxTrust: ScodeTrustLevel;
  sandboxNoNet: boolean;
  sandboxScrubEnv: boolean;
  sandboxBlock: readonly string[];
  permissionTimeoutMs: number;
  turnTimeoutMs: number | null;
  sessionTimeoutMs: number | null;
  shutdownGraceMs: number;
  requestedAutonomy: AutonomyLevel;
  sandboxOptions: SandboxOptions | undefined;
  runLike: RunRequest;
  registryPath: string;
  harnessHome: string;
  providerBaseUrl: string | null;
  buildSessionEnvironment: SessionEnvironmentBuilder;
  /** The CLI's `--final` directory removal, handed to the driver so its
   * end path runs it before the end stamp releases the record (review
   * round 10, edges 4). */
  removeFinalProjectDir: () => boolean;
  /** Whether the session runs hermetic (plain --hermetic; project
   * settings implies it for the claude family). */
  hermetic: boolean;
  /** The hermetic codex/kimi/agy session's private home
   * (cli-launch.ts), null for every other agent. */
  sessionPrivateHome: SessionPrivateHome | null;
  /** The operator brand home a hermetic kimi session's filtered config
   * is generated from (null when the session is not kimi). */
  kimiSourceBrandHome: string | null;
  /** The claude family's session directory — the private home both
   * hermetic modes share; passed to the driver as its privateHome. */
  sessionProjectDir: ProjectSettingsSessionDir | null;
}) {
  // The wire models for the turn-per-process agents, through the
  // adapters' public seam (wireModelFor): exactly what
  // buildRunCommand would pass — openai/-prefixed for aider,
  // codemux/-prefixed for opencode under an override — so session
  // turns and runs cannot drift.
  const opencodeWireModel =
    agentId === "opencode" && adapter instanceof OpencodeAdapter
      ? adapter.wireModelFor(model)
      : undefined;
  const aiderWireModel =
    agentId === "aider" && adapter instanceof AiderAdapter
      ? adapter.wireModelFor(model)
      : undefined;
  // The `--model` value kimi's per-turn commands carry (the session
  // re-carries it on every per-turn argv): none under a provider
  // override — the synthesized KIMI_MODEL_* provider is the default
  // model and `--model` names a config alias that outranks it (the
  // run adapter's buildRunCommand rule) — else the resolved model.
  const kimiWireModel =
    agentId === "kimi" ? (override !== null ? undefined : model) : undefined;

  let driver: SessionDriver;
  let claudeDriver: ClaudeSessionDriver | null = null;
  let agyDriver: AgySessionDriver | null = null;
  let aiderDriver: AiderSessionDriver | null = null;
  let aiderSessionId: string | null = null;
  // The hermetic aider session's private home (the arm below opens it),
  // returned so cli.ts can bind it into the catch and finally that own
  // its removal — the codex/kimi sessionPrivateHome family.
  let aiderPrivateHome: SessionPrivateHome | null = null;
  // The shared per-turn spawn closure (turn-driver-spawn.ts) and the
  // turn state the CLI's end path finalizes; the seven second-wave
  // agents reuse the state and the keep-env helper through their own
  // builder-shaped closure (turn-driver-launch.ts).
  let turnAgentDriver: ReturnType<typeof createTurnAgentDriver>["driver"] | null = null;
  // A FRESH second-wave private home (turn-driver-launch.ts opens it),
  // returned so cli.ts removes it when the session aborts before its
  // spawn began (review m5). A resumed home is never abandoned, and
  // every later exit, --final included, is the driver's own end path,
  // so this never joins cli.ts's sessionPrivateHome.
  let turnAgentFreshHome: SessionPrivateHome | null = null;
  const { spawnTurn, turnState, turnSandboxOptions } = buildSessionTurnSpawn({
    agentId,
    adapter,
    options,
    runLike,
    override,
    hermetic,
    experimentProjectSettings,
    buildSessionEnvironment,
    sandboxOptions,
    callerBlockPaths: agentId === "opencode" ? sandboxBlock : undefined,
    workdir,
    requestedAutonomy,
    shutdownGraceMs,
    sessionPrivateHome,
    callerHome: isCallerHarnessHome(sessionPrivateHome) ? sessionPrivateHome : null,
    driverRef: () => driver,
  });
  if (isTurnAgent(agentId)) {
    let privateHome: SessionPrivateHome | null;
    ({ driver: turnAgentDriver, privateHome } = createTurnAgentDriver({
      agent: agentId,
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
      callerHome: isCallerHarnessHome(sessionPrivateHome) ? sessionPrivateHome : null,
      buildSessionEnvironment,
      turnState,
      turnSandboxOptions,
    }));
    turnAgentFreshHome = resumeId === undefined ? privateHome : null;
    driver = turnAgentDriver;
  } else if (agentId === "codex") {
    driver = new CodexSessionDriver({
      tools: runLike.tools, noToolsCatalog: codexSessionCatalog, projectSettings: experimentProjectSettings,
      // Record the MCP flag used by the argv and resume guard.
      playwrightMcp: enablePlaywrightMcp,
      permissionPolicy: options.permissionPolicy as "default" | "deny" | undefined,
      resumeThreadId: resumeId ?? null,
      autonomy,
      model,
      modelAlias,
      // Provider config selects the wire model; the reported model stays explicit.
      wireModel: codexOverride !== null ? null : undefined,
      effort,
      cwd: workdir,
      sandboxed: Boolean(options.sandbox),
      sandboxTrust,
      sandboxNoNet,
      sandboxScrubEnv,
      sandboxBlock,
      passEnv: passthroughEnv,
      authorPrefix: Boolean(options.authorPrefix),
      permissionTimeoutMs,
      turnTimeoutMs,
      sessionTimeoutMs,
      registryPath,
      harnessHome,
      providerBaseUrl,
      // The override session's recorded home names the thread id —
      // the session-keyed path a resume computes — which the
      // harness only mints at thread/start, after the spawn.
      harnessHomeFor:
        codexOverride !== null
          ? (id) =>
              codexSessionProviderHomePath(codexHome(), codexOverride.baseUrl, id)
          : undefined,
      // The home's end-of-session settlement: keep on a resumable end,
      // remove otherwise — except a resumed home (review D3). A HERMETIC
      // session settles the shared private home through privateHome
      // below instead (the override home is null there).
      settleSessionHome: codexSessionHome?.settle,
      // A hermetic session's own state home: reported on
      // session_started.private_home, keyed by the thread id (codex-driver-io.ts).
      hermetic,
      privateHome: sessionPrivateHome,
    });
  } else if (agentId === "agy") {
    driver = agyDriver = new AgySessionDriver({
      resumeConversationId: resumeId ?? null,
      autonomy,
      model,
      modelAlias,
      cwd: workdir,
      hermetic,
      privateHome: sessionPrivateHome,
      final: Boolean(options.final) && hermetic,
      sandboxed: Boolean(options.sandbox),
      sandboxTrust,
      sandboxNoNet,
      sandboxScrubEnv,
      sandboxBlock,
      passEnv: passthroughEnv,
      authorPrefix: Boolean(options.authorPrefix),
      sessionTimeoutMs,
      registryPath,
      harnessHome,
      providerBaseUrl,
    });
  } else if (agentId === "opencode") {
    driver = new OpenCodeSessionDriver({
      permissionPolicy: options.permissionPolicy as "default" | "deny" | undefined,
      resumeSessionId: resumeId ?? null,
      autonomy,
      // The resolved id, reported on session_started and recorded like
      // every other agent (design §2.3's normalization); the wire id —
      // provider-prefixed under an override — rides the per-turn argv
      // through `wireModel` alone.
      model,
      wireModel: opencodeWireModel,
      modelAlias,
      effort,
      cwd: workdir,
      // Plain --hermetic (the mode always pairs with it, the gate in
      // cli-request.ts): the per-turn argv prefix follows it, matching
      // the claude family's convention.
      hermetic,
      projectSettings: experimentProjectSettings,
      sandboxed: Boolean(options.sandbox),
      sandboxTrust,
      sandboxNoNet,
      sandboxScrubEnv,
      sandboxBlock,
      passEnv: passthroughEnv,
      authorPrefix: Boolean(options.authorPrefix),
      sessionTimeoutMs,
      turnTimeoutMs,
      privateHome: sessionPrivateHome,
      final: Boolean(options.final) && hermetic,
      tools: runLike.tools,
      playwrightMcp: enablePlaywrightMcp,
      pathEnv: adapter.executionPathEnv(),
      registryPath,
      harnessHome,
      providerBaseUrl,
      spawnTurn,
      // The end path's bound on an in-flight turn spawn (review round
      // 110): the same --shutdown-grace that bounds the stop.
      spawnGraceMs: shutdownGraceMs,
    });
  } else if (agentId === "kimi") {
    driver = new KimiSessionDriver({
      tools: options.tools as "none" | "default" | undefined,
      turnTimeoutMs,
      playwrightMcp: enablePlaywrightMcp,
      playwrightPathEnv: adapter.executionPathEnv(),
      preserveCustomization: !hermetic && sessionPrivateHome !== null,
      permissionPolicy: options.permissionPolicy as "default" | "deny" | undefined,
      resumeSessionId: resumeId ?? null,
      autonomy,
      model,
      modelAlias,
      // Provider overrides select the wire model through environment.
      wireModel: kimiWireModel,
      cwd: workdir,
      hermetic,
      hermeticSourceHome: kimiSourceBrandHome,
      privateHome: sessionPrivateHome,
      // The project-settings mode's one per-turn argv difference and its
      // `project_settings` record (kimi-driver-io.ts).
      experimentProjectSettings,
      sandboxed: Boolean(options.sandbox),
      sandboxTrust,
      sandboxNoNet,
      sandboxScrubEnv,
      sandboxBlock,
      passEnv: passthroughEnv,
      authorPrefix: Boolean(options.authorPrefix),
      sessionTimeoutMs,
      registryPath,
      harnessHome,
      providerBaseUrl,
      spawnTurn,
    });
  } else if (agentId === "aider") {
    // Codemux owns the identity: aider has no session id of its own,
    // so one is minted here and the per-session history directory is
    // keyed by it (aider-session.ts).
    aiderSessionId = resumeId ?? randomUUID();
    // Hermetic history lives in a managed session directory. Caller-owned
    // history stays under the supplied root and never joins cleanup.
    aiderPrivateHome = hermetic
      ? openSessionPrivateHome({
          parent: join(aiderHarnessHome(), ".codemux-hermetic"),
          sessionId: aiderSessionId,
          resume: resumeId !== undefined,
          idPattern: AIDER_SESSION_ID_PATTERN,
          // Nothing outside the home needs blocking: the home IS the
          // redirect (HOME rides each turn's argv), and aider reads no
          // other state outside it.
          blockedPaths: [],
        })
      : null;
    driver = aiderDriver = new AiderSessionDriver({
      sessionId: aiderSessionId,
      resume: resumeId !== undefined,
      autonomy,
      model: aiderWireModel,
      modelAlias,
      // Under an override the weak model rides the same endpoint
      // (aider's ChatSummary runs through it); without one aider
      // picks its own default, exactly as the run path leaves it.
      weakModel: override !== null ? aiderWireModel : undefined,
      maxOutputTokens: override?.maxOutputTokens,
      effort,
      permissionPolicy: options.permissionPolicy as "default" | "deny" | undefined,
      turnTimeoutMs,
      tools: options.tools as "none" | "default" | undefined,
      historyPath:
        isCallerHarnessHome(sessionPrivateHome)
          ? aiderSessionHistoryPath(join(sessionPrivateHome.dir, ".aider"), aiderSessionId)
          : aiderPrivateHome !== null
          ? join(aiderPrivateHome.dir, "history.md")
          : aiderSessionHistoryPath(harnessHome, aiderSessionId),
      cwd: workdir,
      hermetic,
      hermeticHome: aiderPrivateHome?.dir,
      callerHome: isCallerHarnessHome(sessionPrivateHome) ? sessionPrivateHome : undefined,
      sandboxed: Boolean(options.sandbox),
      sandboxTrust,
      sandboxNoNet,
      sandboxScrubEnv,
      sandboxBlock,
      passEnv: passthroughEnv,
      authorPrefix: Boolean(options.authorPrefix),
      sessionTimeoutMs,
      registryPath,
      // Hermetic records the settled keyed spelling (the home is opened
      // settled, so it is the directory itself); plain records the brand
      // home the resume probe compares.
      harnessHome:
        aiderPrivateHome !== null
          ? settledPrivateHomePath(aiderPrivateHome.dir, aiderSessionId)
          : harnessHome,
      providerBaseUrl,
      spawnTurn,
      // The end path's bound on an in-flight turn spawn (review round
      // 110): the same --shutdown-grace that bounds the stop.
      spawnGraceMs: shutdownGraceMs,
    });
  } else if (claudeBuilt !== null) {
    driver = claudeDriver = new ClaudeSessionDriver({
      agent: claudeFamilyAgent,
      sessionId: resumeId ?? claudeBuilt.sessionId,
      autonomy,
      model,
      modelAlias,
      cwd: workdir,
      sandboxed: Boolean(options.sandbox),
      sandboxTrust,
      sandboxNoNet,
      sandboxScrubEnv,
      sandboxBlock,
      passEnv: passthroughEnv,
      playwrightMcp: enablePlaywrightMcp,
      authorPrefix: Boolean(options.authorPrefix),
      permissionTimeoutMs,
      turnTimeoutMs,
      sessionTimeoutMs,
      registryPath,
      harnessHome,
      providerBaseUrl,
      hermetic,
      projectSettings: experimentProjectSettings,
      // The session-keyed private home both isolation modes share:
      // reported on session_started.private_home, null for a plain
      // session.
      privateHome: sessionProjectDir,
      // --final reaches the driver only for a hermetic session (either
      // mode): the end path removes the directory — the whole
      // two-attempt sequence — BEFORE the end stamp, and only a removal
      // that settled removed makes the resumable verdict say false
      // (review rounds 10, 15, and 7).
      final: Boolean(options.final) && hermetic,
      removeFinalProjectDir,
      permissionPolicy:
        options.permissionPolicy === "deny" ? "deny" : "default",
    });
  } else {
    // Unreachable: every agent either built a claude-family
    // command above or matched a branch already.
    throw new Error(`no session driver for '${agentId}'`);
  }
  return {
    driver,
    claudeDriver,
    agyDriver,
    aiderDriver,
    aiderSessionId,
    aiderPrivateHome,
    turnState,
    turnAgentDriver,
    turnAgentFreshHome,
  };
}

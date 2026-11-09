// Per-agent session driver construction: the wire models, the
// turn-per-process spawn closure, and the codex/agy/opencode/kimi/
// aider/claude driver arms. src/session/cli.ts owns the command, the
// record claims, and the spawn.
import { randomUUID } from "node:crypto";
import { AiderAdapter } from "../adapters/aider.js";
import type { BaseAdapter, RunContext } from "../adapters/base.js";
import { OpencodeAdapter, opencodeRealDataParent } from "../adapters/opencode.js";
import type { ProviderOverride } from "../provider-override.js";
import {
  withKeepEnvExemption,
  type SandboxOptions,
  type ScodeTrustLevel,
} from "../sandbox.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
} from "../types.js";
import { AiderSessionDriver } from "./aider-driver.js";
import { AgySessionDriver } from "./agy-driver.js";
import { aiderSessionHistoryPath } from "./aider-session.js";
import { CodexSessionDriver } from "./codex-driver.js";
import { codexSessionProviderHomePath } from "../codex-provider.js";
import type { CodexSessionProviderHome } from "../codex-provider.js";
import { KimiSessionDriver } from "./kimi-driver.js";
import { kimiHermeticTurnContext } from "./kimi-turn-context.js";
import { OpenCodeSessionDriver } from "./opencode-driver.js";
import { openCodeHermeticTurnPrefix } from "./opencode-session.js";
import { ClaudeSessionDriver } from "./driver.js";
import type { SessionProcess } from "./process.js";
import { spawnSessionChild } from "./spawn.js";
import type { SessionEnvironmentBuilder } from "./cli-launch.js";
import type { SessionCommandOptions } from "./cli-request.js";
import type { ClaudeSessionBuilt } from "./claude-session/builders.js";
import type { SessionPrivateHome } from "./private-home-types.js";
import type { ProjectSettingsSessionDir } from "../claude-project-config.js";
import type { SessionDriver } from "./stdin-frame.js";

export function createSessionDriver({
  options,
  agentId,
  adapter,
  override,
  codexHome,
  codexOverride,
  codexSessionHome,
  resumeId,
  claudeFamilyAgent,
  claudeBuilt,
  model,
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
  resumeId: string | undefined;
  claudeFamilyAgent: "claude" | "zai";
  claudeBuilt: ClaudeSessionBuilt | null;
  model: string | undefined;
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
  // Holder (not a bare let): the assignment happens inside the
  // spawnTurn closure, which TypeScript's flow analysis cannot see
  // at the cleanup site below.
  const turnState: {
    launch: {
      env: Record<string, string>;
      context: RunContext | undefined;
      /** The turn spawn's sandbox options: the session's resolved
       * options plus the keep-env exemption for THIS turn's injected
       * names (the long-lived child computes its own once, above). */
      sandboxOptions: SandboxOptions | undefined;
    } | null;
  } = { launch: null };
  /** The env(1) prefix a hermetic/project-settings opencode turn's argv
   * carries; null leaves the argv as built. */
  let turnArgvPrefix: string[] | null = null;
  /** The keep-env exemption for one turn's spawn — the run path's
   * rule through the same helper (withKeepEnvExemption): the names
   * that turn's env assembly injected, required under an override.
   * Computed per turn because the env is per turn (opencode's
   * provider config directory is minted fresh each turn). */
  const turnSandboxOptions = (
    runEnv: Record<string, string>
  ): SandboxOptions | undefined =>
    sandboxOptions === undefined
      ? undefined
      : withKeepEnvExemption(
          sandboxOptions,
          { ...adapter.getEnv(), ...runEnv },
          override !== null
        );
  // The kimi hermetic turn context (kimi-turn-context.ts): the adapter's
  // getRunEnv refuses a hermetic launch whose context carries no home.
  const kimiHermeticContext: RunContext | undefined =
    agentId === "kimi" && sessionPrivateHome !== null
      ? kimiHermeticTurnContext(sessionPrivateHome)
      : undefined;
  const spawnTurn = (turnArgv: string[], abandoned?: () => boolean): Promise<SessionProcess> => {
    // Re-run the adapter's validation gate before EVERY turn
    // (review D2, security 1): the turn-per-process agents (opencode,
    // aider, kimi) reload project config in each fresh process, and turn N
    // may have written `opencode.json` or `.aider.model.settings.yml`
    // granting reach the recorded autonomy does not. `run` checks the
    // tree right before the only process it launches; this is that
    // same moment per turn. Pure validation, so the throw reaches the
    // drivers' existing spawn-failure path: a fatal codemux error
    // carrying the guard's message, and the session ends rather than
    // spawn a process the tree would have refused.
    adapter.validateRunRequest(runLike);
    if (agentId === "opencode") {
      // A FRESH provider config before every turn (review D3,
      // security 2): the config file lives in the opencode data
      // directory, which the sandboxed child can write, and each
      // turn is a new process that reloads it through
      // OPENCODE_CONFIG — a config cached at the first turn let
      // turn N's child rewrite what turn N+1 ran with (permissions,
      // MCP servers). The run path never shares the file across
      // processes, and neither does a session now: one file per
      // turn process, each in its own fresh unguessable directory.
      // Turns serialize (a second input is refused while one runs),
      // so the previous turn's process has exited by the time a
      // next turn spawns: its context is finalized right here,
      // which also keeps exactly one exit listener registered; the
      // live one dies with the session below. If prepareRun throws,
      // the finally below cleans the previous context again —
      // cleanupRun is idempotent — and nothing leaks.
      const previous = turnState.launch?.context;
      if (previous !== undefined) adapter.cleanupRun(previous);
      const context = adapter.prepareRun(runLike);
      const { runEnv, env } = buildSessionEnvironment(context);
      turnState.launch = {
        env,
        sandboxOptions: turnSandboxOptions(runEnv),
        context,
      };
      // The run path's env prefix (adapters/opencode.ts), rebuilt per
      // turn from THAT turn's fresh home: env(1) assignments riding
      // argv, never an environment handed to scode. Project settings
      // rides it minus the project-config disable.
      turnArgvPrefix = openCodeHermeticTurnPrefix({
        hermetic,
        projectSettings: experimentProjectSettings,
        home: context.opencodeHermeticHome?.home,
        providerConfigPath: context.opencodeProviderConfig?.path ?? null,
        realDataParent: opencodeRealDataParent(process.env),
      });
    } else if (turnState.launch === null) {
      // Run's launch order in miniature (launch.ts): prepareRun,
      // then getRunEnv, then the built environment. Aider's and
      // kimi's overrides ride environment variables alone
      // (OPENAI_API_BASE / OPENAI_API_KEY; KIMI_MODEL_*) — nothing
      // on disk to refresh — so the env is built once and cached,
      // keep-env exemption included. A hermetic kimi session's env
      // assembly needs the context above (getRunEnv's fail-closed
      // gate); every other agent here has none.
      const { runEnv, env } = buildSessionEnvironment(
        agentId === "kimi" ? kimiHermeticContext : undefined
      );
      turnState.launch = {
        env,
        sandboxOptions: turnSandboxOptions(runEnv),
        context: undefined,
      };
    }
    return spawnSessionChild(
      turnArgvPrefix === null ? turnArgv : [...turnArgvPrefix, ...turnArgv],
      turnState.launch.env,
      {
      cwd: workdir,
      sandboxed: Boolean(options.sandbox),
      autonomy: requestedAutonomy,
      sandboxOptions: turnState.launch.sandboxOptions,
      graceMs: shutdownGraceMs,
      envOmissions: adapter.getEnvOmissions(),
      abandoned,
    }, {
      onLine: (line) => driver.handleHarnessLine(line),
      onFatal: (fatal) => driver.handleFatal(fatal),
    });
  };
  if (agentId === "codex") {
    driver = new CodexSessionDriver({
      resumeThreadId: resumeId ?? null,
      autonomy,
      model,
      // Under an override the session home's config.toml owns model
      // selection (the run path's never-`-m` rule), so thread/start
      // and thread/resume carry none; `model` stays the reported
      // one.
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
      resumeSessionId: resumeId ?? null,
      autonomy,
      model: opencodeWireModel,
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
      resumeSessionId: resumeId ?? null,
      autonomy,
      model,
      // Under an override the KIMI_MODEL_* synthesis owns model
      // selection (the run path's never-`-m` rule), so the
      // per-turn commands carry none; `model` stays the reported
      // one.
      wireModel: kimiWireModel,
      cwd: workdir,
      // The hermetic home and its source brand home come from the
      // launcher; the driver carries the env redirect on its own
      // per-turn argv and settles the home at the first resume hint's
      // child exit (kimi-driver-io.ts).
      hermetic,
      hermeticSourceHome: kimiSourceBrandHome,
      privateHome: sessionPrivateHome,
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
    driver = aiderDriver = new AiderSessionDriver({
      sessionId: aiderSessionId,
      resume: resumeId !== undefined,
      autonomy,
      model: aiderWireModel,
      // Under an override the weak model rides the same endpoint
      // (aider's ChatSummary runs through it); without one aider
      // picks its own default, exactly as the run path leaves it.
      weakModel: override !== null ? aiderWireModel : undefined,
      effort,
      historyPath: aiderSessionHistoryPath(harnessHome, aiderSessionId),
      cwd: workdir,
      hermetic: false,
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
  return { driver, claudeDriver, agyDriver, aiderDriver, aiderSessionId, turnState };
}

/**
 * The shared per-turn spawn closure for the turn-per-process session
 * agents (opencode, aider, kimi — and the seven second-wave agents
 * through turn-driver-launch.ts): the launcher-held turn state, the
 * keep-env exemption per turn, and the spawnTurn the drivers call once
 * per caller input. Extracted from session/cli-drivers.ts so the
 * driver-arm table there stays small; the bodies are that file's,
 * verbatim. src/session/cli.ts owns the command and the registry.
 */
import type { BaseAdapter, RunContext } from "../adapters/base.js";
import { opencodeRealDataParent } from "../adapters/opencode.js";
import type { ProviderOverride } from "../provider-override.js";
import { withKeepEnvExemption, type SandboxOptions } from "../sandbox.js";
import type { AgentId, AutonomyLevel, RunRequest } from "../types.js";
import { kimiHermeticTurnContext } from "./kimi-turn-context.js";
import type { SessionPrivateHome } from "./private-home-types.js";
import type { SessionProcess } from "./process.js";
import { spawnSessionChild } from "./spawn.js";
import type { SessionDriver } from "./stdin-frame.js";
import type { SessionEnvironmentBuilder } from "./cli-launch.js";
import type { SessionCommandOptions } from "./cli-request.js";
import { openCodeHermeticTurnPrefix } from "./opencode-session.js";
import { openCodeSessionSandboxOptions, prepareOpenCodeCallerTurnContext } from "./opencode-home.js";
import { callerHarnessHomeEnvAssignments, type CallerHarnessHome } from "./harness-home.js";

/** The launcher-held state one turn's spawn leaves behind: the env and
 * sandbox options the NEXT turn reuses (or replaces) and the adapter
 * context the CLI's end path finalizes. Holder (not a bare field): the
 * assignment happens inside the spawnTurn closure, which TypeScript's
 * flow analysis cannot see at the cleanup site in cli.ts. */
export interface SessionTurnState {
  launch: {
    env: Record<string, string>;
    context: RunContext | undefined;
    /** The turn spawn's sandbox options: the session's resolved
     * options plus the keep-env exemption for THIS turn's injected
     * names (the long-lived child computes its own once). */
    sandboxOptions: SandboxOptions | undefined;
  } | null;
}

/**
 * One turn's adapter-context chain, shared by the opencode arm below and
 * the second-wave arm (turn-driver-launch.ts) so the two cannot drift
 * (review M1, m6): finalize the previous turn's context, prepare this
 * turn's, then run `store` -- every step that can throw before the new
 * context is held in turnState, ending with that assignment. A throw in
 * `store` releases this turn's artifacts before it propagates, because
 * the CLI's end path finalizes only the context turnState holds. The
 * per-turn validation gate stays with each caller: it runs for every
 * agent, including the ones with no per-turn context.
 */
export function prepareTurnContext<T>(
  adapter: BaseAdapter,
  turnState: SessionTurnState,
  prepare: () => RunContext,
  store: (context: RunContext) => T
): T {
  const previous = turnState.launch?.context;
  if (previous !== undefined) adapter.cleanupRun(previous);
  // If prepare throws, the end path cleans the previous context again;
  // cleanupRun is idempotent, so nothing leaks.
  const context = prepare();
  try {
    return store(context);
  } catch (error) {
    // The refusal is the error to report; a cleanup failure on top of it
    // must not replace it (an async cleanup's rejection included).
    try {
      const pending = adapter.cleanupRun(context);
      if (pending instanceof Promise) pending.catch(() => undefined);
    } catch {
      // Reported through the original error below.
    }
    throw error;
  }
}

export interface SessionTurnSpawnInput {
  agentId: AgentId;
  adapter: BaseAdapter;
  options: SessionCommandOptions;
  runLike: RunRequest;
  override: ProviderOverride | null;
  hermetic: boolean;
  experimentProjectSettings: boolean;
  buildSessionEnvironment: SessionEnvironmentBuilder;
  sandboxOptions: SandboxOptions | undefined;
  callerBlockPaths?: readonly string[];
  workdir: string;
  requestedAutonomy: AutonomyLevel;
  shutdownGraceMs: number;
  /** The hermetic kimi session's private home (null for every other
   * agent): the adapter's getRunEnv refuses a hermetic launch whose
   * context carries no home. */
  sessionPrivateHome: SessionPrivateHome | null;
  callerHome?: CallerHarnessHome | null;
  /** The driver once built; called through a getter because the closure
   * outlives the assignment it reads. */
  driverRef: () => SessionDriver;
}

/** Build the shared spawnTurn closure (cli-drivers.ts's, verbatim) for
 * the turn-per-process agents whose per-turn argv the driver assembles
 * itself. */
export function buildSessionTurnSpawn(
  input: SessionTurnSpawnInput
): {
  spawnTurn: (turnArgv: string[], abandoned?: () => boolean, extraExecutableChecks?: readonly import("../executable-security.js").ExecutableCheck[]) => Promise<SessionProcess>;
  turnState: SessionTurnState;
  turnSandboxOptions: (runEnv: Record<string, string>) => SandboxOptions | undefined;
} {
  const {
    agentId,
    adapter,
    options,
    runLike,
    override,
    hermetic,
    experimentProjectSettings,
    buildSessionEnvironment,
    sandboxOptions,
    callerBlockPaths = [],
    workdir,
    requestedAutonomy,
    shutdownGraceMs,
    sessionPrivateHome,
    driverRef,
    callerHome = null,
  } = input;
  const turnState: SessionTurnState = { launch: null };
  /** The env(1) prefix a hermetic/project-settings opencode turn's argv
   * carries; null leaves the argv as built. */
  let turnArgvPrefix: string[] | null = null;
  /** The keep-env exemption for one turn's spawn — the run path's
   * rule through the same helper (withKeepEnvExemption): the names
   * that turn's env assembly injected, required under an override.
   * Computed per turn because the env is per turn (opencode's
   * provider config directory is minted fresh each turn). */
  const initialOpenCodeHome = sessionPrivateHome?.dir;
  const turnSandboxOptions = (
    runEnv: Record<string, string>, providerConfigPath?: string, turnHome?: string
  ): SandboxOptions | undefined =>
    sandboxOptions === undefined
      ? undefined
      : withKeepEnvExemption(
          agentId === "opencode" && callerHome === null && sessionPrivateHome !== null && initialOpenCodeHome !== undefined
            ? openCodeSessionSandboxOptions(sandboxOptions, sessionPrivateHome, initialOpenCodeHome, providerConfigPath, callerBlockPaths, turnHome)
            : sandboxOptions,
          { ...adapter.getEnv(), ...runEnv },
          override !== null
        );
  // The kimi hermetic turn context (kimi-turn-context.ts): the adapter's
  // getRunEnv refuses a hermetic launch whose context carries no home.
  const kimiHermeticContext: RunContext | undefined =
    agentId === "kimi" && callerHome === null && sessionPrivateHome !== null
      ? kimiHermeticTurnContext(sessionPrivateHome)
      : undefined;
  const spawnTurn = (turnArgv: string[], abandoned?: () => boolean, extraExecutableChecks?: readonly import("../executable-security.js").ExecutableCheck[]): Promise<SessionProcess> => {
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
    callerHome?.verify();
    if (agentId === "opencode" && callerHome !== null) {
      prepareTurnContext(adapter, turnState, () => {
        const prepared = prepareOpenCodeCallerTurnContext(callerHome, override, runLike.model, turnArgv);
        turnArgv = prepared.argv;
        return prepared.context;
      }, (context) => {
        const { runEnv, env } = buildSessionEnvironment(context);
        turnState.launch = { env, context, sandboxOptions: turnSandboxOptions(runEnv) };
      });
    } else if (agentId === "opencode") {
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
      // live one dies with the session below (prepareTurnContext).
      const context = prepareTurnContext(adapter, turnState, () => adapter.prepareRun(runLike), (prepared) => {
        const { runEnv, env } = buildSessionEnvironment(prepared);
        turnState.launch = {
          env,
          sandboxOptions: turnSandboxOptions(runEnv, prepared.opencodeProviderConfig?.path, prepared.opencodeHermeticHome?.home),
          context: prepared,
        };
        return prepared;
      });
      // The run path's env prefix (adapters/opencode.ts), rebuilt per
      // turn from THAT turn's fresh home: env(1) assignments riding
      // argv, never an environment handed to scode. Project settings
      // rides it minus the project-config disable.
      turnArgvPrefix = openCodeHermeticTurnPrefix({
        permissionPolicy: options.permissionPolicy as "default" | "deny" | undefined,
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
    const driver = driverRef();
    // Both branches above leave the launch state set; the opencode one
    // assigns it inside a closure, which flow analysis cannot follow.
    const launch = turnState.launch as NonNullable<SessionTurnState["launch"]>;
    const command = turnArgvPrefix === null ? turnArgv : [...turnArgvPrefix, ...turnArgv];
    return spawnSessionChild(
      callerHome === null ? command : ["env", ...callerHarnessHomeEnvAssignments(callerHome), ...command],
      launch.env,
      {
      cwd: workdir,
      sandboxed: Boolean(options.sandbox),
      autonomy: requestedAutonomy,
      sandboxOptions: launch.sandboxOptions,
      graceMs: shutdownGraceMs,
      envOmissions: adapter.getEnvOmissions(),
      extraExecutableChecks: agentId === "opencode" || agentId === "kimi" ? extraExecutableChecks : undefined,
      abandoned,
      validateBeforeSpawn: callerHome?.verify,
    }, {
      onLine: (line) => driver.handleHarnessLine(line),
      onFatal: (fatal) => driver.handleFatal(fatal),
    });
  };
  return { spawnTurn, turnState, turnSandboxOptions };
}

// Launch preparation for `codemux session`: the shared environment
// builder, the claude-family command, the quota gate and harness floor,
// and the codex override / project-settings homes a session opens
// before anything spawns. src/session/cli.ts owns the command and the
// lifetime of what this phase returns.
import { claudeModelNeedsPickerSettings, claudeProviderPickerSettings } from "../claude-family.js";
import {
  openProjectSettingsSessionConfigDir,
  projectSettingsConfigRoot,
  projectSettingsSessionDirPath,
} from "../claude-project-config.js";
import { assertHarnessSupported } from "../cli-runtime.js";
import {
  createCodexSessionProviderHome,
  openCodexSessionProviderHome,
  readCodexMultiAgent,
} from "../codex-provider.js";
import { assertQuotaHeadroomForLaunch, resolveQuotaGate } from "../quota-gate.js";
import { assertNoCallerBlockOverStateDirs, isCredentialEnvName, type SandboxOptions, type ScodeTrustLevel } from "../sandbox.js";
import type {
  AgentId,
  AutonomyLevel,
  CodemuxConfig,
  ReasoningEffort,
  RunRequest,
} from "../types.js";
import type { BaseAdapter, RunContext } from "../adapters/base.js";
import type { ProviderOverride } from "../provider-override.js";
import { buildClaudeSessionCommand } from "./claude-session.js";
import type { SessionAgentSupport } from "./cli-agents.js";
import type { SessionCommandOptions } from "./cli-request.js";

/** The shared session environment builder this module creates and the
 * spawn prep and every turn spawn reuse: one call per launch context. */
export interface SessionEnvironmentBuilder {
  (context: RunContext | undefined): {
    runEnv: Record<string, string>;
    env: Record<string, string>;
  };
}

export async function prepareSessionLaunch({
  options,
  config,
  agentId,
  adapter,
  sessionSupport,
  override,
  autonomy,
  effort,
  model,
  workdir,
  passthroughEnv,
  enablePlaywrightMcp,
  experimentProjectSettings,
  sandboxOptions,
  sandboxTrust,
  claudeSessionId,
  resumeId,
  codexHome,
  codexOverride,
  runLike,
}: {
  options: SessionCommandOptions;
  config: CodemuxConfig;
  agentId: AgentId;
  adapter: BaseAdapter;
  sessionSupport: SessionAgentSupport;
  override: ProviderOverride | null;
  autonomy: AutonomyLevel;
  effort: ReasoningEffort | undefined;
  model: string | undefined;
  workdir: string;
  passthroughEnv: string[];
  enablePlaywrightMcp: boolean;
  experimentProjectSettings: boolean;
  sandboxOptions: SandboxOptions | undefined;
  sandboxTrust: ScodeTrustLevel;
  claudeSessionId: string | undefined;
  resumeId: string | undefined;
  codexHome: () => string;
  codexOverride: (ProviderOverride & { baseUrl: string; apiKey: string }) | null;
  runLike: RunRequest;
}) {
  // An override session under --sandbox-scrub-env cannot run on a
  // scode without --keep-env: the scrub would strip the override's
  // key, the session's only credential. Refused HERE, before
  // anything spawns or records — the run path's refusal
  // (resolveKeepEnvSandboxOptions in cli-runtime.ts, thrown when a
  // required exemption meets an unsupported scode) with its message
  // verbatim through assertScodeKeepEnvSupport — because
  // a turn-per-process session would otherwise ack its first caller
  // input and only then die at the turn spawn. The names ride the
  // per-spawn options below; the NEED is known now.
  //
  // The probe runs scode under the environment the session's
  // children spawn with — the adapter's standing environment through
  // buildExecutionEnv, HOME and PATH included — never an empty one
  // (round al14's blocker: the installed scode refuses to run
  // without HOME, so an empty-env probe answered "unprobeable" and
  // refused valid sessions before launch). The scode resolves
  // through that environment's PATH, the same resolver the run
  // runner and every session spawn use
  // (resolveScodeExecutableForEnv), so the preflight judges the
  // binary the launches will run. Both probes use the shared
  // session environment builder, including getRunEnv credentials.
  // The probe is memoized by executable, environment, and cwd.
  //
  // The need is the run path's rule (withKeepEnvExemption): an
  // override's key, or a credential-shaped name the adapter injects
  // on its own (zai's gateway token). That question is computed
  // lazily, HERE — after every earlier refusal, the resume guards
  // included (round al16): adapter.getEnv() resolves the agent's
  // credentials, and zai's throws outright when no key exists, so
  // the round-al15 spelling ran that resolution before the resume
  // guards and a keyless zai --resume of another agent's session
  // answered the key error (exit 1) where the resume guard exists
  // to answer the policy refusal (78). A keyless zai still refuses
  // before the spawn once the guards have spoken — under a scrubbed
  // launch here, at the probe's own getEnv call below, and otherwise
  // at beforeLaunch.
  // Either spelling of a scrubbed launch needs the probe (round
  // al32, security minor): the explicit scrub flag, or an untrusted
  // trust level — refused for sessions at the gate above, so that
  // arm is defense in depth, but the cause it states is the truth
  // either way, never a hard-coded scrub-only one.
  const needsKeepEnvPreflight = Boolean(options.sandbox) &&
    (sandboxOptions?.scrubEnv === true || sandboxOptions?.trust === "untrusted") &&
    (override !== null || Object.keys(adapter.getEnv()).some(isCredentialEnvName));
  const buildSessionEnvironment = (context: RunContext | undefined) => {
    const runEnv = adapter.getRunEnv(runLike, context);
    return { runEnv, env: adapter.buildExecutionEnv(runEnv, passthroughEnv) };
  };

  // The claude-family identity for this session: zai rides the same
  // driver, parser, and argv, differing only in the registry and
  // session_started agent the driver records.
  const claudeFamilyAgent: "claude" | "zai" =
    agentId === "zai" ? "zai" : "claude";
  const claudeBuilt = agentId === "claude" || agentId === "zai"
    ? buildClaudeSessionCommand({
        agent: claudeFamilyAgent,
        resumeId,
        // The id minted above (a resume ignores it in favor of
        // resumeId), so --session-id, the private config directory,
        // and the registry record all name one id.
        sessionId: claudeSessionId,
        model,
        autonomy,
        effort,
        cwd: workdir,
        // Run parity for --enable-playwright-mcp (§4.5): the same
        // sandbox-scoped carrier, in run's argv position. The binary
        // resolves through the session child's environment PATH, the same
        // source the spawn's command resolution uses (round 391, item 13).
        sandboxed: Boolean(options.sandbox),
        enablePlaywrightMcp,
        pathEnv: adapter.executionPathEnv(),
        // The picker mapping the run paths' one rule adds whenever the
        // resolved model is not a binary catalog id (claude-family.ts):
        // an override's provider-format model on claude, and a zai
        // provider-format id (-m glm-5.3, the clerk/worker/judge tiers)
        // alike — without it 2.1.280 rejects the id client-side before
        // any request. `model` above resolves exactly the way modelFlags
        // does — the request's -m, else the override's
        // CODEMUX_CLAUDE_PROVIDER_MODEL — so an env-model-only launch
        // (no -m) carries --model and --settings here too, pinned by the
        // picker e2e; an override naming no model never reaches this
        // wiring (the run-like validation above refuses it first, run's
        // own message).
        providerSettings:
          model !== undefined && claudeModelNeedsPickerSettings(model)
            ? claudeProviderPickerSettings(model)
            : undefined,
        // The isolation mode's own argv: the project and local
        // setting sources with slash commands (skills) disabled,
        // never --safe-mode (claude-session.ts).
        projectSettings: experimentProjectSettings,
      })
    : null;
  // Turn-per-process agents (opencode, aider, kimi) have no
  // session-long child: their driver spawns one process per caller
  // input, so there is no argv to build here.
  const turnPerProcess =
    agentId === "opencode" || agentId === "aider" || agentId === "kimi";

  // The quota gate (src/quota-gate.ts): the first command of a
  // session and every resume pass it — after every request check,
  // resume guard, and the resume claim itself (cli.ts claims before
  // this preparation opens anything keyed by the record, review round
  // 13, edges 3), but before anything spawns, records a fresh session,
  // or creates a home. A refusal exits 64; a fresh session has written
  // nothing, while a resume's claim — one registry write — is released
  // by the CLI's catch (handleSessionAbort), leaving the record
  // resumable for the next attempt. A provider override in force skips
  // the native gate (assertQuotaHeadroomForLaunch).
  const quotaPolicy = resolveQuotaGate({
    config: config.quota,
    ceiling: options.quotaCeiling,
    disabled: options.quotaGate === false,
  });
  // A print-only session spends nothing (review round 56).
  if (quotaPolicy !== null && !options.printSandbox) await assertQuotaHeadroomForLaunch(adapter, quotaPolicy);

  // The session floor, above the run contract (§4.3): the resume
  // ladder's reasoning and the permission carrier are only audited
  // down to this build. The gate scans the child's built environment,
  // not process.env (round 401, item 9): an adapter-injected redirect
  // name must be visible here, and a name that is ambient but not
  // passed through is not.
  await assertHarnessSupported(
    agentId,
    adapter.binaryName,
    options.cwd,
    adapter.buildExecutionEnv(adapter.getEnv(), passthroughEnv),
    autonomy,
    Boolean(options.sandbox),
    passthroughEnv,
    sessionSupport.floor
  );

  adapter.beforeLaunch();
  if (options.sandbox && !options.printSandbox) {
    // prepareSandbox is skipped on a print-only invocation for the same
    // reason the run path skips it (launch.ts, review round 18, edges 2):
    // the claude family's implementation refreshes or scrubs the
    // operator's default credential mirror, and a command that prints the
    // scode argv and runs nothing (cli-spawn-prep.ts) must not mutate
    // authentication state on the way. It contributes nothing to the
    // printed argv.
    adapter.prepareSandbox({ sandboxTrust, passthroughEnv });
  }
  // A codex override session's CODEX_HOME (review D1): created only
  // after every refusing step, and its config.toml written only
  // after the resume claim (prepareConfig, inside the spawn block
  // below — review D5, correctness 3), so a session that never
  // spawns writes nothing. FRESH runs in one
  // `run-<pid>-<random>` directory (the run-path shape, so a
  // codemux that dies mid-session leaves it to the same stale
  // sweep) moved onto its session-keyed path at an orderly
  // resumable end; RESUMED opens the recorded key, its config.toml
  // rewritten atomically (the earlier session's child could write
  // that directory) — and a key that is missing or untrusted is
  // refused outright, never silently remade as an empty home
  // (review D2, correctness-2 2). One home holds one session's
  // threads and config — nothing is shared across sessions. The
  // driver settles it at the end path (a settlement that cannot
  // reach the key drops the resumable verdict; a resumed home is
  // never removed there, review D3 — its state predates this
  // process); a spawn that throws abandons it below.
  const codexSessionHome =
    agentId === "codex" && codexOverride !== null
      ? resumeId !== undefined
        ? openCodexSessionProviderHome(
            codexHome(),
            codexOverride,
            // validateRunRequest refused an override without a model
            // (codex's own modelFor), so the config always carries
            // one.
            model as string,
            readCodexMultiAgent(),
            resumeId
          )
        : createCodexSessionProviderHome(
            codexHome(),
            codexOverride,
            model as string,
            readCodexMultiAgent()
          )
      : null;
  // A project-settings session's private config directory
  // (claude-project-config.ts): FRESH at the first command, OPENED
  // by every --resume (the harness's own transcript lives under it
  // now), removed only by --final at session end or the two-day
  // sweep once the registry entry is gone. Opened after every
  // refusing step above — the resume guards included — so a refused
  // command writes nothing. The abort paths below abandon a fresh
  // one (nothing points at it) and honor --final everywhere.
  const wantsSessionProjectDir =
    experimentProjectSettings && claudeSessionId !== undefined;
  if (wantsSessionProjectDir && sandboxOptions !== undefined) {
    // The caller-block conflict check runs BEFORE the directory exists:
    // the session directory's path is deterministic (the same two
    // helpers openProjectSettingsSessionConfigDir builds it from), so a
    // refusal here leaves nothing to leak — the CLI binds
    // sessionProjectDir only after this function returns, so its catch
    // cannot remove a directory created past this point (review round
    // 11, contracts-2 1).
    assertNoCallerBlockOverStateDirs(
      sandboxOptions.blockPaths ?? [],
      [
        ...(sandboxOptions.harnessStateDirs ?? []),
        projectSettingsSessionDirPath(
          projectSettingsConfigRoot(process.env),
          claudeSessionId as string
        ),
      ]
    );
  }
  let sessionProjectDir: ReturnType<typeof openProjectSettingsSessionConfigDir> | null =
    null;
  try {
    sessionProjectDir = wantsSessionProjectDir
      ? openProjectSettingsSessionConfigDir(
          claudeSessionId as string,
          resumeId !== undefined,
          workdir,
          process.env
        )
      : null;
    if (sessionProjectDir !== null && sandboxOptions !== undefined) {
      // The run path's rule (launch.ts): the operator's real config
      // root and the ~/.claude.json beside it are blocked, and only
      // this session's own private directory is re-allowed after them
      // — every other run's and session's tree under .codemux-hermetic
      // stays unreachable, read and write. Sits before every spawn
      // (the long-lived child and each turn), because every child
      // inherits these options.
      sandboxOptions.blockPaths = [
        ...(sandboxOptions.blockPaths ?? []),
        ...sessionProjectDir.blockedPaths,
      ];
      sandboxOptions.harnessStateDirs = [
        ...(sandboxOptions.harnessStateDirs ?? []),
        sessionProjectDir.dir,
      ];
    }
  } catch (error) {
    // The second line of defense for the check above: a fresh directory
    // this function created is removed on the way out of any throw past
    // its creation (a resumed one predates this process and stays).
    if (sessionProjectDir !== null && resumeId === undefined) {
      sessionProjectDir.remove();
    }
    throw error;
  }
  const sessionProjectDirResumed = resumeId !== undefined;
  return {
    needsKeepEnvPreflight,
    buildSessionEnvironment,
    claudeFamilyAgent,
    claudeBuilt,
    turnPerProcess,
    codexSessionHome,
    sessionProjectDir,
    sessionProjectDirResumed,
  };
}

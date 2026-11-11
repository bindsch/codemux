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
import { assertClineToolVersion } from "../cline-experiment-policy.js";
import {
  createCodexSessionProviderHome,
  openCodexSessionProviderHome,
  readCodexMultiAgent,
  writeCodexProviderConfigInto,
} from "../codex-provider.js";
import { assertCodexNoToolsCatalogVersion } from "../codex-no-tools.js";
import { writeCodexProjectSettingsConfig } from "../codex-project-settings.js";
import { pinCodexSessionCatalogBinary } from "./codex-catalog.js";
import { populateCodexHermeticSessionHome } from "../hermetic-home.js";
import { populateKimiHermeticSessionHome } from "../kimi-hermetic.js";
import { populateKimiPolicySessionHome } from "../kimi-run-policy.js";
import { applyAgyIsolationSandboxBlocks } from "../launch/agy-isolation-sandbox.js";
import { assertQuotaHeadroomForLaunch, resolveQuotaGate } from "../quota-gate.js";
import {
  assertNoCallerBlockOverStateDirs,
  withKeepEnvExemption,
  type SandboxOptions,
  type ScodeTrustLevel,
} from "../sandbox.js";
import type { AgentId, AutonomyLevel, CodemuxConfig, ReasoningEffort, RunRequest } from "../types.js";
import type { BaseAdapter } from "../adapters/base.js";
import type { ProviderOverride } from "../provider-override.js";
import { isTurnAgent } from "./turn-driver-launch.js";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { buildClaudeSessionCommand } from "./claude-session.js";
import type { SessionAgentSupport } from "./cli-agents.js";
import { agyHarnessHome, kimiHarnessHome } from "./cli-homes.js";
import type { SessionCommandOptions } from "./cli-request.js";
import { AGY_CONVERSATION_ID_PATTERN } from "./agy-session.js";
import {
  populateAgySessionPrivateHome,
  verifyAgySessionPrivateHome,
} from "./agy-private-home.js";
import { CODEX_THREAD_ID_PATTERN } from "./codex-parse-facts.js";
import { KIMI_SESSION_ID_PATTERN } from "./kimi-session.js";
import { openSessionPrivateHome } from "./private-home.js";
import type { SessionPrivateHome } from "./private-home-types.js";
import { prepareSessionEnvironment } from "./cli-environment.js";
import { openOpenCodeSessionHome } from "./opencode-home.js";
import { opencodeRealDataDir, opencodeRealStateDir } from "../adapters/opencode-home.js";
import { callerHarnessHomeApiKeyAuth, callerHarnessHomeEnvAssignments, callerHarnessHomeSharedLogins, openCallerHarnessHome, type CallerHarnessHome } from "./harness-home.js";
import { applyHarnessHomeSandboxBlocks, harnessHomeBlockedPaths } from "../launch/harness-home-sandbox.js";

export type { SessionEnvironmentBuilder } from "./cli-environment.js";

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
  hermetic,
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
  hermetic: boolean;
  experimentProjectSettings: boolean;
  sandboxOptions: SandboxOptions | undefined;
  sandboxTrust: ScodeTrustLevel;
  claudeSessionId: string | undefined;
  resumeId: string | undefined;
  codexHome: () => string;
  codexOverride: (ProviderOverride & { baseUrl: string; apiKey: string }) | null;
  runLike: RunRequest;
}) {
  if (options.printSandbox) sandboxOptions = structuredClone(sandboxOptions);
  // Preflight and children use the adapter's credential and executable environment.
  let callerHome: CallerHarnessHome | null = null;
  const baseEnvironment = prepareSessionEnvironment({
    adapter, runLike, passthroughEnv, sandboxed: Boolean(options.sandbox), sandboxOptions, override,
    callerHomeAgent: options.harnessHome === undefined ? undefined : agentId,
  });
  const { needsKeepEnvPreflight } = baseEnvironment;
  const buildSessionEnvironment: import("./cli-environment.js").SessionEnvironmentBuilder = (context) => {
    callerHome?.verify();
    // scode keeps the operator HOME; only the harness argv redirects it.
    return baseEnvironment.buildSessionEnvironment(context);
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
        tools: runLike.tools,
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
        // The isolation mode's own argv (claude-session.ts): the
        // project-settings mode's setting sources with slash commands
        // (skills) disabled, or the run path's --safe-mode argv for a
        // plain --hermetic session. The CLI passes projectSettings
        // alone when both flags arrive — hermetic is implied there —
        // so the two branches never mix.
        projectSettings: experimentProjectSettings,
        hermetic: hermetic && !experimentProjectSettings,
        harnessHome: options.harnessHome !== undefined,
      })
    : null;
  // Turn-per-process agents (opencode, aider, kimi, and every
  // turn-driver agent) spawn one process per caller input: no argv here.
  const turnPerProcess =
    agentId === "opencode" || agentId === "aider" || agentId === "kimi" || isTurnAgent(agentId);

  // Check quota after request/resume validation, before creating homes or
  // children. The CLI releases an already-claimed resume after refusal.
  const quotaPolicy = resolveQuotaGate({
    config: config.quota,
    ceiling: options.quotaCeiling,
    disabled: options.quotaGate === false,
  });
  if (quotaPolicy !== null && !options.printSandbox) await assertQuotaHeadroomForLaunch(adapter, quotaPolicy);

  // Pin before probing; app-server argv and spawn keep this executable identity.
  const harnessEnvironment = adapter.buildExecutionEnv(adapter.getEnv(), passthroughEnv);
  const codexCatalogBinary = agentId === "codex"
    ? pinCodexSessionCatalogBinary(runLike, adapter.binaryName, workdir, harnessEnvironment.PATH ?? "") : null;
  const harnessVersion = await assertHarnessSupported(
    agentId,
    codexCatalogBinary?.binary ?? adapter.binaryName,
    options.cwd,
    harnessEnvironment,
    autonomy,
    Boolean(options.sandbox),
    passthroughEnv,
    sessionSupport.floor
  );
  if (codexCatalogBinary !== null) assertCodexNoToolsCatalogVersion(harnessVersion);
  if (agentId === "cline" && runLike.tools === "none") assertClineToolVersion(harnessVersion);

  adapter.beforeLaunch();
  if (options.sandbox && !options.printSandbox) {
    // prepareSandbox is skipped on a print-only invocation for the same
    // reason the run path skips it (launch.ts, review round 18, edges 2):
    // the claude family's implementation refreshes or scrubs the
    // operator's default credential mirror, and a print must not mutate
    // authentication state. --harness-home runs it too (review R420 B1):
    // it guards the mirror the caller home's access-only copy comes from.
    // A caller home refuses --pass-env of the Claude profile redirects it
    // sets (assertHarnessHomePassEnv), so none reaches this guard.
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
  // process); a spawn that throws abandons it below. A HERMETIC
  // session opens the shared private home below instead — the
  // override's config.toml rides inside it, exactly as a hermetic
  // override run's does (adapters/codex.ts).
  const codexSessionHome =
    agentId === "codex" && codexOverride !== null && !hermetic && options.harnessHome === undefined
      ? resumeId !== undefined
        ? openCodexSessionProviderHome(
            codexHome(),
            codexOverride,
            // validateRunRequest refused an override without a model
            // (codex's own modelFor), so the config always carries
            // one.
            model as string,
            readCodexMultiAgent(),
            resumeId, options.printSandbox === true
          )
        : createCodexSessionProviderHome(
            codexHome(),
            codexOverride,
            model as string,
            readCodexMultiAgent(), options.printSandbox === true
          )
      : null;
  // A hermetic claude-family session's private config directory
  // (claude-project-config.ts, over session/private-home.ts): plain
  // --hermetic and --experiment-project-settings share the one
  // session-keyed directory. FRESH at the first command, OPENED by
  // every --resume (the harness's own transcript lives under it
  // now), removed only by --final at session end or the two-day
  // sweep once the registry entry is gone. Opened after every
  // refusing step above — the resume guards included — so a refused
  // command writes nothing. The abort paths below abandon a fresh
  // one (nothing points at it) and honor --final everywhere.
  const wantsSessionProjectDir =
    (hermetic || experimentProjectSettings) && claudeSessionId !== undefined;
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
          process.env, undefined, options.printSandbox === true
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
      sandboxOptions.callerBlockPaths ??= sandboxOptions.blockPaths ?? [];
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
  // A hermetic codex, kimi, or agy session's private home (the shared
  // core, session/private-home.ts): one directory per session, fresh at
  // the first command and keyed by the harness's own session id at the
  // driver's settle, reopened by every --resume (a missing key is
  // refused, never remade — the transcript lived under it). Each
  // agent's populate mirrors its run path exactly: codex's `.codex`
  // CODEX_HOME with its one-line config.toml and the login link
  // (hermetic-home.ts; an override rides inside it instead, the
  // provider key being the credential), kimi's `.kimi-code` brand home
  // with the shared credential symlink and the copied short state, and
  // agy's private Keychain login (agy-private-home.ts). A resumed agy
  // home is verified to still carry its login — a resume would else
  // launch unauthenticated and could store a fresh login into the
  // private home. Nothing is linked from the operator's home except
  // codex's auth.json and kimi's credentials, the two the run path
  // links too. Opened after every refusing step and after the quota
  // gate, like the claude family's directory above; a throw past a
  // fresh populate removes the directory itself
  // (private-home.ts populateOrRemove).
  let sessionPrivateHome: SessionPrivateHome | null = null;
  let kimiSourceBrandHome: string | null = null;
  if (options.harnessHome !== undefined) {
    const blockedPaths = harnessHomeBlockedPaths(process.env, undefined, workdir);
    const sourceHome = agentId === "codex" ? codexHome()
      : agentId === "claude" || agentId === "zai" ? process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || homedir(), ".claude")
      : process.env.HOME || homedir();
    const apiKeyAuth = override !== null || callerHarnessHomeApiKeyAuth(agentId, process.env);
    if (sandboxOptions !== undefined) applyHarnessHomeSandboxBlocks(sandboxOptions, options.harnessHome, blockedPaths,
      callerHarnessHomeSharedLogins(agentId, sourceHome, process.env, workdir, apiKeyAuth));
    callerHome = openCallerHarnessHome({
      agent: agentId, dir: options.harnessHome, cwd: workdir, blockedPaths, sourceHome, apiKeyAuth, providerOverride: override !== null,
      resumed: resumeId !== undefined, printOnly: options.printSandbox === true,
    });
    if (agentId === "claude" || agentId === "zai") {
      sessionProjectDir = callerHome;
      claudeBuilt!.argv.unshift("env", ...callerHarnessHomeEnvAssignments(callerHome));
    }
    else sessionPrivateHome = callerHome;
  }
  if ((hermetic && (agentId === "codex" || agentId === "kimi" || agentId === "agy")) || (agentId === "kimi" && enablePlaywrightMcp && options.harnessHome === undefined)) {
    // Print-only launches need the home's path for the argv and none of
    // the operator's state. Preparation and cleanup leave the tree intact.
    const printOnly = options.printSandbox === true;
    if (agentId === "codex") {
      sessionPrivateHome = openSessionPrivateHome({
        printOnly,
        parent: join(codexHome(), ".codemux-hermetic"),
        sessionId: resumeId,
        resume: resumeId !== undefined,
        idPattern: CODEX_THREAD_ID_PATTERN,
        blockedPaths: [],
        populate: printOnly ? undefined : (dir) => {
          // The run path's own rule (adapters/codex.ts): API-key auth
          // from CODEX_API_KEY alone, and an override run never links
          // the operator's auth.json — the provider key is the
          // credential.
          const apiKeyAuth =
            Boolean(process.env.CODEX_API_KEY?.trim()) || codexOverride !== null;
          const { codexHome: privateCodexHome } =
            populateCodexHermeticSessionHome(dir, codexHome(), apiKeyAuth);
          if (codexOverride !== null) {
            writeCodexProviderConfigInto(
              privateCodexHome,
              codexOverride,
              model as string,
              readCodexMultiAgent()
            );
          }
          if (experimentProjectSettings) {
            writeCodexProjectSettingsConfig(privateCodexHome, workdir, codexOverride !== null);
          }
        },
      });
    } else if (agentId === "kimi") {
      // The brand home the filtered config and the credential link come
      // from — the same resolver the registry's harness_home uses, so
      // the private store and the record name one tree. A missing
      // operator login fails the populate (and removes the fresh
      // home), exactly as a hermetic run's does.
      kimiSourceBrandHome = kimiHarnessHome(passthroughEnv);
      sessionPrivateHome = openSessionPrivateHome({
        printOnly,
        parent: join(kimiSourceBrandHome, ".codemux-hermetic"),
        sessionId: resumeId,
        resume: resumeId !== undefined,
        idPattern: KIMI_SESSION_ID_PATTERN,
        blockedPaths: [],
        populate: printOnly ? undefined : (dir) => {
          if (hermetic) populateKimiHermeticSessionHome(dir, kimiSourceBrandHome);
          else populateKimiPolicySessionHome(dir, kimiSourceBrandHome);
        },
      });
    } else {
      // The agy policy question the run path answers with
      // withKeepEnvExemption (adapters/agy.ts): agy's getRunEnv carries
      // no injected names ({} always), so getEnv() is the whole story.
      const policy = sandboxOptions === undefined
        ? null
        : withKeepEnvExemption(sandboxOptions, adapter.getEnv(), override !== null);
      const agyHomeOptions = {
        environment: process.env,
        cwd: workdir,
        scrubbing: policy !== null &&
          (policy.scrubEnv === true || policy.trust === "untrusted"),
        keepEnv: policy?.keepEnv,
      };
      // The real state tree the child must not reach: the ~/.gemini with
      // the operator's antigravity-cli state, GEMINI.md, and every other
      // run's and session's probe home. Only this session's private home
      // is re-allowed after it (launch/agy-isolation-sandbox.ts).
      const realAgyState = dirname(agyHarnessHome());
      sessionPrivateHome = openSessionPrivateHome({
        printOnly,
        parent: join(realAgyState, ".codemux-isolation-probes"),
        sessionId: resumeId,
        resume: resumeId !== undefined,
        idPattern: AGY_CONVERSATION_ID_PATTERN,
        blockedPaths: [realAgyState],
        populate: printOnly ? undefined : (dir) => {
          populateAgySessionPrivateHome(dir, agyHomeOptions);
        },
      });
      if (sandboxOptions !== undefined) {
        // A fresh home's name is minted at creation, so the caller-block
        // conflict check runs after the open against the exact path: a
        // resume's open reads only, and a refusal on a fresh home removes
        // it here — the CLI binds sessionPrivateHome only after this
        // function returns (review round 11, contracts-2 1).
        try {
          applyAgyIsolationSandboxBlocks(sandboxOptions,
            { realStateRoot: realAgyState, privateHome: sessionPrivateHome.dir });
        } catch (error) {
          if (resumeId === undefined) sessionPrivateHome.remove();
          throw error;
        }
      }
      if (resumeId !== undefined && !printOnly) {
        verifyAgySessionPrivateHome(sessionPrivateHome.dir, agyHomeOptions);
      }
    }
  }
  if (agentId === "opencode" && hermetic) {
    sessionPrivateHome = openOpenCodeSessionHome({
      dataDir: opencodeRealDataDir(process.env),
      stateDir: opencodeRealStateDir(process.env),
      resumeSessionId: resumeId,
      printOnly: options.printSandbox === true,
    });
    if (sandboxOptions !== undefined) {
      try {
        assertNoCallerBlockOverStateDirs(sandboxOptions.blockPaths ?? [], [sessionPrivateHome.dir]);
        sandboxOptions.callerBlockPaths ??= sandboxOptions.blockPaths ?? [];
        sandboxOptions.blockPaths = [...(sandboxOptions.blockPaths ?? []), ...sessionPrivateHome.blockedPaths];
        sandboxOptions.harnessStateDirs = [...(sandboxOptions.harnessStateDirs ?? []), sessionPrivateHome.dir];
      } catch (error) {
        if (resumeId === undefined) sessionPrivateHome.remove();
        throw error;
      }
    }
  }
  return {
    sandboxOptions,
    needsKeepEnvPreflight,
    buildSessionEnvironment,
    claudeFamilyAgent,
    claudeBuilt,
    turnPerProcess,
    codexSessionHome,
    sessionProjectDir,
    sessionProjectDirResumed,
    sessionPrivateHome,
    kimiSourceBrandHome,
    codexCatalogBinary, harnessVersion,
  };
}

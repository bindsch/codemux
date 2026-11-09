// What the long-lived session child runs under: the argv, the run
// context, the environment with its keep-env preflight, and the
// --print-sandbox introspection. src/session/cli.ts owns the command
// and the spawn itself.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { piProviderModelSelector } from "../pi-provider.js";
import { buildCopilotRpcLaunch } from "./copilot-rpc-config.js";
import { previewClineSessionSettings } from "./cline-settings.js";
import { buildClineSessionCommand } from "./cline-session.js";
import { SESSION_AGENTS } from "./cli-agents.js";
import { turnAgentStateRoot, turnAgentHermeticTurnContext, turnSessionProviderOverride } from "./turn-driver-homes.js";
import { prepareCallerTurnContext } from "./turn-driver-caller-context.js";
import { AiderAdapter } from "../adapters/aider.js";
import { buildAiderSessionPreview } from "./aider-preview.js";
import { buildKimiSessionPreview } from "./kimi-preview.js";
import { printKimiSessionSandbox } from "./kimi-print-sandbox.js";
import { kimiHermeticTurnContext } from "./kimi-turn-context.js";
import { buildOpenhandsPreviewCommand, openhandsPreviewContext } from "./openhands-preview.js";
import { aiderHarnessHome } from "./cli-homes.js";
import { buildAgySessionCommand } from "./agy-session.js";
import { buildOpenCodeTurnCommand } from "./opencode-command.js";
import { openCodeHermeticTurnPrefix } from "./opencode-session.js";
import { OpencodeAdapter, opencodeRealDataParent } from "../adapters/opencode.js";
import { openCodeSessionSandboxOptions, prepareOpenCodeCallerTurnContext } from "./opencode-home.js";
import { buildCodexSessionCommand, codexCallerHomeConfigArgs, codexSessionHermeticEnvPrefix } from "./codex-session.js";
import { codexPlaywrightMcpOverrides } from "../codex-playwright-mcp.js";
import type { CodexSessionCatalog } from "./codex-catalog.js";
import type { BaseAdapter, RunContext } from "../adapters/base.js";
import { assertScodeKeepEnvSupport, resolveScodeExecutableForEnv } from "../cli-runtime.js";
import type { ProjectSettingsSessionDir } from "../claude-project-config.js";
import type { CodexSessionProviderHome } from "../codex-provider.js";
import type { ProviderOverride } from "../provider-override.js";
import { assertNoCallerBlockOverStateDirs, withKeepEnvExemption, type SandboxOptions } from "../sandbox.js";
import { escapeArgvForPrint } from "../usage-protocol.js";
import type { SessionEnvironmentBuilder } from "./cli-launch.js";
import type { SessionCommandOptions } from "./cli-request.js";
import type { ClaudeSessionBuilt } from "./claude-session/builders.js";
import type { SessionPrivateHome } from "./private-home-types.js";
import { callerHarnessHomeEnvAssignments, isCallerHarnessHome } from "./harness-home.js";
import { usageError } from "./cli-usage.js";
import { applyTurnProjectSandbox, isTurnAgent, TURN_AGENT_PROFILES, turnArgvExtras } from "./turn-driver-launch.js";
import { resolveSessionSandboxSpawn } from "./spawn.js";
import type { AgentId, AutonomyLevel, ReasoningEffort, RunRequest } from "../types.js";

export async function prepareSessionChild({
  options,
  agentId,
  adapter,
  override,
  runLike,
  resumeId,
  model,
  autonomy,
  effort,
  workdir,
  requestedAutonomy,
  sandboxOptions,
  callerBlockPaths = [],
  claudeBuilt,
  codexSessionHome,
  codexSessionCatalog = null,
  sessionProjectDir,
  sessionPrivateHome,
  turnPerProcess,
  needsKeepEnvPreflight,
  buildSessionEnvironment,
}: {
  options: SessionCommandOptions;
  agentId: AgentId;
  adapter: BaseAdapter;
  override: ProviderOverride | null;
  runLike: RunRequest;
  resumeId: string | undefined;
  model: string | undefined;
  autonomy: AutonomyLevel;
  effort: ReasoningEffort | undefined;
  workdir: string;
  requestedAutonomy: AutonomyLevel;
  sandboxOptions: SandboxOptions | undefined;
  callerBlockPaths?: readonly string[];
  claudeBuilt: ClaudeSessionBuilt | null;
  codexSessionHome: CodexSessionProviderHome | null;
  codexSessionCatalog?: CodexSessionCatalog | null;
  sessionProjectDir: ProjectSettingsSessionDir | null;
  sessionPrivateHome: SessionPrivateHome | null;
  turnPerProcess: boolean;
  needsKeepEnvPreflight: boolean;
  buildSessionEnvironment: SessionEnvironmentBuilder;
}) {
  const callerHome = isCallerHarnessHome(sessionPrivateHome) ? sessionPrivateHome : null;
  const callerPreviewContext = (): RunContext => {
    if (callerHome === null) return {};
    if (agentId === "opencode") return prepareOpenCodeCallerTurnContext(callerHome, override, model, ["opencode"], true).context;
    if (!isTurnAgent(agentId)) return {};
    const provider = ["pi", "droid", "gemini", "goose", "qwen"].includes(agentId)
      ? turnSessionProviderOverride(agentId as "pi" | "droid" | "gemini" | "goose" | "qwen") : null;
    return prepareCallerTurnContext({ agent: agentId, adapter, request: runLike, home: callerHome, override: provider, model, printOnly: true });
  };
  // Preview paths use the driver's naming rules without opening its state.
  // A fresh preview ID is representative; a resume keeps its known ID.
  const aiderPreview = options.printSandbox && agentId === "aider" && adapter instanceof AiderAdapter
    ? buildAiderSessionPreview({
        harnessHome: aiderHarnessHome(),
        sessionId: resumeId ?? randomUUID(),
        hermetic: runLike.hermetic === true,
        callerHome: isCallerHarnessHome(sessionPrivateHome) ? sessionPrivateHome : undefined,
        autonomy, effort,
        model: adapter.wireModelFor(model),
        weakModel: override !== null ? adapter.wireModelFor(model) : undefined,
        permissionPolicy: options.permissionPolicy as "default" | "deny" | undefined,
        tools: runLike.tools,
        maxOutputTokens: override?.maxOutputTokens,
      })
    : null;
  const codexPlaywright = agentId === "codex" ? codexPlaywrightMcpOverrides(Boolean(options.sandbox), {
    enabled: options.enablePlaywrightMcp, pathEnv: adapter.executionPathEnv(), forbiddenRoot: workdir,
  }) : { overrides: [], check: null };
  const extraExecutableChecks = [
    ...(codexPlaywright.check === null ? [] : [codexPlaywright.check]),
    ...(codexSessionCatalog === null ? [] : [codexSessionCatalog.check]),
  ];
  const argv =
    claudeBuilt !== null
      ? claudeBuilt.argv
      : agentId === "codex"
        ? buildCodexSessionCommand(
            // A HERMETIC session: the private home as both HOME and
            // CODEX_HOME (codex-session.ts) — the run path's own argv
            // shape. Read once here; the child this names spawns
            // before the end path could settle the home, and it is
            // long-lived, so the name never goes stale under it.
            sessionPrivateHome !== null
              ? isCallerHarnessHome(sessionPrivateHome)
                ? callerHarnessHomeEnvAssignments(sessionPrivateHome)
                : codexSessionHermeticEnvPrefix(sessionPrivateHome.dir)
              : // The override launch: CODEX_HOME pointed at the
                // session's provider home — the live run-shaped one for
                // a fresh session, the session-keyed one for a resume —
                // through the same env(1) shape the run path spawns with.
                codexSessionHome !== null
                ? [`CODEX_HOME=${codexSessionHome.codexHome}`]
                : undefined,
            // The Playwright server rides the app-server's -c channel —
            // the same trust-checked overrides the run path embeds
            // (codex-playwright-mcp.ts); the session gate has already
            // required --sandbox when the flag is on.
            [...(options.harnessHome === undefined ? [] : codexCallerHomeConfigArgs(override, model)), ...codexPlaywright.overrides],
            { hermetic: runLike.hermetic, projectSettings: runLike.experimentProjectSettings,
              tools: runLike.tools, noToolsCatalog: codexSessionCatalog }
          )
        : agentId === "agy"
          ? sessionPrivateHome !== null
            ? // The builder supplies the private home's empty-environment
              // redirect itself (agy-session.ts privateHomeDir): no operator
              // config, instructions, or state loads from a home codemux made.
              buildAgySessionCommand({
                permissionPolicy: options.permissionPolicy as "default" | "deny" | undefined,
                privateHomeDir: sessionPrivateHome.dir,
                callerHome: isCallerHarnessHome(sessionPrivateHome) ? sessionPrivateHome : undefined,
                resumeConversationId: resumeId,
                model,
                autonomy,
                effort,
              })
            : buildAgySessionCommand({
                permissionPolicy: options.permissionPolicy as "default" | "deny" | undefined,
                resumeConversationId: resumeId,
                model,
                autonomy,
                effort,
              })
          : options.printSandbox && agentId === "kimi" && callerHome !== null
            ? buildKimiSessionPreview({ model: override === null ? model : undefined, resumeSessionId: resumeId,
              harnessHome: callerHome.dir, hermetic: false, callerHome, tools: runLike.tools })
            : aiderPreview?.argv ?? null;
  // The run context, exactly as run's launch path builds one
  // (launch.ts). Codex under an override carries the SESSION's
  // provider home: a getRunEnv shape requirement (the adapter
  // refuses an override launch whose home was not prepared) and the
  // seam that keeps the key off argv. Its finalize is a no-op by
  // design: the home is per-SESSION state, settled by the driver at
  // the end path (kept on a resumable end; a fresh one removed
  // otherwise, a resumed one never — review D3), so no run-scoped
  // cleanup may own its lifetime. A hermetic agy session carries its
  // private home on the probe seam for the same reason — the
  // adapter's getRunEnv refuses a hermetic launch without one — with
  // the same no-run-scoped-lifetime rule.
  const runContext: RunContext | undefined =
    sessionPrivateHome !== null && agentId === "kimi" ? kimiHermeticTurnContext(sessionPrivateHome) :
    sessionPrivateHome !== null && agentId === "codex"
      ? {
          // The adapter requires the prepared home for native and
          // provider-override launches. The session owns its removal.
          hermeticHome: {
            home: sessionPrivateHome.dir,
            codexHome: join(sessionPrivateHome.dir, ".codex"),
            finalize: () => {},
          },
          ...(isCallerHarnessHome(sessionPrivateHome) ? {
            codexProviderHome: { codexHome: join(sessionPrivateHome.dir, ".codex"), finalize: () => {} },
          } : {}),
        }
      : codexSessionHome !== null
      ? {
          codexProviderHome: {
            codexHome: codexSessionHome.codexHome,
            finalize: () => {},
          },
        }
      : sessionPrivateHome !== null && agentId === "agy"
        ? {
            agyProbe: {
              mode: "hermetic",
              home: sessionPrivateHome.dir,
              printOnly: options.printSandbox === true,
            },
          }
        : sessionProjectDir !== null && !isCallerHarnessHome(sessionProjectDir)
        ? {
            // The session's private config directory through the
            // adapter's own getRunEnv seam: CLAUDE_CONFIG_DIR plus
            // the credential copy. Its finalize is a no-op by
            // design, the codex session-home rule: the directory is
            // per-SESSION state (it must survive this process for
            // the next --resume), so no run-scoped cleanup may own
            // its lifetime — --final and the sweep do.
            claudeProjectConfigDir: {
              dir: sessionProjectDir.dir,
              blockedPaths: sessionProjectDir.blockedPaths,
              finalize: () => {},
            },
          }
        : undefined;
  // The probe environment answers the same environment WITHOUT writing
  // into the session's private directory (the credential copy is
  // deferred): everything below that runs before the resume claim —
  // the keep-env preflight, --print-sandbox — builds from this one,
  // so a resume that never claims writes nothing (review round 3,
  // edges finding on the claim order). Built lazily: the preflight and
  // the print are the only consumers, and opencode's probe context (a
  // prepared provider config) exists only while one runs.
  const buildProbeEnvironment = (): { runEnv: Record<string, string>; env: Record<string, string> } => {
    if (callerHome !== null && turnPerProcess) return buildSessionEnvironment(callerPreviewContext());
    if (runContext?.claudeProjectConfigDir !== undefined) {
      return buildSessionEnvironment({
        ...runContext,
        claudeProjectConfigDir: { ...runContext.claudeProjectConfigDir, deferCredentialCopy: true },
      });
    }
    if (isTurnAgent(agentId) && needsKeepEnvPreflight) {
      // The seven second-wave agents need a prepared context to build
      // their run environment (droid's override settings file, pi's
      // override agent directory) — and their getRunEnv gates refuse
      // without one, so the keep-env preflight could not resolve
      // scode otherwise. Probe-only, cleaned on success and failure
      // (the opencode rule); every actual turn still prepares its own
      // fresh context. hermetic stays off in the probe request: the
      // gemini gate the real turn satisfies through its session home
      // has no home to name here, and the probe only reads names.
      const probeContext = agentId === "openhands" ? openhandsPreviewContext() : adapter.prepareRun({ ...runLike, hermetic: false });
      try {
        return buildSessionEnvironment(probeContext);
      } finally {
        adapter.cleanupRun(probeContext);
      }
    }
    if (agentId !== "opencode" || !needsKeepEnvPreflight) {
      // The codex override launch carries its session provider home on the
      // run context: the adapter's getRunEnv refuses an override launch
      // whose home was not prepared, so the probe environment must see the
      // same context the long-lived build will (it reads, never writes).
      return buildSessionEnvironment(runContext);
    }
    // OpenCode needs a prepared config to build its run environment.
    // This probe-only context is cleaned on success and failure;
    // every actual turn still prepares a fresh, private config.
    const probeContext = adapter.prepareRun(runLike);
    try {
      return buildSessionEnvironment(probeContext);
    } finally {
      adapter.cleanupRun(probeContext);
    }
  };
  // Long-lived children reuse this environment, BUILT AFTER THE RESUME
  // CLAIM by the caller (cli.ts builds it right before the spawn, the
  // codex prepareConfig position): building it here would copy the
  // credential mirror into a session's private directory before this
  // process owned the session. Turn children use the same builder with
  // their own context at each launch (after the claim, per turn).
  const buildLongLivedEnvironment = turnPerProcess
    ? () => ({ env: null as Record<string, string> | null, longLivedSandboxOptions: sandboxOptions, validateBeforeSpawn: undefined })
    : () => {
        const { runEnv, env } = buildSessionEnvironment(runContext);
        return {
          env,
          validateBeforeSpawn: isCallerHarnessHome(sessionPrivateHome) ? sessionPrivateHome.verify
            : isCallerHarnessHome(sessionProjectDir) ? sessionProjectDir.verify : undefined,
          longLivedSandboxOptions:
            sandboxOptions === undefined
              ? sandboxOptions
              : withKeepEnvExemption(
                  sandboxOptions,
                  { ...adapter.getEnv(), ...runEnv },
                  override !== null
                ),
        };
      };
  if (needsKeepEnvPreflight) {
    const probeEnv = buildProbeEnvironment().env;
    const scode = resolveScodeExecutableForEnv(probeEnv, workdir);
    if (scode !== null) {
      await assertScodeKeepEnvSupport(scode, workdir, probeEnv, {
        scrubEnv: sandboxOptions?.scrubEnv === true,
        untrusted: sandboxOptions?.trust === "untrusted",
      });
    }
  }

  // `--print-sandbox`: resolve exactly what the long-lived child's
  // spawn would exec — probes and keep-env resolution included, the
  // same shared builder (resolveSessionSandboxSpawn) — print the
  // scode argv, and report the print through the return value. A
  // print-only invocation claims nothing, records nothing, spawns
  // nothing: cli.ts decides print-only from the argv alone, ahead of
  // the resume claim, so the printed argv is the real one while the
  // registry is never claimed, released, or stamped (review round 17,
  // edges 2) — and nothing is written: the probe environment below
  // defers the credential copy, so a print of a resume leaves the
  // session's private directory byte-identical. A real run's claim
  // still precedes this call (it opens nothing until the launch
  // preparation below it returns). Aider prints a representative turn
  // through its pure preview builder; kimi through kimi-print-sandbox.ts.
  // cli.ts's single exit path owns the finalizers from here, so this
  // branch never exits the process itself (review round 2, edges 3).
  if (options.printSandbox && agentId === "kimi") {
    const preview = await printKimiSessionSandbox({ adapter, runLike, sessionPrivateHome, buildSessionEnvironment,
      overrideActive: override !== null, model, resumeId, enablePlaywrightMcp: options.enablePlaywrightMcp,
      workdir, requestedAutonomy, sandboxOptions });
    return { argv: preview, buildLongLivedEnvironment, extraExecutableChecks, printedSandbox: true };
  }
  if (options.printSandbox && agentId === "opencode" && adapter instanceof OpencodeAdapter) {
    const context = callerHome === null ? adapter.prepareRun(runLike) : callerPreviewContext();
    try {
      const probe = buildSessionEnvironment(context);
      const prefix = callerHome !== null ? null : openCodeHermeticTurnPrefix({
        hermetic: runLike.hermetic === true,
        projectSettings: runLike.experimentProjectSettings === true,
        home: context.opencodeHermeticHome?.home,
        providerConfigPath: context.opencodeProviderConfig?.path ?? null,
        realDataParent: opencodeRealDataParent(process.env),
        permissionPolicy: options.permissionPolicy as "default" | "deny" | undefined,
      });
      const executableChecks: import("../executable-security.js").ExecutableCheck[] = [];
      let preview = [...(prefix ?? []), ...buildOpenCodeTurnCommand({
        autonomy, effort, model: adapter.wireModelFor(model), resumeSessionId: resumeId,
        projectSettings: runLike.experimentProjectSettings === true,
        privateHome: sessionPrivateHome, tools: runLike.tools,
        playwrightMcp: options.enablePlaywrightMcp, sandboxed: Boolean(options.sandbox),
        pathEnv: adapter.executionPathEnv(), cwd: workdir, executableChecks,
        permissionPolicy: options.permissionPolicy as "default" | "deny" | undefined,
      })];
      if (callerHome !== null) preview = prepareOpenCodeCallerTurnContext(callerHome, override, model, preview, true).argv;
      const policy = sandboxOptions === undefined ? undefined : withKeepEnvExemption(
        sessionPrivateHome && callerHome === null ? openCodeSessionSandboxOptions(sandboxOptions, sessionPrivateHome, sessionPrivateHome.dir, context.opencodeProviderConfig?.path, callerBlockPaths, context.opencodeHermeticHome?.home) : sandboxOptions,
        { ...adapter.getEnv(), ...probe.runEnv }, override !== null);
      const { scodeCmd } = await resolveSessionSandboxSpawn(preview, probe.env, {
        cwd: workdir, sandboxed: true, autonomy: requestedAutonomy,
        sandboxOptions: policy, envOmissions: adapter.getEnvOmissions(), extraExecutableChecks: executableChecks,
      }, workdir);
      process.stdout.write(scodeCmd.map(escapeArgvForPrint).join("\n") + "\n");
      return { argv: preview, buildLongLivedEnvironment, extraExecutableChecks, printedSandbox: true };
    } finally { adapter.cleanupRun(context); }
  }
  if (options.printSandbox) {
    if (!options.sandbox) {
      usageError(
        "--print-sandbox requires --sandbox: it prints the scode argv of a sandboxed session child"
      );
    }
    if (argv === null && (agentId === "pi" || agentId === "gemini" || agentId === "copilot" ||
        agentId === "cursor" || agentId === "droid" || agentId === "goose" || agentId === "cline" ||
        agentId === "openhands" || (callerHome !== null && agentId === "qwen"))) {
      const id = resumeId ?? (agentId === "cline" ? `${Date.now()}_print_cli` : randomUUID());
      const privateDir = runLike.hermetic
        ? join(turnAgentStateRoot(agentId, runLike.passthroughEnv ?? []),
            ".codemux-hermetic", `session-${id}`)
        : null;
      // Printing never opens or claims a session home. The path is the
      // same path the session would own; prompt text arrives on stdin.
      const prepared = callerHome !== null ? callerPreviewContext() : agentId === "openhands" ? openhandsPreviewContext() : adapter.prepareRun({ ...runLike, hermetic: agentId === "cline" && runLike.hermetic === true },
        sandboxOptions?.trust, sandboxOptions, { printOnly: true });
      try {
        const context = agentId === "cline"
          ? previewClineSessionSettings({ request: runLike, prepared, privateDir, environment: process.env })
          : privateDir === null ? prepared : { ...prepared, ...turnAgentHermeticTurnContext(agentId, { dir: privateDir }) };
        const probe = buildSessionEnvironment(context);
        const provider = adapter.providerOverride();
        const selected = model ?? provider?.model;
        // The per-turn inputs a real turn carries (review m4): the tool
        // selection, the Playwright flag, and the argv extras that need
        // no file write, through the turn's own helper.
        const turnInput = {
          text: "<session prompt>", sessionId: id, firstTurn: resumeId === undefined,
          hermeticHome: privateDir, autonomy, model, effort,
          callerHome: callerHome?.dir,
          tools: runLike.tools, playwrightMcp: runLike.enablePlaywrightMcp === true,
          ...turnArgvExtras(agentId, runLike, prepared, adapter),
          ...(agentId === "pi" && provider !== null && selected !== undefined
            ? { providerModelId: piProviderModelSelector(selected) } : {}),
        };
        // The copilot project blocks a real turn adds, on a copy: the
        // session's resolved options stay as they were.
        const printedOptions = sandboxOptions === undefined ? undefined : { ...sandboxOptions };
        if (agentId === "cline" && privateDir !== null && printedOptions !== undefined) {
          const disposable = (prepared as ReturnType<typeof previewClineSessionSettings>).clineConfig?.home;
          const directories = [...(printedOptions.harnessStateDirs ?? []).filter((path) => path !== disposable), privateDir];
          assertNoCallerBlockOverStateDirs(printedOptions.blockPaths ?? [], directories);
          printedOptions.blockPaths = [...(printedOptions.blockPaths ?? []), turnAgentStateRoot(agentId, runLike.passthroughEnv ?? [])];
          printedOptions.harnessStateDirs = directories;
        }
        applyTurnProjectSandbox(agentId, runLike, printedOptions,
          turnAgentStateRoot(agentId, runLike.passthroughEnv ?? []), privateDir, prepared);
        let previewArgv = agentId === "cline" ? buildClineSessionCommand({ home: privateDir ?? callerHome?.dir, autonomy, effort,
          permissionPolicy: options.permissionPolicy === "deny" ? "deny" : "default" }) : agentId === "openhands" ? buildOpenhandsPreviewCommand({
          resumeId, callerHomeDir: callerHome?.dir, privateDir, model }) : TURN_AGENT_PROFILES[agentId].buildTurnCommand(turnInput);
        if (SESSION_AGENTS[agentId]?.interrupt) {
          if (agentId === "copilot") previewArgv = buildCopilotRpcLaunch({
            adapter, request: { ...runLike, resultJson: false }, context,
            turn: turnInput, harnessHome: turnAgentStateRoot(agentId, runLike.passthroughEnv ?? []),
          }).argv;
          if (agentId === "pi") {
            const mode = previewArgv.indexOf("--mode");
            if (mode < 0 || previewArgv[mode + 1] !== "json") throw new Error("Pi preview requires its JSON profile");
            previewArgv[mode + 1] = "rpc";
            const print = previewArgv.indexOf("--print");
            if (print >= 0) previewArgv.splice(print, 1);
          }
        }
        if (callerHome !== null) previewArgv = ["env", ...callerHarnessHomeEnvAssignments(callerHome), ...previewArgv];
        const { scodeCmd } = await resolveSessionSandboxSpawn(previewArgv, probe.env, {
          cwd: workdir, sandboxed: true, autonomy: requestedAutonomy,
          sandboxOptions: printedOptions === undefined ? undefined
            : withKeepEnvExemption(printedOptions,
                { ...adapter.getEnv(), ...probe.runEnv }, override !== null),
          envOmissions: adapter.getEnvOmissions(),
          extraExecutableChecks: prepared.playwrightMcpCheck == null ? [] : [prepared.playwrightMcpCheck],
        }, workdir);
        process.stdout.write(`${scodeCmd.map(escapeArgvForPrint).join("\n")}\n`);
        return { argv: previewArgv, buildLongLivedEnvironment, extraExecutableChecks, printedSandbox: true };
      } finally {
        adapter.cleanupRun(prepared);
      }
    }
    if (argv === null) {
      usageError(
        "--print-sandbox is not available for this agent: its session children spawn per turn, so there is no one scode argv to print"
      );
    }
    const probeEnvironment = buildProbeEnvironment();
    // The keep-env exemption the printed spawn would carry, from the
    // probe environment (same names as the real build; no writes).
    const printedSandboxOptions =
      sandboxOptions === undefined
        ? sandboxOptions
        : withKeepEnvExemption(
            sandboxOptions,
            { ...adapter.getEnv(), ...probeEnvironment.runEnv },
            override !== null
          );
    const { scodeCmd } = await resolveSessionSandboxSpawn(
      argv,
      probeEnvironment.env,
      {
        cwd: workdir,
        sandboxed: true,
        autonomy: requestedAutonomy,
        sandboxOptions: printedSandboxOptions,
        envOmissions: adapter.getEnvOmissions(),
      },
      workdir
    );
    if (aiderPreview !== null) {
      process.stderr.write(
        'codemux: aider session preview uses the placeholder prompt "codemux session"; ' +
        'session state and cap settings are not created.\n'
      );
    }
    // One argument per line, control characters escaped per argument
    // (escapeArgvForPrint), so a multi-line prompt argument cannot read as
    // several arguments.
    process.stdout.write(`${scodeCmd.map(escapeArgvForPrint).join("\n")}\n`);
    return { argv, buildLongLivedEnvironment, extraExecutableChecks, printedSandbox: true };
  }
  return { argv, buildLongLivedEnvironment, extraExecutableChecks, printedSandbox: false };
}

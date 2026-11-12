// Flag parsing and validation for one `codemux session` invocation:
// the commander options shape and the funnel that turns it into the
// validated request values — agent, model, autonomy, effort, sandbox
// options, timeouts, working directory, and the run-like request every
// adapter gate re-checks. src/session/cli.ts owns the command and
// calls this phase first.
import { AGENT_IDS, getAdapter } from "../adapters/index.js";
import { assertAbsoluteClaudeConfigDir } from "../claude-family.js";
import { PROJECT_SETTINGS_AGENTS, validateProjectSettingsRequest } from "../claude-project-settings.js";
import {
  isScodeAvailable,
  parseAutonomyOption,
  parseEffortOption,
  parsePassthroughEnvOption,
  parseSandboxPolicyOverrides,
  parseToolsOption,
  resolveAutonomyForAdapter,
  resolveEffortForAdapter,
} from "../cli-runtime.js";
import { resolveModel } from "../config.js";
import { PLAYWRIGHT_MCP_AGENT_LIST, supportsPlaywrightMcpAgent } from "../mcp.js";
import { agentsSupporting } from "../parity/index.js";
import { resolveSandboxOptionsForAgent } from "../sandbox-policy.js";
import type { AgentId, CodemuxConfig, RunRequest } from "../types.js";
import { validateWorkingDirectory } from "../validation.js";
import { canonicalSandboxBlockPaths } from "./registry/format.js";
import { parseQuotaCeilingOption } from "../quota-gate.js";
import { SESSION_AGENTS } from "./cli-agents.js";
import { assertHarnessHomePassEnv, validateHarnessHome } from "./harness-home.js";
import { harnessHomeBlockedPaths } from "../launch/harness-home-sandbox.js";
import { asUsage, assertResumeIdShape, parseOptionalTimeout, usageError } from "./cli-usage.js";

/** The commander options `codemux session` delivers to its action. */
export interface SessionCommandOptions {
  agent?: string;
  model?: string;
  resume?: string;
  harnessHome?: string;
  auto?: string;
  effort?: string;
  cwd?: string;
  timeout?: string;
  turnTimeout?: string;
  permissionTimeout?: string;
  shutdownGrace?: string;
  authorPrefix?: boolean;
  tools?: string;
  enablePlaywrightMcp?: boolean;
  passEnv?: string;
  hermetic?: boolean;
  experimentProjectSettings?: boolean;
  final?: boolean;
  permissionPolicy?: string;
  sandbox?: boolean;
  sandboxTrust?: string;
  sandboxStrict?: boolean;
  sandboxNoNet?: boolean;
  sandboxScrubEnv?: boolean;
  sandboxBlock?: string[];
  printSandbox?: boolean;
  quotaCeiling?: string;
  quotaGate?: boolean;
}

export function resolveSessionRequest(
  options: SessionCommandOptions,
  config: CodemuxConfig
) {
  const agentId = options.agent as AgentId;
  if (!AGENT_IDS.includes(agentId)) {
    console.error(`Error: Unknown agent '${agentId}'`);
    console.error(`Available agents: ${AGENT_IDS.join(", ")}`);
    process.exit(64);
  }
  const sessionSupport = SESSION_AGENTS[agentId];
  if (sessionSupport === undefined) {
    usageError(
      `sessions are not implemented for '${agentId}' in this release`
    );
  }

  // Provider overrides reach session spawns exactly as run spawns:
  // every session-capable harness `run` can point at a custom
  // provider, its session can too, through the same adapter seams
  // (the adapter's environment view here — the same read its own
  // env/config wiring makes below; the ledger's provider identity
  // derives from this one value, so a record can never name an
  // endpoint the session's spawns did not use). The adapter's own
  // validateRunRequest — the uniform gate every session agent passes
  // through below — refuses an override an agent cannot carry, zai
  // and agy, with the run path's message verbatim, so the two paths
  // cannot drift.
  const adapter = getAdapter(agentId);
  const caps = adapter.capabilities();
  const override = adapter.providerOverride();

  const requestedAutonomy = parseAutonomyOption(options.auto) ?? "read-only";
  const requestedEffort = parseEffortOption(options.effort);
  const tools = parseToolsOption(options.tools);
  if (tools === "none" && !sessionSupport.tools) {
    usageError(
      "--tools none is refused for sessions: no verified carrier " +
        "restores the tools for a resumed session on any harness " +
        "(see docs/harnesses.md)"
    );
  }
  if (tools !== undefined && !sessionSupport.tools) {
    usageError(
      `--tools is not implemented for '${agentId}' sessions in this release`
    );
  }
  // Run and session share the supported MCP carriers and sandbox gate.
  const enablePlaywrightMcp = Boolean(options.enablePlaywrightMcp);
  if (enablePlaywrightMcp && !options.sandbox) {
    usageError("--enable-playwright-mcp requires --sandbox");
  }
  if (enablePlaywrightMcp && !supportsPlaywrightMcpAgent(agentId)) {
    usageError(`--enable-playwright-mcp is supported only by ${PLAYWRIGHT_MCP_AGENT_LIST}`);
  }
  // The session cell decides, not the run-path list (review M2): an agent
  // whose run carries the server but whose session does not is refused
  // instead of starting a session the server never rides.
  if (enablePlaywrightMcp && !agentsSupporting("session.playwright-mcp").includes(agentId)) {
    usageError(`--enable-playwright-mcp is not implemented for '${agentId}' sessions in this release`);
  }
  const passthroughEnv = asUsage(() => parsePassthroughEnvOption(options.passEnv));
  // CLAUDE_CONFIG_DIR reaches only a claude-family session's child
  // (claude and zai share the one store, claudeFamilyHarnessHome),
  // so only they validate it — the CODEX_HOME rule below, mirrored:
  // the refusals (a relative or padded value) must not end a
  // codex/agy/opencode/aider session over a variable its harness
  // never reads (review D8, correctness 2, same-class audit). The
  // run path has always been scoped this way: the check lives in
  // the claude and zai adapters' validateRunRequest, never in the
  // shared launcher.
  if (agentId === "claude" || agentId === "zai") {
    asUsage(() => assertAbsoluteClaudeConfigDir(passthroughEnv));
  }
  // Hermetic sessions take the same flags `run` takes: plain --hermetic
  // (the run path's isolation, plus a per-session private home the
  // harness keeps its transcript in) and --hermetic
  // --experiment-project-settings (the repository's own settings in
  // place of the operator's). The adapter's own validateRunRequest —
  // run's gate, on runLike below — refuses a --hermetic an agent has no
  // verified mode for, with the run path's reason verbatim, so the two
  // paths cannot drift.
  const hermetic = Boolean(options.hermetic);
  if (options.harnessHome !== undefined && hermetic) {
    usageError("--harness-home cannot be combined with --hermetic; choose one isolation mode");
  }
  if (options.harnessHome !== undefined && !agentsSupporting("session.harness-home").includes(agentId)) {
    usageError(`--harness-home is not implemented for '${agentId}' sessions in this release`);
  }
  // Session isolation also requires a session-lifetime state carrier.
  // Refuse unsupported modes before availability checks so a missing
  // binary cannot replace the capability refusal with exit 1.
  if (hermetic && !sessionSupport.hermetic) {
    usageError(
      `${agentId} has no verified hermetic mode for sessions: the session keeps its ` +
        `state under the operator's real home with no session-lifetime private home ` +
        `(see docs/sessions.md)`
    );
  }
  const experimentProjectSettings = Boolean(options.experimentProjectSettings);
  if (experimentProjectSettings && !PROJECT_SETTINGS_AGENTS.some((agent) => agent === agentId)) {
    usageError(
      `--experiment-project-settings applies to the ${PROJECT_SETTINGS_AGENTS.join(", ")} agents only in this release`
    );
  }
  // The same rule for project settings (review M3): codex's run path
  // carries the mode, its session routing does not yet, so a session
  // refuses instead of running plain hermetic under the flag.
  if (experimentProjectSettings && !agentsSupporting("session.experiment-project-settings").includes(agentId)) {
    usageError(`--experiment-project-settings is not implemented for '${agentId}' sessions in this release`);
  }
  // Run refuses playwright under --hermetic; a hermetic session is no
  // exception (review round 14, edges 6).
  if (enablePlaywrightMcp && (hermetic || experimentProjectSettings) && agentId !== "cline") {
    usageError(
      "--enable-playwright-mcp cannot be combined with --hermetic --experiment-project-settings"
    );
  }
  if (options.final !== undefined && !hermetic && options.harnessHome === undefined) {
    usageError(
      "--final requires --hermetic: it removes the private home a hermetic session's " +
        "harness state lives in"
    );
  }
  // A deny uses the ask channel, or native rules in an isolated config.
  if (
    options.permissionPolicy !== undefined &&
    options.permissionPolicy !== "deny" &&
    options.permissionPolicy !== "default"
  ) {
    usageError(
      `--permission-policy accepts 'default' or 'deny' in this release; '${options.permissionPolicy}' is not supported`
    );
  }
  if (options.permissionPolicy === "deny" && sessionSupport.approvals === "none" &&
      agentId !== "aider") {
    if (sessionSupport.denyRules !== "native" && (sessionSupport.denyRules !== "hermetic" || !hermetic)) {
      const requirement = sessionSupport.denyRules === "hermetic"
        ? "requires --hermetic for native deny rules"
        : "is unavailable";
      usageError(`--permission-policy deny ${requirement} for '${agentId}': ${sessionSupport.approvalsNote}`);
    }
    if (agentId === "opencode" && experimentProjectSettings) {
      usageError("--permission-policy deny refuses --experiment-project-settings for opencode: " +
        "project agent permissions can override the global deny; " + sessionSupport.approvalsNote);
    }
    if (agentId === "openhands" && experimentProjectSettings) {
      usageError("--permission-policy deny refuses --experiment-project-settings for openhands: " +
        "HookConfig.load reads the working directory's .openhands/hooks.json first and then never reads the home's deny rule");
    }
  }
  const sandboxPolicyOverrides = asUsage(() =>
    parseSandboxPolicyOverrides({
      sandbox: Boolean(options.sandbox),
      sandboxTrust: options.sandboxTrust,
      sandboxStrict: options.sandboxStrict,
      sandboxNoNet: Boolean(options.sandboxNoNet),
      sandboxScrubEnv: Boolean(options.sandboxScrubEnv),
      sandboxBlock: options.sandboxBlock,
    })
  );
  const sandboxOptions = options.sandbox
    ? resolveSandboxOptionsForAgent(agentId, requestedAutonomy, sandboxPolicyOverrides)
    : undefined;
  const sandboxTrust = sandboxOptions?.trust ?? "standard";
  // The containment flags the registry records and the resume guard
  // compares (§4.8): only meaningful inside scode, so they are read
  // off the resolved sandbox options, not the raw argv. The block
  // paths are read here, before launch adds the project-settings
  // blocks to the same object, so the record and the resume probe
  // carry the caller's paths alone — the internal blocks are re-added
  // at every launch and can never be dropped by a resume.
  const sandboxNoNet = sandboxOptions?.noNet === true;
  const sandboxScrubEnv = sandboxOptions?.scrubEnv === true;
  const sandboxBlock = canonicalSandboxBlockPaths(sandboxOptions?.blockPaths ?? []);
  if (sandboxTrust === "untrusted") {
    usageError(
      "--sandbox-trust untrusted is refused for sessions: an untrusted " +
        "sandbox denies harness state, which a persistent session must " +
        "write (transcripts, rollouts)"
    );
  }
  // --print-sandbox's flag combinations are refused HERE, in the
  // request phase, before any home or private directory is created
  // (review round 8, contracts-2 finding 2): a refusal that fires
  // after the launch phase exits through usageError's process exit
  // and strands a fresh codex override home's run-<pid>-* directory.
  // The spawn-prep phase repeats both checks on the built argv as a
  // second line. The parity declaration admits long-lived children
  // and agents with an integrated representative per-turn preview.
  if (options.printSandbox) {
    if (!options.sandbox) {
      usageError(
        "--print-sandbox requires --sandbox: it prints the scode argv of a sandboxed session child"
      );
    }
    if (!agentsSupporting("session.print-sandbox").includes(agentId)) {
      if (options.harnessHome === undefined) usageError(
        "--print-sandbox is not available for this agent: its session children spawn per turn, so there is no one scode argv to print"
      );
    }
  }
  const sessionTimeoutMs = parseOptionalTimeout(options.timeout, "--timeout");
  const turnTimeoutMs = parseOptionalTimeout(options.turnTimeout, "--turn-timeout");
  if (turnTimeoutMs !== null && !sessionSupport.interrupt) {
    usageError("--turn-timeout requires an agent whose sessions support interrupt");
  }
  // The same funnel as --timeout/--turn-timeout above: a malformed
  // value is usage (exit 64), never an unhandled throw into the
  // outer catch's exit 1 (review live5).
  const permissionTimeoutMs =
    parseOptionalTimeout(options.permissionTimeout, "--permission-timeout") ?? 300_000;
  const shutdownGraceMs =
    parseOptionalTimeout(options.shutdownGrace, "--shutdown-grace") ?? 30_000; // DEFAULT_SHUTDOWN_GRACE_MS in process.ts

  // Presence is `!== undefined` (review round 159): an explicit
  // `--model ""` is a given model option and refuses in resolveModel's
  // validateModelName — it must never read as "no model" and fall back
  // to the recorded override's model.
  const model = options.model !== undefined
    ? asUsage(() => resolveModel(options.model!, agentId, config))
    : override?.model;
  if (model !== undefined && !caps.supportsModel) {
    usageError(`${agentId} does not support model selection`);
  }
  // The alias is the `-m` value as typed, carried only when it resolved
  // through config.models (design P5) — the run path's own rule
  // (run-command.ts). An override-selected model resolves no alias.
  const modelAlias =
    options.model !== undefined && config.models[options.model] !== undefined
      ? options.model
      : null;
  const autonomy = asUsage(() => resolveAutonomyForAdapter(agentId, caps, requestedAutonomy));
  // The ceiling grants no MCP tool at medium or high, and read-only
  // allows no tool use, so every Playwright call would be denied
  // `autonomy_escalation` at those levels; only low, where the caller
  // answers each request, can use the server (review live25).
  if (enablePlaywrightMcp && (agentId === "copilot" || agentId === "cline") && autonomy !== "medium" && autonomy !== "high") {
    usageError(`--enable-playwright-mcp for ${agentId} sessions requires --auto medium or high; low has no caller approval bridge`);
  }
  if (enablePlaywrightMcp && agentId !== "opencode" && agentId !== "copilot" && agentId !== "cline" && autonomy !== "low") {
    usageError(
      "--enable-playwright-mcp requires --auto low for sessions: the session " +
        "ceiling grants no MCP tool at medium or high, and read-only allows no tool use"
    );
  }
  if (
    adapter.requiresSandboxForAutonomy(autonomy) &&
    !options.sandbox
  ) {
    usageError(
      `${agentId} cannot enforce '${autonomy}' autonomy without --sandbox`
    );
  }
  const effort = asUsage(() => resolveEffortForAdapter(agentId, caps, requestedEffort));

  const workdir = asUsage(() => validateWorkingDirectory(options.cwd)) ?? process.cwd();
  if (options.harnessHome !== undefined) {
    options.harnessHome = asUsage(() => validateHarnessHome(
      options.harnessHome!, workdir, harnessHomeBlockedPaths(process.env),
    ));
    asUsage(() => assertHarnessHomePassEnv(agentId, passthroughEnv));
  }
  // The run path's own request validator, in its session spelling:
  // the same refusals (scode required, no --pass-env
  // CLAUDE_CONFIG_DIR/CLAUDE_CODE_PROJECT_DIR_NAME, the ancestor
  // project-memory walk) with one difference a session earns —
  // `--auto high` is accepted alongside low, because the session
  // high is codemux's own grant list, never the bypass flag, so the
  // repository's deny rules still bind (claude-project-settings.ts).
  // A UsageRefusalError (the ancestor walk) maps to 64 like every
  // other flag misuse here.
  if (experimentProjectSettings) {
    asUsage(() =>
      validateProjectSettingsRequest({
        agent: agentId,
        hermetic: Boolean(options.hermetic),
        autonomy: requestedAutonomy,
        sandbox: Boolean(options.sandbox),
        cwd: workdir,
        passthroughEnv,
        session: true,
        tools,
      })
    );
  }
  // Run's own validation gate, verbatim, for every session agent:
  // the placeholder request carries the launch values this session
  // will use, so every per-adapter rule that judges agent, model,
  // autonomy, effort, cwd, or the environment holds for sessions
  // with zero drift from `run` — the provider-override contract
  // (the model requirement, the cap refusals, zai/agy's refusal)
  // and the project-execution guards (kimi, agy, codex, aider,
  // opencode).
  // The argv prompt bound is the one rule the placeholder cannot
  // carry: its prompt is a constant, never a turn's text, so the
  // session enforces that bound per turn at the driver instead —
  // aider's text_too_long check before the ack (review D1, 2.3).
  // The project-execution guards are the one rule the start-time
  // call alone cannot carry for the turn-per-process agents: turn N
  // may write the very config turn N+1 reloads, so spawnTurn
  // re-runs this gate before every turn it spawns (review D2,
  // security 1).
  // The plain throw is run's own failure class here too (its CLI
  // maps validateRunRequest failures to exit 1), except a
  // UsageRefusalError, which maps to 64 on both paths (review D10:
  // the aider slash-command rule refuses as usage); asUsage stays
  // for the flag validators alone (review live25). Pure validation,
  // so it runs before the environment probes below.
  const runLike: RunRequest = {
    agent: agentId,
    ...(agentId === "claude" || agentId === "zai" || agentId === "opencode" || agentId === "aider" || agentId === "copilot" ||
      agentId === "gemini" || agentId === "pi" || agentId === "cursor" ||
      agentId === "droid" || agentId === "goose" || agentId === "codex" || agentId === "cline" || agentId === "kimi" ? { tools } : {}),
    ...(agentId === "opencode" || agentId === "copilot" || agentId === "gemini" ||
      agentId === "pi" || agentId === "goose" || agentId === "qwen" || agentId === "codex" || agentId === "cline" || agentId === "kimi" ? { enablePlaywrightMcp } : {}),
    prompt: "codemux session",
    model,
    autonomy,
    effort,
    cwd: workdir,
    passthroughEnv,
    sandboxed: Boolean(options.sandbox),
    // Plain --hermetic, or the pair the mode requires (the gate above
    // and validateProjectSettingsRequest both refuse the mode without
    // the flag, exactly as run does), so a project-settings session's
    // per-turn prepareRun builds the private home its env prefix names.
    hermetic,
    experimentProjectSettings,
  };
  adapter.validateRunRequest(runLike);

  // The last two option values the later phases judge (review round
  // 159): checked here as well, so a malformed --resume id or
  // --quota-ceiling is refused as usage before the availability checks
  // below can report a missing harness instead.
  if (options.resume !== undefined) assertResumeIdShape(sessionSupport, options.resume);
  if (options.quotaCeiling !== undefined) {
    asUsage(() => parseQuotaCeilingOption(options.quotaCeiling!));
  }

  if (!adapter.isAvailable()) {
    console.error(`Error: ${agentId} is not installed`);
    console.error(`Please install '${adapter.binaryName}' and try again`);
    process.exit(1);
  }
  if (options.sandbox && !isScodeAvailable()) {
    console.error("Error: scode is not installed (required for --sandbox)");
    console.error("Install scode and ensure its executable is on PATH");
    process.exit(1);
  }
  return {
    agentId,
    sessionSupport,
    adapter,
    override,
    requestedAutonomy,
    passthroughEnv,
    enablePlaywrightMcp,
    hermetic,
    experimentProjectSettings,
    sandboxOptions,
    sandboxTrust,
    sandboxNoNet,
    sandboxScrubEnv,
    sandboxBlock,
    sessionTimeoutMs,
    turnTimeoutMs,
    permissionTimeoutMs,
    shutdownGraceMs,
    model,
    modelAlias,
    autonomy,
    effort,
    workdir,
    runLike,
  };
}

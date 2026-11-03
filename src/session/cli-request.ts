// Flag parsing and validation for one `codemux session` invocation:
// the commander options shape and the funnel that turns it into the
// validated request values — agent, model, autonomy, effort, sandbox
// options, timeouts, working directory, and the run-like request every
// adapter gate re-checks. src/session/cli.ts owns the command and
// calls this phase first.
import { AGENT_IDS, getAdapter } from "../adapters/index.js";
import { assertAbsoluteClaudeConfigDir } from "../claude-family.js";
import { validateProjectSettingsRequest } from "../claude-project-settings.js";
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
import { readProviderOverride } from "../provider-override.js";
import { resolveSandboxOptionsForAgent } from "../sandbox-policy.js";
import type { AgentId, CodemuxConfig, RunRequest } from "../types.js";
import { validateWorkingDirectory } from "../validation.js";
import { canonicalSandboxBlockPaths } from "./registry/format.js";
import { SESSION_AGENTS } from "./cli-agents.js";
import { asUsage, parseOptionalTimeout, usageError } from "./cli-usage.js";

/** The commander options `codemux session` delivers to its action. */
export interface SessionCommandOptions {
  agent?: string;
  model?: string;
  resume?: string;
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
  // (readProviderOverride here; the adapter's env/config wiring
  // below). The adapter's own validateRunRequest — the uniform gate
  // every session agent passes through below — refuses an override
  // an agent cannot carry, zai and agy, with the run path's message
  // verbatim, so the two paths cannot drift.
  const adapter = getAdapter(agentId);
  const caps = adapter.capabilities();
  const override = readProviderOverride(agentId);

  const requestedAutonomy = parseAutonomyOption(options.auto) ?? "read-only";
  const requestedEffort = parseEffortOption(options.effort);
  const tools = parseToolsOption(options.tools);
  if (tools === "none") {
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
  // Run's validation verbatim (§4.5 flag matching): the carrier is
  // the sandbox-scoped --mcp-config, and only the claude family
  // has a verified one. --tools none is already refused above.
  const enablePlaywrightMcp = Boolean(options.enablePlaywrightMcp);
  if (enablePlaywrightMcp && !options.sandbox) {
    usageError("--enable-playwright-mcp requires --sandbox");
  }
  if (enablePlaywrightMcp && agentId !== "claude" && agentId !== "zai") {
    usageError("--enable-playwright-mcp is supported only by claude and zai");
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
  // Hermetic sessions exist in exactly one mode: the project-settings
  // isolation (claude/zai), which pairs --hermetic with
  // --experiment-project-settings. Every other spelling is refused
  // with the reason, so a plain --hermetic never silently becomes a
  // different isolation than `run` gives it.
  const experimentProjectSettings = Boolean(options.experimentProjectSettings);
  if (options.hermetic && !experimentProjectSettings) {
    usageError(
      "--hermetic is refused for sessions in this release: no verified hermetic " +
        "canary covers a persistent, resumable session. The one hermetic session mode " +
        "is --experiment-project-settings, which requires --hermetic (see docs/sessions.md)"
    );
  }
  if (experimentProjectSettings && agentId !== "claude" && agentId !== "zai") {
    usageError(
      "--experiment-project-settings applies to the claude and zai agents only in this release"
    );
  }
  // Run refuses playwright under --hermetic; the session's one hermetic
  // mode is no exception (review round 14, edges 6).
  if (enablePlaywrightMcp && (options.hermetic || experimentProjectSettings)) {
    usageError(
      "--enable-playwright-mcp cannot be combined with --hermetic --experiment-project-settings"
    );
  }
  if (options.final !== undefined && !experimentProjectSettings) {
    usageError(
      "--final requires --hermetic --experiment-project-settings: it removes the private " +
        "config directory those flags give a session"
    );
  }
  // The deny policy rides the claude-family permission channel alone;
  // every other agent's driver has no such channel to answer on.
  // 'default' names the unchanged behavior for scripts that spell
  // the whole policy out.
  if (
    options.permissionPolicy !== undefined &&
    options.permissionPolicy !== "deny" &&
    options.permissionPolicy !== "default"
  ) {
    usageError(
      `--permission-policy accepts 'default' or 'deny' in this release; '${options.permissionPolicy}' is not supported`
    );
  }
  // Only deny rides the claude-family channel; 'default' changes nothing
  // for any agent, so it is accepted everywhere (review round 5, edges
  // finding 2).
  if (options.permissionPolicy === "deny" && agentId !== "claude" && agentId !== "zai") {
    usageError("--permission-policy deny is supported only by claude and zai sessions");
  }
  const sandboxPolicyOverrides = asUsage(() =>
    parseSandboxPolicyOverrides({
      sandbox: Boolean(options.sandbox),
      sandboxTrust: options.sandboxTrust,
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
  // second line. The turn-per-process agents are exactly the ones
  // with no session-long child, so this is the same condition.
  if (options.printSandbox) {
    if (!options.sandbox) {
      usageError(
        "--print-sandbox requires --sandbox: it prints the scode argv of a sandboxed session child"
      );
    }
    if (agentId === "opencode" || agentId === "aider" || agentId === "kimi") {
      usageError(
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
    parseOptionalTimeout(options.shutdownGrace, "--shutdown-grace") ?? 10_000;

  const model = options.model
    ? asUsage(() => resolveModel(options.model!, agentId, config))
    : override?.model;
  if (model && !caps.supportsModel) {
    usageError(`${agentId} does not support model selection`);
  }
  const autonomy = asUsage(() => resolveAutonomyForAdapter(agentId, caps, requestedAutonomy));
  // The ceiling grants no MCP tool at medium or high, and read-only
  // allows no tool use, so every Playwright call would be denied
  // `autonomy_escalation` at those levels; only low, where the caller
  // answers each request, can use the server (review live25).
  if (enablePlaywrightMcp && autonomy !== "low") {
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
    prompt: "codemux session",
    model,
    autonomy,
    effort,
    cwd: workdir,
    passthroughEnv,
    sandboxed: Boolean(options.sandbox),
    hermetic: experimentProjectSettings,
    experimentProjectSettings,
  };
  adapter.validateRunRequest(runLike);

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
    autonomy,
    effort,
    workdir,
    runLike,
  };
}

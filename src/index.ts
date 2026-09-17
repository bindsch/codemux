import { program } from "commander";
import { readFileSync } from "fs";
import { resolveSandboxOptionsForAgent } from "./sandbox-policy.js";
import { getAdapter, AGENT_IDS } from "./adapters/index.js";
import { registerCheckCommand } from "./check-command.js";
import { getDefaultConfig, loadConfig, resolveModel } from "./config.js";
import { registerInfoCommands } from "./info-commands.js";
import { launchRunRequest } from "./launch.js";
import {
  handleUnexpectedError,
  isScodeAvailable,
  parseAutonomyOption,
  parseEffortOption,
  parsePassthroughEnvOption,
  parseSandboxPolicyOverrides,
  parseTimeoutOption,
  parseToolsOption,
  resolveAutonomyForAdapter,
  resolveEffortForAdapter,
  assertHarnessSupported,
  runSandboxed,
} from "./cli-runtime.js";
import { readUtf8FileBounded } from "./file-io.js";
import { validateWorkingDirectory } from "./validation.js";
import {
  type AgentId,
  type RunRequest,
} from "./types.js";

const MAX_PROMPT_FILE_BYTES = 16 * 1024 * 1024;

let configError: Error | undefined;
const config = (() => {
  try {
    return loadConfig();
  } catch (error) {
    configError = error instanceof Error ? error : new Error(String(error));
    return getDefaultConfig();
  }
})();

function requireValidConfig(): void {
  if (configError) throw configError;
}

const packageVersion = (() => {
  const packagePath = new URL("../package.json", import.meta.url);
  const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string") {
    throw new Error("package.json is missing a string version");
  }
  return parsed.version;
})();

program
  .name("codemux")
  .description("Unified CLI for AI coding agents")
  .version(packageVersion);

program
  .command("run")
  .description("Run a prompt with an AI coding agent (non-interactive)")
  .option("-a, --agent <agent>", "Agent to use", config.defaultAgent)
  .option("-m, --model <model>", "Model to use (supports aliases)")
  .option("-p, --prompt <prompt>", "Prompt text")
  .option("-f, --file <path>", "Read prompt from file")
  .option("--timeout <seconds>", "Maximum run time in seconds", "1800")
  .option("--pass-env <names>", "Pass comma-separated sensitive environment names")
  .option("--enable-playwright-mcp", "Enable local Playwright MCP inside the sandbox")
  .option(
    "--hermetic",
    "Load none of the operator's customizations (instruction files, skills, plugins, hooks, MCP servers); harnesses with a verified mechanism only, see docs/HERMETIC.md"
  )
  .option("--tools <selection>", "Built-in tools the harness exposes: default, none")
  .option("-s, --sandbox", "Run in sandbox (default; requires scode)", true)
  .option("--no-sandbox", "Run without the scode boundary (autonomy below high is unavailable)")
  .option(
    "--sandbox-trust <level>",
    "scode trust override: trusted, standard, untrusted"
  )
  .option("--sandbox-no-net", "Pass --no-net to scode when sandboxed")
  .option("--sandbox-scrub-env", "Pass --scrub-env to scode when sandboxed")
  .option(
    "--auto <level>",
    "Autonomy level: read-only, low, medium, high",
    "read-only"
  )
  .option(
    "--effort <level>",
    "Reasoning effort: none, minimal, low, medium, high, xhigh, max, ultra"
  )
  .option("--cwd <path>", "Working directory")
  .action(async (options) => {
    try {
      requireValidConfig();
      const agentId = options.agent as AgentId;

      if (!AGENT_IDS.includes(agentId)) {
        console.error(`Error: Unknown agent '${agentId}'`);
        console.error(`Available agents: ${AGENT_IDS.join(", ")}`);
        process.exit(1);
      }

      const requestedAutonomy = parseAutonomyOption(options.auto) ?? "read-only";
      const requestedEffort = parseEffortOption(options.effort);
      const passthroughEnv = parsePassthroughEnvOption(options.passEnv);
      const enablePlaywrightMcp = Boolean(options.enablePlaywrightMcp);
      if (enablePlaywrightMcp && !options.sandbox) {
        throw new Error("--enable-playwright-mcp requires --sandbox");
      }
      if (enablePlaywrightMcp && agentId !== "claude" && agentId !== "zai") {
        throw new Error("--enable-playwright-mcp is supported only by claude and zai");
      }
      const hermetic = Boolean(options.hermetic);
      const tools = parseToolsOption(options.tools);
      if ((hermetic || tools === "none") && enablePlaywrightMcp) {
        throw new Error("--hermetic and --tools none cannot be combined with --enable-playwright-mcp");
      }
      const sandboxPolicyOverrides = parseSandboxPolicyOverrides({
        sandbox: Boolean(options.sandbox),
        sandboxTrust: options.sandboxTrust,
        sandboxNoNet: Boolean(options.sandboxNoNet),
        sandboxScrubEnv: Boolean(options.sandboxScrubEnv),
      });

      const adapter = getAdapter(agentId);

      let prompt = options.prompt;
      if (options.file) {
        if (options.prompt !== undefined) {
          console.error("Error: --prompt and --file cannot be used together");
          process.exit(1);
        }
        try {
          prompt = readUtf8FileBounded(options.file, {
            maxBytes: MAX_PROMPT_FILE_BYTES,
            label: "prompt file",
          });
        } catch (error) {
          const message = error instanceof Error ? `: ${error.message}` : "";
          console.error(`Error: Could not read file '${options.file}'${message}`);
          process.exit(1);
        }
      }

      if (typeof prompt !== "string" || prompt.trim().length === 0) {
        console.error("Error: No prompt provided. Use -p or -f");
        process.exit(1);
      }

      const timeoutMs = parseTimeoutOption(options.timeout);

      const caps = adapter.capabilities();
      const model = options.model
        ? resolveModel(options.model, agentId, config)
        : undefined;
      if (model && !caps.supportsModel) {
        console.error(`Error: ${agentId} does not support model selection`);
        process.exit(1);
      }

      const autonomy = resolveAutonomyForAdapter(agentId, caps, requestedAutonomy);
      if (
        autonomy &&
        adapter.requiresSandboxForAutonomy(autonomy) &&
        !options.sandbox
      ) {
        console.error(
          `Error: ${agentId} cannot enforce '${autonomy}' autonomy without --sandbox`
        );
        process.exit(1);
      }
      const effort = resolveEffortForAdapter(agentId, caps, requestedEffort);
      const sandboxAutonomy = requestedAutonomy;

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

      const request: RunRequest = {
        agent: agentId,
        prompt,
        model,
        autonomy,
        effort,
        cwd: options.cwd,
        sandboxed: Boolean(options.sandbox),
        timeoutMs,
        passthroughEnv,
        enablePlaywrightMcp,
        hermetic,
        tools,
      };
      // Refuse an unsupported hermetic or tools request before any launch work.
      adapter.validateRunRequest(request);

      console.error(`Running with ${agentId}${model ? ` (model: ${model})` : ""}${options.sandbox ? " (sandboxed)" : ""}...`);

      // Refuse or warn before launch: a flag can survive an upstream release
      // while the enforcement behind it does not.
      await assertHarnessSupported(
        agentId,
        adapter.binaryName,
        options.cwd,
        undefined,
        request.autonomy,
        Boolean(options.sandbox)
      );

      const result = await launchRunRequest(adapter, request, {
        sandbox: Boolean(options.sandbox),
        sandboxPolicyOverrides,
        requestedAutonomy: sandboxAutonomy,
        passthroughEnv,
        timeoutMs,
        cwd: options.cwd,
      });

      process.stdout.write(result.stdout);
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }

      process.exitCode = result.exitCode;
      return;
    } catch (error) {
      handleUnexpectedError(error);
    }
  });

program
  .command("tui")
  .description("Start interactive TUI for an AI coding agent")
  .option("-a, --agent <agent>", "Agent to use", config.defaultAgent)
  .option("-m, --model <model>", "Model to use (supports aliases)")
  .option("-s, --sandbox", "Run in sandbox (default; requires scode)", true)
  .option("--no-sandbox", "Run without the scode boundary (autonomy below high is unavailable)")
  .option(
    "--sandbox-trust <level>",
    "scode trust override: trusted, standard, untrusted"
  )
  .option("--sandbox-no-net", "Pass --no-net to scode when sandboxed")
  .option("--sandbox-scrub-env", "Pass --scrub-env to scode when sandboxed")
  .option("--auto <level>", "Autonomy level: read-only, low, medium, high")
  .option("--effort <level>", "Reasoning effort: none, minimal, low, medium, high, xhigh, max, ultra")
  .option("--pass-env <names>", "Pass comma-separated sensitive environment names")
  .option("--enable-playwright-mcp", "Enable local Playwright MCP inside the sandbox")
  .option("--cwd <path>", "Working directory")
  .action(async (options) => {
    try {
      requireValidConfig();
      const agentId = options.agent as AgentId;

      if (!AGENT_IDS.includes(agentId)) {
        console.error(`Error: Unknown agent '${agentId}'`);
        console.error(`Available agents: ${AGENT_IDS.join(", ")}`);
        process.exit(1);
      }

      const parsedAutonomy = parseAutonomyOption(options.auto);
      const requestedEffort = parseEffortOption(options.effort);
      const passthroughEnv = parsePassthroughEnvOption(options.passEnv);
      const enablePlaywrightMcp = Boolean(options.enablePlaywrightMcp);
      if (enablePlaywrightMcp && !options.sandbox) {
        throw new Error("--enable-playwright-mcp requires --sandbox");
      }
      if (enablePlaywrightMcp && agentId !== "claude" && agentId !== "zai") {
        throw new Error("--enable-playwright-mcp is supported only by claude and zai");
      }
      const sandboxPolicyOverrides = parseSandboxPolicyOverrides({
        sandbox: Boolean(options.sandbox),
        sandboxTrust: options.sandboxTrust,
        sandboxNoNet: Boolean(options.sandboxNoNet),
        sandboxScrubEnv: Boolean(options.sandboxScrubEnv),
      });

      const adapter = getAdapter(agentId);

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

      const caps = adapter.capabilities();
      const model = options.model
        ? resolveModel(options.model, agentId, config)
        : undefined;
      if (model && !adapter.supportsTuiModel()) {
        console.error(`Error: ${agentId} does not support model selection in TUI mode`);
        process.exit(1);
      }

      const requestedAutonomy = parsedAutonomy ?? "read-only";
      const sandboxAutonomy = requestedAutonomy;
      const autonomy = resolveAutonomyForAdapter(agentId, caps, requestedAutonomy);
      if (
        autonomy &&
        adapter.requiresSandboxForTuiAutonomy(autonomy) &&
        !options.sandbox
      ) {
        console.error(
          `Error: ${agentId} cannot enforce '${autonomy}' autonomy without --sandbox`
        );
        process.exit(1);
      }
      const effort = adapter.supportsTuiEffort()
        ? resolveEffortForAdapter(agentId, caps, requestedEffort)
        : undefined;
      if (requestedEffort && !adapter.supportsTuiEffort()) {
        console.warn(`Warning: ${agentId} does not support --effort in TUI mode, ignoring`);
      }
      const sandboxOptions = options.sandbox
        ? resolveSandboxOptionsForAgent(agentId, sandboxAutonomy, sandboxPolicyOverrides)
        : undefined;

      await assertHarnessSupported(
        agentId,
        adapter.binaryName,
        options.cwd,
        undefined,
        autonomy,
        Boolean(options.sandbox)
      );

      if (options.sandbox) {
        const workdir = validateWorkingDirectory(options.cwd) ?? process.cwd();
        adapter.validateTuiRequest(
          model,
          workdir,
          autonomy,
          effort,
          passthroughEnv,
          enablePlaywrightMcp
        );
        adapter.beforeLaunch();
        adapter.prepareSandbox({ sandboxTrust: sandboxOptions?.trust, passthroughEnv });
        const adapterEnv = adapter.buildExecutionEnv(
          adapter.getTuiEnv(model, autonomy, effort, true),
          passthroughEnv
        );
        const command = adapter.buildTuiCommand(
          model,
          autonomy,
          effort,
          true,
          enablePlaywrightMcp,
          workdir
        );
        const exitCode = await runSandboxed(
          command,
          workdir,
          adapterEnv,
          true,
          sandboxAutonomy,
          sandboxOptions,
          adapter.getEnvOmissions()
        );
        process.exitCode = exitCode;
      } else {
        const exitCode = await adapter.runInteractive(
          model,
          options.cwd,
          autonomy,
          effort,
          false,
          passthroughEnv,
          enablePlaywrightMcp
        );
        process.exitCode = exitCode;
      }
    } catch (error) {
      handleUnexpectedError(error);
    }
  });

registerCheckCommand(program, config, requireValidConfig);
registerInfoCommands(program, config, configError);

await program.parseAsync();

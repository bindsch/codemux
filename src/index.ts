import { program } from "commander";
import { readFileSync } from "fs";
import { resolveSandboxOptionsForAgent } from "./sandbox-policy.js";
import { getAdapter, AGENT_IDS } from "./adapters/index.js";
import { getDefaultConfig, loadConfig, resolveModel } from "./config.js";
import { registerInfoCommands } from "./info-commands.js";
import {
  handleUnexpectedError,
  isScodeAvailable,
  parseAutonomyOption,
  parseEffortOption,
  parsePassthroughEnvOption,
  parseSandboxPolicyOverrides,
  parseTimeoutOption,
  resolveAutonomyForAdapter,
  resolveEffortForAdapter,
  runSandboxed,
  runSandboxedWithStdin,
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
  .option("-s, --sandbox", "Run in sandbox (requires scode)")
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
      const sandboxOptions = options.sandbox
        ? resolveSandboxOptionsForAgent(agentId, sandboxAutonomy, sandboxPolicyOverrides)
        : undefined;

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
      };

      console.error(`Running with ${agentId}${model ? ` (model: ${model})` : ""}${options.sandbox ? " (sandboxed)" : ""}...`);

      let result;
      if (options.sandbox) {
        adapter.validateRunRequest(request);
        adapter.beforeLaunch();
        const envArg = adapter.buildExecutionEnv(
          adapter.getRunEnv(request),
          passthroughEnv
        );
        const command = adapter.buildRunCommand(request);
        const stdinData = adapter.getStdinInput(request);
        result = await runSandboxedWithStdin(
          command,
          stdinData,
          options.cwd,
          envArg,
          sandboxAutonomy,
          sandboxOptions,
          timeoutMs,
          adapter.getEnvOmissions()
        );
      } else {
        result = await adapter.run(request);
      }

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
  .command("check")
  .description("Check agent/model configuration with a quick probe")
  .option("-a, --agent <agent>", "Agent to use", config.defaultAgent)
  .option("-m, --model <model>", "Model to use (supports aliases)")
  .option("--auto <level>", "Autonomy level: read-only, low, medium, high", "read-only")
  .option("--effort <level>", "Reasoning effort: none, minimal, low, medium, high, xhigh, max, ultra")
  .option("-s, --sandbox", "Run probe in sandbox (requires scode)")
  .option(
    "--sandbox-trust <level>",
    "scode trust override: trusted, standard, untrusted"
  )
  .option("--sandbox-no-net", "Pass --no-net to scode when sandboxed")
  .option("--sandbox-scrub-env", "Pass --scrub-env to scode when sandboxed")
  .option("--pass-env <names>", "Pass comma-separated sensitive environment names")
  .option("--timeout <seconds>", "Maximum probe time in seconds", "60")
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
      const timeoutMs = parseTimeoutOption(options.timeout);
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

      const model = options.model
        ? resolveModel(options.model, agentId, config)
        : undefined;

      const caps = adapter.capabilities();
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

      const request: RunRequest = {
        agent: agentId,
        prompt: "Reply with: OK",
        model,
        autonomy,
        effort,
        cwd: options.cwd,
        sandboxed: Boolean(options.sandbox),
        passthroughEnv,
        timeoutMs,
      };

      if (options.sandbox && !isScodeAvailable()) {
        console.error("Error: scode is not installed (required for --sandbox)");
        process.exit(1);
      }

      console.error(`Checking ${agentId}${model ? ` (model: ${model})` : ""}${options.sandbox ? " (sandboxed)" : ""}...`);

      let result;
      if (options.sandbox) {
        adapter.validateRunRequest(request);
        adapter.beforeLaunch();
        const envArg = adapter.buildExecutionEnv(
          adapter.getRunEnv(request),
          passthroughEnv
        );
        result = await runSandboxedWithStdin(
          adapter.buildRunCommand(request),
          adapter.getStdinInput(request),
          options.cwd,
          envArg,
          requestedAutonomy,
          resolveSandboxOptionsForAgent(
            agentId,
            requestedAutonomy,
            sandboxPolicyOverrides
          ),
          timeoutMs,
          adapter.getEnvOmissions()
        );
      } else {
        result = await adapter.run(request);
      }

      if (result.exitCode !== 0) {
        if (result.stdout) {
          process.stderr.write(result.stdout);
        }
        if (result.stderr) {
          process.stderr.write(result.stderr);
        }
        process.exitCode = result.exitCode;
        return;
      }

      if (!/(?:^|\r?\n)\s*OK[.!]?\s*(?:\r?\n|$)/.test(result.stdout)) {
        console.error("Error: agent probe returned an unexpected response");
        if (result.stdout) {
          process.stderr.write(result.stdout);
        }
        process.exitCode = 1;
        return;
      }

      process.stdout.write("OK\n");
      process.exitCode = 0;
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
  .option("-s, --sandbox", "Run in sandbox (requires scode)")
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

registerInfoCommands(program, config, configError);

await program.parseAsync();

import { program } from "commander";
import { readFileSync } from "fs";
import { resolveSandboxOptionsForAgent } from "./sandbox-policy.js";
import { getAdapter, AGENT_IDS } from "./adapters/index.js";
import { registerCheckCommand } from "./check-command.js";
import { registerCallsCommand } from "./calls-command.js";
import { getDefaultConfig, loadConfig, resolveModel } from "./config.js";
import { registerInfoCommands } from "./info-commands.js";
import { launchRunRequest } from "./launch.js";
import { registerSessionCommand } from "./session/cli.js";
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

// The stand-in prompt for the run command's preflight validation: the
// shortest text that satisfies every prompt rule (non-empty, no NUL byte,
// under every byte cap), so the validation that runs before `-f -` consumes
// stdin exercises every other check exactly as it will run. The content
// rules are re-applied to the real prompt after it is read.
const PREFLIGHT_PROMPT = "x";

/**
 * Reads a `-f -` prompt from stdin, bounded by the same limit as a prompt
 * file, decoded with the same fatal UTF-8 decoder: the two prompt paths
 * are advertised as equivalents, so malformed bytes are an error either
 * way, never replacement characters that silently change the prompt. The
 * read is also bounded by the run's `--timeout`: a blocking read has no
 * deadline of its own, so a pipe whose producer stalls -- open, never
 * written, never closed -- would block past every timeout the run itself
 * honors; the read now fails the run at the timeout instead. Stdin is not
 * argv, so the argv-prompt rules (NUL byte, 32 KiB cap for harnesses that
 * pass the prompt as an argument) apply later, unchanged, at adapter
 * validation. A terminal stdin is refused rather than read: this is a
 * non-interactive command, and a read with no writer would hang until the
 * run's timeout.
 */
async function readStdinPrompt(
  maxBytes: number,
  timeoutMs: number
): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error("-f - reads the prompt from stdin, but stdin is a terminal; pipe the prompt instead");
  }
  const stdin = process.stdin;
  const chunks: Buffer[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("error", onError);
      // Dropped either way: on failure an unread pipe must not hold the
      // process open, and on success EOF has already closed it.
      stdin.destroy();
      if (error !== null) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      finish(
        new Error(
          "-f - read no complete prompt from stdin before --timeout elapsed; " +
            "a stalled prompt producer fails the run instead of hanging it"
        )
      );
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > maxBytes) {
        finish(
          new Error(
            `-f - prompt exceeds the ${maxBytes}-byte limit (stdin is not argv, but the bound still applies)`
          )
        );
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => finish(null);
    const onError = (error: Error): void => finish(error);
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
  });
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks)
    );
  } catch {
    throw new Error("-f - prompt must contain valid UTF-8");
  }
}

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
  .option("-f, --file <path>", "Read prompt from file, or from stdin with -")
  .option(
    "--timeout <seconds>",
    "Maximum run time in seconds; also bounds the -f - stdin prompt read",
    "1800"
  )
  .option("--pass-env <names>", "Pass comma-separated sensitive environment names")
  .option("--enable-playwright-mcp", "Enable local Playwright MCP inside the sandbox")
  .option(
    "--hermetic",
    "Load none of the operator's customizations (instruction files, skills, plugins, hooks, MCP servers); harnesses with a verified mechanism only, see docs/HERMETIC.md"
  )
  .option("--tools <selection>", "Built-in tools the harness exposes: default, none")
  .option(
    "--result-json",
    "Return the harness's structured result envelope on stdout, carrying token usage"
  )
  .option("-s, --sandbox", "Run in sandbox (default; requires scode)", true)
  .option("--no-sandbox", "Run without the scode boundary (autonomy below high is unavailable)")
  .option(
    "--sandbox-trust <level>",
    "scode trust override: trusted, standard, untrusted"
  )
  .option("--sandbox-no-net", "Pass --no-net to scode when sandboxed")
  .option("--sandbox-scrub-env", "Pass --scrub-env to scode when sandboxed")
  .option(
    "--sandbox-account <file>",
    "Request scode scratch accounting, appending one JSON line per run to FILE"
  )
  .option(
    "--sandbox-account-id <id>",
    "Opaque correlation token recorded in the scode accounting line"
  )
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
        sandboxAccount: options.sandboxAccount,
        sandboxAccountId: options.sandboxAccountId,
      });

      const adapter = getAdapter(agentId);

      // Parsed before the prompt is read: a `-f -` read is bounded by the
      // same timeout the run itself honors, and an invalid value should
      // fail before anything consumes stdin.
      const timeoutMs = parseTimeoutOption(options.timeout);

      // The prompt resolves before the availability checks, with one
      // exception (round10). An ambiguous -p/-f pair, a missing prompt,
      // and an unreadable or empty prompt file are the caller's malformed
      // command, and an "agent is not installed" or "scode is not
      // installed" line would misdirect them. Stdin is the one prompt
      // source that can BLOCK -- a producer that never closes the pipe --
      // so `-f -` is the exception: its read waits until adapter
      // validation has run, and an unsupported combination like `-a droid
      // --hermetic -f -` is rejected at once instead of waiting out
      // the timeout on a read that never completes.
      let earlyPrompt: string;
      let readPromptFromStdin = false;
      if (options.file) {
        if (options.prompt !== undefined) {
          console.error("Error: --prompt and --file cannot be used together");
          process.exit(1);
        }
        if (options.file === "-") {
          // The stand-in (PREFLIGHT_PROMPT) until the read below: stdin is
          // the one prompt source that can block, so its read waits for
          // adapter validation.
          readPromptFromStdin = true;
          earlyPrompt = PREFLIGHT_PROMPT;
        } else {
          try {
            earlyPrompt = readUtf8FileBounded(options.file, {
              maxBytes: MAX_PROMPT_FILE_BYTES,
              label: "prompt file",
            });
          } catch (error) {
            const message = error instanceof Error ? `: ${error.message}` : "";
            console.error(`Error: Could not read file '${options.file}'${message}`);
            process.exit(1);
          }
          if (earlyPrompt.trim().length === 0) {
            console.error("Error: No prompt provided. Use -p or -f");
            process.exit(1);
          }
        }
      } else if (
        typeof options.prompt !== "string" ||
        options.prompt.trim().length === 0
      ) {
        console.error("Error: No prompt provided. Use -p or -f");
        process.exit(1);
      } else {
        earlyPrompt = options.prompt;
      }

      // Everything the request carries except a stdin prompt is known
      // here, so the request checks above run BEFORE stdin is consumed
      // (round10). One later gate is deliberately outside that rule:
      // assertHarnessSupported probes the harness binary after the read
      // (a subprocess, not a request check), and the read is
      // timeout-bounded while it waits.
      const caps = adapter.capabilities();
      const model = options.model
        ? resolveModel(options.model, agentId, config)
        : undefined;
      if (model && !caps.supportsModel) {
        console.error(`Error: ${agentId} does not support model selection`);
        process.exit(1);
      }

      const autonomy = resolveAutonomyForAdapter(agentId, caps, requestedAutonomy);
      if (adapter.requiresSandboxForAutonomy(autonomy) && !options.sandbox) {
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
        // The resolved prompt -- the stand-in only while stdin is the
        // source (see PREFLIGHT_PROMPT), with every other source already
        // validated above.
        prompt: earlyPrompt,
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
        resultJson: Boolean(options.resultJson),
      };
      // Preflight: refuse an unsupported hermetic, tools, or result-json
      // request before anything consumes stdin. When the
      // prompt is the stand-in, the content rules are re-applied to the
      // real text after the read -- the same single validator, twice, with
      // the second pass carrying the text the run will actually submit.
      adapter.validateRunRequest(request);

      let prompt = earlyPrompt;
      if (readPromptFromStdin) {
        prompt = await readStdinPrompt(MAX_PROMPT_FILE_BYTES, timeoutMs);
        if (prompt.trim().length === 0) {
          console.error("Error: -f - read an empty prompt from stdin");
          process.exit(1);
        }
      }

      // The real prompt replaces the stand-in ON THIS OBJECT: the object
      // validated here stays the object that launches, so the launch path
      // builds the child environment from the same passthroughEnv list it
      // validated (one source, request.passthroughEnv).
      request.prompt = prompt;
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
        Boolean(options.sandbox),
        // The names the launch will keep. One of them may choose which executable runs --
        // OpenCode's launcher reads OPENCODE_BIN_PATH -- and a gate that measures a different
        // binary than the one about to run is worse than no gate.
        passthroughEnv
      );

      const result = await launchRunRequest(adapter, request, {
        sandbox: Boolean(options.sandbox),
        sandboxPolicyOverrides,
        requestedAutonomy: sandboxAutonomy,
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
  .option(
    "--sandbox-account <file>",
    "Request scode scratch accounting, appending one JSON line per run to FILE"
  )
  .option(
    "--sandbox-account-id <id>",
    "Opaque correlation token recorded in the scode accounting line"
  )
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
        sandboxAccount: options.sandboxAccount,
        sandboxAccountId: options.sandboxAccountId,
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
      if (adapter.requiresSandboxForTuiAutonomy(autonomy) && !options.sandbox) {
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

      // Validation before the version gate, as on the run path: an adapter
      // that refuses this request (cursor's desktop entry without the
      // --pass-env opt-in among them) must do so before the gate can execute
      // the harness binary it resolves.
      const workdir = validateWorkingDirectory(options.cwd) ?? process.cwd();
      adapter.validateTuiRequest(
        model,
        workdir,
        autonomy,
        effort,
        passthroughEnv,
        enablePlaywrightMcp
      );

      await assertHarnessSupported(
        agentId,
        adapter.binaryName,
        options.cwd,
        undefined,
        autonomy,
        Boolean(options.sandbox),
        passthroughEnv
      );

      if (options.sandbox) {
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
registerCallsCommand(program);
registerSessionCommand(program, config, requireValidConfig);

await program.parseAsync();

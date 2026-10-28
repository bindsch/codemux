import {
  handleUnexpectedError,
  isScodeAvailable,
  parseAutonomyOption,
  parseEffortOption,
  parsePassthroughEnvOption,
  parseSandboxPolicyOverrides,
  resolveAutonomyForAdapter,
  resolveEffortForAdapter,
  assertHarnessSupported,
} from "./cli-runtime.js";
import { getAdapter, AGENT_IDS } from "./adapters/index.js";
import { resolveModel } from "./config.js";
import type { Command } from "commander";
import type { AgentId, CodemuxConfig } from "./types.js";
import { resolveSandboxOptionsForAgent } from "./sandbox-policy.js";
import { withKeepEnvExemption } from "./sandbox.js";
import { runSandboxed } from "./cli-runtime.js";
import { validateWorkingDirectory } from "./validation.js";

export function registerTuiCommand(
  program: Command,
  config: CodemuxConfig,
  requireValidConfig: () => void
): void {
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

        // `sandboxOptions` resolves exactly when `options.sandbox` is set;
        // the compound guard lets the type system see that too.
        if (options.sandbox && sandboxOptions !== undefined) {
          adapter.beforeLaunch();
          adapter.prepareSandbox({ sandboxTrust: sandboxOptions?.trust, passthroughEnv });
          // The environment codemux itself chose for this child: the
          // adapter's standing variables plus the tui-specific ones — the
          // two maps buildExecutionEnv merges — captured here for their
          // names, exactly as the run launcher does (launch.ts). Under
          // --sandbox-scrub-env those names ride scode's --keep-env
          // exemption; a provider override makes that exemption mandatory —
          // its key is the launch's only credential, the operator's own
          // having been omitted on purpose — so a scode without the flag
          // refuses the launch rather than run it stripped. The same rule
          // the run and session spawns apply (withKeepEnvExemption).
          const injectedEnv = {
            ...adapter.getEnv(),
            ...adapter.getTuiEnv(model, autonomy, effort, true),
          };
          const adapterEnv = adapter.buildExecutionEnv(injectedEnv, passthroughEnv);
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
            withKeepEnvExemption(
              sandboxOptions,
              injectedEnv,
              adapter.providerOverrideActive()
            ),
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
}

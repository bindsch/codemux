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
import type { ExecutableCheck } from "./executable-security.js";
import { runSandboxed } from "./cli-runtime.js";
import { assertQuotaHeadroomForLaunch, resolveQuotaGate } from "./quota-gate.js";
import { UsageRefusalError, validateWorkingDirectory } from "./validation.js";

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
    .option(
      "--sandbox-block <path>",
      "Pass an extra scode --block for this run (repeatable); absolute paths only",
      (value: string, previous: string[]) => [...previous, value],
      []
    )
    .option(
      "--print-sandbox",
      "Print the scode argv this TUI would exec, one argument per line (controls escaped, a newline prints as \\n), and exit 0 without running anything; requires --sandbox"
    )
    .option("--auto <level>", "Autonomy level: read-only, low, medium, high")
    .option("--effort <level>", "Reasoning effort: none, minimal, low, medium, high, xhigh, max, ultra")
    .option("--pass-env <names>", "Pass comma-separated sensitive environment names")
    .option("--enable-playwright-mcp", "Enable local Playwright MCP inside the sandbox")
    .option("--cwd <path>", "Working directory")
    .option(
      "--quota-ceiling <percent>",
      "Refuse the launch when a bounding usage window is below this percent remaining; overrides the config quota ceiling for this invocation"
    )
    .option("--no-quota-gate", "Skip the pre-launch usagemux quota check for this invocation")
    .action(async (options) => {
      try {
        requireValidConfig();
        const agentId = options.agent as AgentId;

        if (!AGENT_IDS.includes(agentId)) {
          // One message, two lines: handleUnexpectedError prints it with the
          // "Error:" prefix, so the output matches the old console.error pair.
          throw new UsageRefusalError(
            `Unknown agent '${agentId}'\nAvailable agents: ${AGENT_IDS.join(", ")}`
          );
        }

        const parsedAutonomy = parseAutonomyOption(options.auto);
        const requestedEffort = parseEffortOption(options.effort);
        const passthroughEnv = parsePassthroughEnvOption(options.passEnv);
        const enablePlaywrightMcp = Boolean(options.enablePlaywrightMcp);
        if (enablePlaywrightMcp && !options.sandbox) {
          throw new UsageRefusalError("--enable-playwright-mcp requires --sandbox");
        }
        if (enablePlaywrightMcp && agentId !== "claude" && agentId !== "zai") {
          throw new UsageRefusalError("--enable-playwright-mcp is supported only by claude and zai");
        }
        const sandboxPolicyOverrides = parseSandboxPolicyOverrides({
          sandbox: Boolean(options.sandbox),
          sandboxTrust: options.sandboxTrust,
          sandboxNoNet: Boolean(options.sandboxNoNet),
          sandboxScrubEnv: Boolean(options.sandboxScrubEnv),
          sandboxAccount: options.sandboxAccount,
          sandboxAccountId: options.sandboxAccountId,
          sandboxBlock: options.sandboxBlock,
        });
        // The same refusal run carries: a print of the scode argv is a
        // property of the sandboxed spawn, and the print below must not
        // fall through to an unsandboxed interactive launch.
        if (options.printSandbox && !options.sandbox) {
          throw new UsageRefusalError("--print-sandbox requires --sandbox: it prints the scode argv of a sandboxed session");
        }

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
          throw new UsageRefusalError(`${agentId} does not support model selection in TUI mode`);
        }

        const requestedAutonomy = parsedAutonomy ?? "read-only";
        const sandboxAutonomy = requestedAutonomy;
        const autonomy = resolveAutonomyForAdapter(agentId, caps, requestedAutonomy);
        if (adapter.requiresSandboxForTuiAutonomy(autonomy) && !options.sandbox) {
          throw new UsageRefusalError(
            `${agentId} cannot enforce '${autonomy}' autonomy without --sandbox`
          );
        }
        // The same resolution as run: a value outside the adapter's effort
        // set is a usage refusal (exit 64), never a dropped flag. Droid and
        // opencode accept effort on run but have no TUI carrier for it, so
        // a materialized level on their TUI refuses by name. `none` is the
        // no-flag spelling everywhere: on a no-TUI-effort adapter it maps
        // to undefined here, or the adapter's own validateTuiRequest would
        // refuse what launches with no flag at all.
        const resolvedEffort = resolveEffortForAdapter(agentId, caps, requestedEffort);
        if (
          requestedEffort !== undefined &&
          requestedEffort !== "none" &&
          !adapter.supportsTuiEffort()
        ) {
          throw new UsageRefusalError(
            `${agentId} does not carry --effort in TUI mode; omit it or use run`
          );
        }
        const effort =
          resolvedEffort === "none" && !adapter.supportsTuiEffort()
            ? undefined
            : resolvedEffort;
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

        // The quota gate: an interactive session spends from the same
        // windows a run does, so it passes the same check — after every
        // request check, before anything spawns. A provider override in
        // force skips the native gate (assertQuotaHeadroomForLaunch).
        const quotaPolicy = resolveQuotaGate({
          config: config.quota,
          ceiling: options.quotaCeiling,
          disabled: options.quotaGate === false,
        });
        // A print-only launch spends nothing (review round 56).
        if (quotaPolicy !== null && !options.printSandbox) await assertQuotaHeadroomForLaunch(adapter, quotaPolicy);

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
          // A print-only launch skips the sandbox preparation the run path
          // skips under --print-sandbox (launch.ts): it exists for its side
          // effects alone — the claude family's refreshes or scrubs the
          // operator's credential mirror — and a diagnostic command that
          // promises to run nothing must not touch that state.
          if (!options.printSandbox) {
            adapter.prepareSandbox({ sandboxTrust: sandboxOptions?.trust, passthroughEnv });
          }
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
            ...adapter.getTuiEnv(model, autonomy, effort, true, passthroughEnv),
          };
          const adapterEnv = adapter.buildExecutionEnv(injectedEnv, passthroughEnv);
          // The Playwright binary the command embeds is trust-checked
          // inside buildTuiCommand, but its path sits in the --mcp-config
          // JSON argument the command re-check never parses (review round
          // 110). The build hands back the check it captured in that same
          // resolution (review round 111: never a second resolution, which
          // would trust whatever replaced the binary in between), and the
          // spawn's re-stat compares against it.
          const nestedChecks: ExecutableCheck[] = [];
          const command = adapter.buildTuiCommand(
            model,
            autonomy,
            effort,
            true,
            enablePlaywrightMcp,
            workdir,
            nestedChecks
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
            adapter.getEnvOmissions(),
            Boolean(options.printSandbox),
            nestedChecks[0] ?? null
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

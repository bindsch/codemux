import type { Command } from "commander";
import { getAdapter } from "./adapters/index.js";
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
} from "./cli-runtime.js";
import { resolveModel } from "./config.js";
import {
  HERMETIC_CANARY_PROMPT,
  evaluateCanary,
  plantCanary,
} from "./hermetic-canary.js";
import { launchRunRequest, type LaunchOptions } from "./launch.js";
import { AGENT_IDS, type AgentId, type CodemuxConfig, type RunRequest, type RunResult } from "./types.js";

const OK_LINE = /(?:^|\r?\n)\s*OK[.!]?\s*(?:\r?\n|$)/;

function reportFailure(result: RunResult): void {
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

/**
 * `codemux check`: one live probe. Plain: the model must answer OK. With
 * --hermetic: a hermetic probe in a scratch directory carrying planted
 * instruction files must answer OK without repeating their code word, and a
 * control probe without --hermetic shows whether the planted files or the
 * operator's own context would have reached the model. Two real requests.
 */
export function registerCheckCommand(
  program: Command,
  config: CodemuxConfig,
  requireValidConfig: () => void
): void {
  program
    .command("check")
    .description("Check agent/model configuration with a quick probe")
    .option("-a, --agent <agent>", "Agent to use", config.defaultAgent)
    .option("-m, --model <model>", "Model to use (supports aliases)")
    .option("--auto <level>", "Autonomy level: read-only, low, medium, high", "read-only")
    .option("--effort <level>", "Reasoning effort: none, minimal, low, medium, high, xhigh, max, ultra")
    .option(
      "--hermetic",
      "Prove the harness ignores its customizations: plant instruction files in a scratch directory and probe twice"
    )
    .option("--tools <selection>", "Built-in tools for the probe: default, none")
    .option("-s, --sandbox", "Run probe in sandbox (default; requires scode)", true)
    .option("--no-sandbox", "Probe without the scode boundary (autonomy below high is unavailable)")
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
        const tools = parseToolsOption(options.tools);
        const hermetic = Boolean(options.hermetic);
        if (hermetic && options.cwd !== undefined) {
          throw new Error("--hermetic plants its own working directory; drop --cwd");
        }
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

        if (options.sandbox && !isScodeAvailable()) {
          console.error("Error: scode is not installed (required for --sandbox)");
          process.exit(1);
        }

        const baseRequest: RunRequest = {
          agent: agentId,
          prompt: "Reply with: OK",
          model,
          autonomy,
          effort,
          cwd: options.cwd,
          sandboxed: Boolean(options.sandbox),
          passthroughEnv,
          timeoutMs,
          tools,
        };
        const launch: LaunchOptions = {
          sandbox: Boolean(options.sandbox),
          sandboxPolicyOverrides,
          requestedAutonomy,
          passthroughEnv,
          timeoutMs,
          cwd: options.cwd,
        };
        const label = `${agentId}${model ? ` (model: ${model})` : ""}${options.sandbox ? " (sandboxed)" : ""}`;

        if (!hermetic) {
          console.error(`Checking ${label}...`);
          const result = await launchRunRequest(adapter, baseRequest, launch);
          if (result.exitCode !== 0) {
            reportFailure(result);
            process.exitCode = result.exitCode;
            return;
          }
          if (!OK_LINE.test(result.stdout)) {
            console.error("Error: agent probe returned an unexpected response");
            if (result.stdout) process.stderr.write(result.stdout);
            process.exitCode = 1;
            return;
          }
          process.stdout.write("OK\n");
          process.exitCode = 0;
          return;
        }

        const canary = plantCanary();
        try {
          const canaryLaunch = { ...launch, cwd: canary.cwd };
          const probe: RunRequest = {
            ...baseRequest,
            prompt: HERMETIC_CANARY_PROMPT,
            cwd: canary.cwd,
            instructionDirs: [canary.cwd],
          };
          // Fail before spending a request when the adapter cannot claim it;
          // validated against the planted directory, the only one probed.
          adapter.validateRunRequest({ ...probe, hermetic: true });

          console.error(`Checking ${label} hermetically (planted code word ${canary.marker})...`);
          const hermeticResult = await launchRunRequest(
            adapter,
            { ...probe, hermetic: true },
            canaryLaunch
          );
          if (hermeticResult.exitCode !== 0) {
            reportFailure(hermeticResult);
            process.exitCode = hermeticResult.exitCode;
            return;
          }
          const verdict = evaluateCanary(hermeticResult.stdout, canary.marker);

          console.error(`Control probe without --hermetic...`);
          const controlResult = await launchRunRequest(adapter, probe, canaryLaunch);
          const control = controlResult.exitCode === 0
            ? evaluateCanary(controlResult.stdout, canary.marker)
            : null;
          // Only the planted code word proves the control saw the planted
          // files; a name, a refusal or empty output proves nothing.
          const controlLeaked = control !== null && control.kind === "leak" && control.what === "marker";
          const controlLine = control === null
            ? `control: the request failed (exit ${controlResult.exitCode})`
            : controlLeaked
              ? "control: planted code word reached the model, as expected"
              : control.kind === "clean"
                ? "control: clean too, so the planted files never reached the model"
                : `control: answered '${control.answer}' without the planted code word`;

          if (verdict.kind === "leak") {
            console.error(
              verdict.what === "marker"
                ? `Error: hermetic ${agentId} run is NOT hermetic: the planted code word reached the model`
                : `Error: hermetic ${agentId} probe did not pass: the model answered '${verdict.answer}' ` +
                  "instead of OK (an owner's name is a leak; a refusal or anything else is inconclusive)"
            );
            console.error(controlLine);
            if (controlResult.exitCode !== 0) reportFailure(controlResult);
            process.exitCode = 1;
            return;
          }
          if (!controlLeaked) {
            console.error(
              `Error: hermetic ${agentId} probe answered OK, but the check proved nothing: ` +
                controlLine.replace(/^control: /, "")
            );
            if (controlResult.exitCode !== 0) reportFailure(controlResult);
            process.exitCode = 1;
            return;
          }
          process.stdout.write(`HERMETIC ${agentId}: OK\n`);
          console.error(controlLine);
          process.exitCode = 0;
        } finally {
          canary.cleanup();
        }
      } catch (error) {
        handleUnexpectedError(error);
      }
    });
}

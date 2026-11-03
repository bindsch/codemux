import type { Command } from "commander";
import { existsSync } from "node:fs";
import { runAgyCanaryChecks, runAgyIsolationProbe } from "./agy-isolation-probe.js";
import { plantKimiCanary } from "./kimi-isolation-probe.js";
import { assertExperimentMcpUnavailable, experimentCanaryControl, validateExperimentRequest } from "./experiment-mcp.js";
import { getAdapter } from "./adapters/index.js";
import {
  assertHarnessSupported,
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
import { collectLabel, parseLabels } from "./labels.js";
import {
  HERMETIC_CANARY_PROMPT,
  evaluateCanary,
  plantCanary,
} from "./hermetic-canary.js";
import { launchRunRequest, type LaunchOptions } from "./launch.js";
import { assertQuotaHeadroomForLaunch, resolveQuotaGate } from "./quota-gate.js";
import { UsageRefusalError } from "./validation.js";
import { AGENT_IDS, type AgentId, type CodemuxConfig, type RunRequest, type RunResult } from "./types.js";

export const OK_LINE = /(?:^|\r?\n)\s*OK[.!]?\s*(?:\r?\n|$)/;

function reportFailure(result: RunResult): void {
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

/**
 * `codemux check`: one live probe. Plain: the model must answer OK. With
 * --hermetic: a hermetic probe in a scratch directory carrying planted
 * instruction files must answer OK without repeating their code word, and a
 * control probe without --hermetic — carrying everything else the hermetic
 * probe carries, the tools selection included — shows whether the planted
 * files or the operator's own context would have reached the model. Two real
 * requests.
 */
export function registerCheckCommand(
  program: Command,
  config: CodemuxConfig,
  requireValidConfig: () => void
): void {
  program
    .command("check")
    .description("Check configuration with real model requests (credentials and quota required; canaries use multiple probes)")
    .option("-a, --agent <agent>", "Agent to use", config.defaultAgent)
    .option("-m, --model <model>", "Model to use (supports aliases)")
    .option("--auto <level>", "Autonomy level: read-only, low, medium, high", "read-only")
    .option("--effort <level>", "Reasoning effort: none, minimal, low, medium, high, xhigh, max, ultra")
    .option(
      "--hermetic",
      "Test specified customization channels against a positive control in a managed directory; incompatible with --cwd"
    )
    .option("--tools <selection>", "Built-in tools for the probe: default, none")
    .option("--experiment-mcp <spec.json>", "Extend the Claude, Z.AI, or Kimi hermetic canary with an experiment MCP server")
    .option("--agy-isolation-probe <mode>", "Unverified agy diagnostic: login, hermetic, control, tools, tools-control")
    .option("-s, --sandbox", "Run probe in sandbox (default; requires scode)", true)
    .option("--no-sandbox", "Probe without the scode boundary (autonomy below high is unavailable)")
    .option(
      "--sandbox-trust <level>",
      "scode trust override: trusted, standard, untrusted"
    )
    .option("--sandbox-no-net", "Pass --no-net to scode when sandboxed")
    .option("--sandbox-scrub-env", "Pass --scrub-env to scode when sandboxed")
    .option(
      "--sandbox-block <path>",
      "Pass an extra scode --block for this probe (repeatable); absolute paths only",
      (value: string, previous: string[]) => [...previous, value],
      []
    )
    .option(
      "--print-sandbox",
      "Print the scode argv this probe would exec, one argument per line (controls escaped, a newline prints as \\n), and exit 0 without running anything; requires --sandbox and a plain probe without Agy isolation or tools canaries"
    )
    .option("--pass-env <names>", "Pass comma-separated sensitive environment names")
    .option("--timeout <seconds>", "Timeout per probe in seconds; paired and multiple probes each receive this budget", "60")
    .option("--cwd <path>", "Working directory (incompatible with --hermetic and Agy isolation canaries)")
    .option(
      "--quota-ceiling <percent>",
      "Refuse the probe when a bounding usage window is below this percent remaining; overrides the config quota ceiling for this invocation"
    )
    .option("--no-quota-gate", "Skip the pre-launch usagemux quota check for this invocation")
    .option(
      "--label <KEY=VALUE>",
      "Record a workflow label on the probe's ledger record (repeatable)",
      collectLabel,
      []
    )
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

        const requestedAutonomy = parseAutonomyOption(options.auto) ?? "read-only";
        const requestedEffort = parseEffortOption(options.effort);
        const passthroughEnv = parsePassthroughEnvOption(options.passEnv);
        const tools = parseToolsOption(options.tools);
        assertExperimentMcpUnavailable(agentId, options.experimentMcp);
        const hermetic = Boolean(options.hermetic);
        const sandboxPolicyOverrides = parseSandboxPolicyOverrides({
          sandbox: Boolean(options.sandbox),
          sandboxTrust: options.sandboxTrust,
          sandboxNoNet: Boolean(options.sandboxNoNet),
          sandboxScrubEnv: Boolean(options.sandboxScrubEnv),
          sandboxBlock: options.sandboxBlock,
        });
        // The run command's own refusals, so one operator request cannot
        // yield three outcomes across the launch commands: the argv print
        // belongs to the sandboxed spawn, and the hermetic probes below
        // run several different children with no single argv to print.
        if (options.printSandbox && !options.sandbox) {
          throw new UsageRefusalError("--print-sandbox requires --sandbox: it prints the scode argv of a sandboxed probe");
        }
        if (options.printSandbox && options.agyIsolationProbe !== undefined) {
          throw new UsageRefusalError("--print-sandbox cannot be combined with --agy-isolation-probe: isolation probes do not provide print-only argv");
        }
        if (options.printSandbox && hermetic) {
          throw new UsageRefusalError("--print-sandbox supports the plain probe only: hermetic checks run several probes with no single scode argv");
        }
        if (options.printSandbox && agentId === "agy" && tools === "none") {
          throw new UsageRefusalError("--print-sandbox cannot be combined with --tools none for agy: canary checks run several probes with no single scode argv");
        }
        validateExperimentRequest({ agent: agentId, prompt: "probe", experimentMcp: options.experimentMcp,
          hermetic, tools, autonomy: requestedAutonomy, sandboxed: Boolean(options.sandbox),
          sandboxNoNet: Boolean(options.sandboxNoNet), sandboxTrust: sandboxPolicyOverrides?.trust });
        if (options.experimentMcp && agentId === "codex") {
          throw new UsageRefusalError("Codex --experiment-mcp supports run only; the paired check requires a non-hermetic control and is supported only by claude, zai, and kimi");
        }
        if (hermetic && options.cwd !== undefined) {
          throw new UsageRefusalError("--hermetic plants its own working directory; drop --cwd");
        }
        const timeoutMs = parseTimeoutOption(options.timeout);
        const model = options.model
          ? resolveModel(options.model, agentId, config)
          : undefined;
        if (options.agyIsolationProbe !== undefined) {
          if (agentId !== "agy" || hermetic || tools === "none" || options.experimentMcp ||
              !options.sandbox || requestedAutonomy !== "read-only" || options.cwd || passthroughEnv.length ||
              options.sandboxTrust || options.sandboxNoNet || options.sandboxScrubEnv || requestedEffort) {
            throw new UsageRefusalError("--agy-isolation-probe requires -a agy --auto read-only with default scode and no other isolation flags");
          }
        }
        if (agentId === "agy" && (hermetic || tools === "none")) {
          if (!options.sandbox || requestedAutonomy !== "read-only" || options.cwd || passthroughEnv.length ||
              options.sandboxTrust || options.sandboxNoNet || options.sandboxScrubEnv || requestedEffort) {
            throw new UsageRefusalError("agy canary checks require default read-only scode and manage their own scratch cwd and HOME");
          }
        }

        const adapter = getAdapter(agentId);

        if (!adapter.isAvailable()) {
          console.error(`Error: ${agentId} is not installed`);
          console.error(`Please install '${adapter.binaryName}' and try again`);
          process.exit(1);
        }

        const caps = adapter.capabilities();
        if (model && !caps.supportsModel) {
          throw new UsageRefusalError(`${agentId} does not support model selection`);
        }

        // The control repeats the probe's --tools selection without
        // --hermetic and nothing else, so a harness that scopes --tools none
        // to hermetic runs cannot be checked at --tools none: its plain
        // control is refused by the adapter itself, and substituting default
        // tools would vary two things at once — the control's leak would no
        // longer prove a tools-free channel carried the canary, so the
        // hermetic probe's clean OK could mean tool removal, not isolation.
        // Fail before spending a request; the harness's two claims keep
        // their own instruments (check --hermetic without --tools for the
        // isolation, the capability probes for --tools none).
        if (hermetic && tools === "none" && caps.toolsNoneRequiresHermetic) {
          throw new UsageRefusalError(
            `check --hermetic --tools none cannot run for ${agentId}: the control probe would be a ` +
              `plain --tools none run, which ${agentId} refuses. Run the check without --tools for the ` +
              "isolation claim; the --tools none claim keeps its own capability probes (docs/isolation.md)"
          );
        }

        const autonomy = resolveAutonomyForAdapter(agentId, caps, requestedAutonomy);
        if (adapter.requiresSandboxForAutonomy(autonomy) && !options.sandbox) {
          throw new UsageRefusalError(
            `${agentId} cannot enforce '${autonomy}' autonomy without --sandbox`
          );
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
          sandboxNoNet: Boolean(options.sandboxNoNet),
          sandboxTrust: sandboxPolicyOverrides?.trust,
          passthroughEnv,
          timeoutMs,
          tools,
          experimentMcp: options.experimentMcp,
          // The label lands on the ledger record every probe of this
          // check inherits (baseRequest spreads into each of them), so
          // `codemux calls --label … --sum` can report what a labeled
          // batch cost — the machine check's --spend stage relies on it.
          labels: parseLabels(options.label),
        };
        // Validation before the quota gate, the order the run path holds:
        // the plain request below is the control every check launches, and
        // its hermetic twin is the probe, so a request the adapter refuses
        // (opencode's plain --tools none among them) must surface as its
        // own exit-64 refusal, never hide behind a quota refusal (review
        // round 12, edges 3). Only the plain request is validated here.
        // The hermetic twin's cwd is the canary's scratch directory,
        // planted only below; validating it here — against the operator's
        // cwd, the request's undefined cwd — refused hermetic checks for
        // kimi, codex, and agy from any repo holding project config
        // (AGENTS.md and kin) before any probe ran (review round 14,
        // contracts 1), so the hermetic request is validated where it is
        // built, on the planted directory (below). The same rule covers
        // every flow that builds forms of its own: the agy canary and
        // isolation-probe flows launch requests against a scratch cwd this
        // command owns — agy's hermetic rule demands one — and an
        // experiment check's plain control is valid only once registered
        // (canaryControls), which happens when the canary is planted
        // below; all of them keep their per-probe validation there.
        const buildsItsOwnPlainRequest =
          options.experimentMcp !== undefined ||
          (agentId === "agy" && (hermetic || tools === "none" || options.agyIsolationProbe !== undefined));
        if (!buildsItsOwnPlainRequest) {
          adapter.validateRunRequest(baseRequest);
        }

        // The quota gate: a check spends real requests, so it passes the
        // same gate a run does — after every request check, before any
        // probe spawns. A provider override in force skips the native gate
        // (assertQuotaHeadroomForLaunch).
        const quotaPolicy = resolveQuotaGate({
          config: config.quota,
          ceiling: options.quotaCeiling,
          disabled: options.quotaGate === false,
        });
        // A print-only check spends nothing (review round 56).
        if (quotaPolicy !== null && !options.printSandbox) await assertQuotaHeadroomForLaunch(adapter, quotaPolicy);

        const harnessVersion = await assertHarnessSupported(
          agentId, adapter.binaryName, options.cwd, undefined,
          autonomy, Boolean(options.sandbox), passthroughEnv
        );
        if (options.agyIsolationProbe !== undefined) {
          process.exitCode = await runAgyIsolationProbe(options.agyIsolationProbe, timeoutMs, model, harnessVersion);
          return;
        }
        if (agentId === "agy" && (hermetic || tools === "none")) {
          process.exitCode = await runAgyCanaryChecks(hermetic, tools === "none", timeoutMs, model, harnessVersion);
          return;
        }

        const launch: LaunchOptions = {
          sandbox: Boolean(options.sandbox),
          sandboxPolicyOverrides,
          requestedAutonomy,
          timeoutMs,
          cwd: options.cwd,
          kind: "check",
          harnessVersion,
          printSandbox: Boolean(options.printSandbox),
        };
        const label = `${agentId}${model ? ` (model: ${model})` : ""}${options.sandbox ? " (sandboxed)" : ""}`;

        if (!hermetic) {
          console.error(`Checking ${label}...`);
          const result = await launchRunRequest(adapter, baseRequest, launch);
          if (options.printSandbox) {
            // The argv was printed inside the launch and nothing ran, so
            // the probe's OK-line judgment has no response to judge.
            process.exitCode = result.exitCode;
            return;
          }
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

        const kimiCanary = agentId === "kimi" ? plantKimiCanary() : null;
        const canary = kimiCanary ?? plantCanary(Boolean(options.experimentMcp));
        let probeThrew = false;
        let cleanupWarning = false;
        try {
          const canaryAdapter = kimiCanary?.adapter ?? adapter;
          const canaryLaunch = { ...launch, cwd: canary.cwd };
          const probe: RunRequest = {
            ...baseRequest,
            prompt: HERMETIC_CANARY_PROMPT,
            cwd: canary.cwd,
            instructionDirs: [canary.cwd],
          };
          const plantedControl = agentId === "kimi" && !passthroughEnv.includes("KIMI_CODE_HOME")
            ? { ...probe, passthroughEnv: [...passthroughEnv, "KIMI_CODE_HOME"] }
            : probe;
          const controlProbe = options.experimentMcp ? experimentCanaryControl(plantedControl, kimiCanary?.brandHome) : plantedControl;
          // Fail before spending a request when the adapter cannot claim it;
          // validate both requests against the planted directory before either launch.
          canaryAdapter.validateRunRequest({ ...probe, hermetic: true });
          canaryAdapter.validateRunRequest(controlProbe);

          console.error(`Checking ${label} hermetically (planted code word ${canary.marker})...`);
          const hermeticResult = await launchRunRequest(
            canaryAdapter,
            { ...probe, hermetic: true },
            canaryLaunch
          );
          if (hermeticResult.exitCode !== 0) {
            reportFailure(hermeticResult);
            process.exitCode = hermeticResult.exitCode;
            return;
          }
          // The marker scan covers the run's whole record (stdout plus what
          // the harness kept off-screen, when it recorded anything), and the
          // exact-OK test runs on the model's answer, which a harness whose
          // stdout is a transcript carries in `reply`. Both fields are set
          // by processRunResult while the run's context was alive; the
          // launcher has disposed it by now, so the result is the only
          // channel to that record.
          const verdict = evaluateCanary(
            hermeticResult.scanSurface ?? hermeticResult.stdout,
            canary.marker,
            hermeticResult.reply ?? hermeticResult.stdout
          );

          // The control varies --hermetic alone: it repeats the probe's
          // tools selection unchanged, so its leak proves the planted files
          // reached the model through a channel that needed no tools — the
          // attribution that makes the hermetic probe's clean OK mean
          // isolation, not tool removal. A harness whose --tools none is
          // hermetic-only was refused before any probe ran.
          console.error("Control probe without --hermetic...");
          const controlResult = await launchRunRequest(canaryAdapter, controlProbe, canaryLaunch);
          const control = controlResult.exitCode === 0
            ? evaluateCanary(controlResult.scanSurface ?? controlResult.stdout, canary.marker)
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
          console.error(controlLine);
        } catch (error) {
          probeThrew = true;
          throw error;
        } finally {
          canary.cleanup();
          if (kimiCanary && existsSync(kimiCanary.brandHome)) {
            cleanupWarning = true;
            console.warn("Warning: Kimi planted brand home still exists after cleanup");
            if (!probeThrew) process.exitCode ||= 1;
          }
        }
        if (cleanupWarning) return;
        process.stdout.write(`HERMETIC ${agentId}: OK\n`);
        process.exitCode = 0;
      } catch (error) {
        handleUnexpectedError(error);
      }
    });
}

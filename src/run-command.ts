import { validateProjectSettingsRequest } from "./claude-project-settings.js";
import {
  handleUnexpectedError,
  isScodeAvailable,
  parseAutonomyOption,
  parseBudgetUsdOption,
  parseEffortOption,
  parsePassthroughEnvOption,
  parseSandboxPolicyOverrides,
  resolveAutonomyForAdapter,
  resolveEffortForAdapter,
  assertHarnessSupported,
} from "./cli-runtime.js";
import { getAdapter, AGENT_IDS } from "./adapters/index.js";
import { resolveModel } from "./config.js";
import { PLAYWRIGHT_MCP_AGENT_LIST, supportsPlaywrightMcpAgent } from "./mcp.js";
import type { Command } from "commander";
import type { AgentId, CodemuxConfig, RunRequest } from "./types.js";
import { assertExperimentMcpUnavailable, validateExperimentRequest } from "./experiment-mcp.js";
import { launchRunRequest } from "./launch.js";
import { ExperimentFailure } from "./experiment-records.js";
import { experimentFailedResult } from "./result-envelope/experiment.js";
import { readUtf8FileBounded } from "./file-io.js";
import { parseTimeoutOption, parseToolsOption } from "./cli-runtime.js";
import { collectLabel, LABELS_ENV, parseLabels } from "./labels.js";
import { assertQuotaHeadroomForLaunch, resolveQuotaGate } from "./quota-gate.js";
import { UsageRefusalError, requireNonEmptyOption } from "./validation.js";
import { agentsSupporting } from "./parity/index.js";
/** A prompt-source refusal is usage (exit 64): the prompt is part of
 * the request, so an empty, oversized, malformed, or ambiguous source
 * is a mistake only the caller can fix. The one exception is a plain
 * error (exit 1): a stdin producer that stalls past --timeout. */
const promptRefusal = (message: string): UsageRefusalError =>
  new UsageRefusalError(message);

const MAX_PROMPT_FILE_BYTES = 16 * 1024 * 1024;

// The stand-in prompt for preflight validation: the shortest text that
// satisfies every prompt rule, so the validation that runs before `-f -`
// consumes stdin exercises every check. The rules are re-applied to the
// real prompt after it is read.
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
    throw promptRefusal("-f - reads the prompt from stdin, but stdin is a terminal; pipe the prompt instead");
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
          promptRefusal(
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
    throw promptRefusal("-f - prompt must contain valid UTF-8");
  }
}

export function registerRunCommand(
  program: Command,
  config: CodemuxConfig,
  requireValidConfig: () => void
): void {
  program
    .command("run")
    .description("Run a prompt with an AI coding agent (non-interactive)")
    .option("-a, --agent <agent>", "Agent to use", config.defaultAgent)
    .option("-m, --model <model>", "Model to use (supports aliases)")
    .option("-p, --prompt <prompt>", "Prompt text")
    .option("--label <KEY=VALUE>", "Record a workflow label (repeatable)", collectLabel, [])
    .option("-f, --file <path>", "Read prompt from file, or from stdin with -")
    .option(
      "--timeout <seconds>",
      "Timeout in seconds for each phase: stdin collection and subprocess execution have separate budgets",
      "1800"
    )
    .option("--pass-env <names>", "Pass comma-separated sensitive environment names")
    .option("--enable-playwright-mcp", "Enable local Playwright MCP inside the sandbox")
    .option(
      "--hermetic",
      "Suppress supported automatic customization loading; exceptions and harness requirements: docs/isolation.md"
    )
    .option("--tools <selection>", "Built-in tools the harness exposes: default, none")
    .option("--no-web", "Deny the harness's built-in web tools in a headless run (agents: docs/harnesses.md)")
    .option(
      "--experiment-project-settings",
      "Load the repository's own settings on a hermetic run, for experiments on the native permission system; requires scode (agents and autonomy: docs/cli.md)"
    )
    .option("--experiment-mcp <spec.json>", "One experiment stdio MCP server; requires hermetic, tools none, read-only (agents: docs/experiment-mcp.md)")
    .option(
      "--result-json",
      "Return a structured result with harness-specific normalization and reported token usage"
    )
    .option(
      "--max-budget-usd <amount>",
      "Soft dollar spend threshold checked after charges; a call may exceed it (agents: docs/harnesses.md); a positive amount with at most two fraction digits"
    )
    .option("-s, --sandbox", "Run in sandbox (default; requires scode)", true)
    .option("--no-sandbox", "Run without the scode boundary (autonomy below high is unavailable)")
    .option(
      "--sandbox-trust <level>",
      "scode trust override: trusted, standard, untrusted"
    )
    .option("--sandbox-no-net", "Pass --no-net to scode when sandboxed")
    .option("--sandbox-strict", "Pass --strict to scode (deny-default); requires --sandbox")
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
      "Print the scode argv this run would exec, one argument per line (controls escaped, a newline prints as \\n), and exit 0 without running anything; requires --sandbox"
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
    .option(
      "--quota-ceiling <percent>",
      "Refuse the launch when a bounding usage window is below this percent remaining; overrides the config quota ceiling for this invocation"
    )
    .option("--no-quota-gate", "Skip the pre-launch usagemux quota check for this invocation")
    .action(async (options) => {
      let failureRequest: RunRequest | undefined;
      try {
        requireValidConfig();
        const labels = parseLabels(options.label, process.env[LABELS_ENV]);
        const agentId = options.agent as AgentId;

        if (!AGENT_IDS.includes(agentId)) {
          // One message, two lines: handleUnexpectedError prints it with the
          // "Error:" prefix, so the output matches the old console.error pair.
          throw new UsageRefusalError(
            `Unknown agent '${agentId}'\nAvailable agents: ${AGENT_IDS.join(", ")}`
          );
        }

        const requestedAutonomy = parseAutonomyOption(options.auto) ?? "read-only";
        assertExperimentMcpUnavailable(agentId, options.experimentMcp);
        const requestedEffort = parseEffortOption(options.effort);
        const passthroughEnv = parsePassthroughEnvOption(options.passEnv);
        const enablePlaywrightMcp = Boolean(options.enablePlaywrightMcp);
        if (enablePlaywrightMcp && !options.sandbox) {
          throw new UsageRefusalError("--enable-playwright-mcp requires --sandbox");
        }
        if (enablePlaywrightMcp && !supportsPlaywrightMcpAgent(agentId)) {
          throw new UsageRefusalError(`--enable-playwright-mcp is supported only by ${PLAYWRIGHT_MCP_AGENT_LIST}`);
        }
        const hermetic = Boolean(options.hermetic);
        const tools = parseToolsOption(options.tools);
        const sandboxPolicyOverrides = parseSandboxPolicyOverrides({
          sandbox: Boolean(options.sandbox),
          sandboxTrust: options.sandboxTrust, sandboxStrict: options.sandboxStrict,
          sandboxNoNet: Boolean(options.sandboxNoNet),
          sandboxScrubEnv: Boolean(options.sandboxScrubEnv),
          sandboxAccount: options.sandboxAccount,
          sandboxAccountId: options.sandboxAccountId,
          sandboxBlock: options.sandboxBlock,
        });
        validateExperimentRequest({ agent: agentId, prompt: PREFLIGHT_PROMPT, experimentMcp: options.experimentMcp,
          hermetic, tools, autonomy: requestedAutonomy, sandboxed: Boolean(options.sandbox),
          sandboxNoNet: Boolean(options.sandboxNoNet), sandboxTrust: sandboxPolicyOverrides?.trust, enablePlaywrightMcp });
        if ((hermetic || tools === "none") && enablePlaywrightMcp) {
          throw new UsageRefusalError("--hermetic and --tools none cannot be combined with --enable-playwright-mcp");
        }
        // The flag denies Claude Code's own web tools; another harness's web
        // tools are untouched, so accepting it there would promise a gate
        // that does not exist.
        if (options.web === false && !agentsSupporting("run.no-web").includes(agentId)) {
          throw new UsageRefusalError(`--no-web applies to the ${agentsSupporting("run.no-web").join(", ")} agents only; ${agentId} keeps its own web tools`);
        }
        if (options.experimentProjectSettings) {
          validateProjectSettingsRequest({ agent: agentId, hermetic, autonomy: requestedAutonomy,
            sandbox: Boolean(options.sandbox), cwd: options.cwd ?? process.cwd(), tools,
            experimentMcp: options.experimentMcp, passthroughEnv });
        }
        if (options.printSandbox && !options.sandbox) {
          throw new UsageRefusalError("--print-sandbox requires --sandbox: it prints the scode argv of a sandboxed run");
        }
        if (options.printSandbox && options.experimentMcp) {
          throw new UsageRefusalError(
            "--print-sandbox cannot be combined with --experiment-mcp: the MCP relay is minted at start, so its argv cannot be shown without starting it"
          );
        }

        const adapter = getAdapter(agentId);

        // Parsed before the prompt is read: a `-f -` read is bounded by
        // the same timeout the run honors, and an invalid value must
        // fail before anything consumes stdin. The spend limit parses
        // here for the same reason.
        const timeoutMs = parseTimeoutOption(options.timeout);
        const maxBudgetUsd = parseBudgetUsdOption(options.maxBudgetUsd);

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
        // Presence is `!== undefined`, never truthiness: `-f ""` (an unset
        // shell variable) is a given file option, not a missing one, so the
        // mutual-exclusion refusal below still fires and an empty path is
        // refused by name instead of silently falling back to -p (review
        // round 159).
        if (options.file !== undefined) {
          if (options.prompt !== undefined) {
            throw promptRefusal("--prompt and --file cannot be used together");
          }
          if (options.file === "-") {
            // The stand-in (PREFLIGHT_PROMPT) until the read below: stdin is
            // the one prompt source that can block, so its read waits for
            // adapter validation.
            readPromptFromStdin = true;
            earlyPrompt = PREFLIGHT_PROMPT;
          } else {
            requireNonEmptyOption("--file", options.file, "a path or '-' as its value");
            try {
              earlyPrompt = readUtf8FileBounded(options.file, {
                maxBytes: MAX_PROMPT_FILE_BYTES,
                label: "prompt file",
              });
            } catch (error) {
              const message = error instanceof Error ? `: ${error.message}` : "";
              throw promptRefusal(`Could not read file '${options.file}'${message}`);
            }
            if (earlyPrompt.trim().length === 0) {
              throw promptRefusal("No prompt provided. Use -p or -f");
            }
          }
        } else if (
          typeof options.prompt !== "string" ||
          options.prompt.trim().length === 0
        ) {
          throw promptRefusal("No prompt provided. Use -p or -f");
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
        // Presence is `!== undefined` so an explicit `--model ""` reaches
        // resolveModel and its validateModelName refusal instead of reading
        // as "no model" (review round 159).
        const model = options.model !== undefined
          ? resolveModel(options.model, agentId, config)
          : undefined;
        if (model !== undefined && !caps.supportsModel) {
          throw new UsageRefusalError(`${agentId} does not support model selection`);
        }
        // The alias is the -m value as typed, only when it resolved
        // through config.models (design P5); a raw id reports no alias.
        const modelAlias =
          options.model !== undefined && config.models[options.model] !== undefined
            ? options.model
            : undefined;

        const autonomy = resolveAutonomyForAdapter(agentId, caps, requestedAutonomy);
        if (adapter.requiresSandboxForAutonomy(autonomy) && !options.sandbox) {
          throw new UsageRefusalError(
            `${agentId} cannot enforce '${autonomy}' autonomy without --sandbox`
          );
        }
        const effort = resolveEffortForAdapter(agentId, caps, requestedEffort);
        const sandboxAutonomy = requestedAutonomy;

        const request: RunRequest = {
          agent: agentId,
          labels,
          // The resolved prompt -- the stand-in only while stdin is the
          // source (see PREFLIGHT_PROMPT), with every other source already
          // validated above.
          prompt: earlyPrompt,
          model,
          ...(modelAlias !== undefined ? { modelAlias } : {}),
          autonomy,
          effort,
          cwd: options.cwd,
          sandboxed: Boolean(options.sandbox),
          // The claim rides only a sandboxed run: unsandboxed, the policy
          // flags were already warned about and dropped (round 341), and a
          // request claiming a restriction its launch cannot apply is
          // refused by the launcher.
          sandboxNoNet: Boolean(options.sandbox && options.sandboxNoNet),
          sandboxTrust: sandboxPolicyOverrides?.trust,
          timeoutMs,
          passthroughEnv,
          enablePlaywrightMcp,
          hermetic,
          experimentMcp: options.experimentMcp,
          experimentProjectSettings: Boolean(options.experimentProjectSettings),
          tools,
          web: options.web !== false,
          resultJson: Boolean(options.resultJson),
          maxBudgetUsd,
        };
        failureRequest = request;
        // Preflight: refuse an unsupported hermetic, tools, or result-json
        // request before anything consumes stdin. When the
        // prompt is the stand-in, the content rules are re-applied to the
        // real text after the read -- the same single validator, twice, with
        // the second pass carrying the text the run will actually submit.
        adapter.validateRunRequest(request, { printOnly: Boolean(options.printSandbox) });
        // The quota options are request checks too, so their values are
        // judged here; the gate itself runs after the stdin read below.
        const quotaPolicy = resolveQuotaGate({
          config: config.quota,
          ceiling: options.quotaCeiling,
          disabled: options.quotaGate === false,
        });

        // Availability comes after every request check (review round
        // 159): a malformed request (a missing --cwd, an empty
        // --quota-ceiling) is the caller's mistake, and an "is not
        // installed" line would misdirect them. It stays ahead of the
        // stdin read, so a missing harness never waits on a producer.
        if (!adapter.isAvailable()) {
          console.error(`Error: ${agentId} is not installed`);
          console.error(`Please install '${adapter.binaryName}' and try again`);
          process.exit(1);
        }

        // Reached only when scode is genuinely absent: a scode that is
        // present but fails the trust check throws its own refusal from
        // isScodeAvailable, which the handler below reports instead of
        // this "not installed" misdirection (review round 381).
        if (options.sandbox && !isScodeAvailable()) {
          console.error("Error: scode is not installed (required for --sandbox)");
          console.error("Install scode and ensure its executable is on PATH");
          process.exit(1);
        }

        let prompt = earlyPrompt;
        if (readPromptFromStdin) {
          prompt = await readStdinPrompt(MAX_PROMPT_FILE_BYTES, timeoutMs);
          if (prompt.trim().length === 0) {
            throw promptRefusal("-f - read an empty prompt from stdin");
          }
        }

        // The real prompt replaces the stand-in ON THIS OBJECT: the object
        // validated here stays the object that launches, so the launch path
        // builds the child environment from the same passthroughEnv list it
        // validated (one source, request.passthroughEnv).
        request.prompt = prompt;
        adapter.validateRunRequest(request, { printOnly: Boolean(options.printSandbox) });

        // The quota gate: after every request check, before anything spawns
        // or is recorded. A refusal exits 64 and nothing runs. A provider
        // override in force moves the spend off the native account, and the
        // gate skips it with one stderr line (assertQuotaHeadroomForLaunch).
        // A print-only launch spends nothing: the quota gate has nothing to
        // protect and must not refuse the diagnostic (review round 55).
        if (quotaPolicy !== null && !options.printSandbox) await assertQuotaHeadroomForLaunch(adapter, quotaPolicy);

        console.error(`Running with ${agentId}${model ? ` (model: ${model})` : ""}${options.sandbox ? " (sandboxed)" : ""}...`);

        // Refuse or warn before launch: a flag can survive an upstream release
        // while the enforcement behind it does not.
        const harnessVersion = await assertHarnessSupported(
          agentId,
          adapter.binaryName,
          options.cwd,
          // The environment the launch will use, built the way the launch
          // paths build it from the adapter's own view: a redirect an
          // adapter injects through its environment (OPENCODE_BIN_PATH)
          // is trust-pinned by the launch but was invisible to a gate
          // reading process.env, so the binary it probed was not the one
          // about to run (review round 338, item 14). getRunEnv is
          // deliberately absent: it needs the run context prepareRun
          // builds, which the gate precedes, and no production adapter
          // injects a redirect through it.
          adapter.buildExecutionEnv({}, passthroughEnv, { printOnly: Boolean(options.printSandbox) }),
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
          harnessVersion,
          printSandbox: Boolean(options.printSandbox),
        });

        process.stdout.write(result.stdout);
        if (result.stderr) {
          process.stderr.write(result.stderr);
        }

        process.exitCode = result.exitCode;
        return;
      } catch (error) {
        if (failureRequest?.experimentMcp && error instanceof ExperimentFailure) {
          const normalized = failureRequest.agent === "kimi" ? getAdapter("kimi").processRunResult(
            { stdout: "", stderr: "", exitCode: 1, success: false }, failureRequest, undefined, error) : undefined;
          const result = experimentFailedResult(normalized, failureRequest, null, error);
          process.stdout.write(result.stdout);
          process.stderr.write(result.stderr);
          process.exitCode = result.exitCode;
          return;
        }
        handleUnexpectedError(error);
      }
    });
}

#!/usr/bin/env bun
import { program } from "commander";
import { readFileSync } from "fs";
import { AUTONOMY_EQUIVALENCE } from "./autonomy.js";
import { buildEffectiveScodeCommands, verifyAgentsWiring } from "./verify.js";
import {
  hasSandboxPolicyConflicts,
  resolveSandboxOptionsForAgent,
  type SandboxPolicyOverrides,
} from "./sandbox-policy.js";
import { getAdapter, getAllAdapters, AGENT_IDS } from "./adapters/index.js";
import { guardedWait } from "./adapters/base.js";
import { loadConfig, resolveModel } from "./config.js";
import {
  SCODE_TRUST_LEVELS,
  buildSandboxEnv,
  buildScodeCommand,
  type SandboxOptions,
  type ScodeTrustLevel,
} from "./sandbox.js";
import {
  AUTONOMY_LEVELS,
  REASONING_EFFORT_LEVELS,
  isAutonomyLevel,
  isReasoningEffort,
  type AgentId,
  type AdapterCapabilities,
  type AutonomyLevel,
  type ReasoningEffort,
  type RunRequest,
} from "./types.js";

const config = loadConfig();

function isScodeAvailable(): boolean {
  const result = Bun.spawnSync(["which", "scode"]);
  return result.exitCode === 0;
}

function failInvalidOption(
  optionName: string,
  value: string,
  allowed: readonly string[]
): never {
  console.error(`Error: Invalid value '${value}' for ${optionName}`);
  console.error(`Allowed values: ${allowed.join(", ")}`);
  process.exit(1);
}

function parseAutonomyOption(value: string | undefined): AutonomyLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isAutonomyLevel(value)) {
    failInvalidOption("--auto", value, AUTONOMY_LEVELS);
  }
  return value;
}

function parseEffortOption(value: string | undefined): ReasoningEffort | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isReasoningEffort(value)) {
    failInvalidOption("--effort", value, REASONING_EFFORT_LEVELS);
  }
  return value;
}

function parseSandboxTrustOption(value: string | undefined): ScodeTrustLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!(SCODE_TRUST_LEVELS as readonly string[]).includes(value)) {
    failInvalidOption("--sandbox-trust", value, SCODE_TRUST_LEVELS);
  }
  return value as ScodeTrustLevel;
}

function parseSandboxPolicyOverrides(options: {
  sandbox: boolean;
  sandboxTrust?: string;
  sandboxNoNet?: boolean;
  sandboxScrubEnv?: boolean;
  sandboxAllowNet?: boolean;
  sandboxKeepEnv?: boolean;
  sandboxNoDefaults?: boolean;
}, allowWithoutSandbox = false): SandboxPolicyOverrides | undefined {
  const trust = parseSandboxTrustOption(options.sandboxTrust);
  const overrides: SandboxPolicyOverrides = {
    trust,
    noNet: Boolean(options.sandboxNoNet),
    scrubEnv: Boolean(options.sandboxScrubEnv),
    allowNet: Boolean(options.sandboxAllowNet),
    keepEnv: Boolean(options.sandboxKeepEnv),
    disableAgentDefaults: Boolean(options.sandboxNoDefaults),
  };

  const conflicts = hasSandboxPolicyConflicts(overrides);
  if (conflicts.length > 0) {
    for (const conflict of conflicts) {
      console.error(`Error: ${conflict}`);
    }
    process.exit(1);
  }

  if (!options.sandbox && !allowWithoutSandbox) {
    if (
      trust ||
      overrides.noNet ||
      overrides.scrubEnv ||
      overrides.allowNet ||
      overrides.keepEnv ||
      overrides.disableAgentDefaults
    ) {
      console.warn(
        "Warning: sandbox policy flags require --sandbox, ignoring"
      );
    }
    return undefined;
  }

  return overrides;
}

function resolveAutonomyForAdapter(
  agentId: AgentId,
  caps: AdapterCapabilities,
  requested: AutonomyLevel
): AutonomyLevel | undefined {
  if (!caps.supportsAutonomy) {
    if (requested !== "read-only") {
      console.warn(
        `Warning: ${agentId} does not support autonomy levels, ignoring --auto`
      );
    }
    return undefined;
  }

  if (!caps.autonomyLevels.includes(requested)) {
    const fallback = caps.autonomyLevels[0];
    console.warn(
      `Warning: ${agentId} does not support autonomy level '${requested}', using '${fallback}'`
    );
    return fallback;
  }

  return requested;
}

function resolveEffortForAdapter(
  agentId: AgentId,
  caps: AdapterCapabilities,
  requested?: ReasoningEffort
): ReasoningEffort | undefined {
  if (!requested) {
    return undefined;
  }

  if (!caps.supportsEffort) {
    console.warn(
      `Warning: ${agentId} does not support --effort flag, ignoring`
    );
    return undefined;
  }

  if (!caps.effortLevels.includes(requested)) {
    const fallback = caps.effortLevels[0];
    console.warn(
      `Warning: ${agentId} does not support effort level '${requested}', using '${fallback}'`
    );
    return fallback;
  }

  return requested;
}

async function runSandboxed(
  command: string[],
  cwd?: string,
  extraEnv?: Record<string, string>,
  interactive = false,
  autonomy?: AutonomyLevel,
  sandboxOptions?: SandboxOptions
): Promise<number> {
  const scodeCmd = buildScodeCommand(command, cwd, autonomy, sandboxOptions);
  const env = buildSandboxEnv(extraEnv);

  const proc = Bun.spawn(scodeCmd, {
    cwd: cwd || process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env,
  });

  return interactive ? await guardedWait(proc) : await proc.exited;
}

async function runSandboxedWithStdin(
  command: string[],
  stdinData: string,
  cwd?: string,
  extraEnv?: Record<string, string>,
  autonomy?: AutonomyLevel,
  sandboxOptions?: SandboxOptions
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const scodeCmd = buildScodeCommand(command, cwd, autonomy, sandboxOptions);
  const env = buildSandboxEnv(extraEnv);

  const proc = Bun.spawn(scodeCmd, {
    cwd: cwd || process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env,
  });

  proc.stdin.write(stdinData);
  proc.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

program
  .name("codemux")
  .description("Unified CLI for AI coding agents")
  .version("0.1.0");

program
  .command("run")
  .description("Run a prompt with an AI coding agent (non-interactive)")
  .option("-a, --agent <agent>", "Agent to use", config.defaultAgent)
  .option("-m, --model <model>", "Model to use (supports aliases)")
  .option("-p, --prompt <prompt>", "Prompt text")
  .option("-f, --file <path>", "Read prompt from file")
  .option("-s, --sandbox", "Run in sandbox (requires scode)")
  .option(
    "--sandbox-trust <level>",
    "scode trust override: trusted, standard, untrusted"
  )
  .option("--sandbox-no-net", "Pass --no-net to scode when sandboxed")
  .option("--sandbox-scrub-env", "Pass --scrub-env to scode when sandboxed")
  .option("--sandbox-allow-net", "Force network on when sandboxed")
  .option("--sandbox-keep-env", "Disable --scrub-env when sandboxed")
  .option("--sandbox-no-defaults", "Disable per-harness sandbox policy defaults")
  .option(
    "--auto <level>",
    "Autonomy level: read-only, low, medium, high",
    "read-only"
  )
  .option(
    "--effort <level>",
    "Reasoning effort: none, low, medium, high"
  )
  .option("--cwd <path>", "Working directory")
  .action(async (options) => {
    const agentId = options.agent as AgentId;

    if (!AGENT_IDS.includes(agentId)) {
      console.error(`Error: Unknown agent '${agentId}'`);
      console.error(`Available agents: ${AGENT_IDS.join(", ")}`);
      process.exit(1);
    }

    const requestedAutonomy = parseAutonomyOption(options.auto) ?? "read-only";
    const requestedEffort = parseEffortOption(options.effort);
    const sandboxPolicyOverrides = parseSandboxPolicyOverrides({
      sandbox: Boolean(options.sandbox),
      sandboxTrust: options.sandboxTrust,
      sandboxNoNet: Boolean(options.sandboxNoNet),
      sandboxScrubEnv: Boolean(options.sandboxScrubEnv),
      sandboxAllowNet: Boolean(options.sandboxAllowNet),
      sandboxKeepEnv: Boolean(options.sandboxKeepEnv),
      sandboxNoDefaults: Boolean(options.sandboxNoDefaults),
    });

    const adapter = getAdapter(agentId);

    if (!adapter.isAvailable()) {
      console.error(`Error: ${agentId} is not installed`);
      console.error(`Please install '${adapter.binaryName}' and try again`);
      process.exit(1);
    }

    if (options.sandbox && !isScodeAvailable()) {
      console.error("Error: scode is not installed (required for --sandbox)");
      console.error("Install from: ~/Programming/Ops/scode");
      process.exit(1);
    }

    let prompt = options.prompt;
    if (options.file) {
      try {
        prompt = readFileSync(options.file, "utf-8").trim();
      } catch (err) {
        console.error(`Error: Could not read file '${options.file}'`);
        process.exit(1);
      }
    }

    if (!prompt) {
      console.error("Error: No prompt provided. Use -p or -f");
      process.exit(1);
    }

    const model = options.model
      ? resolveModel(options.model, agentId, config)
      : undefined;

    const caps = adapter.capabilities();
    const autonomy = resolveAutonomyForAdapter(agentId, caps, requestedAutonomy);
    const effort = resolveEffortForAdapter(agentId, caps, requestedEffort);
    const sandboxAutonomy = requestedAutonomy;
    const sandboxOptions = options.sandbox
      ? resolveSandboxOptionsForAgent(agentId, sandboxAutonomy, sandboxPolicyOverrides)
      : undefined;

    const request: RunRequest = {
      agent: agentId,
      prompt,
      model,
      autonomy,
      effort,
      cwd: options.cwd,
      sandboxed: Boolean(options.sandbox),
    };

    adapter.beforeLaunch();
    const adapterEnv = adapter.getEnv();
    const envArg = Object.keys(adapterEnv).length > 0 ? adapterEnv : undefined;

    console.error(`Running with ${agentId}${model ? ` (model: ${model})` : ""}${options.sandbox ? " (sandboxed)" : ""}...`);

    let result;
    if (options.sandbox) {
      const command = adapter.buildRunCommand(request);
      const stdinData = adapter.getStdinInput(request);
      if (stdinData) {
        result = await runSandboxedWithStdin(
          command,
          stdinData,
          options.cwd,
          envArg,
          sandboxAutonomy,
          sandboxOptions
        );
      } else {
        const exitCode = await runSandboxed(
          command,
          options.cwd,
          envArg,
          false,
          sandboxAutonomy,
          sandboxOptions
        );
        result = { stdout: "", stderr: "", exitCode };
      }
    } else {
      result = await adapter.run(request);
    }

    process.stdout.write(result.stdout);
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }

    process.exit(result.exitCode);
  });

program
  .command("check")
  .description("Check agent/model configuration with a quick probe")
  .option("-a, --agent <agent>", "Agent to use", config.defaultAgent)
  .option("-m, --model <model>", "Model to use (supports aliases)")
  .option("--auto <level>", "Autonomy level: read-only, low, medium, high", "read-only")
  .option("--effort <level>", "Reasoning effort: none, low, medium, high")
  .option("--cwd <path>", "Working directory")
  .action(async (options) => {
    const agentId = options.agent as AgentId;

    if (!AGENT_IDS.includes(agentId)) {
      console.error(`Error: Unknown agent '${agentId}'`);
      console.error(`Available agents: ${AGENT_IDS.join(", ")}`);
      process.exit(1);
    }

    const requestedAutonomy = parseAutonomyOption(options.auto) ?? "read-only";
    const requestedEffort = parseEffortOption(options.effort);

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
    const effort = resolveEffortForAdapter(agentId, caps, requestedEffort);

    const request: RunRequest = {
      agent: agentId,
      prompt: "Reply with: OK",
      model,
      autonomy,
      effort,
      cwd: options.cwd,
      sandboxed: false,
    };

    console.error(`Checking ${agentId}${model ? ` (model: ${model})` : ""}...`);

    const result = await adapter.run(request);

    if (result.exitCode !== 0) {
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }
      process.exit(result.exitCode);
    }

    process.stdout.write("OK\n");
    process.exit(0);
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
  .option("--sandbox-allow-net", "Force network on when sandboxed")
  .option("--sandbox-keep-env", "Disable --scrub-env when sandboxed")
  .option("--sandbox-no-defaults", "Disable per-harness sandbox policy defaults")
  .option("--auto <level>", "Autonomy level: read-only, low, medium, high")
  .option("--effort <level>", "Reasoning effort: none, low, medium, high")
  .option("--cwd <path>", "Working directory")
  .action(async (options) => {
    const agentId = options.agent as AgentId;

    if (!AGENT_IDS.includes(agentId)) {
      console.error(`Error: Unknown agent '${agentId}'`);
      console.error(`Available agents: ${AGENT_IDS.join(", ")}`);
      process.exit(1);
    }

    const parsedAutonomy = parseAutonomyOption(options.auto);
    const requestedEffort = parseEffortOption(options.effort);
    const sandboxPolicyOverrides = parseSandboxPolicyOverrides({
      sandbox: Boolean(options.sandbox),
      sandboxTrust: options.sandboxTrust,
      sandboxNoNet: Boolean(options.sandboxNoNet),
      sandboxScrubEnv: Boolean(options.sandboxScrubEnv),
      sandboxAllowNet: Boolean(options.sandboxAllowNet),
      sandboxKeepEnv: Boolean(options.sandboxKeepEnv),
      sandboxNoDefaults: Boolean(options.sandboxNoDefaults),
    });

    const adapter = getAdapter(agentId);

    if (!adapter.isAvailable()) {
      console.error(`Error: ${agentId} is not installed`);
      console.error(`Please install '${adapter.binaryName}' and try again`);
      process.exit(1);
    }

    if (options.sandbox && !isScodeAvailable()) {
      console.error("Error: scode is not installed (required for --sandbox)");
      console.error("Install from: ~/Programming/Ops/scode");
      process.exit(1);
    }

    const model = options.model
      ? resolveModel(options.model, agentId, config)
      : undefined;

    // Default: high with sandbox, medium without
    const requestedAutonomy = parsedAutonomy ?? (options.sandbox ? "high" : "medium");
    const sandboxAutonomy = requestedAutonomy;
    const caps = adapter.capabilities();
    const autonomy = resolveAutonomyForAdapter(agentId, caps, requestedAutonomy);
    const effort = resolveEffortForAdapter(agentId, caps, requestedEffort);
    const sandboxOptions = options.sandbox
      ? resolveSandboxOptionsForAgent(agentId, sandboxAutonomy, sandboxPolicyOverrides)
      : undefined;

    adapter.beforeLaunch();
    const adapterEnv = adapter.getEnv();

    if (options.sandbox) {
      const command = adapter.buildTuiCommand(model, autonomy, effort, true);
      const exitCode = await runSandboxed(
        command,
        options.cwd,
        Object.keys(adapterEnv).length > 0 ? adapterEnv : undefined,
        true,
        sandboxAutonomy,
        sandboxOptions
      );
      process.exitCode = exitCode;
    } else {
      const exitCode = await adapter.runInteractive(model, options.cwd, autonomy, effort, false);
      process.exitCode = exitCode;
    }
  });

program
  .command("autonomy")
  .description("Show autonomy equivalence mappings for all agents")
  .action(() => {
    console.log("Autonomy equivalence matrix:\n");
    console.log("| Agent | read-only | low | medium | high | Notes |");
    console.log("|-------|-----------|-----|--------|------|-------|");

    for (const agentId of AGENT_IDS) {
      const mapping = AUTONOMY_EQUIVALENCE[agentId];
      console.log(
        `| ${agentId} | ${mapping.byLevel["read-only"]} | ${mapping.byLevel.low} | ${mapping.byLevel.medium} | ${mapping.byLevel.high} | ${mapping.notes ?? ""} |`
      );
    }
  });

program
  .command("verify")
  .description("Verify harness wiring and autonomy mapping consistency")
  .option("-a, --agent <agent>", "Verify a single agent")
  .option("--show-scode", "Show effective scode command preview per harness/autonomy")
  .option(
    "--sandbox-trust <level>",
    "scode trust override for --show-scode: trusted, standard, untrusted"
  )
  .option("--sandbox-no-net", "Add --no-net in --show-scode preview")
  .option("--sandbox-scrub-env", "Add --scrub-env in --show-scode preview")
  .option("--sandbox-allow-net", "Force network on in --show-scode preview")
  .option("--sandbox-keep-env", "Disable scrub-env in --show-scode preview")
  .option("--sandbox-no-defaults", "Disable per-harness defaults in --show-scode preview")
  .action((options) => {
    let selectedAgents: AgentId[] = AGENT_IDS;
    if (options.agent) {
      const agentId = options.agent as AgentId;
      if (!AGENT_IDS.includes(agentId)) {
        console.error(`Error: Unknown agent '${agentId}'`);
        console.error(`Available agents: ${AGENT_IDS.join(", ")}`);
        process.exit(1);
      }
      selectedAgents = [agentId];
    }

    const sandboxPolicyOverrides = parseSandboxPolicyOverrides(
      {
        sandbox: false,
        sandboxTrust: options.sandboxTrust,
        sandboxNoNet: Boolean(options.sandboxNoNet),
        sandboxScrubEnv: Boolean(options.sandboxScrubEnv),
        sandboxAllowNet: Boolean(options.sandboxAllowNet),
        sandboxKeepEnv: Boolean(options.sandboxKeepEnv),
        sandboxNoDefaults: Boolean(options.sandboxNoDefaults),
      },
      true
    );

    const rows = verifyAgentsWiring(selectedAgents);

    console.log("Verification checks: static wiring only (no model/network calls).\n");
    console.log("| Agent | Installed | Mapping | Build Run | Build TUI | Warnings | Status |");
    console.log("|-------|-----------|---------|-----------|-----------|----------|--------|");
    for (const row of rows) {
      console.log(
        `| ${row.agentId} | ${row.installed ? "yes" : "no"} | ${row.mappingOk ? "yes" : "no"} | ${row.runBuildOk ? "yes" : "no"} | ${row.tuiBuildOk ? "yes" : "no"} | ${row.warningCount} | ${row.status} |`
      );
    }

    const pass = rows.filter((r) => r.status === "PASS").length;
    const warn = rows.filter((r) => r.status === "WARN").length;
    const failRows = rows.filter((r) => r.status === "FAIL");
    const fail = failRows.length;

    console.log(`\nSummary: PASS ${pass}, WARN ${warn}, FAIL ${fail}`);

    const hasSandboxPreviewFlags = Boolean(
      options.sandboxTrust ||
        options.sandboxNoNet ||
        options.sandboxScrubEnv ||
        options.sandboxAllowNet ||
        options.sandboxKeepEnv ||
        options.sandboxNoDefaults
    );

    if (options.showScode) {
      const scodeRows = buildEffectiveScodeCommands(selectedAgents, sandboxPolicyOverrides);
      console.log("\nEffective scode command preview (run+tui x autonomy):\n");
      console.log("| Agent | Autonomy | Mode | Command |");
      console.log("|-------|----------|------|---------|");
      for (const row of scodeRows) {
        const rendered = row.command
          .map((part) => (part.includes(" ") ? JSON.stringify(part) : part))
          .join(" ");
        console.log(`| ${row.agentId} | ${row.autonomy} | ${row.mode} | \`${rendered}\` |`);
      }
    } else if (hasSandboxPreviewFlags) {
      console.warn("Warning: verify sandbox policy flags require --show-scode, ignoring");
    }

    if (fail > 0) {
      console.log("\nFailure details:");
      for (const row of failRows) {
        for (const issue of row.issues) {
          console.log(`- ${row.agentId}: ${issue}`);
        }
      }
      process.exitCode = 1;
    }
  });

program
  .command("list")
  .description("List available AI coding agents")
  .action(() => {
    console.log("Available agents:");
    for (const adapter of getAllAdapters()) {
      const available = adapter.isAvailable();
      const status = available ? "✅" : "❌";
      const caps = adapter.capabilities();
      const features: string[] = [];

      if (caps.supportsModel) features.push("model");
      if (caps.supportsAutonomy) features.push("autonomy");
      if (caps.supportsEffort) features.push("effort");

      const featureStr = features.length > 0 ? ` [${features.join(", ")}]` : "";
      console.log(`  ${status} ${adapter.id}${featureStr}`);
    }
  });

program
  .command("doctor")
  .description("Check installed AI coding agents and configuration")
  .action(() => {
    console.log("Checking AI coding agents...\n");

    let installed = 0;
    let missing = 0;

    for (const adapter of getAllAdapters()) {
      const available = adapter.isAvailable();
      const status = available ? "✅ installed" : "❌ not found";

      console.log(`${adapter.id} (${adapter.binaryName}): ${status}`);

      if (available) {
        installed++;
        const caps = adapter.capabilities();
        console.log(`  Non-interactive: ${caps.supportsNonInteractive ? "yes" : "no"}`);
        console.log(`  Interactive: ${caps.supportsInteractive ? "yes" : "no"}`);
        console.log(`  Model selection: ${caps.supportsModel ? "yes" : "no"}`);
        if (caps.supportsAutonomy) {
          console.log(`  Autonomy levels: ${caps.autonomyLevels.join(", ")}`);
        }
        if (caps.supportsEffort) {
          console.log(`  Effort levels: ${caps.effortLevels.join(", ")}`);
        }
      } else {
        missing++;
      }
      console.log();
    }

    console.log(`Summary: ${installed} installed, ${missing} missing`);
    console.log(`\nDefault agent: ${config.defaultAgent}`);
    console.log(`\nModel aliases available:`);
    for (const [alias, mapping] of Object.entries(config.models)) {
      const agents = Object.keys(mapping).join(", ");
      console.log(`  ${alias}: ${agents}`);
    }
  });

program.parse();

#!/usr/bin/env bun
import { program } from "commander";
import { readFileSync } from "fs";
import { getAdapter, getAllAdapters, AGENT_IDS } from "./adapters/index.js";
import { guardedWait } from "./adapters/base.js";
import { loadConfig, resolveModel } from "./config.js";
import type { AgentId, AutonomyLevel, ReasoningEffort, RunRequest } from "./types.js";

const config = loadConfig();

function isScoderAvailable(): boolean {
  const result = Bun.spawnSync(["which", "scoder"]);
  return result.exitCode === 0;
}

async function runSandboxed(command: string[], cwd?: string, extraEnv?: Record<string, string>, interactive = false): Promise<number> {
  const scoderCmd = ["scoder"];
  if (cwd) {
    scoderCmd.push("-C", cwd);
  }
  scoderCmd.push("--", ...command);

  const env = extraEnv
    ? { ...process.env, ...extraEnv } as Record<string, string>
    : undefined;

  const proc = Bun.spawn(scoderCmd, {
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
  extraEnv?: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const scoderCmd = ["scoder"];
  if (cwd) {
    scoderCmd.push("-C", cwd);
  }
  scoderCmd.push("--", ...command);

  const env = extraEnv
    ? { ...process.env, ...extraEnv } as Record<string, string>
    : undefined;

  const proc = Bun.spawn(scoderCmd, {
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
  .option("-s, --sandbox", "Run in sandbox (requires scoder)")
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

    const adapter = getAdapter(agentId);

    if (!adapter.isAvailable()) {
      console.error(`Error: ${agentId} is not installed`);
      console.error(`Please install '${adapter.binaryName}' and try again`);
      process.exit(1);
    }

    if (options.sandbox && !isScoderAvailable()) {
      console.error("Error: scoder is not installed (required for --sandbox)");
      console.error("Install from: ~/Programming/Ops/scoder");
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

    const autonomy = options.auto as AutonomyLevel;
    const caps = adapter.capabilities();

    if (autonomy !== "read-only" && !caps.supportsAutonomy) {
      console.warn(
        `Warning: ${agentId} does not support autonomy levels, ignoring --auto`
      );
    }

    if (
      autonomy !== "read-only" &&
      caps.supportsAutonomy &&
      !caps.autonomyLevels.includes(autonomy)
    ) {
      console.warn(
        `Warning: ${agentId} does not support autonomy level '${autonomy}'`
      );
    }

    const effort = options.effort as ReasoningEffort | undefined;

    if (effort && !caps.supportsEffort) {
      console.warn(
        `Warning: ${agentId} does not support --effort flag, ignoring`
      );
    }

    if (effort && caps.supportsEffort && !caps.effortLevels.includes(effort)) {
      console.warn(
        `Warning: ${agentId} does not support effort level '${effort}'`
      );
    }

    const request: RunRequest = {
      agent: agentId,
      prompt,
      model,
      autonomy: caps.supportsAutonomy ? autonomy : undefined,
      effort: caps.supportsEffort ? effort : undefined,
      cwd: options.cwd,
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
        result = await runSandboxedWithStdin(command, stdinData, options.cwd, envArg);
      } else {
        const exitCode = await runSandboxed(command, options.cwd, envArg);
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

    const autonomy = options.auto as AutonomyLevel;
    const effort = options.effort as ReasoningEffort | undefined;

    const request: RunRequest = {
      agent: agentId,
      prompt: "Reply with: OK",
      model,
      autonomy: caps.supportsAutonomy ? autonomy : undefined,
      effort: caps.supportsEffort ? effort : undefined,
      cwd: options.cwd,
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
  .option("-s, --sandbox", "Run in sandbox (requires scoder)")
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

    const adapter = getAdapter(agentId);

    if (!adapter.isAvailable()) {
      console.error(`Error: ${agentId} is not installed`);
      console.error(`Please install '${adapter.binaryName}' and try again`);
      process.exit(1);
    }

    if (options.sandbox && !isScoderAvailable()) {
      console.error("Error: scoder is not installed (required for --sandbox)");
      console.error("Install from: ~/Programming/Ops/scoder");
      process.exit(1);
    }

    const model = options.model
      ? resolveModel(options.model, agentId, config)
      : undefined;

    // Default: high with sandbox, medium without
    const autonomy = (options.auto as AutonomyLevel | undefined)
      ?? (options.sandbox ? "high" : "medium");
    const effort = options.effort as ReasoningEffort | undefined;

    adapter.beforeLaunch();
    const adapterEnv = adapter.getEnv();

    if (options.sandbox) {
      const command = adapter.buildTuiCommand(model, autonomy, effort);
      const exitCode = await runSandboxed(command, options.cwd, Object.keys(adapterEnv).length > 0 ? adapterEnv : undefined, true);
      process.exitCode = exitCode;
    } else {
      const exitCode = await adapter.runInteractive(model, options.cwd, autonomy, effort);
      process.exitCode = exitCode;
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

#!/usr/bin/env bun
import { program } from "commander";
import { readFileSync } from "fs";
import { getAdapter, getAllAdapters, AGENT_IDS } from "./adapters/index.js";
import { loadConfig, resolveModel } from "./config.js";
import type { AgentId, AutonomyLevel, RunRequest } from "./types.js";

const config = loadConfig();

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
  .option(
    "--auto <level>",
    "Autonomy level: read-only, low, medium, high",
    "read-only"
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

    const request: RunRequest = {
      agent: agentId,
      prompt,
      model,
      autonomy: caps.supportsAutonomy ? autonomy : undefined,
      cwd: options.cwd,
    };

    console.error(`Running with ${agentId}${model ? ` (model: ${model})` : ""}...`);

    const result = await adapter.run(request);

    process.stdout.write(result.stdout);
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }

    process.exit(result.exitCode);
  });

program
  .command("tui")
  .description("Start interactive TUI for an AI coding agent")
  .option("-a, --agent <agent>", "Agent to use", config.defaultAgent)
  .option("-m, --model <model>", "Model to use (supports aliases)")
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

    const exitCode = await adapter.runInteractive(model, options.cwd);
    process.exit(exitCode);
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

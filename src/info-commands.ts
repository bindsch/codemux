import type { Command } from "commander";
import { getAllAdapters } from "./adapters/index.js";
import { AUTONOMY_EQUIVALENCE } from "./autonomy.js";
import {
  getScodeCompatibilityStatus,
  parseSandboxPolicyOverrides,
} from "./cli-runtime.js";
import { buildEffectiveScodeCommands, verifyAgentsWiring } from "./verify.js";
import { AGENT_IDS, type AgentId, type CodemuxConfig } from "./types.js";
import {
  fetchUsageSnapshot,
  formatUsageSnapshot,
  getUsagemuxStatus,
  parseUsageTimeoutOption,
  UsageIntegrationUnavailableError,
  USAGEMUX_UNAVAILABLE_EXIT_CODE,
} from "./usage.js";

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function registerInfoCommands(
  program: Command,
  config: CodemuxConfig,
  configError?: Error,
  setExitCode: (code: number) => void = (code) => {
    process.exitCode = code;
  }
): void {
  program
    .command("usage")
    .description("Show subscription usage through optional usagemux integration")
    .option("-a, --agent <agent>", "Query a single agent")
    .option("--all", "Query all agents")
    .option("--json", "Emit the validated usagemux JSON response")
    .option("--timeout <seconds>", "Maximum usage query time in seconds", "30")
    .action(async (options) => {
      if (options.agent && options.all) {
        console.error("Error: --agent and --all cannot be used together");
        setExitCode(1);
        return;
      }
      const agent = options.agent as string | undefined;
      if (agent !== undefined && !AGENT_IDS.includes(agent as AgentId)) {
        console.error(`Error: Unknown agent '${agent}'`);
        console.error(`Available agents: ${AGENT_IDS.join(", ")}`);
        setExitCode(1);
        return;
      }
      try {
        const clients: readonly AgentId[] = agent ? [agent as AgentId] : AGENT_IDS;
        const timeoutMs = parseUsageTimeoutOption(options.timeout);
        const result = await fetchUsageSnapshot(clients, timeoutMs);
        console.log(
          options.json
            ? JSON.stringify(result.snapshot, null, 2)
            : formatUsageSnapshot(result.snapshot)
        );
        if (result.exitCode !== 0) setExitCode(result.exitCode);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        setExitCode(
          error instanceof UsageIntegrationUnavailableError
            ? USAGEMUX_UNAVAILABLE_EXIT_CODE
            : 1
        );
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
    .action((options) => {
      let selectedAgents: readonly AgentId[] = AGENT_IDS;
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

      const pass = rows.filter((row) => row.status === "PASS").length;
      const warn = rows.filter((row) => row.status === "WARN").length;
      const failRows = rows.filter((row) => row.status === "FAIL");
      console.log(`\nSummary: PASS ${pass}, WARN ${warn}, FAIL ${failRows.length}`);

      const warningRows = rows.filter((row) => row.warnings.length > 0);
      if (warningRows.length > 0) {
        console.log("\nWarning details:");
        for (const row of warningRows) {
          for (const warning of row.warnings) {
            console.log(`- ${row.agentId}: ${warning.replace(/^Warning:\s*/, "")}`);
          }
        }
      }

      const hasSandboxPreviewFlags = Boolean(
        options.sandboxTrust ||
          options.sandboxNoNet ||
          options.sandboxScrubEnv
      );
      if (options.showScode) {
        const previewAgents = rows
          .filter((row) => row.status !== "FAIL")
          .map((row) => row.agentId);
        const scodeRows = buildEffectiveScodeCommands(previewAgents, sandboxPolicyOverrides);
        console.log("\nEffective scode command preview (run+tui x autonomy):\n");
        console.log("| Agent | Autonomy | Mode | Command |");
        console.log("|-------|----------|------|---------|");
        for (const row of scodeRows) {
          const rendered = row.command
            .map(shellQuote)
            .join(" ");
          console.log(`| ${row.agentId} | ${row.autonomy} | ${row.mode} | \`${rendered}\` |`);
        }
      } else if (hasSandboxPreviewFlags) {
        console.warn("Warning: verify sandbox policy flags require --show-scode, ignoring");
      }

      if (failRows.length > 0) {
        console.log("\nFailure details:");
        for (const row of failRows) {
          for (const issue of row.issues) console.log(`- ${row.agentId}: ${issue}`);
        }
        setExitCode(1);
      }
    });

  program
    .command("list")
    .description("List available AI coding agents")
    .action(() => {
      console.log("Available agents:");
      for (const adapter of getAllAdapters()) {
        const status = adapter.isAvailable() ? "✅" : "❌";
        const caps = adapter.capabilities();
        const features: string[] = [];
        if (caps.supportsModel) features.push("model");
        if (caps.supportsAutonomy) features.push("autonomy");
        if (caps.supportsEffort) features.push("effort");
        const featureText = features.length > 0 ? ` [${features.join(", ")}]` : "";
        console.log(`  ${status} ${adapter.id}${featureText}`);
      }
    });

  program
    .command("doctor")
    .description("Check installed AI coding agents and configuration")
    .action(async () => {
      console.log("Checking AI coding agents...\n");
      if (configError) {
        console.log(`Configuration: ❌ ${configError.message}\n`);
        setExitCode(1);
      }
      let installed = 0;
      let missing = 0;

      for (const adapter of getAllAdapters()) {
        const available = adapter.isAvailable();
        const configurationIssues = available ? adapter.configurationIssues() : [];
        const status = !available
          ? "❌ not found"
          : configurationIssues.length > 0
            ? "⚠️ installed, configuration incomplete"
            : "✅ installed";
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
          for (const issue of configurationIssues) console.log(`  Configuration: ${issue}`);
        } else {
          missing++;
        }
        console.log();
      }

      const scode = await getScodeCompatibilityStatus();
      const scodeStatus = !scode.available
        ? "❌ not found (required only for --sandbox)"
        : scode.issue
          ? `⚠️ ${scode.issue}`
          : "✅ compatible";
      console.log(`scode (sandbox): ${scodeStatus}\n`);
      if (scode.issue) setExitCode(1);

      const usagemux = getUsagemuxStatus();
      const usageStatus = !usagemux.available
        ? "❌ not found (optional)"
        : usagemux.issue
          ? `⚠️ installed, unavailable: ${usagemux.issue}`
          : "✅ installed";
      console.log(`usagemux (optional usage): ${usageStatus}\n`);

      console.log(`Summary: ${installed} installed, ${missing} missing`);
      console.log(`\nDefault agent: ${config.defaultAgent}`);
      console.log("\nModel aliases available:");
      for (const [alias, mapping] of Object.entries(config.models)) {
        console.log(`  ${alias}: ${Object.keys(mapping).join(", ")}`);
      }
    });
}

import type { Command } from "commander";
import { getAllAdapters } from "./adapters/index.js";
import { AUTONOMY_EQUIVALENCE } from "./autonomy.js";
import { parseSandboxPolicyOverrides } from "./cli-runtime.js";
import { buildEffectiveScodeCommands, verifyAgentsWiring } from "./verify.js";
import { AGENT_IDS, type AdapterCapabilities, type AgentId, type CodemuxConfig } from "./types.js";
import { SESSION_AGENTS } from "./session/cli.js";
import { runMachineCheck, type MachineCheckReport } from "./doctor-machine-check.js";
import { renderMachineCheckHuman, renderMachineCheckJson } from "./doctor-report.js";
import {
  fetchUsageSnapshot,
  formatUsageSnapshot,
  getUsagemuxStatus,
  parseUsageTimeoutOption,
  UsageIntegrationUnavailableError,
  USAGEMUX_UNAVAILABLE_EXIT_CODE,
} from "./usage.js";
import { escapeJsonControls } from "./labels.js";

/** The `tools` label with the condition the adapter enforces on `--tools none`. */
function toolsLabel(caps: AdapterCapabilities): string {
  if (caps.toolsNoneRequiresHermetic) return "tools(hermetic)";
  if (caps.toolsNoneRequiresReadOnly || caps.isolationRequiresReadOnly) return "tools(read-only)";
  return "tools";
}
import { EXPERIMENT_MCP_HARNESSES } from "./experiment-mcp.js";
import { SERVED_MODEL_EVIDENCE_HARNESSES } from "./result-envelope/index.js";
import { UsageRefusalError, USAGE_REFUSAL_EXIT_CODE } from "./validation.js";

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
    .option("--all", "Query all agents, agy included (the no-agent default excludes agy, whose probe is slow)")
    .option("--json", "Emit the validated usagemux JSON response")
    .option("--timeout <seconds>", "Maximum usage query time in seconds", "30")
    .action(async (options) => {
      if (options.agent && options.all) {
        console.error("Error: --agent and --all cannot be used together");
        setExitCode(USAGE_REFUSAL_EXIT_CODE);
        return;
      }
      const agent = options.agent as string | undefined;
      if (agent !== undefined && !AGENT_IDS.includes(agent as AgentId)) {
        console.error(`Error: Unknown agent '${agent}'`);
        console.error(`Available agents: ${AGENT_IDS.join(", ")}`);
        setExitCode(USAGE_REFUSAL_EXIT_CODE);
        return;
      }
      try {
        // Caller mistakes are judged before the environment: a bad
        // --timeout exits 64 whatever usagemux's state (round 28, edges 6).
        const timeoutMs = parseUsageTimeoutOption(options.timeout);
        // An untrusted usagemux binary is the same integration failure as an
        // absent one (69), not a generic error: the operator fixes both the
        // same way, by installing or repairing usagemux.
        const status = getUsagemuxStatus();
        if (status.issue !== null) {
          throw new UsageIntegrationUnavailableError(status.issue);
        }
        // agy is excluded from the default set, mirroring usagemux's own
        // DEFAULT_CLIENTS: its probe can take up to 90 seconds, so a bare
        // `codemux usage` stays fast. `-a agy` and `--all` include it.
        const clients: readonly AgentId[] = agent
          ? [agent as AgentId]
          : options.all
            ? AGENT_IDS
            : AGENT_IDS.filter((id) => id !== "agy");
        const snapshot = await fetchUsageSnapshot(clients, timeoutMs);
        // A nonzero usagemux exit never reaches here (fetchUsageSnapshot
        // treats it as an unreadable query); 69 stays reserved for the
        // integration being absent or untrusted.
        console.log(
          options.json
            ? escapeJsonControls(JSON.stringify(snapshot, null, 2))
            : formatUsageSnapshot(snapshot)
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        setExitCode(
          error instanceof UsageIntegrationUnavailableError
            ? USAGEMUX_UNAVAILABLE_EXIT_CODE
            : error instanceof UsageRefusalError
              ? USAGE_REFUSAL_EXIT_CODE
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
          setExitCode(USAGE_REFUSAL_EXIT_CODE);
          return;
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
    .option("--json", "Print the machine-readable listing (schema codemux-list-1)")
    .action((options: { json?: boolean }) => {
      if (options.json) {
        // The machine-readable spelling of the same facts the human lines
        // print: which agents exist, which are installed here, and the
        // capability booleans a caller outside this checkout needs (the
        // release gate reads it to build its probe matrix from a candidate
        // build, scripts/live-gate/candidate.ts).
        const agents = getAllAdapters().map((adapter) => {
          const caps = adapter.capabilities();
          return {
            id: adapter.id,
            available: adapter.isAvailable(),
            // The binary name the candidate's own resolution uses: the
            // release gate resolves the contract column through the
            // candidate's listing, not this checkout's adapters (round
            // 19, edges 4).
            binary: adapter.binaryName,
            capabilities: {
              hermetic: caps.supportsHermetic === true,
              resultJson: caps.supportsResultJson === true,
              toolsNoneRequiresHermetic: caps.toolsNoneRequiresHermetic === true,
              toolsNoneRequiresReadOnly: caps.toolsNoneRequiresReadOnly === true || caps.isolationRequiresReadOnly === true,
              isolationRequiresReadOnly: caps.isolationRequiresReadOnly === true,
              effortLevels: caps.supportsEffort === true ? [...caps.effortLevels] : null,
              providerOverride: caps.supportsProviderOverride === true,
              // The -m and --effort declarations feed the release gate's
              // alias+effort probe (scripts/live-gate/run.ts, probe I), so
              // a candidate build's I probe set describes the candidate.
              model: caps.supportsModel === true,
              effort: caps.supportsEffort === true,
              sessions: SESSION_AGENTS[adapter.id] !== undefined,
              // The experiment-MCP mechanism and the served-model evidence
              // come from the src tables that own them (review round 20,
              // edges finding 2): a candidate build declares its own facts
              // here, and the release gate's G and H probe sets come from
              // the listing rather than the probing checkout's tables.
              experimentMcp: EXPERIMENT_MCP_HARNESSES[adapter.id] !== undefined,
              experimentPrefix: EXPERIMENT_MCP_HARNESSES[adapter.id]?.[0] ?? null,
              servedModelEvidence: SERVED_MODEL_EVIDENCE_HARNESSES.has(adapter.id),
            },
          };
        });
        console.log(JSON.stringify({ schema: "codemux-list-1", agents }));
        return;
      }
      console.log("Available agents:");
      for (const adapter of getAllAdapters()) {
        const status = adapter.isAvailable() ? "✅" : "❌";
        const caps = adapter.capabilities();
        const features: string[] = [];
        if (caps.supportsModel) features.push("model");
        if (caps.supportsAutonomy) features.push("autonomy");
        if (caps.supportsEffort) features.push("effort");
        // A label carries its condition, so a workflow reading `list`
        // does not send a combination the launch refuses (audit A9).
        if (caps.supportsHermetic) features.push(caps.isolationRequiresReadOnly ? "hermetic(read-only)" : "hermetic");
        if (caps.supportsToolSelection) features.push(toolsLabel(caps));
        if (caps.supportsProviderOverride) features.push("provider");
        if (caps.supportsResultJson) features.push("result-json");
        if (SESSION_AGENTS[adapter.id] !== undefined) features.push("sessions");
        const featureText = features.length > 0 ? ` [${features.join(", ")}]` : "";
        console.log(`  ${status} ${adapter.id}${featureText}`);
      }
    });

  program
    .command("doctor")
    .description("Machine health check: every installed harness, the environment, and the configuration, without model requests")
    .option("--format <format>", "Output format: text (default) or json (schema codemux-doctor-1)")
    .option("--spend", "Paid stage: one real codemux check request per eligible harness, labeled machine-check=<date>")
    .option("--spend-cap <n>", "At most n spend probes (default: one per eligible harness)")
    .option("--spend-unreadable", "Spend on harnesses whose usage row is unreadable too")
    .option("--only <agents>", "Check only these agents (comma-separated)")
    .option("--skip <agents>", "Skip these agents (comma-separated)")
    .option("--timeout <seconds>", "Per-probe bound in seconds for one version verdict", "10")
    .option("--strict", "Treat warnings as broken for the exit code")
    .option("--capabilities", "Print only the per-harness capabilities block (the pre-2.0 output)")
    .action(async (options) => {
      // A bad --format is refused before the check runs: with --spend the
      // check would otherwise complete paid probes first (review round 41).
      if (options.format !== undefined && options.format !== "text" && options.format !== "json") {
        console.error("Error: --format must be 'text' or 'json'");
        setExitCode(USAGE_REFUSAL_EXIT_CODE);
        return;
      }
      let report: MachineCheckReport;
      try {
        report = await runMachineCheck(config, configError, {
          spend: Boolean(options.spend),
          spendCap:
            options.spendCap !== undefined ? Number(options.spendCap) : undefined,
          spendUnreadable: Boolean(options.spendUnreadable),
          only: options.only !== undefined ? [options.only] : undefined,
          skip: options.skip !== undefined ? [options.skip] : undefined,
          timeoutSeconds: Number(options.timeout),
          strict: Boolean(options.strict),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        setExitCode(error instanceof UsageRefusalError ? USAGE_REFUSAL_EXIT_CODE : 1);
        return;
      }
      if (options.format === "json") {
        console.log(renderMachineCheckJson(report));
        setExitCode(report.exitCode);
        return;
      }
      if (!options.capabilities) {
        console.log(renderMachineCheckHuman(report));
        console.log();
      }
      // The capabilities block: the pre-2.0 per-harness detail, kept as
      // the trailing block so an operator diffing old output still finds
      // it. The version line reuses the health table's verdict — one
      // probe per binary per doctor run, not two. A filtered report
      // (--only/--skip) prints only the harnesses it checked, so an
      // unchecked one never shows "no contract" for a contract it has.
      const contractById = new Map(report.harnesses.map((row) => [row.id, row.checks.contract]));
      const selected = new Set(
        report.harnesses.filter((row) => row.installed).map((row) => row.id)
      );
      console.log("Harness details:");
      for (const adapter of getAllAdapters()) {
        if (!selected.has(adapter.id)) continue;
        const available = adapter.isAvailable();
        if (!available) continue;
        const configurationIssues = adapter.configurationIssues();
        const status = configurationIssues.length > 0 ? "⚠️ installed, configuration incomplete" : "✅ installed";
        console.log(`\n${adapter.id} (${adapter.displayName}): ${status}`);
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
        console.log(`  Hermetic runs: ${caps.supportsHermetic ? "yes" : "no"}`);
        console.log(`  Tool selection: ${caps.supportsToolSelection ? "yes" : "no"}`);
        console.log(`  Provider override: ${caps.supportsProviderOverride ? "yes" : "no"}`);
        console.log(`  Result JSON: ${caps.supportsResultJson ? "yes" : "no"}`);
        console.log(`  Sessions: ${SESSION_AGENTS[adapter.id] !== undefined ? "yes" : "no"}`);
        console.log(`  Version contract: ${contractById.get(adapter.id) ?? "no contract"}`);
        for (const issue of configurationIssues) console.log(`  Configuration: ${issue}`);
      }
      console.log(`\nDefault agent: ${config.defaultAgent}`);
      console.log("Model aliases available:");
      for (const [alias, mapping] of Object.entries(config.models)) {
        console.log(`  ${alias}: ${Object.keys(mapping).join(", ")}`);
      }
      setExitCode(report.exitCode);
    });
}

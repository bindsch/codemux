import { getAdapter } from "./adapters/index.js";
import { AUTONOMY_EQUIVALENCE } from "./autonomy.js";
import {
  resolveSandboxOptionsForAgent,
  type SandboxPolicyOverrides,
} from "./sandbox-policy.js";
import { buildScodeCommand } from "./sandbox.js";
import {
  AUTONOMY_LEVELS,
  type AgentId,
  type RunRequest,
} from "./types.js";

export type VerificationStatus = "PASS" | "WARN" | "FAIL";

export interface VerificationResult {
  agentId: AgentId;
  installed: boolean;
  mappingOk: boolean;
  runBuildOk: boolean;
  tuiBuildOk: boolean;
  warningCount: number;
  warnings: string[];
  status: VerificationStatus;
  issues: string[];
}

export interface EffectiveScodeCommand {
  agentId: AgentId;
  autonomy: (typeof AUTONOMY_LEVELS)[number];
  mode: "run" | "tui";
  command: string[];
}

function commandIsValid(cmd: string[]): boolean {
  return (
    Array.isArray(cmd) &&
    cmd.length > 0 &&
    cmd.every((part) => typeof part === "string" && part.length > 0)
  );
}

function captureWarnings<T>(fn: () => T): { value: T; warnings: string[] } {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function verifyMapping(agentId: AgentId, issues: string[]): boolean {
  const mapping = AUTONOMY_EQUIVALENCE[agentId];
  if (!mapping) {
    issues.push("missing AUTONOMY_EQUIVALENCE entry");
    return false;
  }

  let ok = true;
  for (const level of AUTONOMY_LEVELS) {
    const value = mapping.byLevel[level];
    if (typeof value !== "string" || value.trim().length === 0) {
      issues.push(`missing mapping for autonomy level '${level}'`);
      ok = false;
    }
  }

  return ok;
}

function verifyRunBuilds(agentId: AgentId, issues: string[]): { ok: boolean; warnings: string[] } {
  const adapter = getAdapter(agentId);
  const caps = adapter.capabilities();

  try {
    const { warnings } = captureWarnings(() => {
      for (const autonomy of AUTONOMY_LEVELS) {
        const sandboxed = adapter.requiresSandboxForAutonomy(autonomy);
        const req: RunRequest = {
          agent: agentId,
          prompt: "verify",
          autonomy,
          sandboxed,
        };
        adapter.validateRunRequest(req);
        const normalCmd = adapter.buildRunCommand(req);
        if (!commandIsValid(normalCmd)) {
          throw new Error(`invalid run command for autonomy='${autonomy}'`);
        }

        const sandboxedRequest = { ...req, sandboxed: true };
        adapter.validateRunRequest(sandboxedRequest);
        const sandboxedCmd = adapter.buildRunCommand(sandboxedRequest);
        if (!commandIsValid(sandboxedCmd)) {
          throw new Error(`invalid sandboxed run command for autonomy='${autonomy}'`);
        }
      }

      if (caps.supportsModel) {
        const modelRequest: RunRequest = {
          agent: agentId,
          prompt: "verify",
          model: "verify-model",
          autonomy: "low",
          sandboxed: adapter.requiresSandboxForAutonomy("low"),
        };
        adapter.validateRunRequest(modelRequest);
        const modelCmd = adapter.buildRunCommand(modelRequest);
        if (!commandIsValid(modelCmd)) {
          throw new Error("invalid run command with model");
        }
      }

      if (caps.supportsEffort) {
        for (const effort of caps.effortLevels) {
          const effortRequest: RunRequest = {
            agent: agentId,
            prompt: "verify",
            autonomy: "low",
            effort,
            sandboxed: adapter.requiresSandboxForAutonomy("low"),
          };
          adapter.validateRunRequest(effortRequest);
          const effortCmd = adapter.buildRunCommand(effortRequest);
          if (!commandIsValid(effortCmd)) {
            throw new Error(`invalid run command with effort='${effort}'`);
          }
        }
      }
    });

    return { ok: true, warnings };
  } catch (error) {
    issues.push(`run command generation failed: ${error}`);
    return { ok: false, warnings: [] };
  }
}

function verifyTuiBuilds(agentId: AgentId, issues: string[]): { ok: boolean; warnings: string[] } {
  const adapter = getAdapter(agentId);
  const caps = adapter.capabilities();

  try {
    const { warnings } = captureWarnings(() => {
      for (const autonomy of AUTONOMY_LEVELS) {
        const effort = adapter.supportsTuiEffort() && caps.effortLevels.includes("low")
          ? "low"
          : undefined;
        const sandboxed = adapter.requiresSandboxForTuiAutonomy(autonomy);
        adapter.validateTuiRequest(undefined, process.cwd(), autonomy, effort);
        const normalCmd = adapter.buildTuiCommand(undefined, autonomy, effort, sandboxed);
        if (!commandIsValid(normalCmd)) {
          throw new Error(`invalid tui command for autonomy='${autonomy}'`);
        }

        const sandboxedCmd = adapter.buildTuiCommand(undefined, autonomy, effort, true);
        if (!commandIsValid(sandboxedCmd)) {
          throw new Error(`invalid sandboxed tui command for autonomy='${autonomy}'`);
        }
      }

      if (caps.supportsModel) {
        if (!adapter.supportsTuiModel()) return;
        const effort = adapter.supportsTuiEffort() && caps.effortLevels.includes("low")
          ? "low"
          : undefined;
        adapter.validateTuiRequest("verify-model", process.cwd(), "low", effort);
        const modelCmd = adapter.buildTuiCommand(
          "verify-model",
          "low",
          effort,
          adapter.requiresSandboxForTuiAutonomy("low")
        );
        if (!commandIsValid(modelCmd)) {
          throw new Error("invalid tui command with model");
        }
      }
    });

    return { ok: true, warnings };
  } catch (error) {
    issues.push(`tui command generation failed: ${error}`);
    return { ok: false, warnings: [] };
  }
}

function classifyStatus(
  installed: boolean,
  mappingOk: boolean,
  runBuildOk: boolean,
  tuiBuildOk: boolean,
  warningCount: number
): VerificationStatus {
  if (!mappingOk || !runBuildOk || !tuiBuildOk) {
    return "FAIL";
  }
  return installed && warningCount === 0 ? "PASS" : "WARN";
}

export function verifyAgentWiring(agentId: AgentId): VerificationResult {
  const issues: string[] = [];
  const adapter = getAdapter(agentId);
  const installed = adapter.isAvailable();

  const mappingOk = verifyMapping(agentId, issues);
  const runResult = verifyRunBuilds(agentId, issues);
  const tuiResult = verifyTuiBuilds(agentId, issues);
  const warnings = [...new Set([...runResult.warnings, ...tuiResult.warnings])];
  const warningCount = warnings.length;
  const status = classifyStatus(
    installed,
    mappingOk,
    runResult.ok,
    tuiResult.ok,
    warningCount
  );

  return {
    agentId,
    installed,
    mappingOk,
    runBuildOk: runResult.ok,
    tuiBuildOk: tuiResult.ok,
    warningCount,
    warnings,
    status,
    issues,
  };
}

export function verifyAgentsWiring(agentIds: readonly AgentId[]): VerificationResult[] {
  return agentIds.map((agentId) => verifyAgentWiring(agentId));
}

export function buildEffectiveScodeCommands(
  agentIds: readonly AgentId[],
  overrides: SandboxPolicyOverrides = {}
): EffectiveScodeCommand[] {
  const rows: EffectiveScodeCommand[] = [];

  for (const agentId of agentIds) {
    const adapter = getAdapter(agentId);
    const caps = adapter.capabilities();

    for (const autonomy of AUTONOMY_LEVELS) {
      const effort = caps.supportsEffort ? "low" : undefined;
      const sandboxOptions = resolveSandboxOptionsForAgent(agentId, autonomy, overrides);

      const runRequest: RunRequest = {
        agent: agentId,
        prompt: "verify",
        autonomy,
        sandboxed: true,
      };
      const runCmd = captureWarnings(() => adapter.buildRunCommand(runRequest)).value;
      rows.push({
        agentId,
        autonomy,
        mode: "run",
        command: buildScodeCommand(runCmd, undefined, autonomy, sandboxOptions),
      });

      const tuiCmd = captureWarnings(() =>
        adapter.buildTuiCommand(undefined, autonomy, effort, true)
      ).value;
      rows.push({
        agentId,
        autonomy,
        mode: "tui",
        command: buildScodeCommand(tuiCmd, undefined, autonomy, sandboxOptions),
      });
    }
  }

  return rows;
}

import { getAdapter } from "./adapters/index.js";
import { AUTONOMY_EQUIVALENCE } from "./autonomy.js";
import {
  resolveSandboxOptionsForAgent,
  type SandboxPolicyOverrides,
} from "./sandbox-policy.js";
import { buildScodeCommand } from "./sandbox.js";
import {
  AUTONOMY_LEVELS,
  REASONING_EFFORT_LEVELS,
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
  return Array.isArray(cmd) && cmd.length > 0 && typeof cmd[0] === "string" && cmd[0].length > 0;
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

function verifyRunBuilds(agentId: AgentId, issues: string[]): { ok: boolean; warningCount: number } {
  const adapter = getAdapter(agentId);
  const caps = adapter.capabilities();

  try {
    const { warnings } = captureWarnings(() => {
      for (const autonomy of AUTONOMY_LEVELS) {
        const req: RunRequest = {
          agent: agentId,
          prompt: "verify",
          autonomy,
          sandboxed: false,
        };
        const normalCmd = adapter.buildRunCommand(req);
        if (!commandIsValid(normalCmd)) {
          throw new Error(`invalid run command for autonomy='${autonomy}'`);
        }

        const sandboxedCmd = adapter.buildRunCommand({ ...req, sandboxed: true });
        if (!commandIsValid(sandboxedCmd)) {
          throw new Error(`invalid sandboxed run command for autonomy='${autonomy}'`);
        }
      }

      if (caps.supportsModel) {
        const modelCmd = adapter.buildRunCommand({
          agent: agentId,
          prompt: "verify",
          model: "verify-model",
          autonomy: "low",
          sandboxed: false,
        });
        if (!commandIsValid(modelCmd)) {
          throw new Error("invalid run command with model");
        }
      }

      if (caps.supportsEffort) {
        for (const effort of REASONING_EFFORT_LEVELS) {
          const effortCmd = adapter.buildRunCommand({
            agent: agentId,
            prompt: "verify",
            autonomy: "low",
            effort,
            sandboxed: false,
          });
          if (!commandIsValid(effortCmd)) {
            throw new Error(`invalid run command with effort='${effort}'`);
          }
        }
      }
    });

    return { ok: true, warningCount: warnings.length };
  } catch (error) {
    issues.push(`run command generation failed: ${error}`);
    return { ok: false, warningCount: 0 };
  }
}

function verifyTuiBuilds(agentId: AgentId, issues: string[]): { ok: boolean; warningCount: number } {
  const adapter = getAdapter(agentId);
  const caps = adapter.capabilities();

  try {
    const { warnings } = captureWarnings(() => {
      for (const autonomy of AUTONOMY_LEVELS) {
        const effort = caps.supportsEffort ? "low" : undefined;
        const normalCmd = adapter.buildTuiCommand(undefined, autonomy, effort, false);
        if (!commandIsValid(normalCmd)) {
          throw new Error(`invalid tui command for autonomy='${autonomy}'`);
        }

        const sandboxedCmd = adapter.buildTuiCommand(undefined, autonomy, effort, true);
        if (!commandIsValid(sandboxedCmd)) {
          throw new Error(`invalid sandboxed tui command for autonomy='${autonomy}'`);
        }
      }

      if (caps.supportsModel) {
        const modelCmd = adapter.buildTuiCommand("verify-model", "low", caps.supportsEffort ? "low" : undefined, false);
        if (!commandIsValid(modelCmd)) {
          throw new Error("invalid tui command with model");
        }
      }
    });

    return { ok: true, warningCount: warnings.length };
  } catch (error) {
    issues.push(`tui command generation failed: ${error}`);
    return { ok: false, warningCount: 0 };
  }
}

function classifyStatus(
  installed: boolean,
  mappingOk: boolean,
  runBuildOk: boolean,
  tuiBuildOk: boolean
): VerificationStatus {
  if (!mappingOk || !runBuildOk || !tuiBuildOk) {
    return "FAIL";
  }
  return installed ? "PASS" : "WARN";
}

export function verifyAgentWiring(agentId: AgentId): VerificationResult {
  const issues: string[] = [];
  const adapter = getAdapter(agentId);
  const installed = adapter.isAvailable();

  const mappingOk = verifyMapping(agentId, issues);
  const runResult = verifyRunBuilds(agentId, issues);
  const tuiResult = verifyTuiBuilds(agentId, issues);
  const status = classifyStatus(installed, mappingOk, runResult.ok, tuiResult.ok);

  return {
    agentId,
    installed,
    mappingOk,
    runBuildOk: runResult.ok,
    tuiBuildOk: tuiResult.ok,
    warningCount: runResult.warningCount + tuiResult.warningCount,
    status,
    issues,
  };
}

export function verifyAgentsWiring(agentIds: AgentId[]): VerificationResult[] {
  return agentIds.map((agentId) => verifyAgentWiring(agentId));
}

export function buildEffectiveScodeCommands(
  agentIds: AgentId[],
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

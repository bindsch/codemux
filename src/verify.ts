import { lstatSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// Static wiring checks must not depend on what happens to sit in the
// checker's own working directory: an adapter that (correctly) refuses
// repository-local executable configuration would otherwise report its
// wiring as broken whenever the checker itself runs inside such a repo —
// including this one, whose own hook shim lives in .claude/settings.json.
// So command building runs in a neutral scratch cwd instead of process.cwd().
//
// Root selection, per platform: on macOS, the per-user confstr temp
// (getconf DARWIN_USER_TEMP_DIR) — its ancestors are root-owned, so no other
// local user can plant executable configuration above the scratch dir, and
// it ignores a repointed TMPDIR. Elsewhere POSIX falls back to /tmp; there a
// same-machine user could pre-create or plant inside the scratch dir, so we
// verify we own it (below) and otherwise use a fresh mkdtemp. Windows uses
// tmpdir() and makes no immunity guarantee (scode is not a Windows boundary
// in practice). Resolved lazily so a plain `codemux run`/`tui` never spawns
// getconf — only `verify` builds commands.
function platformTempRoot(): string {
  if (process.platform === "darwin") {
    const proc = Bun.spawnSync(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 2000,
    });
    if (proc.exitCode === 0) {
      const dir = proc.stdout.toString().trim();
      if (dir.length > 0) return dir;
    }
    return "/tmp";
  }
  return process.platform === "win32" ? tmpdir() : "/tmp";
}

// A per-user scratch directory reused across invocations. Nothing but an
// empty `.git` marker is ever written into it (it is only a cwd for command
// building), so reuse means no accumulation and no cleanup to leak when exit
// handlers do not fire (Bun's test workers skip them). If the fixed path
// exists but is not owned by us (a foreign plant on the shared /tmp
// fallback), a fresh private mkdtemp is used instead, so the cwd is always
// one we control.
//
// The marker matters: the adapters' project-configuration walker climbs from
// the cwd to the nearest `.git`, so without it every ancestor of the scratch
// dir is inspected too, and the user's own temp root is not neutral — a
// Claude Code session started in $TMPDIR leaves a `.claude/settings.local.json`
// there, which made `verify` report Copilot's wiring as broken. An empty
// `.git` directory ends the walk at the scratch dir itself.
let neutralCwd: string | null = null;
export function verificationCwd(): string {
  if (neutralCwd === null) {
    const root = platformTempRoot();
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const fixed = join(root, `codemux-verify-${uid ?? "u"}`);
    let dir = fixed;
    try {
      mkdirSync(fixed, { recursive: true, mode: 0o700 });
      // lstat, not stat: a symlink planted at the fixed path (on the shared
      // /tmp fallback) must be rejected, not followed to a directory the
      // attacker happens to own. Require a real, self-owned directory.
      const st = lstatSync(fixed);
      if (!st.isDirectory() || (uid !== null && st.uid !== uid)) {
        dir = mkdtempSync(join(root, "codemux-verify-"));
      }
    } catch {
      dir = mkdtempSync(join(root, "codemux-verify-"));
    }
    mkdirSync(join(dir, ".git"), { recursive: true, mode: 0o700 });
    neutralCwd = dir;
  }
  return neutralCwd;
}

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

// The one legitimate empty argument is the value of `--tools` (an empty
// list removes Claude's tools); any other empty argument is a wiring bug.
function commandIsValid(cmd: string[]): boolean {
  return (
    Array.isArray(cmd) &&
    cmd.length > 0 &&
    typeof cmd[0] === "string" &&
    cmd[0].length > 0 &&
    cmd.every(
      (part, index) =>
        typeof part === "string" && (part.length > 0 || cmd[index - 1] === "--tools")
    )
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
          cwd: verificationCwd(),
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
          cwd: verificationCwd(),
          sandboxed: adapter.requiresSandboxForAutonomy("low"),
        };
        adapter.validateRunRequest(modelRequest);
        const modelCmd = adapter.buildRunCommand(modelRequest);
        if (!commandIsValid(modelCmd)) {
          throw new Error("invalid run command with model");
        }
      }

      if (caps.supportsHermetic) {
        // Static only: the private home and the live canary belong to
        // `check --hermetic`, so nothing here calls getRunEnv.
        const hermeticRequest: RunRequest = {
          agent: agentId,
          prompt: "verify",
          autonomy: "read-only",
          cwd: verificationCwd(),
          sandboxed: true,
          hermetic: true,
          tools: caps.supportsToolSelection ? "none" : "default",
        };
        adapter.validateRunRequest(hermeticRequest);
        if (!commandIsValid(adapter.buildRunCommand(hermeticRequest))) {
          throw new Error("invalid hermetic run command");
        }
      }

      if (caps.supportsEffort) {
        for (const effort of caps.effortLevels) {
          const effortRequest: RunRequest = {
            cwd: verificationCwd(),
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
        adapter.validateTuiRequest(undefined, verificationCwd(), autonomy, effort);
        const normalCmd = adapter.buildTuiCommand(
          undefined,
          autonomy,
          effort,
          sandboxed,
          false,
          verificationCwd()
        );
        if (!commandIsValid(normalCmd)) {
          throw new Error(`invalid tui command for autonomy='${autonomy}'`);
        }

        const sandboxedCmd = adapter.buildTuiCommand(
          undefined,
          autonomy,
          effort,
          true,
          false,
          verificationCwd()
        );
        if (!commandIsValid(sandboxedCmd)) {
          throw new Error(`invalid sandboxed tui command for autonomy='${autonomy}'`);
        }
      }

      if (caps.supportsModel) {
        if (!adapter.supportsTuiModel()) return;
        const effort = adapter.supportsTuiEffort() && caps.effortLevels.includes("low")
          ? "low"
          : undefined;
        adapter.validateTuiRequest("verify-model", verificationCwd(), "low", effort);
        const modelCmd = adapter.buildTuiCommand(
          "verify-model",
          "low",
          effort,
          adapter.requiresSandboxForTuiAutonomy("low"),
          false,
          verificationCwd()
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
        cwd: verificationCwd(),
      };
      const runCmd = captureWarnings(() => adapter.buildRunCommand(runRequest)).value;
      rows.push({
        agentId,
        autonomy,
        mode: "run",
        command: buildScodeCommand(runCmd, undefined, autonomy, sandboxOptions),
      });

      const tuiCmd = captureWarnings(() =>
        adapter.buildTuiCommand(undefined, autonomy, effort, true, false, verificationCwd())
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

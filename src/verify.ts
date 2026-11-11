import { chmodSync, lstatSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAdapter } from "./adapters/index.js";
import { AUTONOMY_EQUIVALENCE } from "./autonomy.js";
import {
  resolveSandboxOptionsForAgent,
  type SandboxPolicyOverrides,
} from "./sandbox-policy.js";
import { verifiedScodeCommand } from "./verify-scode.js";
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
  if (neutralCwd === null) neutralCwd = scratchCwdUnder(platformTempRoot());
  return neutralCwd;
}

/** The scratch-directory rule at one root, split out so tests can drive a
 * private tree. The fixed name's mode is stated after creation (the umask
 * would otherwise leave a directory the marker cannot be created in), and
 * its identity is revalidated after the marker lands: between the trusted
 * lstat and the marker's mkdir, a same-uid writer with access to the root
 * can swap the name for a symlink and receive the marker — or the run's
 * cwd — through it (review round 401, item 10). A changed identity
 * refuses the reused name and a fresh mkdtemp is used; the residual is an
 * empty marker planted through the link ahead of the revalidation. */
export function scratchCwdUnder(root: string): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const fixed = join(root, `codemux-verify-${uid ?? "u"}`);
  const fresh = (): string => {
    const dir = mkdtempSync(join(root, "codemux-verify-"));
    chmodSync(dir, 0o700); // stated whatever the umask is
    mkdirSync(join(dir, ".git"), { recursive: true, mode: 0o700 });
    return dir;
  };
  try {
    let existed = true;
    try {
      lstatSync(fixed);
    } catch {
      existed = false;
    }
    mkdirSync(fixed, { recursive: true, mode: 0o700 });
    // lstat, not stat: a symlink planted at the fixed path (on the shared
    // /tmp fallback) must be rejected, not followed to a directory the
    // attacker happens to own. Require a real, self-owned directory.
    const trusted = lstatSync(fixed);
    if (!trusted.isDirectory() || (uid !== null && trusted.uid !== uid)) return fresh();
    // The mode is stated only for a directory this call created: an
    // existing one keeps the permissions it has.
    if (!existed) chmodSync(fixed, 0o700);
    mkdirSync(join(fixed, ".git"), { recursive: true, mode: 0o700 });
    const after = lstatSync(fixed);
    if (after.dev !== trusted.dev || after.ino !== trusted.ino) return fresh();
    return fixed;
  } catch {
    return fresh();
  }
}

// The environment half of static neutrality: verificationCwd pins the
// working directory, this pins the environment. An exported
// CODEMUX_CURSOR_ENTRY=cursor selects cursor's desktop entry on the launch
// path — and, lacking the argv authorization of --pass-env, launch
// validation refuses it. Verify builds those same commands, so inheriting
// the operator's shell made a plain `codemux verify` report cursor's
// wiring as broken while a real launch with the passthrough worked. Every
// adapter verify consults receives only PATH: installation checks and
// default entry selection still see installed binaries, while provider
// overrides and per-launch opt-ins cannot change the wiring result.
function staticWiringEnv(): Record<string, string | undefined> {
  return { PATH: process.env.PATH };
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
  error?: string;
}

// The legitimate empty arguments are the value of `--tools` (an empty
// list removes Claude's tools) and gemini's `-p ""` (the empty flag selects
// headless mode while the prompt rides stdin, src/adapters/gemini.ts); any
// other empty argument is a wiring bug.
const EMPTY_VALUE_FLAGS: Readonly<Partial<Record<AgentId, readonly string[]>>> = { gemini: ["-p"] };

function commandIsValid(cmd: string[], agentId: AgentId): boolean {
  const emptyValueFlags = ["--tools", ...(EMPTY_VALUE_FLAGS[agentId] ?? [])];
  return (
    Array.isArray(cmd) &&
    cmd.length > 0 &&
    typeof cmd[0] === "string" &&
    cmd[0].length > 0 &&
    cmd.every(
      (part, index) =>
        typeof part === "string" && (part.length > 0 || emptyValueFlags.includes(cmd[index - 1] ?? ""))
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
  const adapter = getAdapter(agentId, staticWiringEnv());
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
        if (!commandIsValid(normalCmd, agentId)) {
          throw new Error(`invalid run command for autonomy='${autonomy}'`);
        }

        const sandboxedRequest = { ...req, sandboxed: true };
        adapter.validateRunRequest(sandboxedRequest);
        const sandboxedCmd = adapter.buildRunCommand(sandboxedRequest);
        if (!commandIsValid(sandboxedCmd, agentId)) {
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
        if (!commandIsValid(modelCmd, agentId)) {
          throw new Error("invalid run command with model");
        }
      }

      if (caps.supportsHermetic) {
        // Static only: the private home and the live canary belong to
        // `check --hermetic`, so nothing here calls getRunEnv.
        // A hermetic run whose contract requires the provider override
        // (goose, openhands — the capability flag) is built against a
        // SYNTHETIC trio, the same fixture style as "verify-model"
        // above: staticWiringEnv keeps the operator's exports out, and
        // without an override the adapter's own fail-closed refusal
        // would answer here, so the hermetic argv would never be built
        // statically at all (the wiring gap the 2.0.0 parity merge
        // surfaced).
        const hermeticEnv = caps.hermeticRequiresProviderOverride
          ? {
              ...staticWiringEnv(),
              [`CODEMUX_${agentId.toUpperCase()}_PROVIDER_BASE_URL`]: "https://verify.invalid",
              [`CODEMUX_${agentId.toUpperCase()}_PROVIDER_API_KEY`]: "verify-key",
              [`CODEMUX_${agentId.toUpperCase()}_PROVIDER_MODEL`]: "verify-model",
            }
          : staticWiringEnv();
        const hermeticAdapter = getAdapter(agentId, hermeticEnv);
        const hermeticRequest: RunRequest = {
          agent: agentId,
          prompt: "verify",
          autonomy: "read-only",
          cwd: verificationCwd(),
          sandboxed: true,
          hermetic: true,
          tools: caps.supportsToolSelection ? "none" : "default",
        };
        hermeticAdapter.validateRunRequest(hermeticRequest);
        if (!commandIsValid(hermeticAdapter.buildRunCommand(hermeticRequest), agentId)) {
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
          if (!commandIsValid(effortCmd, agentId)) {
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

// OpenCode's TUI stores the effort variant per provider/model, so its TUI
// effort needs an explicit provider/model selector (src/opencode-tui-effort.ts).
// The model-free TUI builds carry no effort for it; the model build below
// carries both.
const TUI_EFFORT_NEEDS_MODEL: ReadonlySet<AgentId> = new Set(["opencode"]);
// A provider/model selector every adapter's TUI accepts.
const TUI_MODEL_FIXTURE = "verify-provider/verify-model";

function verifyTuiBuilds(agentId: AgentId, issues: string[]): { ok: boolean; warnings: string[] } {
  const adapter = getAdapter(agentId, staticWiringEnv());
  const caps = adapter.capabilities();

  try {
    const { warnings } = captureWarnings(() => {
      for (const autonomy of AUTONOMY_LEVELS) {
        const effort = adapter.supportsTuiEffort() && caps.effortLevels.includes("low") &&
          !TUI_EFFORT_NEEDS_MODEL.has(agentId)
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
        if (!commandIsValid(normalCmd, agentId)) {
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
        if (!commandIsValid(sandboxedCmd, agentId)) {
          throw new Error(`invalid sandboxed tui command for autonomy='${autonomy}'`);
        }
      }

      if (caps.supportsModel) {
        if (!adapter.supportsTuiModel()) return;
        const effort = adapter.supportsTuiEffort() && caps.effortLevels.includes("low")
          ? "low"
          : undefined;
        adapter.validateTuiRequest(TUI_MODEL_FIXTURE, verificationCwd(), "low", effort);
        const modelCmd = adapter.buildTuiCommand(
          TUI_MODEL_FIXTURE,
          "low",
          effort,
          adapter.requiresSandboxForTuiAutonomy("low"),
          false,
          verificationCwd()
        );
        if (!commandIsValid(modelCmd, agentId)) {
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
  const adapter = getAdapter(agentId, staticWiringEnv());
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
    const adapter = getAdapter(agentId, staticWiringEnv());
    const caps = adapter.capabilities();

    for (const autonomy of AUTONOMY_LEVELS) {
      // The membership guard its sibling applies (verifyTuiBuilds): an
      // effort-capable adapter whose levels omit `low` would otherwise
      // receive an effort it refuses and fail the whole listing (review
      // round 361). Latent today — every adapter carries `low`.
      const effort = caps.supportsEffort && caps.effortLevels.includes("low")
        ? "low"
        : undefined;
      const sandboxOptions = resolveSandboxOptionsForAgent(agentId, autonomy, overrides);

      const runRequest: RunRequest = {
        agent: agentId,
        prompt: "verify",
        autonomy,
        sandboxed: true,
        cwd: verificationCwd(),
      };
      const runCmd = captureWarnings(() => adapter.buildRunCommand(runRequest)).value;
      // Both previews carry the same `-C <workdir>` pin the real spawns
      // in cli-runtime.ts give buildScodeCommand: without it the listed
      // argv omits the pin scode's cwd-dependent project detection reads,
      // a shape no launch runs (round 372, item 15).
      rows.push({
        agentId,
        autonomy,
        mode: "run",
        ...verifiedScodeCommand(runCmd, verificationCwd(), autonomy, sandboxOptions),
      });

      const tuiCmd = captureWarnings(() =>
        adapter.buildTuiCommand(undefined, autonomy, effort, true, false, verificationCwd())
      ).value;
      rows.push({
        agentId,
        autonomy,
        mode: "tui",
        ...verifiedScodeCommand(tuiCmd, verificationCwd(), autonomy, sandboxOptions),
      });
    }
  }

  return rows;
}

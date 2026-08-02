import { existsSync } from "node:fs";
import { join } from "node:path";
import { guardedWait, runCapturedCommand } from "./process-runner.js";
import { resolveTrustedExecutable } from "./executable-security.js";
import type { SandboxPolicyOverrides } from "./sandbox-policy.js";
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
  type AdapterCapabilities,
  type AgentId,
  type AutonomyLevel,
  type ReasoningEffort,
  type RunResult,
} from "./types.js";
import {
  MAX_PASSTHROUGH_ENV_NAMES,
  validateEnvironmentNames,
  validateWorkingDirectory,
} from "./validation.js";

export const SCODE_MINIMUM_VERSION = "0.2.0";
const SCODE_VERSION_TIMEOUT_MS = 5_000;

export function isScodeAvailable(): boolean {
  try {
    return resolveScodeExecutable() !== null;
  } catch {
    return false;
  }
}

export interface ScodeCompatibilityStatus {
  available: boolean;
  issue: string | null;
}

export async function getScodeCompatibilityStatus(
  workdir = process.cwd()
): Promise<ScodeCompatibilityStatus> {
  const binary = Bun.which("scode", { PATH: process.env.PATH });
  if (!binary) return { available: false, issue: null };
  try {
    const scode = resolveTrustedExecutable(binary, "scode", workdir);
    await assertCompatibleScode(
      scode,
      workdir,
      process.env as Record<string, string>
    );
    return { available: true, issue: null };
  } catch (error) {
    return {
      available: true,
      issue: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getScodeCompatibilityIssue(
  workdir = process.cwd()
): Promise<string | null> {
  return (await getScodeCompatibilityStatus(workdir)).issue;
}

function resolveScodeExecutable(workdir?: string): string | null {
  const binary = Bun.which("scode", { PATH: process.env.PATH });
  if (!binary) return null;
  return resolveTrustedExecutable(binary, "scode", workdir);
}

export function parseVersion(value: string): readonly [number, number, number] | null {
  const match = value.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isVersionAtLeast(
  actual: readonly [number, number, number],
  minimum: readonly [number, number, number]
): boolean {
  for (let index = 0; index < actual.length; index++) {
    const actualPart = actual[index]!;
    const minimumPart = minimum[index]!;
    if (actualPart !== minimumPart) return actualPart > minimumPart;
  }
  return true;
}

async function assertCompatibleScode(
  scode: string,
  workdir: string,
  extraEnv?: Record<string, string>
): Promise<void> {
  const result = await runCapturedCommand([scode, "--version"], {
    cwd: workdir,
    env: buildSandboxEnv(extraEnv),
    timeoutMs: SCODE_VERSION_TIMEOUT_MS,
  });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (!result.success) {
    throw new Error(
      `could not verify scode version (requires ${SCODE_MINIMUM_VERSION} or newer)${output ? `: ${output}` : ""}`
    );
  }
  const actual = parseVersion(output);
  const minimum = parseVersion(SCODE_MINIMUM_VERSION)!;
  if (!actual) {
    throw new Error(
      `could not parse scode version '${output}' (requires ${SCODE_MINIMUM_VERSION} or newer)`
    );
  }
  if (!isVersionAtLeast(actual, minimum)) {
    throw new Error(
      `scode ${actual.join(".")} is too old; ${SCODE_MINIMUM_VERSION} or newer is required`
    );
  }
}

function assertNoProjectScodePolicy(workdir: string): void {
  const projectPolicy = join(workdir, ".scode.yaml");
  if (existsSync(projectPolicy)) {
    throw new Error(
      `refusing sandbox execution because ${projectPolicy} can alter scode policy`
    );
  }
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

export function handleUnexpectedError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.startsWith("Error:") ? message : `Error: ${message}`);
  process.exit(1);
}

export function parseAutonomyOption(value: string | undefined): AutonomyLevel | undefined {
  if (value === undefined) return undefined;
  if (!isAutonomyLevel(value)) {
    failInvalidOption("--auto", value, AUTONOMY_LEVELS);
  }
  return value;
}

export function parseEffortOption(value: string | undefined): ReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (!isReasoningEffort(value)) {
    failInvalidOption("--effort", value, REASONING_EFFORT_LEVELS);
  }
  return value;
}

export function parseTimeoutOption(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86_400) {
    throw new Error(
      "--timeout must be a number from 0 (exclusive) to 86400 seconds"
    );
  }
  return Math.ceil(seconds * 1_000);
}

export function parsePassthroughEnvOption(value?: string): string[] {
  if (value === undefined) return [];
  const names = [...new Set(value.split(",").map((name) => name.trim()).filter(Boolean))];
  if (names.length === 0 || names.length > MAX_PASSTHROUGH_ENV_NAMES) {
    throw new Error(
      `--pass-env requires 1 to ${MAX_PASSTHROUGH_ENV_NAMES} comma-separated names`
    );
  }
  validateEnvironmentNames(names, "--pass-env");
  return names;
}

function parseSandboxTrustOption(value: string | undefined): ScodeTrustLevel | undefined {
  if (value === undefined) return undefined;
  if (!(SCODE_TRUST_LEVELS as readonly string[]).includes(value)) {
    failInvalidOption("--sandbox-trust", value, SCODE_TRUST_LEVELS);
  }
  return value as ScodeTrustLevel;
}

export interface SandboxCliOptions {
  sandbox: boolean;
  sandboxTrust?: string;
  sandboxNoNet?: boolean;
  sandboxScrubEnv?: boolean;
}

export function parseSandboxPolicyOverrides(
  options: SandboxCliOptions,
  allowWithoutSandbox = false
): SandboxPolicyOverrides | undefined {
  const trust = parseSandboxTrustOption(options.sandboxTrust);
  const overrides: SandboxPolicyOverrides = {
    trust,
    noNet: Boolean(options.sandboxNoNet),
    scrubEnv: Boolean(options.sandboxScrubEnv),
  };

  if (!options.sandbox && !allowWithoutSandbox) {
    if (
      trust ||
      overrides.noNet ||
      overrides.scrubEnv
    ) {
      console.warn("Warning: sandbox policy flags require --sandbox, ignoring");
    }
    return undefined;
  }

  return overrides;
}

export function resolveAutonomyForAdapter(
  agentId: AgentId,
  caps: AdapterCapabilities,
  requested: AutonomyLevel
): AutonomyLevel | undefined {
  if (!caps.supportsAutonomy) {
    throw new Error(
      `${agentId} cannot enforce requested autonomy '${requested}'; use an external sandbox`
    );
  }

  if (!caps.autonomyLevels.includes(requested)) {
    throw new Error(
      `${agentId} does not support autonomy level '${requested}'`
    );
  }
  return requested;
}

export function resolveEffortForAdapter(
  agentId: AgentId,
  caps: AdapterCapabilities,
  requested?: ReasoningEffort
): ReasoningEffort | undefined {
  if (!requested) return undefined;
  if (!caps.supportsEffort) {
    if (requested === "none") return undefined;
    throw new Error(`${agentId} does not support reasoning effort '${requested}'`);
  }
  if (!caps.effortLevels.includes(requested)) {
    throw new Error(`${agentId} does not support reasoning effort '${requested}'`);
  }
  return requested;
}

export async function runSandboxed(
  command: string[],
  cwd?: string,
  extraEnv?: Record<string, string>,
  interactive = false,
  autonomy?: AutonomyLevel,
  sandboxOptions?: SandboxOptions,
  envOmissions: readonly string[] = []
): Promise<number> {
  const workdir = validateWorkingDirectory(cwd) ?? process.cwd();
  assertNoProjectScodePolicy(workdir);
  const scode = resolveScodeExecutable(workdir);
  if (!scode) throw new Error("scode is not installed");
  await assertCompatibleScode(scode, workdir, extraEnv);
  const requestedBinary = command[0];
  if (!requestedBinary) throw new Error("sandbox command cannot be empty");
  const binary = Bun.which(requestedBinary, {
    PATH: extraEnv?.PATH ?? process.env.PATH,
  });
  if (!binary) throw new Error(`sandbox command '${requestedBinary}' was not found`);
  const resolvedCommand = [
    resolveTrustedExecutable(binary, requestedBinary, workdir),
    ...command.slice(1),
  ];
  const scodeCmd = buildScodeCommand(
    resolvedCommand,
    workdir,
    autonomy,
    sandboxOptions,
    scode
  );
  const env = buildSandboxEnv(extraEnv);
  for (const name of envOmissions) delete env[name];

  const proc = Bun.spawn(scodeCmd, {
    cwd: workdir,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env,
  });
  return interactive ? await guardedWait(proc) : await proc.exited;
}

export async function runSandboxedWithStdin(
  command: string[],
  stdinData: string | null,
  cwd?: string,
  extraEnv?: Record<string, string>,
  autonomy?: AutonomyLevel,
  sandboxOptions?: SandboxOptions,
  timeoutMs?: number,
  envOmissions: readonly string[] = []
): Promise<RunResult> {
  const workdir = validateWorkingDirectory(cwd) ?? process.cwd();
  assertNoProjectScodePolicy(workdir);
  const scode = resolveScodeExecutable(workdir);
  if (!scode) throw new Error("scode is not installed");
  await assertCompatibleScode(scode, workdir, extraEnv);
  const requestedBinary = command[0];
  if (!requestedBinary) throw new Error("sandbox command cannot be empty");
  const binary = Bun.which(requestedBinary, {
    PATH: extraEnv?.PATH ?? process.env.PATH,
  });
  if (!binary) throw new Error(`sandbox command '${requestedBinary}' was not found`);
  const resolvedCommand = [
    resolveTrustedExecutable(binary, requestedBinary, workdir),
    ...command.slice(1),
  ];
  const scodeCmd = buildScodeCommand(
    resolvedCommand,
    workdir,
    autonomy,
    sandboxOptions,
    scode
  );
  const env = buildSandboxEnv(extraEnv);
  for (const name of envOmissions) delete env[name];
  return runCapturedCommand(scodeCmd, {
    cwd: workdir,
    env,
    stdinInput: stdinData,
    timeoutMs,
  });
}

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { guardedWait, runCapturedCommand } from "./process-runner.js";
import {
  resolveTrustedCommand,
  resolveTrustedExecutable,
} from "./executable-security.js";
import { activeRedirects, probeEnvironment } from "./environment.js";
import {
  ALLOW_UNTESTED_ENV,
  assertSupportedHarnessVersion,
} from "./harness-compatibility.js";
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
  TOOL_SELECTIONS,
  isAutonomyLevel,
  isReasoningEffort,
  isToolSelection,
  type AdapterCapabilities,
  type AgentId,
  type AutonomyLevel,
  type ReasoningEffort,
  type RunResult,
  type ToolSelection,
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

// scode reports a version number for features it does not have (accounting
// is opt-in and ships independently), so capability is probed from --help:
// a scode with scratch accounting documents SCODE_ACCOUNT_FILE there. Run
// only when accounting is requested, so unsandboxed-feature runs pay nothing.
async function assertScodeSupportsAccounting(
  scode: string,
  workdir: string,
  extraEnv?: Record<string, string>
): Promise<void> {
  const result = await runCapturedCommand([scode, "--help"], {
    cwd: workdir,
    env: buildSandboxEnv(extraEnv),
    timeoutMs: SCODE_VERSION_TIMEOUT_MS,
  });
  if (!result.success) {
    // A probe that cannot run proves nothing either way; launching would
    // mean guessing about the one capability this run asked for.
    throw new Error(
      `could not probe the installed scode (--help did not exit cleanly); refusing to guess whether it supports scratch accounting`
    );
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes("SCODE_ACCOUNT_FILE")) {
    throw new Error(
      "the installed scode has no scratch accounting; --sandbox-account and --sandbox-account-id need a scode whose --help documents SCODE_ACCOUNT_FILE"
    );
  }
}

// The sink is only ever confidentiality. A sink the sandbox can write is a
// sink the sandbox can forge, and crew's documented placement lives inside
// the project, so this warns instead of refusing -- the caller may have
// meant exactly that.
function warnIfSinkInsideWorkdir(accountFile: string, workdir: string): void {
  // Only a complete ".." segment escapes; a name that merely begins with two
  // dots ("..acct.jsonl") is a real file inside the workdir, not traversal.
  const isInside = (dir: string, candidate: string): boolean => {
    const rel = relative(dir, candidate);
    return rel.length > 0 && !isAbsolute(rel) && !rel.split(sep).includes("..");
  };
  // A purely lexical comparison misses alias paths -- on macOS /var/folders is
  // a symlink to /private/var/folders, so a sink spelled inside the workdir
  // looks outside. The sink usually does not exist yet (scode creates it at
  // exit), and its parent directories may be missing too, so walk up to the
  // nearest existing ancestor, resolve it, and keep the unresolved tail;
  // fall back to the lexical form when nothing can be resolved.
  const resolveBestEffort = (path: string): string => {
    const tail: string[] = [];
    let current = path;
    for (;;) {
      try {
        return join(realpathSync(current), ...tail);
      } catch {
        const parent = dirname(current);
        if (parent === current) {
          return path;
        }
        tail.unshift(basename(current));
        current = parent;
      }
    }
  };
  // Either spelling counts: the lexical check catches a sink that sits in
  // the workdir but is itself a symlink pointing outside (the sandboxed
  // command can replace such a link with a regular file), and the resolved
  // check catches the alias case the lexical check cannot see.
  if (isInside(workdir, accountFile) ||
      isInside(resolveBestEffort(workdir), resolveBestEffort(accountFile))) {
    // This warns rather than refuses on purpose: scode re-validates the sink
    // when it writes, after the sandbox has exited and the command can no
    // longer swap it, so the residual risk is forged records -- which is
    // exactly what the warning discloses. The operator opted in explicitly;
    // codemux surfaces the trade-off instead of second-guessing it.
    console.warn(
      `Warning: the accounting sink ${accountFile} is inside the sandbox working directory ${workdir}; the sandboxed command can write it, so treat its records as confidentiality, not integrity -- prefer a sink outside that area`
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

export function parseToolsOption(value: string | undefined): ToolSelection | undefined {
  if (value === undefined) return undefined;
  if (!isToolSelection(value)) {
    failInvalidOption("--tools", value, TOOL_SELECTIONS);
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
  sandboxAccount?: string;
  sandboxAccountId?: string;
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
    accountFile: options.sandboxAccount,
    accountId: options.sandboxAccountId,
  };

  if (overrides.accountFile !== undefined && !isAbsolute(overrides.accountFile)) {
    throw new Error(
      `--sandbox-account requires an absolute path, got '${overrides.accountFile}' (scode resolves a relative sink path against its own working directory, not the caller's intent)`
    );
  }

  // scode records an id containing any character outside
  // `[A-Za-z0-9._:-]` as null -- it does not strip the offenders -- so an
  // id like `crew/job-42` would correlate nothing, silently. Refuse here,
  // where the caller can still fix it, instead of at read time when the
  // records no longer join.
  if (
    overrides.accountId !== undefined &&
    !/^[A-Za-z0-9._:-]{1,128}$/.test(overrides.accountId)
  ) {
    throw new Error(
      `--sandbox-account-id accepts 1-128 characters of letters, digits, and '. _ : -', got '${overrides.accountId}' (scode records any other id as null, which would silently break correlation)`
    );
  }
  if (overrides.accountId !== undefined && !overrides.accountFile) {
    throw new Error(
      "--sandbox-account-id without --sandbox-account: the id only ever reaches a sink through an account file, so this request would be silently dropped"
    );
  }

  if (!options.sandbox && !allowWithoutSandbox) {
    if (
      trust ||
      overrides.noNet ||
      overrides.scrubEnv ||
      overrides.accountFile ||
      overrides.accountId
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

/**
 * Resolves an active redirect's value to the trusted executable the launch
 * will run, or null when it cannot: the value must be an absolute path (a
 * relative one resolves against whatever working directory resolves it --
 * the launcher's for the launch, codemux's own cwd for a realpath here --
 * and those can differ, so codemux cannot name the file it would validate)
 * and must pass the same trust check the PATH-resolved binary does, because
 * the probe runs it before scode exists. Null is the caller's fallback,
 * never a throw: a redirect codemux cannot resolve to a trusted executable
 * is a warning about the version being unconfirmed, not a refusal of the
 * run -- the launch may still sandbox it.
 */
function resolveRedirectedBinary(
  name: string,
  environment: Record<string, string>,
  workdir: string
): string | null {
  const value = environment[name] ?? "";
  if (!isAbsolute(value)) return null;
  try {
    return resolveTrustedExecutable(value, name, workdir);
  } catch {
    return null;
  }
}

/**
 * Refuses to launch a harness whose version Codemux has not audited.
 *
 * Runs for sandboxed and direct launches alike: the sandbox bounds what a
 * harness can reach, but it cannot restore an autonomy level whose meaning
 * changed upstream. A harness that is not installed is left to the existing
 * "not found" handling rather than reported as a version problem.
 */
export async function assertHarnessSupported(
  agent: AgentId,
  binaryName: string,
  cwd?: string,
  extraEnv?: Record<string, string>,
  autonomy?: AutonomyLevel,
  sandboxed = false,
  explicitPassthrough: readonly string[] = []
): Promise<void> {
  const workdir = validateWorkingDirectory(cwd) ?? process.cwd();
  const environment = { ...(process.env as Record<string, string>), ...(extraEnv ?? {}) };
  const binary = Bun.which(binaryName, { PATH: environment.PATH });
  if (!binary) return;
  // The one place that decides what the version probe runs with, chosen because it is the only
  // scope where the launch environment is also visible. Every regression in this path came from
  // the decision being made somewhere the launch could not be compared against: the probe runs
  // before any sandbox exists, so it must carry nothing that redirects code loading and nothing
  // that selects an executable, even one the launch keeps. Carrying the selector in the probe
  // environment was tried and withdrawn (see EXECUTABLE_SELECTORS in environment.ts): honoring
  // OpenCode's OPENCODE_BIN_PATH there runs whatever the variable names, unvalidated, outside
  // the sandbox.
  //
  // A redirect is answered here instead of inside the probe environment. When exactly one is
  // active and its value resolves to a trusted executable, THAT binary is what the launch runs
  // (OpenCode's launcher execs it), so the verdict is read from it: a gate that measured the
  // PATH binary approved a below-floor redirect behind a supported launcher and blocked a
  // supported redirect behind an old one. resolveTrustedExecutable holds the redirect to the
  // PATH binary's own rule -- real file, not group/world-writable, owned by the user or root --
  // which is what makes probing it outside the sandbox acceptable. A redirect that cannot be
  // so resolved -- not absolute, missing, or failing the trust check -- keeps the fallback: say
  // the version is unconfirmed, and keep gating the PATH binary, because the operator's
  // redirect does not make a below-minimum launcher acceptable.
  const redirects = activeRedirects(agent, environment, explicitPassthrough);
  let gateBinary = resolveTrustedExecutable(binary, binaryName, workdir);
  if (redirects.length > 0) {
    const redirected =
      redirects.length === 1 ? resolveRedirectedBinary(redirects[0]!, environment, workdir) : null;
    if (redirected !== null) {
      gateBinary = redirected;
    } else {
      console.warn(
        `Warning: ${redirects.join(", ")} can change which ${agent} executable runs, so Codemux ` +
          `cannot confirm the version of the binary this run will use. Autonomy may not behave ` +
          `as documented.`
      );
    }
  }
  await assertSupportedHarnessVersion({
    agent,
    binary: gateBinary,
    // The entry identity that resolved `gateBinary`, preserved for
    // per-entry contracts: the cursor selector keys on it rather than on
    // the canonical path's basename, which a symlink can change (the
    // Homebrew `cursor` resolves inside the app bundle as `code`).
    binaryName,
    workdir,
    probeEnvironment: probeEnvironment(
      environment,
      explicitPassthrough,
      // The adapter's own names: whatever it injects for the launch also selects what runs.
      Object.keys(extraEnv ?? {})
    ),
    // Read from the operator's own environment, not the probe's: the probe drops it, and the
    // override is a decision the operator made rather than something the harness should see.
    override: process.env[ALLOW_UNTESTED_ENV] === "1",
    autonomy,
    sandboxed,
  });
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
  if (sandboxOptions?.accountFile || sandboxOptions?.accountId) {
    await assertScodeSupportsAccounting(scode, workdir, extraEnv);
    if (sandboxOptions.accountFile) {
      warnIfSinkInsideWorkdir(sandboxOptions.accountFile, workdir);
    }
  }
  const resolvedCommand = resolveTrustedCommand(
    command,
    "sandbox command",
    workdir,
    extraEnv?.PATH ?? process.env.PATH
  );
  const scodeCmd = buildScodeCommand(
    resolvedCommand,
    workdir,
    autonomy,
    sandboxOptions,
    scode
  );
  const env = buildSandboxEnv(extraEnv, sandboxOptions);
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
  if (sandboxOptions?.accountFile || sandboxOptions?.accountId) {
    await assertScodeSupportsAccounting(scode, workdir, extraEnv);
    if (sandboxOptions.accountFile) {
      warnIfSinkInsideWorkdir(sandboxOptions.accountFile, workdir);
    }
  }
  const resolvedCommand = resolveTrustedCommand(
    command,
    "sandbox command",
    workdir,
    extraEnv?.PATH ?? process.env.PATH
  );
  const scodeCmd = buildScodeCommand(
    resolvedCommand,
    workdir,
    autonomy,
    sandboxOptions,
    scode
  );
  const env = buildSandboxEnv(extraEnv, sandboxOptions);
  for (const name of envOmissions) delete env[name];
  return runCapturedCommand(scodeCmd, {
    cwd: workdir,
    env,
    stdinInput: stdinData,
    timeoutMs,
  });
}

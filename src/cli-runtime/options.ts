// CLI option parsing and per-adapter option resolution: autonomy,
// effort, tools, timeout, pass-through environment, and sandbox
// policy overrides. src/cli-runtime.ts owns the commands that parse.
import { isAbsolute } from "node:path";
import type { SandboxPolicyOverrides } from "../sandbox-policy.js";
import { SCODE_TRUST_LEVELS, type ScodeTrustLevel } from "../sandbox.js";
import { AUTONOMY_LEVELS, REASONING_EFFORT_LEVELS, TOOL_SELECTIONS, isAutonomyLevel, isReasoningEffort, isToolSelection, type AdapterCapabilities, type AgentId, type AutonomyLevel, type ReasoningEffort, type ToolSelection } from "../types.js";
import { canonicalSandboxBlockPaths } from "../session/registry/format.js";
import { BUDGET_USD_PATTERN, MAX_PASSTHROUGH_ENV_NAMES, UsageRefusalError, validateEnvironmentNames } from "../validation.js";

function failInvalidOption(
  optionName: string,
  value: string,
  allowed: readonly string[]
): never {
  console.error(`Error: Invalid value '${value}' for ${optionName}`);
  console.error(`Allowed values: ${allowed.join(", ")}`);
  // EX_USAGE (sysexits): a bad option value is a usage error, not a
  // runtime failure — the same 64 the session CLI's usageError exits
  // with, so scripts see one code for one class (review live10).
  process.exit(64);
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
    throw new UsageRefusalError(
      "--timeout must be a number from 0 (exclusive) to 86400 seconds"
    );
  }
  return Math.ceil(seconds * 1_000);
}

/** The spend limit `run --max-budget-usd` carries on the request: a
 * positive dollar amount with at most ten integer digits and at most two
 * fraction digits. Digits only, so no sign, exponent, separator, or the
 * Number("NaN")/Number("Infinity") shapes ever pass, and zero is refused
 * by value, not by shape — a well-formed `0.00` is a limit of nothing and
 * must not launch. The digit bound keeps the amount exact through the
 * number the request carries: twelve significant digits round-trip, while
 * a longer amount would reach the harness rounded, as more than the
 * caller wrote (review round 274). */
export function parseBudgetUsdOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!BUDGET_USD_PATTERN.test(value)) {
    throw new UsageRefusalError(
      "--max-budget-usd must be a positive dollar amount written as a decimal with at most ten integer digits and two fraction digits"
    );
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new UsageRefusalError("--max-budget-usd must be greater than zero");
  }
  return amount;
}

export function parsePassthroughEnvOption(value?: string): string[] {
  if (value === undefined) return [];
  const names = [...new Set(value.split(",").map((name) => name.trim()).filter(Boolean))];
  if (names.length === 0 || names.length > MAX_PASSTHROUGH_ENV_NAMES) {
    throw new UsageRefusalError(
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
  sandboxStrict?: boolean;
  sandboxTrust?: string;
  sandboxNoNet?: boolean;
  sandboxScrubEnv?: boolean;
  sandboxAccount?: string;
  sandboxAccountId?: string;
  sandboxBlock?: readonly string[];
}

export function parseSandboxPolicyOverrides(
  options: SandboxCliOptions,
  allowWithoutSandbox = false
): SandboxPolicyOverrides | undefined {
  if (options.sandboxStrict && !options.sandbox) {
    throw new UsageRefusalError("--sandbox-strict requires --sandbox");
  }
  const trust = parseSandboxTrustOption(options.sandboxTrust);
  const overrides: SandboxPolicyOverrides = {
    trust,
    ...(options.sandboxStrict ? { strict: true } : {}),
    noNet: Boolean(options.sandboxNoNet),
    scrubEnv: Boolean(options.sandboxScrubEnv),
    accountFile: options.sandboxAccount,
    accountId: options.sandboxAccountId,
  };

  // scode resolves --block against its own working directory when the path
  // is relative, so a relative block would deny the wrong tree entirely.
  // A NUL byte cannot survive real argv (the kernel refuses it) but the
  // parser runs before anything execs, so refuse it here too.
  if (options.sandboxBlock !== undefined) {
    for (const blocked of options.sandboxBlock) {
      if (!isAbsolute(blocked) || blocked.includes("\0")) {
        throw new UsageRefusalError(
          `--sandbox-block requires absolute paths, got '${blocked.replaceAll("\0", "\\0")}'`
        );
      }
    }
    overrides.blockPaths = options.sandboxBlock;
  }

  if (overrides.accountFile !== undefined && !isAbsolute(overrides.accountFile)) {
    throw new UsageRefusalError(
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
    throw new UsageRefusalError(
      `--sandbox-account-id accepts 1-128 characters of letters, digits, and '. _ : -', got '${overrides.accountId}' (scode records any other id as null, which would silently break correlation)`
    );
  }
  if (overrides.accountId !== undefined && !overrides.accountFile) {
    throw new UsageRefusalError(
      "--sandbox-account-id without --sandbox-account: the id only ever reaches a sink through an account file, so this request would be silently dropped"
    );
  }

  if (!options.sandbox && !allowWithoutSandbox) {
    if (
      trust ||
      overrides.noNet ||
      overrides.scrubEnv ||
      overrides.accountFile ||
      overrides.accountId ||
      (overrides.blockPaths !== undefined && overrides.blockPaths.length > 0)
    ) {
      console.warn("Warning: sandbox policy flags require --sandbox, ignoring");
    }
    return undefined;
  }

  // Canonicalized once, here at the flag boundary (round 19, edges 1):
  // the caller's spelling — a symlinked or `..`-carrying path — must not
  // survive into the block list the children enforce. scode dereferences
  // a symlink at block time, so a spelling left raw means a symlink
  // retargeted after this point makes every later child block the new
  // target and regain the originally named tree. Every consumer
  // downstream — the session record and its resume probe, the
  // launch-time conflict check, and the --block argv of every child —
  // now sees the same dereferenced strings.
  if (overrides.blockPaths !== undefined && overrides.blockPaths.length > 0) {
    overrides.blockPaths = canonicalSandboxBlockPaths(overrides.blockPaths);
  }

  return overrides;
}

export function resolveAutonomyForAdapter(
  agentId: AgentId,
  caps: AdapterCapabilities,
  requested: AutonomyLevel
): AutonomyLevel {
  // Never undefined (review live10): an adapter that cannot enforce the
  // requested level throws — the old `| undefined` arm was unreachable
  // and forced every caller into a redundant truthiness guard.
  if (!caps.supportsAutonomy) {
    throw new UsageRefusalError(
      `${agentId} cannot enforce requested autonomy '${requested}'; use an external sandbox`
    );
  }

  if (!caps.autonomyLevels.includes(requested)) {
    throw new UsageRefusalError(
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
  // `none` is the CLI's "send no effort flag" spelling, one rule on every
  // adapter (docs/cli.md): a harness whose effort list has no native
  // `none` — whether it lacks effort support entirely (kimi, cursor) or
  // carries levels without it (claude, agy, opencode) — launches with no
  // effort flag, and only a value the adapter claims to accept survives.
  if (requested === "none" && !caps.effortLevels.includes("none")) {
    return undefined;
  }
  if (!caps.supportsEffort) {
    throw new UsageRefusalError(`${agentId} does not support reasoning effort '${requested}'`);
  }
  if (!caps.effortLevels.includes(requested)) {
    throw new UsageRefusalError(`${agentId} does not support reasoning effort '${requested}'`);
  }
  return requested;
}


import { isAbsolute } from "node:path";
import { guardedWait, runCapturedCommand, type StdoutSink } from "./process-runner.js";
import { assertExecutablesUnchanged, executableCheck, resolveTrustedCommand, resolveTrustedExecutable, trustCheckedCommandChecks, trustCheckedCommandPaths, type ExecutableCheck } from "./executable-security.js";
import { activeRedirects, probeEnvironment } from "./environment.js";
import { ALLOW_UNTESTED_ENV, assertSupportedHarnessVersion } from "./harness-compatibility.js";
import { buildSandboxEnv, buildScodeCommand, type SandboxOptions } from "./sandbox.js";
import type { AgentId, AutonomyLevel, RunResult } from "./types.js";
import { UsageRefusalError, validateWorkingDirectory } from "./validation.js";
import { escapeArgvForPrint } from "./usage-protocol.js";
import { assertCompatibleScode, assertNoProjectScodePolicy, assertScodeSupportsAccounting, resolveKeepEnvSandboxOptions, resolveScodeExecutable, resolveScodeExecutableForEnv, warnIfSinkInsideWorkdir } from "./cli-runtime/scode.js";

export {
  SCODE_MINIMUM_VERSION,
  getScodeCompatibilityIssue,
  getScodeCompatibilityStatus,
  parseVersion,
  isVersionAtLeast,
  resolveKeepEnvSandboxOptions,
  resolveScodeExecutable,
  resolveScodeExecutableForEnv,
  assertCompatibleScode,
  assertScodeKeepEnvSupport,
  assertNoProjectScodePolicy,
} from "./cli-runtime/scode.js";
export type {
  ScodeCompatibilityStatus,
  ScodeKeepEnvSupport,
} from "./cli-runtime/scode.js";
export {
  parseAutonomyOption,
  parseEffortOption,
  parseToolsOption,
  parseTimeoutOption,
  parseBudgetUsdOption,
  parsePassthroughEnvOption,
  parseSandboxPolicyOverrides,
  resolveAutonomyForAdapter,
  resolveEffortForAdapter,
} from "./cli-runtime/options.js";
export type { SandboxCliOptions } from "./cli-runtime/options.js";

export function isScodeAvailable(): boolean {
  try {
    return resolveScodeExecutable() !== null;
  } catch {
    return false;
  }
}

/** The exit code a failed launch rejects with: a usage refusal is EX_USAGE
 * (64), everything else 1 (review D10, security). One rule for the CLI's
 * error handler and the ledger's failure receipt, so the record's
 * exit_code is the code the process actually exits with (review ul8). */
export function unexpectedErrorExitCode(error: unknown): 64 | 1 {
  return error instanceof UsageRefusalError ? 64 : 1;
}

export function handleUnexpectedError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.startsWith("Error:") ? message : `Error: ${message}`);
  process.exit(unexpectedErrorExitCode(error));
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
 * Returns the probed version, or null when it is unknown.
 */
export async function assertHarnessSupported(
  agent: AgentId,
  binaryName: string,
  cwd?: string,
  extraEnv?: Record<string, string>,
  autonomy?: AutonomyLevel,
  sandboxed = false,
  explicitPassthrough: readonly string[] = [],
  /** Replaces the per-agent below-min refusal point (session floors,
   * design §4.3); `run` and `tui` never set it. */
  minimumOverride?: string
): Promise<string | null> {
  const workdir = validateWorkingDirectory(cwd) ?? process.cwd();
  const environment = extraEnv ?? process.env as Record<string, string>;
  const binary = Bun.which(binaryName, { PATH: environment.PATH ?? "" });
  if (!binary) return null;
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
  return assertSupportedHarnessVersion({
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
    minimumOverride,
  });
}

export async function runSandboxed(
  command: string[],
  cwd?: string,
  extraEnv?: Record<string, string>,
  interactive = false,
  autonomy?: AutonomyLevel,
  sandboxOptions?: SandboxOptions,
  envOmissions: readonly string[] = [],
  // --print-sandbox, the same contract runSandboxedWithStdin carries: print
  // this runner's own scode argv (one argument per line, escaped per
  // argument) and return 0 without spawning. Everything before this point
  // has already run — the probes, trust checks, and option resolution — so
  // the printed argv is the one a real launch would exec.
  printSandbox?: boolean,
  /** An executable the command embeds inside an argument (the Playwright
   * MCP binary inside --mcp-config JSON, review round 110): trust-checked
   * where the argument was built, invisible to the command re-check, and
   * revalidated here immediately before the spawn. Null when the command
   * embeds none. */
  nestedExecutable?: ExecutableCheck | null
): Promise<number> {
  const workdir = validateWorkingDirectory(cwd) ?? process.cwd();
  assertNoProjectScodePolicy(workdir);
  const scode = resolveScodeExecutableForEnv(extraEnv, workdir);
  if (!scode) throw new Error("scode is not installed");
  // This launch's own scode identity, captured in the resolution's own
  // synchronous block (round 20, minor 7): the probes below await, and a
  // capture after them could read another launch's record for the same
  // path — a replaced scode only that launch probed — so the check is
  // carried to the spawn, not re-derived there.
  const carriedScodeCheck = executableCheck(scode);
  await assertCompatibleScode(scode, workdir, extraEnv);
  if (sandboxOptions?.accountFile || sandboxOptions?.accountId) {
    await assertScodeSupportsAccounting(scode, workdir, extraEnv);
    if (sandboxOptions.accountFile) {
      warnIfSinkInsideWorkdir(sandboxOptions.accountFile, workdir);
    }
  }
  // The keep-env seam the run runner owns (runSandboxedWithStdin): this
  // path's callers (the tui launch) attach the exemption to the options
  // the same way launch.ts does — withKeepEnvExemption over the names the
  // adapter injected — and the shared resolver keeps, drops, or refuses it
  // exactly as the run and session spawn paths do.
  const effectiveSandboxOptions = await resolveKeepEnvSandboxOptions(
    scode,
    workdir,
    extraEnv,
    sandboxOptions
  );
  const resolvedCommand = resolveTrustedCommand(
    command,
    "sandbox command",
    workdir,
    (extraEnv ?? process.env).PATH ?? ""
  );
  const scodeCmd = buildScodeCommand(
    resolvedCommand,
    workdir,
    autonomy,
    effectiveSandboxOptions,
    scode
  );
  const env = buildSandboxEnv(extraEnv, effectiveSandboxOptions);
  for (const name of envOmissions) delete env[name];
  if (printSandbox) {
    process.stdout.write(`${scodeCmd.map(escapeArgvForPrint).join("\n")}\n`);
    return 0;
  }

  // The resolved command's own trust-checked positions are required, so
  // a recording gap refuses the spawn instead of skipping the re-check
  // (edges 2: the env prefix's returned path once had no identity), and
  // each re-stat compares this launch's own resolution, never another
  // launch's recorded identity for the same path (round 13, edges 2).
  // scodeCmd[0] — this launch's own resolveScodeExecutableForEnv result —
  // is pinned by the check carried from that resolution (round 19, edges
  // 2; round 20, minor 7): without its check the re-stat falls back to
  // the process-wide identity list, where another launch's probe of a
  // replaced scode would let this one exec bytes it never probed. The
  // nested executable joins the same pin (review round 110).
  assertExecutablesUnchanged(scodeCmd, "sandbox command", [
    ...trustCheckedCommandPaths(resolvedCommand),
    scode,
  ], [...trustCheckedCommandChecks(resolvedCommand), ...(carriedScodeCheck === null ? [] : [carriedScodeCheck]),
    ...(nestedExecutable == null ? [] : [nestedExecutable])]);
  // The interactive branch's spawn rides the guarded wait (review round
  // 223): the wait installs its signal handlers before running it, so a
  // SIGTERM or SIGHUP cannot land between the spawn and the handlers and
  // orphan the sandbox child. The non-interactive branch keeps its plain
  // wait and never installs handlers, as before.
  const spawnSandboxChild = (): ReturnType<typeof Bun.spawn> =>
    Bun.spawn(scodeCmd, {
      cwd: workdir,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
      env,
    });
  return interactive ? await guardedWait(spawnSandboxChild) : await spawnSandboxChild().exited;
}

export async function runSandboxedWithStdin(
  command: string[],
  stdinData: string | null,
  cwd?: string,
  extraEnv?: Record<string, string>,
  autonomy?: AutonomyLevel,
  sandboxOptions?: SandboxOptions,
  timeoutMs?: number,
  envOmissions: readonly string[] = [],
  stdoutSink?: StdoutSink,
  // The launch's receipt hook for a signal interrupt (runCapturedCommand's
  // onSignaled): the sandboxed run stops the same way, and the receipt
  // must be written before the runner's exit 143 (review ul6).
  onSignaled?: () => void | Promise<void>,
  // --print-sandbox: print the scode argv (this function's own scodeCmd,
  // one argument per line, executable included) and return a synthetic
  // zero exit without spawning anything. Everything before this point has
  // already run — the probes, validation, and option resolution — so the
  // printed argv is exactly the one a real launch would exec.
  printSandbox?: boolean,
  /** An executable the command embeds inside an argument (the Playwright
   * MCP binary inside --mcp-config JSON, review round 110): trust-checked
   * where the argument was built, invisible to the command re-check, and
   * revalidated here immediately before the spawn. Null when the command
   * embeds none. */
  nestedExecutable?: ExecutableCheck | null,
  /** The adapter's `stdinRepeats`: feed the block for the child's whole
   * lifetime instead of one write plus the half-close (review round 153;
   * src/process-stdin-repeat.ts). */
  stdinRepeats?: boolean
): Promise<RunResult> {
  const workdir = validateWorkingDirectory(cwd) ?? process.cwd();
  assertNoProjectScodePolicy(workdir);
  const scode = resolveScodeExecutableForEnv(extraEnv, workdir);
  if (!scode) throw new Error("scode is not installed");
  // This launch's own scode identity, captured in the resolution's own
  // synchronous block (round 20, minor 7): the probes below await, and a
  // capture after them could read another launch's record for the same
  // path, so the check is carried to the spawn, not re-derived there.
  const carriedScodeCheck = executableCheck(scode);
  await assertCompatibleScode(scode, workdir, extraEnv);
  if (sandboxOptions?.accountFile || sandboxOptions?.accountId) {
    await assertScodeSupportsAccounting(scode, workdir, extraEnv);
    if (sandboxOptions.accountFile) {
      warnIfSinkInsideWorkdir(sandboxOptions.accountFile, workdir);
    }
  }
  // The launch path names the variables that must survive --scrub-env
  // (launch.ts, withKeepEnvExemption); the shared resolver keeps, drops,
  // or refuses the exemption exactly as the session spawn path does
  // (resolveKeepEnvSandboxOptions).
  const effectiveSandboxOptions = await resolveKeepEnvSandboxOptions(
    scode,
    workdir,
    extraEnv,
    sandboxOptions
  );
  const resolvedCommand = resolveTrustedCommand(
    command,
    "sandbox command",
    workdir,
    (extraEnv ?? process.env).PATH ?? ""
  );
  const scodeCmd = buildScodeCommand(
    resolvedCommand,
    workdir,
    autonomy,
    effectiveSandboxOptions,
    scode
  );
  const env = buildSandboxEnv(extraEnv, effectiveSandboxOptions);
  for (const name of envOmissions) delete env[name];
  if (printSandbox) {
    // One argument per line, control characters escaped per argument
    // (escapeArgvForPrint), so a multi-line prompt argument cannot read as
    // several arguments.
    process.stdout.write(`${scodeCmd.map(escapeArgvForPrint).join("\n")}\n`);
    return { stdout: "", stderr: "", exitCode: 0, success: true };
  }
  // The resolved command's own trust-checked positions are required, so
  // a recording gap refuses the spawn instead of skipping the re-check
  // (edges 2: the env prefix's returned path once had no identity), and
  // each re-stat compares this launch's own resolution, never another
  // launch's recorded identity for the same path (round 13, edges 2).
  // scodeCmd[0] is pinned by the check carried from that resolution
  // (round 19, edges 2; round 20, minor 7): the same rule the
  // inherited-stdio runner above applies. The nested executable joins
  // the same pin (review round 110).
  assertExecutablesUnchanged(scodeCmd, "sandbox command", [
    ...trustCheckedCommandPaths(resolvedCommand),
    scode,
  ], [...trustCheckedCommandChecks(resolvedCommand), ...(carriedScodeCheck === null ? [] : [carriedScodeCheck]),
    ...(nestedExecutable == null ? [] : [nestedExecutable])]);
  return runCapturedCommand(scodeCmd, {
    cwd: workdir,
    env,
    stdinInput: stdinData,
    stdinRepeats,
    timeoutMs,
    stdoutSink,
    onSignaled,
    // The same pin the assert above applied: the runner's own pre-spawn
    // re-stat compares this launch's resolutions, never the process-wide
    // identity list another launch's probe may have widened (round 23,
    // edges 1).
    requiredPaths: [...trustCheckedCommandPaths(resolvedCommand), scode],
    checks: [...trustCheckedCommandChecks(resolvedCommand), ...(carriedScodeCheck === null ? [] : [carriedScodeCheck]),
      ...(nestedExecutable == null ? [] : [nestedExecutable])],
  });
}

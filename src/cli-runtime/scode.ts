// scode resolution and compatibility: executable lookup, version and
// capability probes, keep-env sandbox option resolution, and the
// accounting-sink checks. src/cli-runtime.ts owns the run paths that
// call these.
import { realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { helpAnswer, runOutputProbe, versionAnswer } from "../output-probe.js";
import { resolveTrustedExecutable } from "../executable-security.js";
import { statEntryPresent } from "../file-io.js";
import { UsageRefusalError } from "../validation.js";
import { buildSandboxEnv, type SandboxOptions } from "../sandbox.js";
import { compareVersions } from "../harness-compatibility.js";

export const SCODE_MINIMUM_VERSION = "0.2.0";
const SCODE_VERSION_TIMEOUT_MS = 5_000;

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

/** Resolves the scode binary through the PATH of the environment the
 * child will be spawned with — the same PATH the trusted-command
 * resolution reads (the supplied environment, or the default shell) — so the run
 * runner, the session spawn, and the session start preflight (round
 * al14) all decide on the ONE scode the launch will use. The ambient
 * PATH alone can disagree with the launch environment's (a custom
 * adapter environment view carries its own), and a probe that found one
 * scode while the spawn runs another answers for the wrong binary. */
export function resolveScodeExecutableForEnv(
  env: Record<string, string> | undefined,
  workdir?: string
): string | null {
  const binary = Bun.which("scode", { PATH: (env ?? process.env).PATH ?? "" });
  if (!binary) return null;
  return resolveTrustedExecutable(binary, "scode", workdir);
}

export function resolveScodeExecutable(workdir?: string): string | null {
  return resolveScodeExecutableForEnv(undefined, workdir);
}

export function parseVersion(value: string): readonly [number, number, number] | null {
  const match = value.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** The version token a `--version` line carries, prerelease suffix included
 * (`0.6.0-rc1`), or null when the output holds none. The floor comparison
 * below orders a prerelease below its own release (the rule
 * src/harness-compatibility.ts states for harness versions), so the suffix
 * must reach the comparison instead of being stripped to the numeric core —
 * a `0.6.0-rc1` used to pass the agy floor `0.6.0` (review round 341,
 * item 3). Build metadata past a `+` is not captured: semver ignores it for
 * precedence, and the comparison below drops it the same way. */
const SCODE_VERSION_TOKEN = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)\b/;

/** The version token of a `scode --version` line, prerelease suffix
 * included, or null when the output carries none. The closing boundary
 * keeps a glued suffix (`1.2.3dev`) from reading as its numeric core
 * (review round 344); doctor reads the same token so its floors agree
 * with the launch gate's. */
export function extractScodeVersion(output: string): string | null {
  return SCODE_VERSION_TOKEN.exec(output)?.[1] ?? null;
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

export async function assertCompatibleScode(
  scode: string,
  workdir: string,
  extraEnv?: Record<string, string>,
  minimumVersion = SCODE_MINIMUM_VERSION
): Promise<void> {
  const result = await runOutputProbe([scode, "--version"], {
    cwd: workdir,
    env: buildSandboxEnv(extraEnv),
    timeoutMs: SCODE_VERSION_TIMEOUT_MS,
  }, versionAnswer(SCODE_VERSION_TOKEN));
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (!result.success) {
    throw new Error(
      `could not verify scode version (requires ${minimumVersion} or newer)${output ? `: ${output}` : ""}`
    );
  }
  // The floor comparison runs on the version string, never the numeric
  // triple alone: a prerelease of the minimum is below the minimum (the
  // rule src/harness-compatibility.ts states for harness versions), and a
  // token this cannot compare is refused rather than read as its numeric
  // core. The plain triple parse above stays for the report surfaces
  // (doctor), which print the numeric core of whatever they found.
  const actual = extractScodeVersion(output);
  let order: number | null = null;
  if (actual !== null) {
    try {
      order = compareVersions(actual, minimumVersion);
    } catch {
      order = null;
    }
  }
  if (actual === null || order === null) {
    throw new Error(
      `could not parse scode version '${output}' (requires ${minimumVersion} or newer)`
    );
  }
  if (order < 0) {
    throw new Error(
      `scode ${actual} is too old; ${minimumVersion} or newer is required`
    );
  }
}

// scode reports a version number for features it does not have (accounting
// is opt-in and ships independently), so capability is probed from --help:
// a scode with scratch accounting documents SCODE_ACCOUNT_FILE there. Run
// only when accounting is requested, so unsandboxed-feature runs pay nothing.
export async function assertScodeSupportsAccounting(
  scode: string,
  workdir: string,
  extraEnv?: Record<string, string>
): Promise<void> {
  const result = await runOutputProbe([scode, "--help"], {
    cwd: workdir,
    env: buildSandboxEnv(extraEnv),
    timeoutMs: SCODE_VERSION_TIMEOUT_MS,
  }, helpAnswer(["SCODE_ACCOUNT_FILE"]));
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

// scode 0.6.0 grew --scrub-env into pattern-based scrubbing and paired it
// with a --keep-env exemption for named variables; codemux's injected
// environment must ride that exemption or the scrub strips it. The same
// doctrine as accounting above: capability is probed from --help, never
// guessed from a version, and only when something asked to be kept.
export type ScodeKeepEnvSupport = "supported" | "unsupported" | "unprobeable";

async function probeScodeKeepEnvSupportOnce(
  scode: string,
  workdir: string,
  extraEnv?: Record<string, string>
): Promise<ScodeKeepEnvSupport> {
  let result;
  try {
    result = await runOutputProbe([scode, "--help"], {
      cwd: workdir,
      env: buildSandboxEnv(extraEnv),
      timeoutMs: SCODE_VERSION_TIMEOUT_MS,
    }, helpAnswer(["--keep-env"]));
  } catch {
    // A probe that cannot run at all proves nothing either way; whether
    // that matters is the caller's call (an override run refuses on the
    // doubt, a plain one proceeds as it always did).
    return "unprobeable";
  }
  if (!result.success) {
    return "unprobeable";
  }
  const output = `${result.stdout}\n${result.stderr}`;
  return output.includes("--keep-env") ? "supported" : "unsupported";
}

// One probe per resolved scode AND its full probe environment per
// process: a definite answer is a property of the binary's --help as
// the probe's environment and working directory see it, not of the
// launch asking. Repeated spawns reuse the answer only while that key
// stays the same. An opencode override creates a fresh OPENCODE_CONFIG
// directory each turn, so each turn probes again. The key names the
// executable (its path and its stat identity, so a scode replaced at the
// same path is probed again; review round 331, item 7) plus the two
// facts about the lookup that can change what the probe actually runs:
// a digest of the WHOLE probe environment
// (buildSandboxEnv of extraEnv, sorted name/value pairs — every variable
// the probe runs with, not just PATH, so no environment-sensitive
// wrapper can poison another environment's answer by dispatching on a
// variable the key ignored; round al25, edges major, extending round
// al24's PATH-only fix) and the working directory the probe runs in.
// The executable path alone let one environment's answer poison
// another's (round al24, edges minor): two launch environments
// resolving the same wrapper path reused the first probe's capability
// and misrefused or misconfigured the second.
// "unprobeable" is not a definite answer — a probe that timed out or
// died under load proved nothing about the binary — so it is never
// cached: the entry is dropped and the next launch probes again rather
// than inherit the failure for the rest of the process (round al3).
// Concurrent callers share the in-flight probe; it never rejects.
const scodeKeepEnvProbes = new Map<string, Promise<ScodeKeepEnvSupport>>();

/** The executable's stat identity for the cache key (review round 331,
 * item 7): a scode replaced or upgraded at the same path in a long-lived
 * process is different bytes behind the same key, so its dev, inode,
 * size, and mtime ride the key and the replacement is probed again.
 * Null when the executable cannot be stat'd — the probe then runs once
 * and caches nothing, the same rule as "unprobeable". */
function scodeExecutableIdentity(scode: string): string | null {
  try {
    const stat = statSync(scode, { bigint: true });
    return `${stat.dev}-${stat.ino}-${stat.size}-${stat.mtimeNs}`;
  } catch {
    return null;
  }
}

/** The cache key: the executable (path AND stat identity, so replacing
 * the binary at the path re-probes) plus what identifies the lookup
 * around it — a sha256 digest of the whole probe environment (sorted, so
 * the key is stable across calls) and the working directory. Null when
 * the executable cannot be stat'd: nothing is cached under it. */
function scodeKeepEnvProbeKey(
  scode: string,
  workdir: string,
  extraEnv?: Record<string, string>
): string | null {
  const identity = scodeExecutableIdentity(scode);
  if (identity === null) return null;
  const env = buildSandboxEnv(extraEnv);
  const digest = createHash("sha256");
  for (const name of Object.keys(env).sort()) {
    digest.update(name);
    digest.update("\0");
    digest.update(env[name] ?? "");
    digest.update("\0");
  }
  return [scode, identity, digest.digest("hex"), workdir].join("\0");
}

async function probeScodeKeepEnvSupport(
  scode: string,
  workdir: string,
  extraEnv?: Record<string, string>
): Promise<ScodeKeepEnvSupport> {
  const key = scodeKeepEnvProbeKey(scode, workdir, extraEnv);
  // An executable that cannot even be stat'd is mid-replacement: probe
  // once, cache nothing (the "unprobeable" rule).
  if (key === null) return probeScodeKeepEnvSupportOnce(scode, workdir, extraEnv);
  let probe = scodeKeepEnvProbes.get(key);
  if (probe === undefined) {
    probe = probeScodeKeepEnvSupportOnce(scode, workdir, extraEnv).then((support) => {
      if (support === "unprobeable") scodeKeepEnvProbes.delete(key);
      return support;
    });
    scodeKeepEnvProbes.set(key, probe);
  }
  return probe;
}

/** The refusal message both keep-env gates share — the run runner's
 * (runSandboxedWithStdin) and the session's (spawnSessionChild and the
 * session CLI's start gate) — so a session whose credential rides the
 * exemption (an override's key, zai's gateway token) plus
 * --sandbox-scrub-env refuses with the run path's words verbatim. Both
 * arms name the release that carries the flag (0.6.0): the probe judges
 * the capability, the message names the upgrade (round al12). The cause
 * names the spelling that turns the scrub on — the explicit flag, the
 * untrusted trust preset that implies it, or both (round al21) — so the
 * remedy names a flag the operator actually passed; and when BOTH
 * spellings are active the remedy names both (round al23): each alone
 * keeps the scrub on, so dropping either one alone repeats the
 * refusal. */
function keepEnvRefusalMessage(
  support: Exclude<ScodeKeepEnvSupport, "supported">,
  cause: { scrubEnv: boolean; untrusted: boolean }
): string {
  const strip =
    cause.scrubEnv && cause.untrusted
      ? "--sandbox-scrub-env under --sandbox-trust untrusted"
      : cause.untrusted
        ? "--sandbox-trust untrusted (scode's untrusted preset scrubs the environment)"
        : "--sandbox-scrub-env";
  const drop =
    cause.scrubEnv && cause.untrusted
      ? "both --sandbox-scrub-env and --sandbox-trust untrusted"
      : cause.untrusted
        ? "--sandbox-trust untrusted"
        : "--sandbox-scrub-env";
  const remedy =
    `upgrade scode to 0.6.0 or newer, whose --help documents --keep-env, ` +
    `or drop ${drop} for this run`;
  return support === "unsupported"
    ? `the installed scode has no --keep-env, so ${strip} would strip the credentials codemux injected (a provider override's key, or zai's gateway token) from the child; ${remedy}`
    : `could not probe the installed scode (--help did not exit cleanly); refusing to guess whether it can exempt the credentials codemux injected from ${strip}; ${remedy}`;
}

/** Resolves the --keep-env exemption against the installed scode: kept on
 * a scode whose --help documents the flag, dropped on one without it (an
 * unknown flag is a scode error, so a non-required exemption is dropped
 * and the launch keeps exactly its pre-0.6.0 behavior), and REFUSED when
 * required — a provider override's key is the run's only credential, the
 * operator's own having been omitted on purpose. The one resolver behind
 * run, tui, and session spawns (spawnSessionChild). */
export async function resolveKeepEnvSandboxOptions(
  scode: string,
  workdir: string,
  extraEnv: Record<string, string> | undefined,
  sandboxOptions: SandboxOptions | undefined
): Promise<SandboxOptions | undefined> {
  if (
    sandboxOptions === undefined ||
    !sandboxOptions.keepEnv ||
    sandboxOptions.keepEnv.length === 0
  ) {
    return sandboxOptions;
  }
  const support = await probeScodeKeepEnvSupport(scode, workdir, extraEnv);
  if (support === "supported") {
    return sandboxOptions;
  }
  if (sandboxOptions.keepEnvRequired) {
    throw new Error(
      keepEnvRefusalMessage(support, {
        scrubEnv: sandboxOptions.scrubEnv === true,
        untrusted: sandboxOptions.trust === "untrusted",
      })
    );
  }
  return { ...sandboxOptions, keepEnv: undefined };
}

/** The session start gate: a session under a provider override plus
 * --sandbox-scrub-env needs the exemption for whatever names its turns
 * will carry, so it refuses to START on a scode that cannot give it —
 * with the run path's message verbatim — rather than ack a caller input
 * first and die at the first turn spawn with its only credential
 * scrubbed. The probe runs with the LAUNCH environment (`extraEnv`), the
 * same environment the session's children spawn with — never an empty
 * one: the installed scode refuses to run without HOME, so an empty-env
 * probe answered "unprobeable" and refused valid sessions before launch
 * (round al14's blocker). Unconditional by design — the caller has
 * already established the need — so anything but "supported" throws
 * (round al20: the pass-through sentence that sat here described the
 * resolver above, which takes the options; this gate takes none). The
 * cause is the session caller's to state: sessions refuse untrusted
 * trust at their own gate (harness state a session must write), so the
 * scrub a session gate names is always the explicit flag. */
export async function assertScodeKeepEnvSupport(
  scode: string,
  workdir: string,
  extraEnv: Record<string, string> | undefined,
  cause: { scrubEnv: boolean; untrusted: boolean }
): Promise<void> {
  const support = await probeScodeKeepEnvSupport(scode, workdir, extraEnv);
  if (support !== "supported") {
    throw new Error(keepEnvRefusalMessage(support, cause));
  }
}

// The sink is only ever confidentiality. A sink the sandbox can write is a
// sink the sandbox can forge, and crew's documented placement lives inside
// the project, so this warns instead of refusing -- the caller may have
// meant exactly that.
export function warnIfSinkInsideWorkdir(accountFile: string, workdir: string): void {
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

export function assertNoProjectScodePolicy(workdir: string): void {
  const projectPolicy = join(workdir, ".scode.yaml");
  // An uninspectable path is the same refusal as a present one: a stat
  // error folded into "absent" would silently pass this security check
  // (review round 169).
  const present = statEntryPresent(projectPolicy, (code) => {
    throw new UsageRefusalError(
      `refusing sandbox execution because ${projectPolicy} could not be inspected (${code})`
    );
  });
  if (present) {
    // A usage refusal (exit 64), the contract every caller-triggered
    // pre-launch refusal follows — project-execution configuration
    // included (review round 17, contracts-2 2: this used to be a plain
    // Error, exit 1).
    throw new UsageRefusalError(
      `refusing sandbox execution because ${projectPolicy} can alter scode policy`
    );
  }
}


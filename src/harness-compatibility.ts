import { statSync } from "node:fs";
import { runCapturedCommand } from "./process-runner.js";
import type { AgentId, AutonomyLevel } from "./types.js";

/**
 * Declared compatibility between this Codemux release and each upstream harness.
 *
 * Codemux translates autonomy levels into harness-native flags, and those flags
 * only mean what we think they mean for the versions we audited. Upstream can
 * keep a flag while changing what it enforces: OpenCode 1.18.18 replaced its
 * per-tool deny map with a rules list whose resolved base is allow-all, so
 * `--agent build` kept working while quietly losing its gate. Flag-presence
 * tests cannot see that, which is why compatibility is declared here.
 *
 * Three tiers, because "newer than we audited" is not the same as "broken":
 *
 *   below `min`          refuse. These releases enforce a policy this Codemux
 *                        no longer translates correctly.
 *   through `maxAudited` run silently. Exercised against this release.
 *   above `maxAudited`   run, but warn. Upstream ships patches that change
 *                        nothing, and stranding the user on every one of them
 *                        makes Codemux unusable.
 *
 * A refusal above `maxAudited` requires a `breaks` entry: something we actually
 * determined, not something we inferred from a version number. Breaks are
 * scoped to the autonomy levels they remove enforcement from, so a change that
 * costs `low` its gate does not also block `read-only`.
 */

export const ALLOW_UNTESTED_ENV = "CODEMUX_ALLOW_UNTESTED_HARNESS";

/**
 * A determined breaking change: what upstream altered, from which version, and
 * which autonomy levels stop being enforceable because of it.
 */
export interface HarnessBreak {
  /** First upstream version exhibiting the change. */
  from: string;
  /** What changed, in terms of what Codemux relies on. */
  note: string;
  /** Autonomy levels whose enforcement this removes. */
  affects: readonly AutonomyLevel[];
  /**
   * When true, the affected levels stay available if the run is sandboxed:
   * scode still supplies the boundary the harness stopped supplying. When the
   * run is not sandboxed, Codemux refuses.
   */
  mitigatedBySandbox: boolean;
}

export interface HarnessContract {
  /** `semver` for major.minor.patch; `calendar` for rolling YYYY.MM.DD builds. */
  scheme: "semver" | "calendar";
  versionArgs: readonly string[];
  pattern: RegExp;
  min: string;
  maxAudited: string;
  breaks?: readonly HarnessBreak[];
}

/**
 * Audited 2026-08-15 against the binaries installed on the release machine.
 * `maxAudited` is the version actually exercised, not a guess at what works.
 * Bump it and docs/HARNESS-COMPATIBILITY.md together.
 */
export const HARNESS_CONTRACTS: Readonly<Partial<Record<AgentId, HarnessContract>>> = {
  aider: {
    scheme: "semver",
    versionArgs: ["--version"],
    pattern: /aider (\d+\.\d+\.\d+)/,
    min: "0.86.0",
    maxAudited: "0.86.2",
  },
  claude: {
    scheme: "semver",
    versionArgs: ["--version"],
    pattern: /^(\d+\.\d+\.\d+)/,
    min: "2.1.220",
    maxAudited: "2.1.223",
  },
  codex: {
    scheme: "semver",
    versionArgs: ["--version"],
    pattern: /codex-cli (\d+\.\d+\.\d+)/,
    min: "0.146.0",
    maxAudited: "0.147.0",
  },
  cursor: {
    scheme: "calendar",
    versionArgs: ["--version"],
    pattern: /^(\d{4}\.\d{2}\.\d{2})/,
    min: "2026.07.23",
    maxAudited: "2026.08.11",
  },
  droid: {
    scheme: "semver",
    versionArgs: ["--version"],
    pattern: /^(\d+\.\d+\.\d+)/,
    min: "0.186.0",
    maxAudited: "0.186.0",
  },
  kimi: {
    scheme: "semver",
    versionArgs: ["--version"],
    pattern: /^(\d+\.\d+\.\d+)/,
    min: "0.31.0",
    maxAudited: "0.31.1",
  },
  openhands: {
    scheme: "semver",
    versionArgs: ["--version"],
    // The banner reports the SDK version; the CLI version follows "OpenHands CLI".
    pattern: /OpenHands CLI (\d+\.\d+\.\d+)/,
    min: "1.16.0",
    maxAudited: "1.16.0",
  },
  opencode: {
    scheme: "semver",
    versionArgs: ["--version"],
    pattern: /^(\d+\.\d+\.\d+)/,
    min: "1.18.10",
    maxAudited: "1.18.18",
    breaks: [
      {
        // Reported upstream, not reproduced locally: the version this machine
        // reports has been observed changing between invocations (1.18.11 and
        // 1.18.18 from identical commands), so the boundary below is recorded
        // on the report rather than on a local repro.
        from: "1.18.18",
        note:
          "the per-tool deny map became a rules list whose resolved base rule is " +
          '{"permission":"*","action":"allow","pattern":"*"}, and the old deny ' +
          "shorthand is ignored, so `--agent build` no longer gates writes or " +
          "execution on its own",
        // read-only already requires scode, and high is auto-approve by design.
        affects: ["low", "medium"],
        mitigatedBySandbox: true,
      },
    ],
  },
  zai: {
    scheme: "semver",
    versionArgs: ["--version"],
    pattern: /^(\d+\.\d+\.\d+)/,
    min: "2.1.220",
    maxAudited: "2.1.223",
  },
};

export class HarnessVersionError extends Error {}

export const parseVersionParts = (value: string): number[] | null => {
  const parts = value.split(".").map((part) => Number(part));
  if (parts.length === 0 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    return null;
  }
  return parts;
};

/** Returns <0, 0, or >0. Missing trailing components count as zero. */
export const compareVersions = (left: string, right: string): number => {
  const a = parseVersionParts(left);
  const b = parseVersionParts(right);
  if (!a || !b) throw new HarnessVersionError(`cannot compare '${left}' and '${right}'`);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

export const extractHarnessVersion = (
  contract: HarnessContract,
  output: string
): string | null => contract.pattern.exec(output.trim())?.[1] ?? null;

export type HarnessVerdictKind = "supported" | "unaudited" | "refuse";

export interface HarnessVerdict {
  kind: HarnessVerdictKind;
  version: string;
  message: string | null;
}

/**
 * Decides whether this version may run at the requested autonomy.
 *
 * `autonomy` and `sandboxed` matter because breaks are scoped: a change that
 * costs `low` its gate leaves `read-only` and `high` alone, and a sandboxed run
 * still has scode underneath it.
 */
export const evaluateHarnessVersion = (
  agent: AgentId,
  contract: HarnessContract,
  version: string,
  autonomy?: AutonomyLevel,
  sandboxed = false
): HarnessVerdict => {
  if (compareVersions(version, contract.min) < 0) {
    return {
      kind: "refuse",
      version,
      message:
        `${agent} ${version} is older than the ${contract.min} this Codemux enforces. ` +
        `Update ${agent}, or install a Codemux release that supports ${version}.`,
    };
  }

  for (const breakage of contract.breaks ?? []) {
    if (compareVersions(version, breakage.from) < 0) continue;
    if (autonomy && !breakage.affects.includes(autonomy)) continue;
    if (breakage.mitigatedBySandbox && sandboxed) continue;
    const levels = breakage.affects.join(" and ");
    return {
      kind: "refuse",
      version,
      message:
        `${agent} ${version} cannot enforce ${levels} autonomy: ${breakage.note}. ` +
        (breakage.mitigatedBySandbox
          ? `Re-run with --sandbox so scode supplies the boundary, or use a different autonomy level.`
          : `Use a different autonomy level, or pin ${agent} below ${breakage.from}.`),
    };
  }

  if (compareVersions(version, contract.maxAudited) > 0) {
    return {
      kind: "unaudited",
      version,
      message:
        `${agent} ${version} is newer than the ${contract.maxAudited} this Codemux audited. ` +
        `No breaking change is known for it, so this run continues. If autonomy stops behaving ` +
        `as documented, that is the first thing to suspect.`,
    };
  }

  return { kind: "supported", version, message: null };
};

/**
 * Identity of the binary we measured, so we can tell whether it was replaced.
 *
 * Reading a version means running the binary, which is a separate exec from the
 * launch that follows: an auto-updater can swap the file in between, and we
 * observed exactly that (identical commands reporting 1.18.11 and 1.18.18
 * minutes apart). Comparing inode, size, and mtime closes the case we have
 * actually seen. It does not make the check atomic, which is fine: scode is the
 * boundary, so a stale reading costs an inaccurate warning, not enforcement.
 */
export interface BinaryIdentity {
  inode: number;
  size: number;
  modifiedMs: number;
}

export const readBinaryIdentity = (binary: string): BinaryIdentity | null => {
  try {
    const stats = statSync(binary);
    return { inode: stats.ino, size: stats.size, modifiedMs: stats.mtimeMs };
  } catch {
    return null;
  }
};

export const binaryChanged = (
  before: BinaryIdentity | null,
  after: BinaryIdentity | null
): boolean => {
  if (!before || !after) return false;
  return (
    before.inode !== after.inode ||
    before.size !== after.size ||
    before.modifiedMs !== after.modifiedMs
  );
};

/** Reads the harness version, or null when it cannot be determined. */
export const probeHarnessVersion = async (
  binary: string,
  contract: HarnessContract,
  workdir: string,
  environment: Record<string, string>
): Promise<string | null> => {
  const result = await runCapturedCommand([binary, ...contract.versionArgs], {
    cwd: workdir,
    env: environment,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) return null;
  return extractHarnessVersion(contract, `${result.stdout}\n${result.stderr}`);
};

/**
 * Warns for unaudited versions and refuses known-broken ones.
 *
 * CODEMUX_ALLOW_UNTESTED_HARNESS=1 downgrades a refusal to a warning. It exists
 * for the case where the operator has checked upstream themselves and accepts
 * that an autonomy level may no longer mean what Codemux documents.
 */
export const assertSupportedHarnessVersion = async (
  agent: AgentId,
  binary: string,
  workdir: string,
  environment: Record<string, string>,
  autonomy?: AutonomyLevel,
  sandboxed = false
): Promise<void> => {
  const contract = HARNESS_CONTRACTS[agent];
  if (!contract) return;

  const override = environment[ALLOW_UNTESTED_ENV] === "1";
  const identityBefore = readBinaryIdentity(binary);
  const version = await probeHarnessVersion(binary, contract, workdir, environment);
  if (binaryChanged(identityBefore, readBinaryIdentity(binary))) {
    console.warn(
      `Warning: the ${agent} binary changed while Codemux was reading its version, ` +
        `so ${version ?? "the reported version"} may not be what runs. scode still ` +
        `supplies the boundary for autonomy below high.`
    );
  }

  if (version === null) {
    // Warn rather than refuse. Codemux refuses only what it has determined to
    // be broken, and an unreadable version is not that: wrapper scripts, shims,
    // and vendored builds legitimately fail to report one, and bricking them
    // would make Codemux unusable. The autonomy contract is unconfirmed here,
    // so say so and continue.
    console.warn(
      `Warning: could not determine the ${agent} version, so Codemux cannot confirm ` +
        `its autonomy contract. Autonomy may not behave as documented.`
    );
    return;
  }

  const verdict = evaluateHarnessVersion(agent, contract, version, autonomy, sandboxed);
  if (verdict.kind === "supported") return;
  if (verdict.kind === "unaudited") {
    console.warn(`Warning: ${verdict.message}`);
    return;
  }
  if (override) {
    console.warn(`Warning: ${verdict.message} (${ALLOW_UNTESTED_ENV}=1)`);
    return;
  }
  throw new HarnessVersionError(`${verdict.message} Set ${ALLOW_UNTESTED_ENV}=1 to run anyway.`);
};

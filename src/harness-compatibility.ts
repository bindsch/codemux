import { statSync } from "node:fs";
import type { ProbeEnvironment } from "./environment.js";
import { runCapturedCommand } from "./process-runner.js";
import type { AgentId, AutonomyLevel } from "./types.js";

import { ALLOW_UNTESTED_ENV, HARNESS_CONTRACTS, type HarnessContract } from "./harness-contracts.js";

export {
  ALLOW_UNTESTED_ENV,
  HARNESS_CONTRACTS,
  type HarnessBreak,
  type HarnessContract,
} from "./harness-contracts.js";

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
  sandboxed = false,
  minimumOverride?: string
): HarnessVerdict => {
  // Sessions carry floors above the run contracts (design §4.3), and a
  // floor is itself an audited build — 2.1.280 is the
  // `--permission-prompt-tool stdio` build the session wire was recorded
  // on, 0.159.3 the app-server method table, 1.2.14 agy's audited
  // release — so the override raises BOTH the below-min refusal point
  // and the audited ceiling (review live10: a session at exactly its
  // floor warned "unaudited" on every launch). It can never lower
  // either: an override below the contract's own min is ignored.
  const minimum =
    minimumOverride !== undefined && compareVersions(minimumOverride, contract.min) > 0
      ? minimumOverride
      : contract.min;
  if (compareVersions(version, minimum) < 0) {
    return {
      kind: "refuse",
      version,
      message:
        `${agent} ${version} is older than the ${minimum} this Codemux enforces. ` +
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

  // The audited ceiling rises with the floor for the same reason: the
  // floor build is the one the session wire was audited against, so a
  // version between the run contract's maxAudited and the floor is
  // inside the session's audited band, not above it.
  const auditedCeiling =
    compareVersions(minimum, contract.maxAudited) > 0 ? minimum : contract.maxAudited;
  if (compareVersions(version, auditedCeiling) > 0) {
    return {
      kind: "unaudited",
      version,
      message:
        `${agent} ${version} is newer than the ${auditedCeiling} this Codemux audited. ` +
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

/** Run the harness's version command and return what it reports, or null.
 *
 * `environment` is used as given. Deciding what belongs in it is the caller's job and is done in
 * one place, `cli-runtime.assertHarnessSupported`, where the launch environment is also in scope.
 * That separation is deliberate: every regression this function has had came from it trying to
 * decide the environment itself while the launch decided differently -- a dropped
 * `OPENCODE_BIN_PATH` made the gate read one executable while the launch ran another, and a
 * case-insensitive allowlist let `https_proxy` reach the probe but not the launch.
 */
export const probeHarnessVersion = async (
  binary: string,
  contract: HarnessContract,
  workdir: string,
  environment: ProbeEnvironment,
  entryName: string
): Promise<string | null> => {
  const read = async (args: readonly string[], pattern: RegExp) => {
    const result = await runCapturedCommand([binary, ...args], {
      cwd: workdir,
      env: environment,
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) return null;
    return pattern.exec(`${result.stdout}\n${result.stderr}`.trim())?.[1] ?? null;
  };

  // One flag, no fallback: a release whose version this cannot read warns
  // and runs rather than being probed a second way. A fallback to a flag
  // that launches the harness was tried and withdrawn (see the copilot
  // entry in HARNESS_CONTRACTS); the test suite fails if one returns.
  // `versionArgsFor` is not a fallback either: it selects which entry
  // point's args to run, keyed on the entry name rather than the resolved
  // path's basename (see the cursor contract), never a second probe of the
  // same entry.
  return read(
    contract.versionArgsFor?.(entryName) ?? contract.versionArgs,
    contract.pattern
  );
};

/** Everything the version gate needs, named rather than positional.
 *
 * It was six positional parameters ending in a boolean and two arrays, which is an ordering
 * hazard for no benefit: `sandboxed` and `override` are both booleans and swapping them silently
 * inverts the gate.
 */
export interface VersionGateRequest {
  agent: AgentId;
  /** The resolved executable that is about to run. */
  binary: string;
  /**
   * The entry-point name that resolved `binary` (the adapter's
   * `binaryName`). Per-entry contracts select their version arguments by
   * this identity, because the resolved path's basename can differ from
   * it: the standard Homebrew `cursor` symlink resolves into the
   * Cursor.app bundle as `code`.
   */
  binaryName: string;
  workdir: string;
  /** Exactly what the probe should run with; only `probeEnvironment` can produce one. */
  probeEnvironment: ProbeEnvironment;
  /** Whether the operator set CODEMUX_ALLOW_UNTESTED_HARNESS, read from their own environment. */
  override: boolean;
  autonomy?: AutonomyLevel;
  sandboxed?: boolean;
  /** Replaces the contract's below-min refusal point. The session path
   * (design §4.3) enforces floors above the run contracts; `run` never
   * sets this. */
  minimumOverride?: string;
}

/**
 * Warns for unaudited versions and refuses known-broken ones.
 *
 * CODEMUX_ALLOW_UNTESTED_HARNESS=1 downgrades a refusal to a warning. It exists
 * for the case where the operator has checked upstream themselves and accepts
 * that an autonomy level may no longer mean what Codemux documents.
 * Returns the probed version, or null when it is unknown.
 */
export const assertSupportedHarnessVersion = async (
  request: VersionGateRequest
): Promise<string | null> => {
  const { agent, binary, binaryName, workdir, override, autonomy, sandboxed = false, minimumOverride } = request;
  const contract = HARNESS_CONTRACTS[agent];
  if (!contract) return null;

  const identityBefore = readBinaryIdentity(binary);
  let version = await probeHarnessVersion(
    binary,
    contract,
    workdir,
    request.probeEnvironment,
    binaryName
  );
  if (binaryChanged(identityBefore, readBinaryIdentity(binary))) {
    console.warn(
      `Warning: the ${agent} binary changed while Codemux was reading its version, ` +
        `so ${version ?? "the reported version"} may not be what runs. scode still ` +
        `supplies the boundary for autonomy below high.`
    );
    version = null;
  }

  if (version === null) {
    if (contract.unknownVersion === "refuse") {
      // The contract pins null to mean below-floor rather than unknown:
      // every release it supports can answer the probe it names, so a null
      // reading is a release below `min` (or a probe that cannot vouch for
      // itself), and the tier table's below-min rule -- refuse -- applies.
      // The override covers it, like every refusal.
      const refusal =
        `could not determine the ${agent} version, so Codemux cannot confirm its ` +
        `autonomy contract: this harness is gated so that every release at or above ` +
        `${contract.min} answers the version probe, which makes an unreadable version ` +
        `a release below that floor or a probe that cannot vouch for itself -- refused ` +
        `either way`;
      if (override) {
        console.warn(`Warning: ${refusal} (${ALLOW_UNTESTED_ENV}=1).`);
        return null;
      }
      throw new HarnessVersionError(`${refusal}. Set ${ALLOW_UNTESTED_ENV}=1 to run anyway.`);
    }
    if (minimumOverride !== undefined) {
      // Review live9: the session path (the only caller that sets
      // `minimumOverride`) cannot read an unreadable version the way
      // `run` tolerates. `run` exits with the harness, so an
      // unconfirmed contract is a bounded bet; a session holds a
      // resumable, interactive process open behind a floor the design
      // (§4.3) treats as the pre-hardening boundary — a wrapper that
      // hides its version could be anything. Refused, like every
      // below-floor session, with the operator's override.
      const refusal =
        `could not determine the ${agent} version, so Codemux cannot confirm ` +
        `the session floor ${minimumOverride}: this harness may be a release ` +
        `below the floor or a wrapper the version probe cannot read`;
      if (override) {
        console.warn(`Warning: ${refusal} (${ALLOW_UNTESTED_ENV}=1).`);
        return null;
      }
      throw new HarnessVersionError(`${refusal}. Set ${ALLOW_UNTESTED_ENV}=1 to run anyway.`);
    }
    // Warn rather than refuse. Codemux refuses only what it has determined to
    // be broken, and an unreadable version is not that: wrapper scripts, shims,
    // and vendored builds legitimately fail to report one, and bricking them
    // would make Codemux unusable. The autonomy contract is unconfirmed here,
    // so say so and continue.
    console.warn(
      `Warning: could not determine the ${agent} version, so Codemux cannot confirm ` +
        `its autonomy contract. Autonomy may not behave as documented.`
    );
    return null;
  }

  const verdict = evaluateHarnessVersion(agent, contract, version, autonomy, sandboxed, minimumOverride);
  if (verdict.kind === "supported") return version;
  if (verdict.kind === "unaudited") {
    console.warn(`Warning: ${verdict.message}`);
    return version;
  }
  if (override) {
    console.warn(`Warning: ${verdict.message} (${ALLOW_UNTESTED_ENV}=1)`);
    return version;
  }
  throw new HarnessVersionError(`${verdict.message} Set ${ALLOW_UNTESTED_ENV}=1 to run anyway.`);
};

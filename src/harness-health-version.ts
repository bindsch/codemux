/**
 * The one version-verdict spelling: the same probe and the same evaluation
 * the launch gate uses, reduced to a structured verdict whose `label` is
 * what doctor prints and whose `kind` is what the machine check and the
 * live gate's probe 0 classify on. One module so the two columns cannot
 * disagree (audit D4). Split from harness-health.ts, which re-exports it,
 * so that module stays under the file-size cap (review round 331).
 */

import { probeEnvironment } from "./environment.js";
import { resolveTrustedExecutable } from "./executable-security.js";
import {
  describeHarnessBreakage,
  evaluateHarnessVersion,
  probeHarnessVersionDetailed,
} from "./harness-compatibility.js";
import { HARNESS_CONTRACTS, type HarnessBreak, type HarnessContract } from "./harness-contracts.js";
import type { AgentId } from "./types.js";

export type VersionVerdictKind =
  | "ok"
  | "above-ceiling"
  | "below-min"
  | "known-break"
  | "no-contract"
  | "unreadable"
  | "untrusted";

export interface VersionVerdict {
  kind: VersionVerdictKind;
  /** The probe's parsed version, when it read one. */
  version: string | null;
  /** The human line: `ok (2.1.223)`, `below minimum (…; minimum …)`, … */
  label: string;
  /** The break record, set for `known-break`, so the caller can apply the
   * sandbox mitigation rule (mitigated and scode present = warn). */
  breakage?: HarnessBreak;
  /** Why an `unreadable` or `untrusted` verdict is one. */
  detail?: string;
}

/** The default per-probe bound for one version verdict. The slowest
 * installed harness (openhands, whose version command pays Python
 * startup) measured about 6 s, so 10 s reads it with margin while still
 * bounding a hung binary; the launch gate keeps its own (longer) timeout. */
export const VERSION_VERDICT_PROBE_TIMEOUT_MS = 10_000;

export async function probeVersionVerdict(
  agent: AgentId,
  binaryName: string,
  options: { timeoutMs?: number; workdir?: string; contract?: HarnessContract; binary?: string } = {}
): Promise<VersionVerdict> {
  const workdir = options.workdir ?? process.cwd();
  const binary = options.binary ?? Bun.which(binaryName, { PATH: process.env.PATH ?? "" });
  if (binary === null) {
    // Installed at discovery, gone at probe time: a removed binary is a
    // version codemux could not read, not an agent without a contract.
    return {
      kind: "unreadable",
      version: null,
      label: "unreadable (binary not found)",
      detail: "binary not found",
    };
  }
  let trusted: string;
  try {
    // The same rule every codemux spawn applies (the launch gate's): a
    // binary planted on PATH — a project-local node_modules/.bin — must
    // not run unsandboxed under a diagnostic either. It runs before the
    // no-contract return below, so an agent without a version contract
    // still cannot show a clean row over a binary the launch path
    // refuses (review round 331).
    trusted = resolveTrustedExecutable(binary, binaryName, workdir);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { kind: "untrusted", version: null, label: `untrusted binary (${detail})`, detail };
  }
  // The live gate's probe 0 resolves the binary itself (its own which seam)
  // and may carry a contract table other than this checkout's default; a
  // caller that passes neither gets exactly what doctor prints.
  const contract = options.contract ?? HARNESS_CONTRACTS[agent];
  if (contract === undefined) {
    return { kind: "no-contract", version: null, label: "no contract" };
  }
  let probe: Awaited<ReturnType<typeof probeHarnessVersionDetailed>>;
  try {
    probe = await probeHarnessVersionDetailed(
      trusted,
      contract,
      workdir,
      probeEnvironment(process.env as Record<string, string>),
      binaryName,
      { timeoutMs: options.timeoutMs ?? VERSION_VERDICT_PROBE_TIMEOUT_MS }
    );
  } catch (error) {
    // One harness's failed probe must not end the whole report: the
    // caller prints every agent, so the verdict names the failure, first
    // line only. The launch gate keeps refusing on the same failure.
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { kind: "unreadable", version: null, label: `unreadable (${detail})`, detail };
  }
  if (probe.timedOut) {
    return { kind: "unreadable", version: null, label: "unreadable (timed out)", detail: "timed out" };
  }
  if (probe.version === null) {
    return { kind: "unreadable", version: null, label: "unreadable", detail: "no version in the probe output" };
  }
  const verdict = evaluateHarnessVersion(agent, contract, probe.version);
  if (verdict.reason === "supported") {
    return { kind: "ok", version: probe.version, label: `ok (${probe.version})` };
  }
  if (verdict.reason === "unaudited") {
    return {
      kind: "above-ceiling",
      version: probe.version,
      label: `above audited ceiling (${probe.version}; audited ${contract.maxAudited})`,
    };
  }
  if (verdict.reason === "breakage" && verdict.breakage) {
    return {
      kind: "known-break",
      version: probe.version,
      label: describeHarnessBreakage(verdict.breakage),
      breakage: verdict.breakage,
    };
  }
  return {
    kind: "below-min",
    version: probe.version,
    label: `below minimum (${probe.version}; minimum ${contract.min})`,
  };
}

import { runCapturedCommand } from "../../src/process-runner.js";
import { probeVersionVerdict, type VersionVerdict } from "../../src/harness-health.js";
import type { HarnessContract } from "../../src/harness-compatibility.js";
import { HARNESS_CONTRACTS } from "../../src/harness-contracts.js";
import type { AgentId } from "../../src/types.js";
import { parseUsageSnapshot, USAGEMUX_PROTOCOL_VERSION } from "../../src/usage-protocol.js";
import { readUsagemuxVersion, USAGEMUX_MINIMUM_VERSION } from "../../src/usage.js";

// Probe 0: zero model quota. The version-contract column reads each installed
// harness's version through the ONE verdict module doctor also reads
// (src/harness-health.ts probeVersionVerdict), so the two columns cannot
// disagree (audit D15's reuse clause), and prints the verdict, so a stale
// contract is visible in the report instead of only as a discarded stderr
// warning (audit finding 4).
export interface ContractHarness {
  id: AgentId;
  /** The adapter's entry name; absent when the caller could not resolve one,
   * in which case the row is UNREADABLE and nothing is spawned. */
  binaryName?: string;
}

export type ContractVerdict =
  | "SUPPORTED"
  | "CONTRACT-STALE"
  | "KNOWN-BREAK"
  | "UNREADABLE"
  | "UNTRUSTED"
  | "NO-CONTRACT";

export interface ContractRow {
  agent: AgentId;
  version: string;
  min: string;
  ceiling: string;
  verdict: ContractVerdict;
  detail: string;
  /** A KNOWN-BREAK whose record says the sandbox mitigates it (audit D15):
   * the gate runs sandboxed by default, so this break does not fail it. */
  mitigated?: boolean;
}

export interface ContractDeps {
  contracts?: Readonly<Partial<Record<AgentId, HarnessContract>>>;
  /** The shared verdict probe, injectable so a test never spawns a binary. */
  probeVerdict?: typeof probeVersionVerdict;
  which?: (binary: string) => string | null;
  workdir?: string;
}

function rowFromVerdict(
  agent: AgentId,
  contract: HarnessContract,
  verdict: VersionVerdict
): ContractRow {
  const verdicts: Record<VersionVerdict["kind"], ContractVerdict> = {
    ok: "SUPPORTED",
    "above-ceiling": "CONTRACT-STALE",
    "below-min": "CONTRACT-STALE",
    "known-break": "KNOWN-BREAK",
    "no-contract": "NO-CONTRACT",
    unreadable: "UNREADABLE",
    untrusted: "UNTRUSTED",
  };
  return {
    agent,
    version: verdict.version ?? (verdict.kind === "unreadable" ? "?" : "-"),
    min: contract.min,
    ceiling: contract.maxAudited,
    verdict: verdicts[verdict.kind],
    // The one label both surfaces print (probeVersionVerdict's spelling):
    // `ok (2.1.223)`, `above audited ceiling (…)`, the breakage line with
    // its mitigation clause.
    detail: verdict.label,
    ...(verdict.kind === "known-break" && verdict.breakage?.mitigatedBySandbox === true
      ? { mitigated: true }
      : {}),
  };
}

export async function runContractColumn(
  harnesses: readonly ContractHarness[],
  deps: ContractDeps = {}
): Promise<ContractRow[]> {
  const contracts = deps.contracts ?? HARNESS_CONTRACTS;
  const probeVerdict = deps.probeVerdict ?? probeVersionVerdict;
  const which = deps.which ?? ((binary: string) => Bun.which(binary, { PATH: process.env.PATH }));
  const rows: ContractRow[] = [];
  for (const harness of harnesses) {
    const contract = contracts[harness.id];
    if (contract === undefined) {
      rows.push({
        agent: harness.id, version: "-", min: "-", ceiling: "-",
        verdict: "NO-CONTRACT", detail: "no version contract for this harness",
      });
      continue;
    }
    const resolved = harness.binaryName !== undefined ? which(harness.binaryName) : null;
    if (resolved === null) {
      rows.push({
        agent: harness.id, version: "-", min: contract.min, ceiling: contract.maxAudited,
        verdict: "UNREADABLE", detail: `could not resolve the ${harness.binaryName ?? harness.id} binary`,
      });
      continue;
    }
    // The trust check and the version probe both live in the shared verdict
    // module; the resolved path is handed over so this column's which seam
    // stays its only resolution step, and an untrusted binary is never
    // executed — its row says why.
    const verdict = await probeVerdict(harness.id, harness.binaryName!, {
      workdir: deps.workdir,
      contract,
      binary: resolved,
    });
    rows.push(rowFromVerdict(harness.id, contract, verdict));
  }
  return rows;
}

/** Rows the report must call out: the contract no longer matches the
 * binary, or a known break removes enforcement at some autonomy level. */
export function staleContracts(rows: readonly ContractRow[]): ContractRow[] {
  return rows.filter((row) => row.verdict === "CONTRACT-STALE" || row.verdict === "KNOWN-BREAK");
}

// `codemux usage --json` through usagemux: a snapshot that does not
// validate means the two tools no longer agree on the protocol, which the
// gate must not hide behind a bare JSON.parse.
export interface UsageCheck {
  status: "PASS" | "SKIP" | "FAIL";
  detail: string;
}

export interface UsageDeps {
  which?: (name: string) => string | null;
  run?: (command: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  timeoutMs?: number;
  /** The usagemux version read, injectable so a test spawns nothing. */
  readVersion?: () => Promise<{ version: string | null; belowMinimum: boolean; issue?: string }>;
}

/** The gate's own subprocesses (the candidate's `--version` and `usage
 * --json`) run with this process's environment: the launcher needs PATH to
 * find bun and HOME for its configuration. Review round 41 found both calls
 * passing the process object itself, which emptied the child environment,
 * so the default live gate could not run the checkout launcher. */
export const captureInProcessEnvironment = (
  command: string[],
  timeoutMs: number
): Promise<{ exitCode: number; stdout: string; stderr: string; success: boolean }> =>
  runCapturedCommand(command, {
    cwd: process.cwd(),
    env: process.env as unknown as Record<string, string>,
    timeoutMs,
  });

export async function runUsageCheck(codemux: string, deps: UsageDeps = {}): Promise<UsageCheck> {
  const which = deps.which ?? ((name: string) => Bun.which(name, { PATH: process.env.PATH }));
  const run = deps.run ?? ((command: string[]) => captureInProcessEnvironment(command, deps.timeoutMs ?? 60_000));
  if (which("usagemux") === null) {
    return { status: "SKIP", detail: "usagemux is not installed" };
  }
  // A usagemux old enough to predate the 1.0.0 protocol is a FAIL, not a
  // pass on whatever it prints (audit D5): the gate's snapshot check is
  // only meaningful against a usagemux that speaks the validated shape.
  const version = await (deps.readVersion ?? readUsagemuxVersion)();
  if (version.version !== null && version.belowMinimum) {
    return {
      status: "FAIL",
      detail: `usagemux ${version.version} is below ${USAGEMUX_MINIMUM_VERSION}; the usage check needs the validated snapshot shape`,
    };
  }
  let captured: { exitCode: number; stdout: string; stderr: string };
  try {
    captured = await run([codemux, "usage", "--json"]);
  } catch (error) {
    return { status: "FAIL", detail: `could not run usage --json: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (captured.exitCode !== 0) {
    return { status: "FAIL", detail: `usage --json exited ${captured.exitCode}: ${captured.stderr.trim().slice(0, 120)}` };
  }
  // The same validator `codemux usage` itself runs (parseUsageSnapshot,
  // src/usage-protocol.ts): any parseable JSON used to pass, so a codemux
  // and a usagemux that disagree on the protocol shape passed the gate.
  try {
    parseUsageSnapshot(captured.stdout);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: "FAIL",
      detail: `usage --json stdout is not a valid usagemux protocol ${USAGEMUX_PROTOCOL_VERSION} snapshot: ${reason}`,
    };
  }
  return { status: "PASS", detail: `usagemux answered a snapshot that validates against protocol ${USAGEMUX_PROTOCOL_VERSION}` };
}

/** The exact `--version` output of the binary under test, stamped in the
 * report header so a saved report names the build that produced it. */
export async function stampCodemuxVersion(
  codemux: string,
  run: (command: string[]) => Promise<{ exitCode: number; stdout: string }> = (command) =>
    captureInProcessEnvironment(command, 60_000)
): Promise<string> {
  try {
    const captured = await run([codemux, "--version"]);
    const stamp = captured.stdout.trim();
    if (captured.exitCode !== 0 || stamp === "") return "unreadable";
    return stamp;
  } catch {
    return "unreadable";
  }
}

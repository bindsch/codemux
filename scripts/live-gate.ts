// Entry point and re-export hub for the live gate. Implementation modules:
// runner.ts (option parsing, probe runner), probes.ts (probe definitions and
// per-harness facts), contracts.ts (zero-quota version/usage columns),
// report.ts (formatting), run.ts (orchestration). Tests import everything
// from here. main() lives HERE, not in run.ts: only spawned child processes
// run it (tests drive its pieces in process), so it belongs to this
// child-only entry file, which the coverage floor waives for exactly that
// reason (review round 8, edges).
import { CommanderError } from "commander";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAvailableAdapters } from "../src/adapters/index.js";
import { contractsAfterPool, runContractColumn, runUsageCheck, stampCodemuxVersion, type ContractRow, type UsageCheck } from "./live-gate/contracts.js";
import { formatReport, gateFailed, type ReportInput } from "./live-gate/report.js";
import { ProbeRunner, isDefaultCodemux, parseOptions } from "./live-gate/runner.js";
import { discoverCandidate } from "./live-gate/candidate.js";
import { createReportDirectory, runProbes, sessionHarnessFacts } from "./live-gate/run.js";

export { escapeControls, isDefaultCodemux, parseOptions, providerOverridePreflight, runPool, ProbeRunner } from "./live-gate/runner.js";
export {
  DEFAULT_PROBES,
  EXPERIMENT_HARNESSES,
  PROVIDER_OVERRIDE_OPT_IN,
  PROBE_LABELS,
  PROBE_LETTERS,
  harnessFacts,
  parseProbeList,
  probeApplies,
  prepareExperimentProbe,
  prepareMediumProbe,
  prepareSessionProbe,
  sessionStartedId,
  unsupportedNote,
  verifyExperimentEcho,
  verifyResultEnvelope,
  verifySessionTurn,
  SERVED_MODEL_EVIDENCE,
} from "./live-gate/probes.js";
export {
  prepareNoNetProbe,
  providerOverrideEnv,
  sandboxPrefixFromPrint,
  startFakeProvider,
  startReachableListener,
  verifyOverrideLog,
  verifyProviderOverrideEnvelope,
} from "./live-gate/loopback.js";
export type { FakeProvider, LoopbackServer, NoNetProbe, OverrideRequestRecord } from "./live-gate/loopback.js";
export { contractsAfterPool, runContractColumn, runUsageCheck, stampCodemuxVersion } from "./live-gate/contracts.js";
export { candidateFacts, discoverCandidate, assertCandidateVersion } from "./live-gate/candidate.js";
export { formatReport, gateFailed } from "./live-gate/report.js";
export {
  createReportDirectory,
  liveSessionLeak,
  LOOPBACK_TIMEOUT_SECONDS,
  modelAliasFor,
  modelNamesTarget,
  runProbes,
  sessionHarnessFacts,
  verifyAliasEnvelope,
} from "./live-gate/run.js";
import { keychainBaselineRefusal, keychainDrift, keychainSnapshot } from "./live-gate/keychain.js";
export type { CapturedOutput, GateOptions, ProbeResult, StdinScript, Verifier } from "./live-gate/runner.js";
export type { ContractRow, UsageCheck } from "./live-gate/contracts.js";
export type { GateRow, ReportInput } from "./live-gate/report.js";
export type { HarnessFacts, ProbeLetter } from "./live-gate/probes.js";

const ROOT = resolve(import.meta.dir, "..");

// The version a candidate must report: this checkout's own build, the one
// whose contract table and probe set the gate runs with.
export const CHECKOUT_VERSION = (() => {
  const parsed = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string") throw new Error("package.json is missing a string version");
  return parsed.version;
})();

export async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const directory = createReportDirectory(join(ROOT, "scratch"));
  const runner = new ProbeRunner();
  // Before the probe pool starts, a signal ends the gate at once with the
  // signal's conventional code (the discovery, contract, and usage
  // subprocesses are bounded and die with the process); during the pool the
  // runner's interrupt path ends the running probe and writes the report
  // (review round 47). The handlers are registered up front so the pool is
  // never reached unguarded.
  let probing = false;
  const signalExit = (signal: "SIGINT" | "SIGTERM" | "SIGHUP"): void => {
    if (probing) {
      runner.interrupt(signal);
      return;
    }
    console.error(`live-gate: ${signal} before the probes started; stopping`);
    process.exit(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129);
  };
  const onInterrupt = (): void => signalExit("SIGINT");
  const onTerminate = (): void => signalExit("SIGTERM");
  const onHangup = (): void => signalExit("SIGHUP");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  process.on("SIGHUP", onHangup);
  try {
    // Discovery (round 18, edges 4): a candidate answers `list --json` and
    // the matrix comes from that listing; only this checkout's own
    // launcher may use the in-process adapter registry.
    const version = await stampCodemuxVersion(options.codemux);
    const candidate = isDefaultCodemux(options.codemux)
      ? null
      : await discoverCandidate(options.codemux, CHECKOUT_VERSION, options.allowVersionMismatch, version);
    const facts = (candidate?.facts ?? sessionHarnessFacts())
      .filter((fact) => !options.only || options.only.has(fact.id));
    // The contract column's input: this checkout's adapters by default,
    // but in candidate mode every id the candidate lists as available,
    // resolved through the candidate's own binary names (round 19, edges
    // 4). A candidate-available harness this checkout cannot resolve
    // still gets its row — UNREADABLE, naming the binary — instead of
    // being dropped because this checkout's adapters never listed it;
    // --only restricts both modes the same way.
    const discoveryIds = new Set(facts.map((fact) => fact.id));
    const contractHarnesses = candidate === null
      ? getAvailableAdapters()
        .filter((adapter) => discoveryIds.has(adapter.id))
        .map((adapter) => ({ id: adapter.id, binaryName: adapter.binaryName }))
      : candidate.contractHarnesses.filter((harness) => discoveryIds.has(harness.id));
    // Read here and again after the pool: a harness can update itself
    // while the pool runs (agy and cursor both did on 2026-11-06), and the
    // report judges the version installed afterwards, naming the change.
    // An interrupted gate keeps this first reading: its report must not
    // wait on more spawns.
    const contractsBefore: ContractRow[] = await runContractColumn(contractHarnesses);
    const usage: UsageCheck = await runUsageCheck(options.codemux);
    probing = true;
    // Keychain hygiene around the whole pool (review round 52): concurrent
    // probes would otherwise snapshot each other's transient state. On a
    // platform the check covers, a baseline that is missing or failed
    // stops the gate before any probe runs (review rounds 87 and 88): a
    // pool whose hygiene cannot be observed must not be certified.
    const keychainBefore = await keychainSnapshot();
    const baselineRefusal = keychainBaselineRefusal(keychainBefore);
    if (baselineRefusal !== null) {
      console.error(
        `live-gate: the Keychain hygiene check could not run: ${baselineRefusal}; stopping before the probes`
      );
      process.exitCode = 1;
      return;
    }
    const rows = await runProbes(facts, options, runner, directory);
    const keychainDriftText = keychainDrift(keychainBefore, await keychainSnapshot());
    const first: ReportInput = {
      rows, contracts: contractsBefore, usage, version,
      keychainDrift: keychainDriftText,
      codemux: options.codemux,
      only: options.only,
      probes: options.probes,
      allowStaleContracts: options.allowStaleContracts,
      allowKnownBreaks: options.allowKnownBreaks,
      ...(candidate === null ? {} : {
        matrixNote: candidate.note,
        // Every candidate-available id in scope must carry a row; a
        // missing one fails the gate rather than certifying the harness
        // unchecked.
        requiredContractIds: new Set(contractHarnesses.map((harness) => harness.id)),
      }),
    };
    // The pool's results are saved before the second reading starts. Each
    // version read is a runCapturedCommand call (src/process-runner.ts,
    // through src/harness-compatibility.ts), and that function's own
    // signal handlers end the process once its child is stopped, so a
    // signal during a version read would otherwise end the gate with the
    // report unwritten. A reread that fails must not cost the report
    // either: its rows print UNREADABLE, which fails the gate (review
    // rounds 183 and 190).
    const path = join(directory, "report.md");
    await Bun.write(path, `${formatReport(first)}\n`);
    const contracts: ContractRow[] = runner.interrupted
      ? contractsBefore
      : contractsAfterPool(contractsBefore, await runContractColumn(contractHarnesses).catch(() => []));
    const input: ReportInput = { ...first, contracts };
    const report = formatReport(input);
    console.log(report);
    await Bun.write(path, `${report}\n`);
    console.log(`Report: ${path}`);
    process.exitCode = runner.interrupted === "SIGHUP" ? 129 : runner.interrupted === "SIGINT" ? 130 : runner.interrupted ? 143
      : gateFailed(input) ? 1 : 0;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    process.off("SIGHUP", onHangup);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if ((error as { code?: string }).code !== "commander.helpDisplayed") {
      // The specific message first (the preflight refusal names the missing
      // variable), then the generic hint: swallowing the cause made an
      // operator-facing refusal unreadable. A CommanderError is excluded —
      // commander has already printed its own message before the
      // exitOverride throw, so repeating it doubled every argument error
      // (review round 9).
      if (!(error instanceof CommanderError) && error instanceof Error && error.message !== "") {
        console.error(error.message);
      }
      console.error("live-gate: could not complete; check arguments, installation, and report directory");
      process.exitCode = error instanceof CommanderError ? error.exitCode : 1;
    }
  }
}

// CLI parsing and preflight checks for the live gate. Split from
// scripts/live-gate/runner.ts (the probe runner) for the 500-line ceiling;
// scripts/live-gate.ts (the entry hub) re-exports both, and no module in
// scripts/live-gate/ imports the hub back: a static cycle there deadlocks
// bun's loader when the hub is the entry file.

import { Command, InvalidArgumentError } from "commander";
import { accessSync, constants, statSync } from "node:fs";
import { resolve } from "node:path";
import { AGENT_IDS } from "../../src/adapters/index.js";
import { MAX_RUN_TIMEOUT_MS } from "../../src/process-runner.js";
import type { AgentId } from "../../src/types.js";

import { DEFAULT_PROBES, PROVIDER_OVERRIDE_OPT_IN, parseProbeList, probeApplies, type HarnessFacts, type ProbeLetter } from "./probes.js";
import { DEFAULT_CODEMUX, escapeControls } from "./runner.js";

// 600: the codex experiment probe runs its code-mode model for six to
// eight minutes (395 s and 495 s on 2026-11-02), and the canonical
// `make live-gate` must be able to run every probe it requires (round 36).
const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_JOBS = 4;

export interface GateOptions {
  codemux: string;
  timeout: number;
  jobs: number;
  skip: Set<AgentId>;
  only?: Set<AgentId>;
  passEnv?: string;
  probes: readonly ProbeLetter[];
  /** The `-m` value the codex experiment probe carries (`worker` by default:
   * the operator's alias; a codex experiment refuses a request without a
   * model). */
  codexModel: string;
  allowStaleContracts: boolean;
  /** KNOWN-BREAK has its own allowance (audit D15); a sandbox-mitigated
   * break never fails, flag or no flag. */
  allowKnownBreaks: boolean;
  /** Harnesses that run even when the gate's login pre-check (audit D8)
   * detects no credentials — the operator says the store is wrong. */
  probeAnyway: Set<AgentId>;
  allowVersionMismatch: boolean;
}

function positiveInteger(maximum: number): (value: string) => number {
  return (value) => {
    const number = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > maximum) {
      throw new InvalidArgumentError(`Expected an integer from 1 to ${maximum}.`);
    }
    return number;
  };
}

function agentList(values: (string | undefined)[], label: string): Set<AgentId> {
  const agents = new Set<AgentId>();
  for (const name of values.flatMap((value) => value?.split(",") ?? [])) {
    const agent = name.trim();
    if (!agent) continue;
    if (!AGENT_IDS.includes(agent as AgentId)) throw new Error(`${label} list contains an unknown harness name.`);
    agents.add(agent as AgentId);
  }
  return agents;
}

export function parseOptions(args: string[], skipEnv = process.env.LIVE_GATE_SKIP, env: Record<string, string | undefined> = process.env): GateOptions {
  const command = new Command()
    .name("live-gate")
    .description("Spend quota to check every installed harness under the default sandbox.")
    .option("--codemux <path>", "Codemux executable to test", DEFAULT_CODEMUX)
    .option("--timeout <seconds>", "Timeout per probe in seconds", positiveInteger(MAX_RUN_TIMEOUT_MS / 1000), DEFAULT_TIMEOUT_SECONDS)
    .option("--jobs <count>", "Concurrent probes (1 to 4)", positiveInteger(MAX_JOBS), MAX_JOBS)
    .option("--skip <agents>", "Comma-separated harnesses without credentials (adds to LIVE_GATE_SKIP)")
    .option("--only <agents>", "Run only these comma-separated installed harnesses")
    .option("--pass-env <names>", "Forward this comma-separated environment list to every probe")
    .option("--probe <probes>", "Run only these comma-separated probes (letters or names; default: every probe but H, which is opt-in)")
    .option("--skip-probe <probes>", "Exclude these comma-separated probes")
    .option("--codex-model <alias>", "The -m value the codex experiment probe carries (a codex experiment refuses a request without one)", "worker")
    .option("--allow-stale-contracts", "Report stale version contracts without failing the gate")
    .option("--allow-known-breaks", "Report known-broken version contracts without failing the gate (a break the sandbox mitigates never fails, flag or no flag)")
    .option("--probe-anyway <agents>", "Run these harnesses even when the gate detects no credentials (the login pre-check would skip them)")
    .option("--allow-version-mismatch", "Test a candidate whose --version differs from this checkout anyway (its probe matrix still comes from the candidate)")
    .exitOverride();
  command.parse(args, { from: "user" });
  const options = command.opts<{ codemux: string; timeout: number; jobs: number; skip?: string; only?: string; passEnv?: string; probe?: string; skipProbe?: string; probeAnyway?: string; codexModel: string; allowStaleContracts?: boolean; allowKnownBreaks?: boolean; allowVersionMismatch?: boolean }>();
  const codemux = resolve(options.codemux);
  try {
    if (!statSync(codemux).isFile()) throw new Error("not a file");
    accessSync(codemux, constants.X_OK);
  } catch {
    command.error(`--codemux must name an existing executable file: ${escapeControls(codemux)}`, { exitCode: 2 });
  }
  // A list flag given with an empty value — the whole value or one
  // comma-separated entry — is a caller mistake, not an absent flag:
  // the list parsers skip empty entries, so `--skip ""` would silently
  // select every harness (review round 159). The env merge
  // (LIVE_GATE_SKIP) keeps its own convention: blank means unset.
  for (const [flag, value] of [["--skip", options.skip], ["--only", options.only], ["--pass-env", options.passEnv],
    ["--probe", options.probe], ["--skip-probe", options.skipProbe], ["--probe-anyway", options.probeAnyway]] as const) {
    if (value?.split(",").some((entry) => entry.trim() === "")) {
      throw new Error(`${flag} takes a comma-separated list; an entry is empty.`);
    }
  }
  const skip = agentList([skipEnv, options.skip], "Skip");
  const only = options.only === undefined ? undefined : agentList([options.only], "Only");
  if (only?.size === 0) throw new Error("Only list must contain at least one harness name.");
  const selected = options.probe === undefined ? [...DEFAULT_PROBES] : parseProbeList([options.probe], "Probe");
  if (selected.length === 0) throw new Error("Probe list must contain at least one probe.");
  const probes = selected.filter((letter) => !parseProbeList([options.skipProbe], "Skip-probe").includes(letter));
  if (probes.length === 0) throw new Error("Probe selection is empty after --skip-probe.");
  if (env[PROVIDER_OVERRIDE_OPT_IN] !== undefined && env[PROVIDER_OVERRIDE_OPT_IN] !== "1") {
    throw new Error(`${PROVIDER_OVERRIDE_OPT_IN} must be 1 when set.`);
  }
  if (options.codexModel.trim() === "" || options.codexModel.includes("\0")) throw new Error("--codex-model must be a nonempty model name or alias.");
  return { codemux, timeout: options.timeout, jobs: options.jobs, skip, only, passEnv: options.passEnv, probes, codexModel: options.codexModel, allowStaleContracts: options.allowStaleContracts === true, allowKnownBreaks: options.allowKnownBreaks === true, probeAnyway: agentList([options.probeAnyway], "Probe-anyway"), allowVersionMismatch: options.allowVersionMismatch === true };
}

/** The opt-in preflight for probe H (review round 4, edges finding H): a
 * harness that will run the provider-override probe must export all three
 * of its CODEMUX_<AGENT>_PROVIDER_{BASE_URL,API_KEY,MODEL} variables,
 * nonempty. A missing or empty one made the probe run WITHOUT the
 * override — the adapter never saw it and answered from the operator's
 * default credentials, a PASS that verified nothing and spent quota
 * outside the account the opt-in names. Refused before any probe runs,
 * naming the variable; unset the opt-in to skip probe H instead. */
export function providerOverridePreflight(
  facts: readonly HarnessFacts[],
  options: Pick<GateOptions, "probes" | "skip" | "only">,
  env: Record<string, string | undefined> = process.env
): void {
  if (env[PROVIDER_OVERRIDE_OPT_IN] !== "1") return;
  const running = facts.filter((fact) =>
    (!options.only || options.only.has(fact.id)) &&
    !options.skip.has(fact.id) &&
    options.probes.includes("H") &&
    probeApplies("H", fact));
  for (const fact of running) {
    for (const suffix of ["BASE_URL", "API_KEY", "MODEL"] as const) {
      const name = `CODEMUX_${fact.id.toUpperCase()}_PROVIDER_${suffix}`;
      if (!env[name]) {
        throw new Error(
          `${PROVIDER_OVERRIDE_OPT_IN}=1 runs probe H on ${fact.id}, but ${name} is missing or empty; export it or unset ${PROVIDER_OVERRIDE_OPT_IN}`
        );
      }
    }
  }
}

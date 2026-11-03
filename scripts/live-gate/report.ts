import type { AgentId } from "../../src/types.js";
import { escapeControls, type ProbeResult } from "./runner.js";
import { DEFAULT_PROBES, PROBE_LABELS, type ProbeLetter } from "./probes.js";
import type { ContractRow, UsageCheck } from "./contracts.js";

export interface GateRow {
  agent: AgentId;
  results: Partial<Record<ProbeLetter, ProbeResult>>;
}

export function cell(value: string): string {
  return escapeControls(value).replaceAll("&", "&amp;").replaceAll("|", "&#124;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function resultCell(result: ProbeResult): string {
  // The note is operator or harness text: it escapes like every other
  // cell, or a "|" in it splits the table column (review round 11,
  // edges 11).
  if (result.status === "SKIP") return `SKIP (${cell(result.note ?? "operator requested")})`;
  if (result.status === "UNSUPPORTED") return `UNSUPPORTED (documented): ${cell(result.note ?? "")}`;
  return result.status;
}

function noteCell(result: ProbeResult): string {
  const parts: string[] = [];
  if (result.status === "FAIL" && result.stderr) parts.push(result.stderr);
  // SKIP and UNSUPPORTED cells already carry their note in the Result column.
  if (result.note && result.status !== "SKIP" && result.status !== "UNSUPPORTED") parts.push(result.note);
  return cell(parts.join("; "));
}

export interface ProbeTotals {
  pass: number;
  fail: number;
  skip: number;
  unsupported: number;
}

export function countRows(rows: readonly GateRow[]): ProbeTotals {
  const totals: ProbeTotals = { pass: 0, fail: 0, skip: 0, unsupported: 0 };
  for (const row of rows) {
    for (const result of Object.values(row.results)) {
      if (!result) continue;
      totals[result.status === "PASS" ? "pass" : result.status === "FAIL" ? "fail"
        : result.status === "SKIP" ? "skip" : "unsupported"]++;
    }
  }
  return totals;
}

/** A row counts as probed only when an authenticated probe actually ran
 * there; skips and unsupported cells are never passes, and the zero-quota
 * print-sandbox probe (P) proves nothing about a harness's credentials, so a
 * gate whose only PASS cells are P cells did not probe (review round 48). */
export function hasProbes(rows: readonly GateRow[]): boolean {
  return rows.some((row) =>
    Object.entries(row.results).some(([letter, result]) =>
      letter !== "P" && (result?.status === "PASS" || result?.status === "FAIL")));
}

export interface ReportInput {
  rows: readonly GateRow[];
  contracts: readonly ContractRow[];
  usage: UsageCheck;
  version: string;
  codemux: string;
  only?: ReadonlySet<AgentId>;
  probes: readonly ProbeLetter[];
  allowStaleContracts: boolean;
  /** KNOWN-BREAK has its own switch (audit D15): a stale contract says the
   * table no longer describes the binary, a known break says a specific
   * enforcement gap exists — allowing one is not allowing the other. */
  allowKnownBreaks: boolean;
  /** Keychain hygiene (2026-11-03): the user search list and default
   * keychain, snapshotted before and after the whole probe pool (probes
   * run concurrently, so per-probe snapshots would see each other's
   * transient state; review round 52). Null when they match or when there
   * is nothing to observe; the drift text fails the gate otherwise. */
  keychainDrift?: string | null;
  /** Present when the probe matrix came from the candidate's own
   * `list --json` rather than this checkout's adapters (candidate.ts):
   * the report names the source so a saved report says which build's
   * matrix it probed (round 18, edges 4). */
  matrixNote?: string;
  /** The ids the contract column owes a row (candidate mode: every id the
   * candidate lists as available, round 19, edges 4). An id in this set
   * with no row fails the gate: a candidate-available harness this
   * checkout could not resolve must surface as UNREADABLE, never as a
   * silently missing verdict. */
  requiredContractIds?: ReadonlySet<AgentId>;
}

/** Ids the contract column owed a row and produced none. */
export function missingContractRows(input: ReportInput): AgentId[] {
  if (input.requiredContractIds === undefined) return [];
  return [...input.requiredContractIds].filter((id) => !input.contracts.some((row) => row.agent === id));
}

export function staleContractLines(input: ReportInput): string[] {
  // CONTRACT-STALE (the table no longer describes the binary) and
  // KNOWN-BREAK (a recorded break removes enforcement at some autonomy
  // level) are both called out, but under their own switches (audit D15):
  // allowing a stale table is not allowing a known enforcement gap. A
  // mitigated break (the sandbox closes it, and the gate probes sandboxed)
  // never fails and carries `(mitigated)` in the table, so it gets no
  // callout either.
  const lines: string[] = [];
  // Every interpolated value escapes like the table does (round 11, edges
  // 11; round 16, contracts 6): the contract detail carries harness
  // --version output and error text, and a control byte in the summary
  // line would reach the report raw.
  const stale = input.contracts.filter((row) => row.verdict === "CONTRACT-STALE");
  if (stale.length > 0) {
    const head = `live-gate: ${stale.length} stale version contract(s): ` +
      `${stale.map((row) => `${row.agent} ${escapeControls(row.version)} (${escapeControls(row.detail)})`).join("; ")}`;
    lines.push(input.allowStaleContracts ? `${head} — allowed by --allow-stale-contracts` : head);
  }
  const broken = input.contracts.filter((row) => row.verdict === "KNOWN-BREAK" && !row.mitigated);
  if (broken.length > 0) {
    const head = `live-gate: ${broken.length} known-broken version contract(s): ` +
      `${broken.map((row) => `${row.agent} ${escapeControls(row.version)} (${escapeControls(row.detail)})`).join("; ")}`;
    lines.push(input.allowKnownBreaks ? `${head} — allowed by --allow-known-breaks` : head);
  }
  return lines;
}

export function formatReport(input: ReportInput): string {
  const totals = countRows(input.rows);
  const scope = input.only ? `Scope: --only ${[...input.only].join(",")} (installed harnesses only).` : "Scope: all installed harnesses.";
  const lines = [
    `Codemux: ${escapeControls(input.codemux)}`,
    `Codemux version: ${escapeControls(input.version)}`,
    // The header names the build under test; a stamp that could not be
    // read fails the gate (gateFailed), so the report says so itself.
    ...(input.version === "unreadable"
      ? ["live-gate: the candidate's --version failed; the report cannot name the build it tested and the gate fails"]
      : []),
    scope,
    // The NOTE line embeds the operator's --codemux path; it escapes like
    // every other interpolation (round 20, contracts finding 1: this was
    // the one line that did not).
    ...(input.matrixNote === undefined ? [] : [escapeControls(input.matrixNote)]),
    `Probes: ${input.probes.join(",")}${input.probes.includes("H") || input.probes.length !== DEFAULT_PROBES.length ? "" : " (H provider-override is opt-in: --probe provider-override)"}`,
    "",
    "| Agent | Probe | Result | Seconds | Note |",
    "| --- | --- | --- | ---: | --- |",
  ];
  for (const row of input.rows) {
    for (const letter of input.probes) {
      const result = row.results[letter];
      if (!result) continue;
      lines.push(`| ${row.agent} | ${letter} ${PROBE_LABELS[letter]} | ${resultCell(result)} | ${result.seconds.toFixed(1)} | ${noteCell(result)} |`);
    }
  }
  if (input.contracts.length > 0) {
    lines.push("", "Version contracts (zero quota):", "| Agent | Version | Min | Audited ceiling | Verdict |", "| --- | --- | --- | --- | --- |");
    for (const row of input.contracts) {
      // The mitigated marker rides the verdict word (audit D15): the break
      // is real but the gate's own sandboxed runs close it.
      const verdict = row.verdict === "KNOWN-BREAK" && row.mitigated ? "KNOWN-BREAK (mitigated)" : row.verdict;
      lines.push(`| ${row.agent} | ${cell(row.version)} | ${cell(row.min)} | ${cell(row.ceiling)} | ${verdict}${row.detail ? ` (${cell(row.detail)})` : ""} |`);
    }
  }
  lines.push("", `usage --json: ${input.usage.status} (${cell(input.usage.detail)})`);
  lines.push(`Keychain hygiene: ${input.keychainDrift == null ? "PASS (user search list and default keychain unchanged, or nothing to observe)" : `FAIL (${cell(input.keychainDrift.split("\n")[0] ?? "")})`}`);
  lines.push("", `live-gate (${escapeControls(input.codemux)}): ${totals.pass} pass, ${totals.fail} fail, ${totals.skip} skip, ${totals.unsupported} unsupported`);
  lines.push(...staleContractLines(input));
  const missing = missingContractRows(input);
  if (missing.length > 0) {
    lines.push(
      `live-gate: no version contract row for ${missing.join(", ")} (the candidate lists them as available; the gate cannot certify a harness it never checked)`
    );
  }
  if (!hasProbes(input.rows)) {
    // Unsupported cells are structural (the capability matrix), not operator
    // choices; "(all skipped)" means every cell that could run was skipped.
    const cells = input.rows.flatMap((row) => Object.values(row.results));
    const allSkipped = cells.some((result) => result?.status === "SKIP")
      && cells.every((result) => result?.status === "SKIP" || result?.status === "UNSUPPORTED");
    lines.push(`live-gate: nothing was probed${allSkipped ? " (all skipped)" : ""}`);
  }
  return lines.join("\n");
}

/** Everything that fails the gate: a failed probe row, a stale, unreadable,
 * or untrusted contract without its allowance, a known break without the
 * mitigation or its allowance, a required contract row that is missing, a
 * failed usage check, no probes at all, or a candidate whose `--version`
 * could not be read — a report that cannot name the build it tested
 * certifies nothing (review round 5, edges finding 3). */
export function gateFailed(input: ReportInput): boolean {
  return countRows(input.rows).fail > 0
    || input.version === "unreadable"
    // An available harness whose version could not be read or whose binary
    // failed the trust check has no established contract, whatever its
    // probes did (round 29, edges 1); NO-CONTRACT is the documented state
    // of harnesses without a contract and does not fail.
    || (!input.allowStaleContracts && input.contracts.some(
      (row) => row.verdict === "CONTRACT-STALE"
        || row.verdict === "UNREADABLE" || row.verdict === "UNTRUSTED"))
    // A KNOWN-BREAK the sandbox mitigates does not fail the gate (audit
    // D15): the gate probes sandboxed by default (`codemux run -s`), so
    // the probe runs already close the gap the record names. An
    // unmitigated break fails unless --allow-known-breaks says otherwise.
    || (!input.allowKnownBreaks && input.contracts.some(
      (row) => row.verdict === "KNOWN-BREAK" && !row.mitigated))
    || missingContractRows(input).length > 0
    || input.usage.status === "FAIL"
    || (input.keychainDrift != null)
    || !hasProbes(input.rows);
}

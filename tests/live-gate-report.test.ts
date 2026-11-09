// Report rendering and gate verdicts for the live gate.
// scripts/live-gate/report.ts owns the report and its totals.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { formatReport, type GateRow } from "../scripts/live-gate.js";
import { countRows, gateFailed, hasProbes } from "../scripts/live-gate/report.js";
import { ROOT, passRow, reportInput } from "./helpers/live-gate.js";

test("a skip or unsupported cell never counts as a pass", () => {
  const skipped: GateRow = { agent: "gemini", results: { A: { status: "SKIP", seconds: 0, stderr: "" }, B: { status: "SKIP", seconds: 0, stderr: "" } } };
  expect(countRows([skipped])).toEqual({ pass: 0, fail: 0, skip: 2, unsupported: 0 });
  expect(hasProbes([skipped])).toBe(false);
  expect(gateFailed(reportInput({ rows: [skipped], probes: ["A", "B"] }))).toBe(true);
  const unsupported: GateRow = { agent: "cursor", results: { C: { status: "UNSUPPORTED", seconds: 0, stderr: "", note: "no capability" } } };
  expect(countRows([unsupported])).toEqual({ pass: 0, fail: 0, skip: 0, unsupported: 1 });
  expect(hasProbes([unsupported])).toBe(false);
  expect(gateFailed(reportInput({ rows: [unsupported], probes: ["C"] }))).toBe(true);
  expect(countRows([passRow("claude", ["A"])])).toEqual({ pass: 1, fail: 0, skip: 0, unsupported: 0 });
  expect(gateFailed(reportInput({ rows: [passRow("claude", ["A"])], probes: ["A"] }))).toBe(false);
});

test("an unreadable candidate version fails the gate and the report says so", () => {
  // Review round 5, edges finding 3: a candidate whose --version failed
  // kept its probes' verdict but left the gate's exit code green.
  const input = reportInput({ rows: [passRow("claude", ["A"])], version: "unreadable", probes: ["A"] });
  expect(gateFailed(input)).toBe(true);
  const report = formatReport(input);
  expect(report).toContain("Codemux version: unreadable");
  expect(report).toContain("the candidate's --version failed");
  expect(gateFailed({ ...input, version: "2.0.0" })).toBe(false);
});

test("a pipe or control byte in a skip note or a contract cell cannot split the table (round 11, edges 11)", () => {
  // The skip note and the contract version arrive from the operator and
  // the harness; raw, a "|" in them opens a new column and a control
  // byte rides to the terminal. They escape like every other cell.
  const input = reportInput({
    rows: [{
      agent: "gemini",
      results: { A: { status: "SKIP", seconds: 0, stderr: "", note: "operator | said \x1b[31mskip\x1b[0m" } },
    }],
    contracts: [{
      agent: "claude" as const, version: "2.1.300 | \x1b injected", min: "2.0.0", ceiling: "2.1.280",
      verdict: "SUPPORTED" as const, detail: "",
    }],
    version: "2.0.0",
    probes: ["A"],
  });
  const report = formatReport(input);
  expect(report).toContain("SKIP (operator &#124; said \\u001b[31mskip\\u001b[0m)");
  expect(report).toContain("| claude | 2.1.300 &#124; \\u001b injected | 2.0.0 | 2.1.280 | SUPPORTED |");
  expect(report).not.toContain("|\x1b");
  expect(report).not.toContain("\x1b");
});

test("no raw control byte survives anywhere in the report, the stale-contract summary and the candidate NOTE included (round 16, contracts 6; round 20, contracts 1)", () => {
  // The stale-contract summary interpolated row.detail raw while the
  // table escaped the same value, so a harness --version output carrying
  // an ESC reached the report line. The candidate NOTE was the same gap
  // for the operator's --codemux path (a filename with ESC or a newline
  // is legal on macOS). Every interpolation escapes.
  const candidate = "/tmp/can\x1bdidate\nco-demux";
  const input = reportInput({
    rows: [{
      agent: "gemini",
      results: { A: { status: "FAIL", seconds: 1, stderr: "boom \x1b[31mnow", note: "Warning: \x07 bell" } },
    }],
    contracts: [{
      agent: "claude" as const, version: "2.1.300", min: "2.0.0", ceiling: "2.1.280",
      verdict: "CONTRACT-STALE" as const, detail: "claude --version printed \x1b[31mRED\x1b[0m",
    }],
    version: "2.0.0",
    probes: ["A"],
    matrixNote: `NOTE: the probe matrix comes from the candidate (${candidate} list --json), not this checkout's adapters`,
  });
  const report = formatReport(input);
  expect(report).toContain(
    "live-gate: 1 stale version contract(s): claude 2.1.300 (claude --version printed \\u001b[31mRED\\u001b[0m)"
  );
  // The NOTE line escapes the candidate path it embeds: ESC and the
  // newline never reach the report raw.
  expect(report).toContain(
    "NOTE: the probe matrix comes from the candidate (/tmp/can\\u001bdidate\\u000aco-demux list --json), not this checkout's adapters"
  );
  for (const line of report.split("\n")) {
    expect(line).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  }
});

test("live gate reports per-probe rows, warnings, contracts, usage, and the version stamp", () => {
  const rows: GateRow[] = [
    passRow("codex", ["A", "B"]),
    {
      agent: "claude",
      results: {
        A: { status: "FAIL", seconds: 2, stderr: "first | failure", note: "Warning: claude 2.1.300 is newer than the 2.1.280 this Codemux audited" },
        B: { status: "PASS", seconds: 1, stderr: "", note: "Warning: unaudited build" },
      },
    },
    {
      agent: "gemini",
      results: {
        A: { status: "SKIP", seconds: 0, stderr: "", note: "no credentials; operator requested" },
        B: { status: "UNSUPPORTED", seconds: 0, stderr: "", note: "documented reason" },
      },
    },
  ];
  const contracts = [
    { agent: "codex" as const, version: "0.165.0", min: "0.147.0", ceiling: "0.165.0", verdict: "SUPPORTED" as const, detail: "" },
    { agent: "claude" as const, version: "2.1.300", min: "2.0.0", ceiling: "2.1.280", verdict: "CONTRACT-STALE" as const, detail: "claude 2.1.300 is newer than the 2.1.280 this Codemux audited" },
  ];
  const input = reportInput({
    rows, contracts,
    usage: { status: "PASS", detail: "usagemux answered a parseable snapshot" },
    version: "2.0.0",
    probes: ["A", "B"],
  });
  const report = formatReport(input);
  const lines = report.split("\n");
  expect(lines[0]).toBe(`Codemux: ${join(ROOT, "bin/codemux")}`);
  expect(lines[1]).toBe("Codemux version: 2.0.0");
  expect(lines[3]).toBe("Probes: A,B");
  expect(lines[5]).toBe("| Agent | Probe | Result | Seconds | Note |");
  expect(report).toContain("| claude | A read-only reply | FAIL | 2.0 | first &#124; failure; Warning: claude 2.1.300 is newer than the 2.1.280 this Codemux audited |");
  expect(report).toContain("| claude | B medium shell | PASS | 1.0 | Warning: unaudited build |");
  expect(report).toContain("| gemini | A read-only reply | SKIP (no credentials; operator requested) | 0.0 |  |");
  expect(report).toContain("| gemini | B medium shell | UNSUPPORTED (documented): documented reason | 0.0 |  |");
  expect(report).toContain("| claude | 2.1.300 | 2.0.0 | 2.1.280 | CONTRACT-STALE (claude 2.1.300 is newer than the 2.1.280 this Codemux audited) |");
  expect(report).toContain("usage --json: PASS (usagemux answered a parseable snapshot)");
  expect(report).toContain(`live-gate (${join(ROOT, "bin/codemux")}): 3 pass, 1 fail, 1 skip, 1 unsupported`);
  expect(report).toContain("live-gate: 1 stale version contract(s): claude 2.1.300");
  expect(gateFailed(input)).toBe(true);
  expect(gateFailed({ ...input, allowStaleContracts: true, rows: [passRow("claude", ["A"])] })).toBe(false);
  const allowed = formatReport({ ...input, allowStaleContracts: true });
  expect(allowed).toContain("allowed by --allow-stale-contracts");
  expect(gateFailed({ ...input, allowStaleContracts: true })).toBe(true);
});

test("a known break fails under its own allowance, not --allow-stale-contracts (audit D15)", () => {
  // Allowing a stale table (the binary outran the audit) is a different
  // judgment from allowing a known enforcement gap, so the two have
  // separate switches; the stale allowance no longer covers a break.
  const unmitigated = reportInput({
    rows: [passRow("opencode", ["A"])],
    contracts: [{
      agent: "opencode" as const, version: "1.18.18", min: "1.18.10", ceiling: "1.18.18",
      verdict: "KNOWN-BREAK" as const,
      detail: "known break at high autonomy from 1.18.18 (no mitigation): auto-approve ignores its flag",
    }],
    probes: ["A"],
  });
  expect(gateFailed(unmitigated)).toBe(true);
  expect(gateFailed({ ...unmitigated, allowStaleContracts: true })).toBe(true);
  expect(gateFailed({ ...unmitigated, allowKnownBreaks: true })).toBe(false);
  expect(formatReport(unmitigated)).toContain(
    "live-gate: 1 known-broken version contract(s): opencode 1.18.18"
  );
  expect(formatReport({ ...unmitigated, allowKnownBreaks: true })).toContain(
    "allowed by --allow-known-breaks"
  );
});

test("a sandbox-mitigated known break does not fail the gate (audit D15)", () => {
  // The gate's probes run sandboxed by default (`codemux run -s`), so a
  // break whose record says the sandbox mitigates it is closed in every
  // probe the gate runs: the table says KNOWN-BREAK (mitigated) and the
  // gate stays green with no allowance flag at all.
  const mitigated = reportInput({
    rows: [passRow("opencode", ["A"])],
    contracts: [{
      agent: "opencode" as const, version: "1.18.18", min: "1.18.10", ceiling: "1.18.18",
      verdict: "KNOWN-BREAK" as const,
      detail: "known break at low and medium autonomy from 1.18.18 (sandbox mitigates): the deny shorthand is ignored",
      mitigated: true,
    }],
    probes: ["A"],
  });
  expect(gateFailed(mitigated)).toBe(false);
  const report = formatReport(mitigated);
  expect(report).toContain("| opencode | 1.18.18 | 1.18.10 | 1.18.18 | KNOWN-BREAK (mitigated)");
  // The callout is reserved for breaks that still bite.
  expect(report).not.toContain("known-broken version contract");
});

test("a gate whose only passing cells are print-sandbox probes did not probe (review round 48)", () => {
  // P spends nothing and needs no credential, so it proves nothing about a
  // harness's login; a credentialless harness with every authenticated
  // probe skipped and P passing must not pass the gate.
  expect(hasProbes([passRow("gemini", ["P"])])).toBe(false);
  // The sandbox policy probe starts no harness either (2026-11-06): J and
  // P together still probed nothing.
  expect(hasProbes([passRow("gemini", ["J"])])).toBe(false);
  expect(hasProbes([passRow("gemini", ["J", "P"])])).toBe(false);
  expect(gateFailed(reportInput({ rows: [passRow("gemini", ["J", "P"])], probes: ["A", "J", "P"] }))).toBe(true);
  expect(hasProbes([passRow("claude", ["J", "P", "H2"])])).toBe(true);
  expect(hasProbes([passRow("claude", ["P", "A"])])).toBe(true);
  expect(gateFailed(reportInput({ rows: [passRow("gemini", ["P"])], probes: ["A", "P"] }))).toBe(true);
});

test("a Keychain drift fails the gate and prints as its own line; none passes (review round 52)", () => {
  const { formatReport } = require("../scripts/live-gate/report.js") as typeof import("../scripts/live-gate/report.js");
  const clean = reportInput({ rows: [passRow("claude", ["A"])], probes: ["A"] });
  expect(gateFailed(clean)).toBe(false);
  expect(formatReport(clean)).toContain("Keychain hygiene: PASS");
  const drifted = reportInput({ rows: [passRow("claude", ["A"])], probes: ["A"], keychainDrift: "the user Keychain search list or default keychain changed during this probe\nbefore:\na\nafter:\nb" });
  expect(gateFailed(drifted)).toBe(true);
  expect(formatReport(drifted)).toContain("Keychain hygiene: FAIL");
});

test("the report prints one summary line per harness and calls out a base-only row (parity pass)", () => {
  // The headline totals hid a harness whose every capability cell was
  // UNSUPPORTED or SKIP: one line per harness names how many of its cells
  // were judged, and a row judged only on the base pair (A, B) says so,
  // because no capability probe ran for it.
  const rows: GateRow[] = [
    passRow("claude", ["A", "B", "C"]),
    {
      agent: "qwen",
      results: {
        A: { status: "PASS", seconds: 1, stderr: "" },
        B: { status: "FAIL", seconds: 1, stderr: "boom" },
        C: { status: "UNSUPPORTED", seconds: 0, stderr: "", note: "no capability" },
        D: { status: "SKIP", seconds: 0, stderr: "", note: "no credentials detected: a store" },
      },
    },
  ];
  const report = formatReport(reportInput({ rows, probes: ["A", "B", "C", "D"] }));
  expect(report).toContain("Harness claude: 3 of 3 cells probed (3 pass, 0 fail, 0 skip, 0 unsupported)");
  expect(report).toContain(
    "Harness qwen: 2 of 4 cells probed (1 pass, 1 fail, 1 skip, 1 unsupported); only the base probes (A, B) were judged"
  );
  // A harness with a judged capability cell carries no base-only callout.
  expect(report).not.toContain("(3 pass, 0 fail, 0 skip, 0 unsupported); only the base probes");
  // The lines sit after the probe table, before the contract table.
  const lines = report.split("\n");
  expect(lines.findIndex((line) => line.startsWith("Harness claude:")))
    .toBeGreaterThan(lines.findIndex((line) => line.startsWith("| Agent | Probe |")));
});

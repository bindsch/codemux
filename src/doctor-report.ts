/**
 * The machine check's two spellings: the human table `codemux doctor`
 * prints by default and the `--format json` document (schema
 * `codemux-doctor-1`). The human table is one row per harness —
 * `agent | installed | version | contract | floors | login | usage |
 * sandbox | state | remedy` — then the environment block, then the
 * summary. The JSON document carries the same rows machine-readably
 * (control characters escaped, usagemux's messages included verbatim);
 * it is what `make machine-check` consumes.
 */

import type { EnvironmentRow, MachineCheckReport } from "./doctor-model.js";
import { escapeJsonControls } from "./labels.js";

const cell = (value: string): string => value.replaceAll("|", "\\|");

const environmentStateLine = (name: string, row: EnvironmentRow): string => {
  const parts = [name, row.state, row.detail];
  if (row.remedy !== null) parts.push(`remedy: ${row.remedy}`);
  return parts.join(": ");
};

/** The human table. Mirrors `verify`'s markdown shape. */
export function renderMachineCheckHuman(report: MachineCheckReport): string {
  const lines: string[] = [];
  lines.push("Machine health check (no model requests; `--spend` adds one per eligible harness)");
  lines.push("");
  lines.push("| Agent | Installed | Version | Contract | Floors | Login | Usage | Sandbox | State | Remedy |");
  lines.push("|-------|-----------|---------|----------|--------|-------|-------|---------|-------|--------|");
  for (const row of report.harnesses) {
    lines.push(
      `| ${cell(row.id)} | ${row.installed ? "yes" : "no"} | ${cell(row.checks.version ?? "-")} | ` +
        `${cell(row.checks.contract)} | ${cell(row.checks.floors)} | ${cell(row.checks.login)} | ` +
        `${cell(row.checks.usage)} | ${cell(row.checks.sandbox)} | ${cell(row.state)} | ` +
        `${cell(row.remedy ?? "")} |`
    );
  }
  lines.push("");
  lines.push("Environment:");
  for (const [name, row] of Object.entries(report.environment)) {
    const mark = row.severity === "broken" ? "❌" : row.severity === "warn" ? "⚠️ " : row.severity === "info" ? "·" : "✅";
    lines.push(`  ${mark} ${environmentStateLine(name, row)}`);
  }
  for (const row of report.harnesses) {
    if (row.detail.length > 0) {
      lines.push("");
      lines.push(`${row.id}:`);
      for (const line of row.detail) lines.push(`  - ${line}`);
    }
  }
  const summary = report.summary;
  lines.push("");
  lines.push(
    `Summary: ${summary.ok} ok, ${summary.warn} warn, ${summary.broken} broken, ${summary.notInstalled} not installed`
  );
  return lines.join("\n");
}

/** The JSON document: `{schema, codemux, environment, harnesses, summary,
 * exitCode}` with one `{id, state, checks, remedy}` entry per harness and
 * the account fingerprint (never a name) only in this spelling. */
export function renderMachineCheckJson(report: MachineCheckReport): string {
  const document = {
    schema: report.schema,
    codemux: report.codemux,
    environment: report.environment,
    harnesses: report.harnesses.map((row) => ({
      id: row.id,
      installed: row.installed,
      state: row.state,
      severity: row.severity,
      checks: row.checks,
      remedy: row.remedy,
      detail: row.detail,
      spend: row.spend,
      // The only place an account appears, and only as a short hash
      // prefix: enough to tell two accounts apart, never a name.
      accountFingerprint: row.accountFingerprint,
      accountPresent: row.accountPresent,
    })),
    summary: report.summary,
    exitCode: report.exitCode,
  };
  return escapeJsonControls(JSON.stringify(document, null, 2));
}

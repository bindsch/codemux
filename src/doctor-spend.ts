import { join } from "node:path";
/**
 * Stage 4 of the machine check, the only paid stage: at most one real
 * `codemux check` request per eligible harness, labeled
 * `machine-check=<date>` so `codemux calls --label machine-check=<date>
 * --sum` reports exactly what the check cost. It never runs unless the
 * caller passed --spend, and it skips every harness the free stages
 * already refused.
 */

import { runCapturedCommand } from "./process-runner.js";
import { remedyFor } from "./doctor-remedies.js";
import type { HarnessRow, MachineCheckFlags } from "./doctor-model.js";
import type { AgentId } from "./types.js";

export const MACHINE_CHECK_LABEL_KEY = "machine-check";

/** The argv of one spend probe: one real request, read-only, sandboxed,
 * labeled so `codemux calls --label machine-check=<date> --sum` reports
 * what the check cost. */
export const spendProbeArgv = (agent: AgentId, isoDate: string): string[] => [
  "check",
  "-a",
  agent,
  "--auto",
  "read-only",
  "--timeout",
  "120",
  "--label",
  `${MACHINE_CHECK_LABEL_KEY}=${isoDate}`,
];

export interface SpendProbeOutcome {
  ok: boolean;
  detail: string;
}

/** One `codemux check` child process. Exported for the tests (spyOn) so
 * a test never spends a request. */
/** The running codemux, invoked the way the launcher invokes it (bun with
 * the runtime config and this checkout's entry point), so a doctor run by
 * absolute path never spends through another installation on PATH
 * (review round 39). */
export const spendProbeCommand = (): string[] => {
  const root = join(import.meta.dir, "..");
  return [
    process.execPath,
    "--no-env-file",
    "--no-install",
    `--config=${join(root, "bunfig.runtime.toml")}`,
    join(root, "src", "index.ts"),
  ];
};

/** The seam the tests point at a recording fake, so no test spends. */
export const spendProbe = { command: spendProbeCommand };

export const runSpendProbe = async (agent: AgentId, isoDate: string): Promise<SpendProbeOutcome> => {
  try {
    const result = await runCapturedCommand([...spendProbe.command(), ...spendProbeArgv(agent, isoDate)], {
      cwd: process.cwd(),
      env: process.env as unknown as Record<string, string>,
      timeoutMs: 150_000,
    });
    if (result.success) return { ok: true, detail: "answered OK" };
    const first = `${result.stderr}\n${result.stdout}`.trim().split("\n")[0] ?? "";
    return { ok: false, detail: first === "" ? `codemux check exited ${result.exitCode}` : first };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error),
    };
  }
};

// One label per run: two checks on one day must not fold into one
// `calls --label` total (review round 52), nor two started inside one
// second (round 307), nor two inside one millisecond (round 310): the
// stamp carries the process id and a per-process counter after the
// millisecond timestamp. Colons are dropped so the value stays a plain
// label token.
let machineCheckLabelSerial = 0;
export const machineCheckLabelValue = (): string =>
  `${new Date().toISOString().replace(/:/g, "")}-${process.pid}-${++machineCheckLabelSerial}`;

export async function applySpendStage(
  rows: HarnessRow[],
  flags: MachineCheckFlags
): Promise<void> {
  if (flags.spend !== true) return;
  const eligible = rows.filter(
    (row) =>
      row.installed &&
      // OK and LOGIN-UNKNOWN are the spendable states; an unreadable
      // usage row (QUOTA-UNREADABLE, warn) joins them only under
      // --spend-unreadable, which exists for exactly that case.
      (row.state === "OK" ||
        row.state === "LOGIN-UNKNOWN" ||
        (flags.spendUnreadable === true && row.state === "QUOTA-UNREADABLE")) &&
      // The gate would refuse anyway; spending there buys a refusal. An
      // active override skips the native gate, so its row stays eligible
      // (review round 57).
      (row.usageVerdict !== "refuse" || row.overrideActive) &&
      // An active override routes the probe to its own provider: the
      // native usage row is irrelevant to it (review round 51).
      (flags.spendUnreadable === true || row.usageReadable || row.overrideActive)
  );
  const cap = flags.spendCap ?? eligible.length;
  const isoDate = machineCheckLabelValue();
  for (const row of eligible.slice(0, cap)) {
    const outcome = await runSpendProbe(row.id, isoDate);
    row.spend = outcome;
    if (!outcome.ok) {
      row.state = "PROBE-FAILED";
      row.severity = "broken";
      row.detail.push(outcome.detail);
      row.remedy = remedyFor(row.id, "PROBE-FAILED");
    }
  }
}

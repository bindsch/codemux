import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunRequest, RunResult } from "./types.js";
import type { PiMcpRunContext } from "./pi-mcp-launch.js";
import { createPiHermeticAgentDir, type PiProviderAgentDir } from "./pi-provider.js";
import { readUtf8FileBounded } from "./file-io.js";
import { piResult } from "./result-envelope/pi.js";
import { installPiBudgetExtension, piBudgetUsage, piBudgetModel, type PiBudgetUsage } from "./pi-budget-extension.js";

const MAX_BUDGET_EVIDENCE_BYTES = 1024 * 1024;
export interface PiBudgetArtifact {
  path: string;
  evidencePath: string;
  limit: number;
  directory: PiProviderAgentDir;
}
export type PiBudgetRunContext = PiMcpRunContext & { piBudget?: PiBudgetArtifact };

export function piBudgetExtensionSource(limit: number, evidencePath: string): string {
  return `import { appendFileSync } from "node:fs";\n` +
    `const piBudgetUsage = ${piBudgetUsage.toString()};\n` +
    `const piBudgetModel = ${piBudgetModel.toString()};\n` +
    `const install = ${installPiBudgetExtension.toString()};\n` +
    `export default function(pi) { let bytes=0; install(pi, {limit:${JSON.stringify(limit)}, record(kind,fields) {\n` +
    ` const line=JSON.stringify({kind,...fields})+"\\n"; bytes+=Buffer.byteLength(line);\n` +
    ` if(bytes>${MAX_BUDGET_EVIDENCE_BYTES}) throw new Error("Pi budget evidence exceeded its bound");\n` +
    ` appendFileSync(${JSON.stringify(evidencePath)},line,{mode:0o600});\n` +
    `}}); }\n`;
}

export function preparePiBudget(request: RunRequest, context: PiMcpRunContext, realAgentDir: string): PiBudgetRunContext {
  if (request.maxBudgetUsd === undefined) return context;
  const directory = createPiHermeticAgentDir(realAgentDir, null, undefined, false);
  try {
    const path = join(directory.path, "budget.mjs");
    const evidencePath = join(directory.path, "budget-evidence.jsonl");
    writeFileSync(evidencePath, "", { mode: 0o600, flag: "wx" });
    writeFileSync(path, piBudgetExtensionSource(request.maxBudgetUsd, evidencePath), { mode: 0o600, flag: "wx" });
    return { ...context, piBudget: { path, evidencePath, limit: request.maxBudgetUsd, directory } };
  } catch (error) { directory.finalize(); throw error; }
}

/** Native JSON output independently proves that every completed charge was recorded. */
export function verifyPiBudget(artifact: PiBudgetArtifact, stdout: string): { total: number; exhausted: boolean } {
  const evidence = readUtf8FileBounded(artifact.evidencePath, {
    maxBytes: MAX_BUDGET_EVIDENCE_BYTES, label: "Pi budget evidence", noFollow: true,
  });
  if (!evidence.endsWith("\n")) throw new Error("Pi budget evidence is missing or truncated");
  const records = evidence.trimEnd().split("\n").map((line) => JSON.parse(line));
  if (records[0]?.kind !== "installed" || records[0]?.limit !== artifact.limit) throw new Error("Pi budget extension did not confirm its limit");
  let total = 0;
  let requests = 0;
  const charges: { source: string; usage: PiBudgetUsage }[] = [];
  let settled = false;
  for (const record of records.slice(1)) {
    if (settled) throw new Error("Pi budget evidence continues after settlement");
    if (record.kind === "failure") throw new Error(`Pi budget failed closed: ${record.message}`);
    if (record.kind === "charge") {
      if (total >= artifact.limit) throw new Error("Pi continued spending after its USD budget");
      if (record.source !== "assistant" && record.source !== "compaction") throw new Error("Unknown Pi budget charge source");
      const usage = piBudgetUsage(record.usage);
      total += usage.cost.total;
      if (!Number.isFinite(total) || record.total !== total || record.status !== (total >= artifact.limit ? "exhausted" : "active"))
        throw new Error("Pi budget accounting totals disagree");
      charges.push({ source: record.source, usage });
    } else if (record.kind === "request") {
      if (total >= artifact.limit) throw new Error("Pi requested a provider after its USD budget");
      piBudgetModel(record.model);
      requests += 1;
    } else if (record.kind === "settled") {
      if (record.total !== total || record.charges !== charges.length || record.status !== (total >= artifact.limit ? "exhausted" : "active"))
        throw new Error("Pi budget settlement disagrees with its charges");
      settled = true;
    } else if (record.kind !== "blocked" || total < artifact.limit) throw new Error("Unknown Pi budget evidence event");
  }
  if (!settled || charges.length === 0 || requests !== charges.filter((charge) => charge.source === "assistant").length)
    throw new Error("Pi budget lacks settled cost or pricing evidence");
  const native: typeof charges = [];
  for (const line of stdout.split("\n").filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.type === "message_end" && event.message?.role === "assistant")
      native.push({ source: "assistant", usage: piBudgetUsage(event.message.usage) });
    if (event.type === "compaction_end" && event.result)
      native.push({ source: "compaction", usage: piBudgetUsage(event.result.usage) });
  }
  if (JSON.stringify(native) !== JSON.stringify(charges)) throw new Error("Pi budget evidence does not match native usage");
  return { total, exhausted: total >= artifact.limit };
}

export function piBudgetResult(result: RunResult, request: RunRequest, context?: PiBudgetRunContext): RunResult {
  let verdict: { total: number; exhausted: boolean } | undefined;
  let diagnostic: string | undefined;
  try {
    if (!context?.piBudget) throw new Error("Pi budget artifacts were not prepared");
    verdict = verifyPiBudget(context.piBudget, result.stdout);
    if (verdict.exhausted) diagnostic = `Pi reached its soft USD budget of ${context.piBudget.limit}`;
  } catch (error) { diagnostic = error instanceof Error ? error.message : String(error); }
  let parsed = piResult(result, request);
  if (diagnostic) parsed = { ...parsed, success: false, exitCode: parsed.exitCode || 1,
    stderr: `${parsed.stderr}${parsed.stderr && !parsed.stderr.endsWith("\n") ? "\n" : ""}codemux: ${diagnostic}\n` };
  try {
    const envelope = JSON.parse(parsed.stdout);
    if (verdict) { envelope.usage.cost_usd = verdict.total; envelope.codemux.usage.cost_usd = verdict.total; }
    envelope.codemux.recording = context?.experimentRecording ?? null;
    if (diagnostic) envelope.codemux.failure_code = verdict?.exhausted ? "budget-limit" : "budget-evidence-invalid";
    return { ...parsed, usage: envelope.usage, scanSurface: result.stdout,
      stdout: request.resultJson ? `${JSON.stringify(envelope)}\n` : envelope.reply };
  } catch { return parsed; }
}

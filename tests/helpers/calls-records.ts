import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CALL_LOG_ENV } from "../../src/call-log.js";
import { runCli } from "./cli.js";

// `codemux calls` reads the ledger the rest of the suite writes through
// the preload's CODEMUX_TEST_LEDGER redirect; these tests point the
// command at their own ledger files instead, so every option is
// exercised against known contents.

function ledgerDir(): string {
  return mkdtempSync(join(tmpdir(), "codemux-calls-ledger-"));
}

interface RecordSpec {
  ts: string;
  agent?: string;
  kind?: string;
  input?: number | null;
  output?: number | null;
  cached?: number | null;
  total?: number | null;
  cost?: number | null;
  /** Written only when given: an omitted field is the older-ledger shape. */
  costSource?: "billed" | "harness-estimate" | "subscription-zero" | null;
  model?: string | null;
  modelEffective?: string | null;
  finish?: string | null;
  exitCode?: number | null;
  sessionId?: string | null;
}

function record(spec: RecordSpec): string {
  return JSON.stringify({
    ts: spec.ts,
    kind: spec.kind ?? "run",
    agent: spec.agent ?? "claude",
    model: spec.model ?? null,
    model_effective: spec.modelEffective ?? null,
    provider: "default",
    session_id: spec.sessionId ?? null,
    turn_id: null,
    autonomy: "read-only",
    hermetic: false,
    sandboxed: false,
    exit_code: spec.exitCode ?? 0,
    finish: spec.finish ?? null,
    duration_ms: 10,
    cwd: "/repo",
    // A figure without an explicit source is a billed one; `costSource: null`
    // builds a line older than the field (review round 39).
    ...(spec.costSource === null
      ? {}
      : { cost_source: spec.costSource ?? (typeof spec.cost === "number" ? "billed" : null) }),
    usage: {
      input_tokens: spec.input ?? null,
      output_tokens: spec.output ?? null,
      cached_input_tokens: spec.cached ?? null,
      total_tokens: spec.total ?? null,
      cost_usd: spec.cost ?? null,
    },
  });
}

async function callsWith(
  lines: string[],
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const dir = ledgerDir();
  try {
    const path = join(dir, "calls.jsonl");
    writeFileSync(path, lines.length > 0 ? `${lines.join("\n")}\n` : "");
    return await runCli(["calls", ...args], { [CALL_LOG_ENV]: path });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MINUTE = 60_000;
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

export { callsWith, iso, ledgerDir, MINUTE, record };
export type { RecordSpec };

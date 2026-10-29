import { closeSync, constants, openSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ResultUsageBlock } from "./types.js";
import { emptyUsage, reportedCount } from "./result-envelope/common.js";
import { readUtf8FileBounded } from "./file-io.js";

export const MAX_KIMI_WIRE_BYTES = 16 * 1024 * 1024;
const MAX_WORKSPACES = 10_000;

export function readBoundedKimiFile(path: string, limit: number): string {
  return readUtf8FileBounded(path, { maxBytes: limit, label: `kimi file ${path}`, noFollow: true });
}

export function findKimiWireLog(brandHome: string, sessionId: string): string {
  // Native 2.3.2 IDs already include session_; retain older unprefixed inputs.
  const sessionDirectory = sessionId.startsWith("session_") ? sessionId : `session_${sessionId}`;
  const pattern = join(brandHome, "sessions", "*", sessionDirectory, "agents", "main", "wire.jsonl");
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error(`kimi session id is invalid for wire log path: ${pattern}`);
  let workspaces;
  try { workspaces = readdirSync(join(brandHome, "sessions"), { withFileTypes: true }); }
  catch { throw new Error(`kimi wire log is missing: ${pattern}`); }
  if (workspaces.length > MAX_WORKSPACES) throw new Error(`kimi wire log search exceeds ${MAX_WORKSPACES} workspaces: ${pattern}`);
  const matches = workspaces.filter((entry) => entry.isDirectory()).map((entry) =>
    join(brandHome, "sessions", entry.name, sessionDirectory, "agents", "main", "wire.jsonl"));
  const found = matches.filter((path) => {
    try {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      closeSync(fd);
      return true;
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      throw new Error(`kimi wire log cannot be opened: ${path}`, { cause: error });
    }
  });
  if (found.length !== 1) throw new Error(`kimi wire log ${found.length ? "is ambiguous" : "is missing"}: ${pattern}`);
  return found[0]!;
}

export function kimiWireUsage(path: string): ResultUsageBlock {
  const usage = emptyUsage();
  const checkedSum = (...counts: number[]): number => {
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (!Number.isSafeInteger(total)) throw new Error(`kimi wire usage exceeds the safe integer range: ${path}`);
    return total;
  };
  const records = readBoundedKimiFile(path, MAX_KIMI_WIRE_BYTES).split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    try { return JSON.parse(line) as Record<string, unknown>; }
    catch { throw new Error(`kimi wire log contains invalid JSON: ${path}`); }
  }).filter((record) => record?.type === "usage.record");
  if (!records.length) return usage;
  const sum = (key: string): number | null => {
    let total = 0;
    for (const record of records) {
      const counts = record.usage;
      const count = counts && typeof counts === "object" ? reportedCount((counts as Record<string, unknown>)[key]) : null;
      if (count === null) return null;
      total = checkedSum(total, count);
    }
    return total;
  };
  usage.input_tokens = sum("inputOther");
  usage.output_tokens = sum("output");
  const read = sum("inputCacheRead"), write = sum("inputCacheCreation");
  if (read !== null && write !== null) usage.cached_input_tokens = checkedSum(read, write);
  if (usage.input_tokens !== null && usage.output_tokens !== null && usage.cached_input_tokens !== null) {
    usage.total_tokens = checkedSum(usage.input_tokens, usage.output_tokens, usage.cached_input_tokens);
  }
  return usage;
}

import { closeSync, constants, fstatSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExperimentRecord } from "./experiment-records.js";

export const MAX_EXPERIMENT_HARNESS_LOG_BYTES = 256 * 1024 * 1024;
const COPY_CHUNK_BYTES = 64 * 1024;

/** Preserve raw harness evidence without changing the experiment verdict. */
export function copyExperimentHarnessLog(harness: "codex" | "kimi", recordingPath: string, runId: string,
  source: () => string | undefined, record: ExperimentRecord): void {
  const suffix = harness === "codex" ? "codex-rollout" : "kimi-wire";
  const path = join(dirname(recordingPath), `${runId}.${suffix}.jsonl`);
  let fields: { bytes: number } | { error: string };
  try {
    const origin = source();
    if (!origin) throw new Error(`Missing ${harness} harness log`);
    fields = { bytes: copyBounded(origin, path) };
  } catch (error) { fields = { error: error instanceof Error ? error.message : String(error) }; }
  try { record("harness_log_copy", { harness, path, ...fields }); }
  catch (error) { console.error(`codemux: cannot record harness log copy: ${String(error)}`); }
}

function copyBounded(source: string, destination: string): number {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const input = openSync(source, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
  let output: number | undefined;
  let complete = false;
  try {
    const stat = fstatSync(input);
    if (!stat.isFile()) throw new Error(`Harness log ${source} is not a regular file`);
    if (stat.size > MAX_EXPERIMENT_HARNESS_LOG_BYTES) throw new Error("Harness log exceeds 256 MiB");
    output = openSync(destination, "wx", 0o600);
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let bytes = 0;
    while (true) {
      const count = readSync(input, buffer, 0, Math.min(buffer.length, MAX_EXPERIMENT_HARNESS_LOG_BYTES + 1 - bytes), null);
      if (!count) break;
      bytes += count;
      if (bytes > MAX_EXPERIMENT_HARNESS_LOG_BYTES) throw new Error("Harness log exceeds 256 MiB");
      let offset = 0;
      while (offset < count) offset += writeSync(output, buffer, offset, count - offset);
    }
    complete = true;
    return bytes;
  } finally {
    try { closeSync(input); }
    finally {
      if (output !== undefined) {
        try { closeSync(output); }
        finally { if (!complete) unlinkSync(destination); }
      }
    }
  }
}

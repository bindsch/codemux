import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, ftruncateSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { copyExperimentHarnessLog, MAX_EXPERIMENT_HARNESS_LOG_BYTES } from "../src/experiment-harness-log.js";
import type { ExperimentRecord } from "../src/experiment-records.js";

function setup() {
  const parent = resolve("scratch/session-14c66a93/exp/h-copy-fixtures");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "copy-"));
  const records: any[] = [];
  const record: ExperimentRecord = (kind, fields) => { records.push({ kind, ...fields }); };
  return { root, records, record, recording: join(root, "run.jsonl"), source: join(root, "source.jsonl") };
}

test.each(["codex", "kimi"] as const)("%s harness copy preserves raw bytes in a private file", (harness) => {
  const { root, records, record, recording, source } = setup();
  const bytes = Buffer.from([0xff, 0, 0x0a, 0x80]);
  writeFileSync(source, bytes);
  copyExperimentHarnessLog(harness, recording, "run", () => source, record);
  const path = join(root, `run.${harness === "codex" ? "codex-rollout" : "kimi-wire"}.jsonl`);
  expect(records).toEqual([{ kind: "harness_log_copy", harness, path, bytes: bytes.length }]);
  expect(readFileSync(path)).toEqual(bytes);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test.each(["missing", "oversized", "symlink", "directory", "existing"])("harness copy failure is recorded without throwing: %s", (reason) => {
  const { root, records, record, recording, source } = setup();
  const destination = join(root, "run.codex-rollout.jsonl");
  if (reason === "oversized") {
    const fd = openSync(source, "wx");
    try { ftruncateSync(fd, MAX_EXPERIMENT_HARNESS_LOG_BYTES + 1); } finally { closeSync(fd); }
  } else if (reason === "symlink") symlinkSync(recording, source);
  else if (reason === "directory") mkdirSync(source);
  else if (reason === "existing") { writeFileSync(source, "new"); writeFileSync(destination, "kept"); }
  expect(() => copyExperimentHarnessLog("codex", recording, "run", () => source, record)).not.toThrow();
  expect(records).toEqual([{ kind: "harness_log_copy", harness: "codex", path: destination, error: expect.any(String) }]);
  if (reason === "existing") expect(readFileSync(destination, "utf8")).toBe("kept");
  else expect(existsSync(destination)).toBe(false);
});

test("log discovery and recording failures cannot replace the run verdict", () => {
  const { records, record, recording } = setup();
  copyExperimentHarnessLog("kimi", recording, "run", () => { throw new Error("discovery failure"); }, record);
  expect(records[0].error).toBe("discovery failure");
  expect(() => copyExperimentHarnessLog("kimi", recording, "run", () => undefined,
    () => { throw new Error("recording failure"); })).not.toThrow();
});

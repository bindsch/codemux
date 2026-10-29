import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ExperimentFailureCode as Code, ExperimentRecording } from "../src/experiment-records.js";

test.each(["run_id", "seq", "kind"])("recording rejects reserved field %s without consuming a sequence", (key) => {
  const parent = resolve("scratch/session-14c66a93/exp/records-r");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "case-"));
  const recording = new ExperimentRecording({ name: "experiment", command: "unused", args: [], env: [],
    recording: cwd }, cwd, {});
  try {
    expect(() => recording.record("harness_item", { [key]: "forged" })).toThrow(`reserved field ${key}`);
    recording.record("failure", { code: Code.Protocol, message: "rejected metadata" });
    recording.close({ code: Code.Protocol, error: "rejected metadata" });
    const records = readFileSync(recording.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((record) => record.seq)).toEqual([0, 1, 2]);
    expect(records.map((record) => record.kind)).toEqual(["run_start", "failure", "run_end"]);
    expect(records.every((record) => record.run_id === recording.runId)).toBe(true);
  } finally { recording.close({ code: null, error: null }); }
});

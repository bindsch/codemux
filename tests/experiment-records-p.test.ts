import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { ExperimentFailureCode as Code, ExperimentRecording } from "../src/experiment-records.js";

test("a failed partial recording write rolls back before failure and run_end records", () => {
  const parent = resolve("scratch/session-14c66a93/exp/records-p");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "case-"));
  let failing = false;
  let writes = 0;
  const failure = new Error("injected transient ENOSPC");
  const writer = (fd: number, bytes: Buffer, offset: number, length: number, position: number) => {
    if (failing && writes++ === 1) { failing = false; throw failure; }
    return writeSync(fd, bytes, offset, failing ? Math.min(length, 12) : length, position);
  };
  const recording = new ExperimentRecording({ name: "experiment", command: process.execPath, args: [], env: [],
    recording: join(cwd, "records") }, cwd, {}, {}, writer);
  try {
    const before = readFileSync(recording.recordingPath);
    failing = true;
    expect(() => recording.record("harness_stdout", { bytes_base64: "unfinished" })).toThrow(failure);
    expect(writes).toBe(2);
    expect(readFileSync(recording.recordingPath)).toEqual(before);
    recording.record("failure", { code: Code.Protocol, message: failure.message });
    recording.close({ code: Code.Protocol, error: failure.message });
    const raw = readFileSync(recording.recordingPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).not.toContain("\0");
    const records = raw.trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((record) => record.kind)).toEqual(["run_start", "failure", "run_end"]);
    expect(records.map((record) => record.seq)).toEqual([0, 1, 2]);
    expect(records.every((record) => record.run_id === recording.runId)).toBe(true);
    expect(records.at(-1)).toMatchObject({ code: Code.Protocol, error: failure.message });
  } finally { recording.close({ code: null, error: null }); }
});

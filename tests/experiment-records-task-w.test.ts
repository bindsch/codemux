import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ExperimentFailureCode as Code, ExperimentRecording } from "../src/experiment-records.js";

function recording() {
  const parent = resolve("scratch/session-14c66a93/exp/records-w");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "case-"));
  return new ExperimentRecording({ name: "experiment", command: "unused", args: [], env: [],
    recording: cwd }, cwd, {});
}

const records = (value: ExperimentRecording) => readFileSync(value.recordingPath, "utf8")
  .trim().split("\n").map((line) => JSON.parse(line));

test("every recording entry defaults to fractional codemux epoch seconds", () => {
  let now = 1_793_272_001_125;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const value = recording();
  try {
    now += 125;
    value.record("harness_stdout", { bytes_base64: "" });
    now += 125;
    value.record("relay_ping", { rpc_id: 7 });
    now += 125;
    value.record("relay_reinitialize", { rpc_id: "reconnect" });
    now += 125;
    value.record("failure", { code: Code.Protocol, message: "test failure" });
    now += 125;
    value.close({ code: Code.Protocol, error: "test failure" });
    const result = records(value);
    expect(result.map((entry) => entry.t)).toEqual([
      1_793_272_001.125, 1_793_272_001.25, 1_793_272_001.375,
      1_793_272_001.5, 1_793_272_001.625, 1_793_272_001.75,
    ]);
    expect(result.map((entry) => entry.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.every((entry) => entry.run_id === value.runId)).toBe(true);
    for (const entry of result) expect(Object.keys(entry).slice(0, 4)).toEqual(["run_id", "seq", "t", "kind"]);
  } finally {
    clock.mockRestore();
    value.close({ code: null, error: null });
  }
});

const timestampedEvents = [
  { kind: "turn", fields: { message_id: "message", usage: null, tool_calls: [], t: 1_700_000_000.125 } },
  { kind: "turn_usage", fields: { message_id: "message", usage: { input: 1, output: 2, cache_read: 0, cache_write: 0 }, t: 1_700_000_000.25 } },
  { kind: "turn_call", fields: { message_id: "message", call_id: "call", name: "bash", t: 1_700_000_000.375 } },
  { kind: "tool_result_delivered", fields: { call_id: "call", t: 1_700_000_000.5 } },
  { kind: "call_ledger", fields: { relay_request_seq: 0, native_call_id: "call", dispatched_t: 1_700_000_000.625,
    delivered_t: 1_700_000_000.75, correlation: "exact", rpc_id: 1, result_sha256: "digest", t: 1_700_000_000.875 } },
];

test.each(timestampedEvents)("the recorder preserves an explicit $kind timestamp", ({ kind, fields }) => {
  const value = recording();
  try {
    value.record(kind, fields);
    value.close({ code: null, error: null });
    const entry = records(value).find((entry) => entry.kind === kind);
    expect(entry).toMatchObject(fields);
    expect(Object.keys(entry).slice(0, 4)).toEqual(["run_id", "seq", "t", "kind"]);
  } finally { value.close({ code: null, error: null }); }
});

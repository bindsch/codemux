import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { codemuxStateDir } from "../src/call-log.js";
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

test("a pre-created 0777 default experiments directory is tightened to 0700", () => {
  const parent = resolve("scratch/session-14c66a93/exp/records-p");
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "case-"));
  const directory = join(codemuxStateDir({ HOME: home }), "experiments");
  mkdirSync(directory, { recursive: true, mode: 0o777 });
  const recording = new ExperimentRecording({ name: "experiment", command: process.execPath, args: [], env: [] },
    home, { HOME: home });
  try {
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  } finally { recording.close({ code: null, error: null }); }
});

test("a symlink planted at the default experiments directory is refused", () => {
  const parent = resolve("scratch/session-14c66a93/exp/records-p");
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "case-"));
  const state = codemuxStateDir({ HOME: home });
  const elsewhere = join(home, "elsewhere");
  mkdirSync(state, { recursive: true });
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(state, "experiments"));
  expect(() => new ExperimentRecording({ name: "experiment", command: process.execPath, args: [], env: [] },
    home, { HOME: home })).toThrow("must be a real directory, not a link");
});

test("a pre-created 0777 spec recording directory is tightened to 0700", () => {
  const parent = resolve("scratch/session-14c66a93/exp/records-p");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "case-"));
  const directory = join(cwd, "records");
  mkdirSync(directory, { mode: 0o777 });
  const recording = new ExperimentRecording({ name: "experiment", command: process.execPath, args: [], env: [],
    recording: directory }, cwd, {});
  try {
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  } finally { recording.close({ code: null, error: null }); }
});

test("a symlink planted at a spec recording directory is refused", () => {
  const parent = resolve("scratch/session-14c66a93/exp/records-p");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "case-"));
  const elsewhere = join(cwd, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(cwd, "records"));
  expect(() => new ExperimentRecording({ name: "experiment", command: process.execPath, args: [], env: [],
    recording: join(cwd, "records") }, cwd, {})).toThrow("must be a real directory, not a link");
});

test("a symlinked ancestor of the recording directory is resolved, not followed (round 8, edges)", () => {
  // The recursive mkdir used to follow a symlinked ancestor silently:
  // the recording and the 0700 chmod landed wherever the link pointed,
  // with recordingPath still naming the link. The resolved ancestor
  // names the real target, and the mode lands there and only there.
  const parent = resolve("scratch/session-14c66a93/exp/records-p");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "case-"));
  const target = join(cwd, "target");
  mkdirSync(target);
  symlinkSync(target, join(cwd, "link"));
  const recording = new ExperimentRecording({ name: "experiment", command: process.execPath, args: [], env: [],
    recording: join(cwd, "link", "experiments") }, cwd, {});
  try {
    expect(dirname(recording.recordingPath)).toBe(join(target, "experiments"));
    expect(statSync(join(target, "experiments")).mode & 0o777).toBe(0o700);
    expect(existsSync(join(cwd, "link", "experiments"))).toBe(true); // the same directory through the link
  } finally { recording.close({ code: null, error: null }); }
});

test("a recording directory ancestor that cannot be resolved is refused with its path", () => {
  const parent = resolve("scratch/session-14c66a93/exp/records-p");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "case-"));
  const closed = join(cwd, "closed");
  mkdirSync(closed, { mode: 0o000 });
  try {
    expect(() => new ExperimentRecording({ name: "experiment", command: process.execPath, args: [], env: [],
      recording: join(closed, "tail", "experiments") }, cwd, {}))
      .toThrow(`experiment MCP recording directory cannot be resolved: ${join(closed, "tail", "experiments")}`);
  } finally {
    chmodSync(closed, 0o700);
  }
});

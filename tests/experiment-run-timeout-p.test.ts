import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ExperimentCodexRun } from "../src/experiment-codex-run.js";
import { ExperimentKimiRun } from "../src/experiment-kimi-run.js";
import { ExperimentServer } from "../src/experiment-server.js";
import { runCapturedCommand } from "../src/process-runner.js";
import * as processTable from "../src/process-table.js";

const MODES: ("codex-json" | "codex-plain" | "kimi")[] = ["codex-json", "codex-plain", "kimi"];
const PARTIAL = '  {"unfinished":"café\r';

async function setup(mode: typeof MODES[number]) {
  const parent = resolve("scratch/session-14c66a93/exp/run-timeout-p");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "case-"));
  const spec = { name: "experiment", command: process.execPath, args: [], env: [], recording: join(cwd, "records") };
  const start = spyOn(ExperimentServer.prototype, "start").mockImplementation(() => {});
  const sink = mode === "kimi" ? new ExperimentKimiRun(spec, cwd, cwd, join(cwd, "agent.md"), {}) :
    new ExperimentCodexRun(spec, cwd, cwd, mode === "codex-json", {});
  try { await sink.prepare(); }
  catch (error) { await sink.close().catch(() => {}); throw error; }
  finally { start.mockRestore(); }
  const records = () => readFileSync(sink.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { sink, cwd, records };
}

test.each(MODES)("%s records exact interrupted stdout bytes without parsing them", async (mode) => {
  const { sink, records } = await setup(mode);
  try {
    sink.push(PARTIAL.slice(0, 11));
    sink.push(PARTIAL.slice(11));
    expect(() => sink.finish({ timedOut: true })).not.toThrow();
    expect(() => sink.finish({ timedOut: true })).not.toThrow();
    const partials = records().filter((record) => record.kind === "harness_stdout_partial");
    expect(partials).toHaveLength(1);
    expect(Buffer.from(partials[0]!.bytes_base64, "base64")).toEqual(Buffer.from(PARTIAL));
    expect(sink.relay.failureCode).toBeNull();
  } finally { await sink.close().catch(() => {}); }
});

test.each(MODES)("%s preserves exit 124 when the actual runner times out with partial JSON", async (mode) => {
  const { sink, cwd, records } = await setup(mode);
  let stdout!: ReadableStreamDefaultController<Uint8Array>;
  let exit!: (code: number) => void;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stdout.close();
    exit(0);
  };
  const spawn = spyOn(Bun, "spawn").mockReturnValue({
    pid: 2147483647, stdin: { write() {}, end() {} }, kill: stop,
    exited: new Promise<number>((resolveExit) => { exit = resolveExit; }),
    stdout: new ReadableStream<Uint8Array>({ start(controller) {
      stdout = controller;
      controller.enqueue(Buffer.from(PARTIAL));
    } }),
    stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
  } as unknown as ReturnType<typeof Bun.spawn>);
  const table = spyOn(processTable, "readProcessTable").mockReturnValue(new Map());
  try {
    const result = await runCapturedCommand(["synthetic-timeout"], { cwd, env: {}, stdoutSink: sink, timeoutMs: 20 });
    expect(result).toMatchObject({ exitCode: 124, success: false });
    expect(result.stderr).toContain("agent timed out after 20ms");
    expect(result.stderr).not.toContain("JSON Parse");
    const partials = records().filter((record) => record.kind === "harness_stdout_partial");
    expect(partials).toHaveLength(1);
    expect(Buffer.from(partials[0]!.bytes_base64, "base64")).toEqual(Buffer.from(PARTIAL));
  } finally { stop(); table.mockRestore(); spawn.mockRestore(); await sink.close().catch(() => {}); }
});

test.each(MODES)("%s continues to reject malformed final JSON without a timeout", async (mode) => {
  const { sink } = await setup(mode);
  try {
    sink.push(PARTIAL);
    expect(() => sink.finish({ timedOut: false })).toThrow(SyntaxError);
  } finally { await sink.close().catch(() => {}); }
});

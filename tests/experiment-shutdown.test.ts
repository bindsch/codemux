import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExperimentBridge } from "../src/experiment-bridge.js";
import { ExperimentServer, MAX_EXPERIMENT_MESSAGE_BYTES, type JsonObject } from "../src/experiment-server.js";
import { FORCE_KILL_DELAY_MS, MAX_CAPTURE_BYTES, PIPE_GIVE_UP_MS, runCapturedCommand } from "../src/process-runner.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "codemux-shutdown-"));
  dirs.push(dir);
  return dir;
}
function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  return { readable: new ReadableStream<Uint8Array>({ start(value) { controller = value; } }),
    send(value: string) { controller.enqueue(Buffer.from(value)); }, end() { controller.close(); } };
}
const spec = { name: "experiment", command: process.execPath, args: [], env: [] };

test("draining server chunks registers one give-up reaction per reader, never per read", async () => {
  const server = new ExperimentServer(spec, directory(), {}, () => {}, (error) => { throw error; });
  const internals = server as unknown as {
    pipeGiveUp: Promise<void>; read(stream: ReadableStream<Uint8Array>, kind: string): Promise<void>;
  };
  const reactions = spyOn(internals.pipeGiveUp, "then");
  let chunks = 0;
  let remaining = 20;
  const input = new ReadableStream<Uint8Array>({ pull(controller) {
    if (!remaining--) { controller.close(); return; }
    const chunk = new Uint8Array(1024 * 1024);
    chunks++;
    expect(reactions).toHaveBeenCalledTimes(1);
    controller.enqueue(chunk);
  } });
  try {
    await internals.read(input, "server_stderr");
    expect(reactions).toHaveBeenCalledTimes(1);
    expect(chunks).toBe(20);
  } finally { reactions.mockRestore(); await server.close(); }
});

test.each(["stdout", "stderr"])("server cleanup abandons %s held by a real orphan within the runner's bound", async (pipe) => {
  if (process.platform === "win32") return;
  const cwd = directory();
  const pidFile = join(cwd, "orphan.pid");
  const readyFile = join(cwd, "leader-exiting");
  const orphan = `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const parent = `Bun.spawn([process.execPath, "-e", ${JSON.stringify(orphan)}], {
    detached: true, stdin: "ignore", stdout: ${JSON.stringify(pipe === "stdout" ? "inherit" : "ignore")},
    stderr: ${JSON.stringify(pipe === "stderr" ? "inherit" : "ignore")} });
    await Bun.sleep(50); await Bun.write(${JSON.stringify(readyFile)}, "ready"); process.exit(0);`;
  const failures: string[] = [];
  const server = new ExperimentServer({ ...spec, args: ["-e", parent] }, cwd, {}, () => {}, (error) => failures.push(error.message));
  try {
    server.start();
    const deadline = performance.now() + 2000;
    while (!Bun.file(readyFile).size && performance.now() < deadline) await Bun.sleep(20);
    expect(await Bun.file(readyFile).text()).toBe("ready");
    await Bun.sleep(100); // The leader exits before the first termination snapshot.
    const started = performance.now();
    await server.close();
    expect(performance.now() - started).toBeLessThan(FORCE_KILL_DELAY_MS + PIPE_GIVE_UP_MS + 750);
    expect(failures.join("\n")).toContain("readers abandoned");
  } finally {
    try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* Already exited. */ }
    await server.close();
  }
}, 8000);

test("recording waits for both readers and rejects a partial frame queued during shutdown", async () => {
  const stdout = stream();
  const stderr = stream();
  const kill = spyOn(process, "kill").mockImplementation(() => true);
  const spawn = spyOn(Bun, "spawn").mockReturnValue({ pid: 2147483647,
    stdout: stdout.readable, stderr: stderr.readable, stdin: { write() {} }, kill() {},
    exited: new Promise(() => {}),
  } as unknown as ReturnType<typeof Bun.spawn>);
  const cwd = directory();
  const bridge = new ExperimentBridge({ ...spec, recording: cwd }, cwd, "probe");
  const abort = mock(() => {});
  try {
    bridge.start(() => {}, () => {}, abort);
    const closing = bridge.closeProtocol();
    void closing.catch(() => {});
    stdout.send('{"jsonrpc":');
    stdout.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(readFileSync(bridge.recordingPath, "utf8")).not.toContain('"kind":"run_end"');
    stderr.send("late stderr");
    stderr.end();
    await expect(closing).rejects.toThrow("incomplete experiment MCP server stdout frame");
    const records = readFileSync(bridge.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.filter((record) => record.kind === "server_stdout").map((record) =>
      Buffer.from(record.bytes_base64, "base64").toString()).join("")).toBe('{"jsonrpc":');
    expect(records.find((record) => record.kind === "server_stderr").bytes_base64).toBe(Buffer.from("late stderr").toString("base64"));
    expect(records.at(-1)).toMatchObject({ kind: "run_end", error: "incomplete experiment MCP server stdout frame" });
    expect(abort).toHaveBeenCalledTimes(1);
  } finally { await bridge.close(); spawn.mockRestore(); kill.mockRestore(); }
});

test.each(["writable", "inside cwd"])("experiment server refuses an untrusted executable: %s", (kind) => {
  const root = directory();
  const cwd = kind === "inside cwd" ? root : directory();
  const command = join(root, "server");
  writeFileSync(command, "#!/bin/sh\nexit 0\n");
  chmodSync(command, kind === "writable" ? 0o777 : 0o755);
  const server = new ExperimentServer({ ...spec, command }, cwd, {}, () => {}, () => {});
  const spawn = spyOn(Bun, "spawn");
  try {
    expect(() => server.start()).toThrow(kind === "writable" ? "group- or world-writable" : "inside the execution working directory");
    expect(spawn).not.toHaveBeenCalled();
  } finally { spawn.mockRestore(); }
});

test.each([0, 1])("both inbound transports count the delimiter at the frame limit + %i", async (extra) => {
  const cwd = directory();
  const bridge = new ExperimentBridge({ ...spec, recording: cwd }, cwd, "probe");
  const frame = { type: "system", subtype: "status", padding: "" };
  const overhead = Buffer.byteLength(JSON.stringify(frame) + "\n");
  frame.padding = "x".repeat(MAX_EXPERIMENT_MESSAGE_BYTES - overhead + extra);
  try {
    if (extra) expect(() => bridge.push(JSON.stringify(frame) + "\n")).toThrow("exceeds 1 MiB");
    else expect(() => bridge.push(JSON.stringify(frame) + "\n")).not.toThrow();
  } finally { await bridge.close(); }
  const fail = mock(() => {});
  const received = mock(() => {});
  const server = new ExperimentServer(spec, cwd, {}, () => {}, fail);
  const internals = server as unknown as { pending: Map<string, unknown>;
    read(stream: ReadableStream<Uint8Array>, kind: string): Promise<void> };
  const reply: JsonObject = { jsonrpc: "2.0", id: 1, result: "" };
  reply.result = "x".repeat(MAX_EXPERIMENT_MESSAGE_BYTES - Buffer.byteLength(JSON.stringify(reply) + "\n") + extra);
  internals.pending.set("1", { resolve: received });
  server.terminate();
  await internals.read(new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from(JSON.stringify(reply) + "\n")); controller.close();
  } }), "server_stdout");
  if (extra) { expect(fail).toHaveBeenCalledTimes(1); expect(received).not.toHaveBeenCalled(); }
  else { expect(fail).not.toHaveBeenCalled(); expect(received).toHaveBeenCalledTimes(1); }
});

test.each(["timeout", "signal", "abort", "parse", "UTF-8", "limit"])("%s terminates the external server group before harness cleanup", async (reason) => {
  const cwd = directory();
  const groupSignals: number[] = [];
  const kill = spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === -2147483601 && signal === "SIGTERM") expect(groupSignals).toContain(-2147483600);
    groupSignals.push(pid);
    return true;
  });
  const server = new ExperimentServer(spec, cwd, {}, () => {}, () => {});
  let sequence = 0;
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    const pid = 2147483600 + sequence++;
    return { pid, kill() {}, stdin: { write() {}, end() {} },
      stdout: new ReadableStream({ start(controller) {
        if (pid === 2147483601) controller.enqueue(reason === "UTF-8" ? new Uint8Array([255]) : Buffer.from("frame"));
        controller.close();
      } }),
      stderr: new ReadableStream({ start(controller) { controller.close(); } }),
      exited: new Promise((resolve) => setTimeout(() => resolve(0), 50)),
    } as unknown as ReturnType<typeof Bun.spawn>;
  });
  const exit = spyOn(process, "exit").mockImplementation(() => { throw new Error("signal exit"); });
  try {
    server.start();
    const operation = runCapturedCommand(["fake"], { cwd, env: {}, timeoutMs: reason === "timeout" ? 5 : 1000,
      stdoutSink: { push() { if (reason === "parse") throw new Error("malformed protocol frame"); },
        finish() { return ""; }, keptBytes() { return reason === "limit" ? MAX_CAPTURE_BYTES + 1 : 0; },
        start(_write, _end, abort) {
          if (reason === "signal") process.emit("SIGTERM");
          if (reason === "abort") abort();
        },
        terminateProtocol() { server.terminate(); },
        async closeProtocol() {
          expect(groupSignals).toContain(-2147483600);
          await server.close();
        } } });
    if (reason === "signal") await expect(operation).rejects.toThrow("signal exit");
    else if (reason === "abort") await expect(operation).rejects.toThrow("protocol capture aborted");
    else if (reason === "parse") await expect(operation).rejects.toThrow("malformed protocol frame");
    else if (reason === "UTF-8") await expect(operation).rejects.toThrow("stdout is not valid UTF-8");
    else expect((await operation).exitCode).toBe(reason === "limit" ? 125 : 124);
    expect(groupSignals).toContain(-2147483600);
    expect(groupSignals.indexOf(-2147483600)).toBeLessThan(groupSignals.indexOf(-2147483601));
  } finally { await server.close(); exit.mockRestore(); spawn.mockRestore(); kill.mockRestore(); }
});

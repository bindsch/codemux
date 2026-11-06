import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { ExperimentHttpRelay } from "../src/experiment-relay.js";
import { ExperimentFailureCode as Code } from "../src/experiment-records.js";
import { MAX_EXPERIMENT_MESSAGE_BYTES, type JsonObject } from "../src/experiment-server.js";
import { readRelayHttpResponse } from "./experiment-relay-http.js";

const relays: ExperimentHttpRelay[] = [];
afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close().catch(() => {});
});

function createRelay(script: string) {
  mkdirSync("scratch", { recursive: true });
  const cwd = mkdtempSync(resolve("scratch/relay-server-task-r-"));
  const relay = new ExperimentHttpRelay({ name: "experiment", command: process.execPath,
    args: ["--no-env-file", "--no-install", `--config=${resolve("bunfig.runtime.toml")}`, "-e", script],
    env: [], recording: join(cwd, "recordings") }, cwd, {});
  relays.push(relay);
  return relay;
}

function records(relay: ExperimentHttpRelay): JsonObject[] {
  return readFileSync(relay.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function list(relay: ExperimentHttpRelay) {
  const request = httpRequest(relay.url, { method: "POST", headers: {
    Authorization: `Bearer ${relay.token}`, "Content-Type": "application/json",
  } });
  const response = readRelayHttpResponse(request);
  request.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  return response;
}

test.each([-1, 0, 1])("combined paginated tools/list checks serialized UTF-8 bytes at the 1 MiB limit + %i", async (extra) => {
  const tools = [{ name: "first", description: "" }, { name: "second", description: "" }];
  const overhead = Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } }));
  const padding = MAX_EXPERIMENT_MESSAGE_BYTES - overhead + extra;
  const relay = createRelay(`import { createInterface } from 'node:readline';
    const padding = ${padding};
    const tools = [{name:'first',description:'π'.repeat(Math.floor(padding / 4))},
      {name:'second',description:'x'.repeat(padding - Math.floor(padding / 4) * 2)}];
    for await (const line of createInterface({input:process.stdin})) {
      const m = JSON.parse(line);
      const result = m.params?.cursor === undefined ? {tools:[tools[0]],nextCursor:'next'} : {tools:[tools[1]]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
    }`);
  await relay.start();
  const reply = await list(relay);
  const stdout = Buffer.concat(records(relay).filter((entry) => entry.kind === "server_stdout")
    .map((entry) => Buffer.from(entry.bytes_base64, "base64"))).toString();
  const pages = stdout.trim().split("\n");
  expect(pages).toHaveLength(2);
  expect(pages.every((page) => Buffer.byteLength(page + "\n") <= MAX_EXPERIMENT_MESSAGE_BYTES)).toBe(true);
  if (extra <= 0) {
    expect(reply.status).toBe(200);
    expect(Buffer.byteLength(reply.body)).toBe(MAX_EXPERIMENT_MESSAGE_BYTES + extra);
    expect(JSON.parse(reply.body).result.tools).toHaveLength(2);
    relay.finish();
    await relay.close();
    expect(records(relay).at(-1)).toMatchObject({ kind: "run_end", error: null, code: null });
  } else {
    expect(reply).toMatchObject({ status: 400, body: "" });
    expect(relay.failureCode).toBe(Code.Protocol);
    await expect(relay.close()).rejects.toMatchObject({ code: Code.Protocol });
    expect(records(relay).at(-1)).toMatchObject({ kind: "run_end", code: Code.Protocol });
    expect(records(relay).filter((entry) => entry.kind === "http_response" && entry.status === 200)).toHaveLength(0);
  }
});

function output() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  return { readable: new ReadableStream<Uint8Array>({ start(value) { controller = value; } }),
    send(value: JsonObject) { controller.enqueue(Buffer.from(JSON.stringify(value) + "\n")); },
    end() { controller.close(); } };
}

test.each([
  { label: "queued exit 0", naturalCode: 0, alreadyExited: false },
  { label: "queued exit 23", naturalCode: 23, alreadyExited: false },
  { label: "observed exit 0", naturalCode: 0, alreadyExited: true },
  { label: "observed exit 23", naturalCode: 23, alreadyExited: true },
  { label: "intentional SIGKILL", naturalCode: null, alreadyExited: false },
])("cleanup observes $label after the final response", async ({ naturalCode, alreadyExited }) => {
  const stdout = output();
  const stderr = output();
  let exit!: (code: number) => void;
  const proc = { pid: 2147483647, exitCode: null as number | null, signalCode: null as string | null,
    stdout: stdout.readable, stderr: stderr.readable,
    stdin: { write(line: string) {
      const request = JSON.parse(line);
      if (alreadyExited) proc.exitCode = naturalCode;
      stdout.send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "lookup" }] } });
      // A real sink answers with the byte count; a nonnumeric synchronous
      // result is a closed sink (round 211).
      return line.length;
    } }, kill() {}, exited: new Promise<number>((resolveExit) => { exit = resolveExit; }) };
  const kill = spyOn(process, "kill").mockImplementation(() => {
    if (naturalCode === null) proc.signalCode = "SIGKILL";
    else proc.exitCode = naturalCode;
    stdout.end(); stderr.end(); setImmediate(() => exit(naturalCode ?? 137));
    return true;
  });
  // The fixture is built before the process-wide mock: a throw in between
  // would leak the mock into every later test (round 35, contracts 2).
  const relay = createRelay("");
  const spawn = spyOn(Bun, "spawn").mockReturnValue(proc as unknown as ReturnType<typeof Bun.spawn>);
  try {
    await relay.start();
    expect((await list(relay)).status).toBe(200);
    relay.finish();
    if (naturalCode === null) {
      await relay.close();
      expect(relay.failureCode).toBeNull();
      expect(records(relay).at(-1)).toMatchObject({ kind: "run_end", error: null, code: null });
    } else {
      await expect(relay.close()).rejects.toMatchObject({ code: Code.ServerError });
      expect(relay.failureCode).toBe(Code.ServerError);
      expect(records(relay).at(-1)).toMatchObject({ kind: "run_end", code: Code.ServerError });
      expect(records(relay).filter((entry) => entry.kind === "failure")).toHaveLength(1);
    }
  } finally {
    await relay.close().catch(() => {});
    spawn.mockRestore(); kill.mockRestore();
  }
});

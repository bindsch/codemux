import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { dirname, join, resolve } from "node:path";
import { ExperimentCodexRun } from "../src/experiment-codex-run.js";
import { ExperimentKimiEvidence } from "../src/experiment-kimi.js";
import { ExperimentKimiRun } from "../src/experiment-kimi-run.js";
import { ExperimentHttpRelay } from "../src/experiment-relay.js";
import { readRelayHttpResponse } from "./experiment-relay-http.js";
import { KIMI_STREAM_SESSION, kimiAssistantCall, kimiResumeHint } from "./fixtures/kimi-stream.js";

type Entry = Record<string, any>;
const relays: ExperimentHttpRelay[] = [];
afterEach(async () => { for (const relay of relays.splice(0)) await relay.close().catch(() => {}); });
const read = (relay: ExperimentHttpRelay): Entry[] => readFileSync(relay.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const encode = (entries: Entry[]) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
const content = (text: string) => [{ type: "text", text }];
const hash = (text: string) => createHash("sha256").update(JSON.stringify([{ text, type: "text" }])).digest("hex");
const loop = (event: Entry) => ({ type: "context.append_loop_event", time: 1000, event });
const NAME = "mcp__experiment__lookup";
const USAGE = { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 };

function fixture(script?: string, timeout?: number) {
  const parent = resolve("scratch/session-14c66a93/exp/ledger-task-v");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "case-"));
  return { cwd, spec: { name: "experiment", command: process.execPath,
    args: ["--no-env-file", "--no-install", `--config=${resolve("bunfig.runtime.toml")}`,
      ...(script ? ["-e", script] : [resolve("tests/fixtures/experiment-mcp.ts")])],
    env: [], recording: join(cwd, "recordings"), accept_harness_prefix: ["kimi-wall-time"],
    ...(timeout === undefined ? {} : { tool_timeout_seconds: timeout }) } };
}

function post(relay: ExperimentHttpRelay, id: string | number, method: string, params?: object) {
  const request = http.request(relay.url, { method: "POST", agent: false, headers: { Authorization: `Bearer ${relay.token}` } });
  const response = readRelayHttpResponse(request);
  request.end(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }));
  return response;
}

test("identical concurrent Kimi calls retain separate dispatches and FIFO native attribution", async () => {
  const { cwd, spec } = fixture(`import { createInterface } from 'node:readline';
    const held = []; const send = (m, text) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,
      result:{content:[{type:'text',text}]}})+'\\n');
    for await (const line of createInterface({input:process.stdin})) {
      const m = JSON.parse(line);
      if (m.method === 'tools/list') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,
        result:{tools:[{name:'lookup',description:'',inputSchema:{}}]}})+'\\n');
      else { held.push(m); if (held.length === 2) { send(held[1], 'second'); setTimeout(()=>send(held[0], 'first'),30); } }
    }`);
  const relay = new ExperimentHttpRelay(spec, cwd, {});
  relays.push(relay);
  await relay.start();
  await post(relay, "inventory", "tools/list");
  const path = join(cwd, "sessions/workspace", KIMI_STREAM_SESSION, "agents/main/wire.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  const ids = ["native-1", "native-2"];
  writeFileSync(path, encode([{ type: "llm.tools_snapshot", tools: [{ name: NAME, description: "", parameters: {} }] },
    ...ids.map((id) => loop({ type: "tool.call", uuid: `uuid-${id}`, stepUuid: "step-1", toolCallId: id, name: NAME, args: {} }))]));
  const evidence = new ExperimentKimiEvidence(relay, { kimiHome: cwd });
  relay.resolveCallId = (call) => evidence.resolveCallId(call);
  try {
    const responses = await Promise.all([post(relay, "rpc-first", "tools/call", { name: "lookup", arguments: {} }),
      post(relay, 42, "tools/call", { name: "lookup", arguments: {} })]);
    expect(responses.map((response) => JSON.parse(response.body))).toEqual([
      { jsonrpc: "2.0", id: "rpc-first", result: { content: content("first") } },
      { jsonrpc: "2.0", id: 42, result: { content: content("second") } },
    ]);
    // Native attribution can accept the opposite result order within this FIFO group.
    const delivered = ["second", "first"];
    appendFileSync(path, encode([loop({ type: "step.end", uuid: "step-1", usage: USAGE }),
      { type: "agent.message.appended", message: { message: { role: "assistant", content: [], toolCalls: ids.map((id) =>
        ({ type: "function", id, name: NAME, arguments: "{}" })) }, meta: { usage: USAGE } } },
      ...ids.flatMap((id, index) => [loop({ type: "tool.result", parentUuid: `uuid-${id}`, toolCallId: id,
        result: { output: delivered[index], durationMs: 5 } }),
      { type: "agent.message.appended", message: { message: { role: "tool", toolCallId: id, content: content(delivered[index]!) } } }]) ]));
    evidence.accept({ role: "assistant", tool_calls: ids.flatMap((id) => kimiAssistantCall(id, NAME, {}).tool_calls) });
    ids.forEach((id, index) => evidence.accept({ role: "tool", tool_call_id: id, content: delivered[index] }));
    evidence.accept(kimiResumeHint());
    evidence.finish();
    relay.finish();
    await relay.close();
    const records = read(relay), ledgers = records.filter((r) => r.kind === "call_ledger");
    expect(ledgers).toHaveLength(2);
    expect(ledgers.map((r) => r.relay_request_seq)).toEqual([1, 0]);
    expect(ledgers.map((r) => r.rpc_id)).toEqual([42, "rpc-first"]);
    expect(relay.calls).toHaveLength(2);
    expect(records.filter((r) => r.kind === "tool_call_identified")).toHaveLength(2);
    expect(records.filter((r) => r.kind === "mcp_request" && r.message.method === "tools/call")).toHaveLength(2);
    expect(records.filter((r) => r.kind === "server_tool_result")).toHaveLength(2);
    const fields = ["relay_request_seq", "native_call_id", "dispatched_t", "delivered_t", "correlation", "rpc_id", "result_sha256"];
    for (const ledger of ledgers) {
      expect(Object.keys(ledger).sort()).toEqual([...fields, "run_id", "seq", "t", "kind"].sort());
      const request = records.find((r) => r.kind === "mcp_request" && r.rpc_id === ledger.rpc_id)!;
      const result = records.find((r) => r.kind === "server_tool_result" && r.relay_request_seq === ledger.relay_request_seq)!;
      expect(request.relay_request_seq).toBe(ledger.relay_request_seq);
      expect(request.relay_index).toBe(ledger.relay_request_seq);
      expect(result.rpc_id).toBe(ledger.rpc_id);
      expect(result.result_sha256).toBe(ledger.result_sha256);
      expect(ledger.result_sha256).toBe(hash(ledger.rpc_id === 42 ? "second" : "first"));
      expect(ledger.correlation).toBe("fifo");
      expect(ledger.native_call_id).toBe(ids[ledger.relay_request_seq]);
      expect(ledger.dispatched_t).toBeGreaterThan(1_000_000_000);
      expect(ledger.delivered_t).toBeGreaterThanOrEqual(ledger.dispatched_t);
      expect(ledger.delivered_t).toBeLessThanOrEqual(Date.now() / 1000);
      expect(result.seq).toBeLessThan(ledger.seq);
    }
    const pairsMatch = (entries: Entry[]) => entries.every((ledger) => records.some((r) => r.kind === "server_tool_result" &&
      r.relay_request_seq === ledger.relay_request_seq && r.rpc_id === ledger.rpc_id && r.result_sha256 === ledger.result_sha256));
    expect(pairsMatch(ledgers)).toBe(true);
    expect(pairsMatch(ledgers.map((ledger, i) => ({ ...ledger, result_sha256: ledgers[1 - i]!.result_sha256 })))).toBe(false);
    expect(records.at(-1)).toMatchObject({ kind: "run_end", calls_delivered: 2, tool_calls: 2, error: null });
  } finally { evidence.stop(); }
});

test.each(["exact", "request_meta"] as const)("HTTP delivery records %s correlation and canonical content hashes", async (correlation) => {
  const { cwd, spec } = fixture(`import { createInterface } from 'node:readline';
    for await (const line of createInterface({input:process.stdin})) { const m=JSON.parse(line);
      const result=m.method==='tools/list'?{tools:[{name:'lookup'}]}:{content:[{type:'text',text:'π\\n',_meta:{z:0,a:[{z:1,a:true}]}}]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n'); }`);
  const relay = new ExperimentHttpRelay(spec, cwd, {});
  relays.push(relay);
  relay.resolveCallId = async (call) => { if (correlation === "request_meta") call.native_call_id_source = "request_meta"; return "native"; };
  await relay.start();
  await post(relay, 1, "tools/list");
  expect(read(relay).some((r) => r.kind === "call_ledger")).toBe(false);
  expect((await post(relay, 2, "tools/call", { name: "lookup", arguments: {} })).status).toBe(200);
  await relay.close();
  const records = read(relay), ledger = records.find((r) => r.kind === "call_ledger")!;
  expect(ledger).toMatchObject({ native_call_id: "native", correlation, relay_request_seq: 0, rpc_id: 2,
    result_sha256: createHash("sha256").update('[{"_meta":{"a":[{"a":true,"z":1}],"z":0},"text":"π\\n","type":"text"}]').digest("hex") });
  expect(records.at(-1)).toMatchObject({ calls_delivered: 1 });
});

test("refused tool results emit no delivery ledger and count zero", async () => {
  const { cwd, spec } = fixture();
  const relay = new ExperimentHttpRelay(spec, cwd, {});
  relays.push(relay);
  relay.resolveCallId = async () => "native";
  relay.validateResult = () => { throw new Error("synthetic refusal"); };
  await relay.start();
  await post(relay, 1, "tools/list");
  expect((await post(relay, 2, "tools/call", { name: "bash", arguments: {} })).status).toBe(400);
  await relay.close().catch(() => {});
  const records = read(relay);
  expect(records.some((r) => r.kind === "server_tool_result")).toBe(true);
  expect(records.some((r) => r.kind === "call_ledger")).toBe(false);
  expect(records.at(-1)).toMatchObject({ calls_delivered: 0 });
});

test.each([{}, { content: "invalid" }])("malformed content stays in raw evidence without a hashless server result: %j", async (result) => {
  const { cwd, spec } = fixture(`import { createInterface } from 'node:readline';
    for await (const line of createInterface({input:process.stdin})) { const m=JSON.parse(line);
      const result=m.method==='tools/list'?{tools:[{name:'lookup'}]}:${JSON.stringify(result)};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n'); }`);
  const relay = new ExperimentHttpRelay(spec, cwd, {});
  relays.push(relay);
  relay.resolveCallId = async () => "native";
  await relay.start();
  await post(relay, 1, "tools/list");
  expect((await post(relay, 2, "tools/call", { name: "lookup", arguments: {} })).status).toBe(400);
  await relay.close().catch(() => {});
  const records = read(relay);
  expect(records.some((r) => r.kind === "server_tool_result" || r.kind === "call_ledger")).toBe(false);
  const raw = records.filter((r) => r.kind === "server_stdout").map((r) => Buffer.from(r.bytes_base64, "base64").toString()).join("");
  expect(raw.trim().split("\n").map((line) => JSON.parse(line))).toContainEqual({ jsonrpc: "2.0", id: 2, result });
  expect(records.at(-1)).toMatchObject({ calls_delivered: 0, code: "protocol" });
});

test("an HTTP response closed before its write finishes emits no delivery ledger", async () => {
  const { cwd, spec } = fixture();
  const original = http.createServer;
  const create = spyOn(http, "createServer").mockImplementation(((...args: any[]) => {
    const server = original(...args);
    server.on("request", (request, response) => {
      if (request.headers["x-drop-result"] === "yes") {
        response.end = (() => { response.destroy(new Error("synthetic failed HTTP write")); return response; }) as typeof response.end;
      }
    });
    return server;
  }) as typeof http.createServer);
  const relay = new ExperimentHttpRelay(spec, cwd, {});
  relays.push(relay);
  relay.resolveCallId = async () => "native";
  try { await relay.start(); } finally { create.mockRestore(); }
  await post(relay, 1, "tools/list");
  const request = http.request(relay.url, { method: "POST", agent: false, headers: {
    Authorization: `Bearer ${relay.token}`, "X-Drop-Result": "yes",
  } });
  const response = readRelayHttpResponse(request);
  request.end(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bash", arguments: {} } }));
  await expect(response).rejects.toBeInstanceOf(Error);
  await relay.close().catch(() => {});
  const records = read(relay);
  expect(records.some((r) => r.kind === "server_tool_result")).toBe(true);
  expect(records.some((r) => r.kind === "call_ledger")).toBe(false);
  expect(records.at(-1)).toMatchObject({ calls_delivered: 0 });
});

test.each(["codex", "kimi"] as const)("%s run_start records the effective tool timeout", async (harness) => {
  for (const seconds of [undefined, 17, 86400]) {
    const { cwd, spec } = fixture(undefined, seconds), home = join(cwd, "home");
    mkdirSync(home);
    const run = harness === "codex" ? new ExperimentCodexRun(spec, cwd, home, true, {}) :
      new ExperimentKimiRun(spec, cwd, home, join(cwd, "agent.md"), {});
    if (run instanceof ExperimentCodexRun) await run.prepare("0.165.0");
    relays.push(run.relay);
    expect(read(run.relay)[0]).toMatchObject({ kind: "run_start", tool_timeout_seconds: seconds ?? 7200 });
    expect(Number.isInteger(read(run.relay)[0]!.tool_timeout_seconds)).toBe(true);
    await run.close().catch(() => {});
  }
});

test("the live relay server disables pending response timeouts", async () => {
  const { cwd, spec } = fixture();
  const original = http.createServer;
  let server!: http.Server;
  const create = spyOn(http, "createServer").mockImplementation(((...args: any[]) => {
    server = original(...args); return server;
  }) as typeof http.createServer);
  const relay = new ExperimentHttpRelay(spec, cwd, {});
  relays.push(relay);
  try { await relay.start(); } finally { create.mockRestore(); }
  expect(server.listening).toBe(true);
  expect(server.requestTimeout).toBe(0);
  expect(server.timeout).toBe(0);
  expect(server.keepAliveTimeout).toBeGreaterThanOrEqual(86_400_000);
});

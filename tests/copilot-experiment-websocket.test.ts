import { expect, test } from "bun:test";
import { CopilotExperimentEvidence } from "../src/copilot-experiment-evidence.js";
import { CopilotExperimentHttp } from "../src/copilot-experiment-http.js";
import { CopilotExperimentWebSocket } from "../src/copilot-experiment-websocket.js";
import type { JsonObject } from "../src/experiment-server.js";

function copilotWsEvidence() {
  const records: JsonObject[] = [];
  const definition = { name: "echo", description: "Echo", inputSchema: { type: "object" } };
  const evidence = new CopilotExperimentEvidence({ spec: { name: "test" }, calls: [], toolDefinitions: [definition],
    record: (kind, fields) => { records.push({ kind, ...fields }); } }, "session");
  evidence.catalog([{ name: "native_echo", mcpToolName: "echo", mcpServerName: "test", description: "Echo", input_schema: definition.inputSchema }]);
  const payload = { type: "response.create", response: { tools: [{ type: "function", name: "native_echo", description: "Echo", parameters: definition.inputSchema }], input: [] } };
  return { evidence, records, payload };
}

test("Copilot WebSocket forwards native messages and serialized replies through a loopback peer", async () => {
  const f = copilotWsEvidence(), frames: JsonObject[] = [], received: string[] = [], failures: Error[] = [];
  const observed: { authorization: string | null } = { authorization: null };
  let done!: () => void;
  const delivered = new Promise<void>((resolve) => { done = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { observed.authorization = request.headers.get("authorization"); if (server.upgrade(request)) return; return new Response(null, { status: 400 }); },
    websocket: { message(ws, message) { received.push(String(message)); ws.send(JSON.stringify({ type: "response.created", response: { id: "native-é🙂" } })); ws.send(Buffer.from(JSON.stringify({ type: "response.completed", response: { id: "native-é🙂", status: "completed" } }))); } } });
  const bridge = new CopilotExperimentHttp({ sessionId: "session", evidence: f.evidence,
    fail: (error) => { failures.push(error); }, request: async (method, params) => {
      frames.push({ method, ...params });
      if (frames.filter((frame) => frame.data && !frame.end).length === 2) done();
      return { accepted: true };
    } });
  try {
    bridge.start({ requestId: "socket", sessionId: "session", transport: "websocket", method: "GET",
      url: `ws://127.0.0.1:${server.port}`, headers: { Authorization: ["synthetic-ws-token"] } });
    await bridge.chunk({ requestId: "socket", data: Buffer.from(JSON.stringify(f.payload)).toString("base64"), binary: true });
    await delivered;
    await bridge.chunk({ requestId: "socket", data: "", end: true });
    await bridge.complete(); f.evidence.complete();
    expect(observed.authorization).toBe("synthetic-ws-token"); expect(received).toEqual([JSON.stringify(f.payload)]);
    expect(frames[0]).toMatchObject({ method: "llmInference.httpResponseStart", status: 101 });
    expect(frames.filter((frame) => frame.data).map((frame) => JSON.parse(Buffer.from(frame.data, "base64").toString("utf8")).type)).toEqual(["response.created", "response.completed"]);
    expect(frames.at(-1)).toMatchObject({ end: true }); expect(failures).toEqual([]);
    expect(JSON.stringify(f.records)).not.toContain("synthetic-ws-token");
    expect(() => bridge.chunk({ requestId: "socket", data: "late" })).toThrow("no request");
  } finally { bridge.close(); await server.stop(true); }
});

test("Copilot WebSocket releases canceled identities and live-connection capacity", async () => {
  const f = copilotWsEvidence(), failures: Error[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, server) { if (server.upgrade(request)) return; return new Response(); }, websocket: { message() {} } });
  const bridge = new CopilotExperimentHttp({ sessionId: "session", evidence: f.evidence,
    fail: (error) => { failures.push(error); }, request: async () => ({ accepted: true }) });
  try {
    for (let index = 0; index < 20; index++) {
      bridge.start({ requestId: "reusable", sessionId: "session", transport: "websocket", method: "GET", url: `ws://127.0.0.1:${server.port}`, headers: {} });
      await bridge.chunk({ requestId: "reusable", data: "", cancel: true });
    }
    await bridge.complete(); expect(failures).toEqual([]);
  } finally { bridge.close(); await server.stop(true); }
});

test("Copilot WebSocket admits a next request immediately after native completion acknowledgment", async () => {
  const f = copilotWsEvidence(), failures: Error[] = [];
  let responses = 0, acknowledged = 0, done!: () => void, next: Promise<JsonObject> | undefined;
  const finished = new Promise<void>((resolve) => { done = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, server) { if (server.upgrade(request)) return; return new Response(); },
    websocket: { message(ws) { responses++; ws.send(JSON.stringify({ type: "response.created", response: { id: String(responses) } })); ws.send(JSON.stringify({ type: "response.completed", response: { id: String(responses), status: "completed" } })); } } });
  const socket = new CopilotExperimentWebSocket({ requestId: "socket", url: `ws://127.0.0.1:${server.port}`, headers: {} }, {
    evidence: f.evidence, fail: (error) => { failures.push(error); done(); }, request: async (_method, params) => {
      if (params.data && JSON.parse(Buffer.from(params.data, "base64").toString("utf8")).type === "response.completed") {
        acknowledged++;
        if (acknowledged === 1) queueMicrotask(() => { next = socket.chunk({ data: JSON.stringify(f.payload) }); });
        else done();
      }
      return { accepted: true };
    },
  });
  try {
    await socket.chunk({ data: JSON.stringify(f.payload) }); await finished; await next; await socket.complete(); f.evidence.complete();
    expect([responses, acknowledged]).toEqual([2, 2]); expect(failures).toEqual([]);
  } finally { socket.dispose(); await server.stop(true); }
});

test("Copilot WebSocket cannot reuse old delivery proof after a truncated next response", async () => {
  const f = copilotWsEvidence(), failures: Error[] = [];
  let requests = 0, firstDone!: () => void, failed!: () => void;
  const first = new Promise<void>((resolve) => { firstDone = resolve; }), failure = new Promise<void>((resolve) => { failed = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, server) { if (server.upgrade(request)) return; return new Response(); }, websocket: {
    message(ws) {
      requests++;
      if (requests === 2) { ws.close(1000); return; }
      ws.send(JSON.stringify({ type: "response.created", response: { id: "first" } })); ws.send(JSON.stringify({ type: "response.completed", response: { id: "first", status: "completed" } }));
    },
  } });
  const socket = new CopilotExperimentWebSocket({ requestId: "socket", url: `ws://127.0.0.1:${server.port}`, headers: {} }, {
    evidence: f.evidence, fail: (error) => { failures.push(error); failed(); }, request: async (_method, params) => {
      if (params.data && JSON.parse(Buffer.from(params.data, "base64").toString("utf8")).type === "response.completed") firstDone();
      return { accepted: true };
    },
  });
  try {
    await socket.chunk({ data: JSON.stringify(f.payload) }); await first;
    await socket.chunk({ data: JSON.stringify(f.payload) }); await failure;
    await expect(socket.complete()).rejects.toThrow("before model completion"); expect(failures).toHaveLength(1);
  } finally { socket.dispose(); await server.stop(true); }
});

test("Copilot WebSocket rejects invalid frames and closes canceled connections", async () => {
  const f = copilotWsEvidence(), failures: Error[] = [];
  const options = { evidence: f.evidence, fail: (error: Error) => { failures.push(error); }, request: async () => ({ accepted: true }) };
  expect(() => new CopilotExperimentWebSocket({ url: "https://synthetic.invalid", headers: {} }, options)).toThrow("URL");
  expect(() => new CopilotExperimentWebSocket({ url: "ws://127.0.0.1", headers: { authorization: "bad" } }, options)).toThrow("arrays");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, server) { if (server.upgrade(request)) return; return new Response(); }, websocket: { message() {} } });
  const socket = new CopilotExperimentWebSocket({ requestId: "socket", url: `ws://127.0.0.1:${server.port}`, headers: {} }, options);
  try {
    await expect(socket.chunk({ data: "bad base64!", binary: true })).rejects.toThrow("base64");
    await expect(socket.chunk({ data: "x".repeat(16 * 1024 * 1024 + 1) })).rejects.toThrow("backpressure");
    await expect(socket.complete()).rejects.toThrow("backpressure");
    expect(failures).toHaveLength(1);
  } finally { socket.dispose(); await server.stop(true); }
  const cancelServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, server) { if (server.upgrade(request)) return; return new Response(); }, websocket: { message() {} } });
  const canceled = new CopilotExperimentWebSocket({ requestId: "cancel", url: `ws://127.0.0.1:${cancelServer.port}`, headers: {} }, options);
  try { await canceled.chunk({ cancel: true }); await canceled.complete(); }
  finally { canceled.dispose(); await cancelServer.stop(true); }
});

test("Copilot WebSocket bounds slow-consumer replies and reports rejected native acknowledgments", async () => {
  for (const behavior of ["overflow", "rejected"] as const) {
    const f = copilotWsEvidence(), failures: Error[] = [];
    let release!: (value: { accepted: boolean }) => void, failed!: () => void;
    const failure = new Promise<void>((resolve) => { failed = resolve; });
    const held = new Promise<{ accepted: boolean }>((resolve) => { release = resolve; });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request, server) { if (server.upgrade(request)) return; return new Response(); },
      websocket: { open(ws) { if (behavior === "overflow") for (let i = 0; i < 65; i++) ws.send("reply"); }, message() {} } });
    const socket = new CopilotExperimentWebSocket({ requestId: "socket", url: `ws://127.0.0.1:${server.port}`, headers: {} }, {
      evidence: f.evidence, fail: (error) => { failures.push(error); failed(); }, request: async () => behavior === "overflow" ? held : { accepted: false },
    });
    try {
      await failure; release({ accepted: true });
      await expect(socket.complete()).rejects.toThrow(behavior === "overflow" ? "backpressure" : "rejected");
      expect(failures).toHaveLength(1);
    } finally { release({ accepted: true }); socket.dispose(); await server.stop(true); }
  }
});

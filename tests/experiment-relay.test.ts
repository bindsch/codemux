import { afterEach, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { ExperimentFailure, ExperimentFailureCode } from "../src/experiment-records.js";
import { MAX_EXPERIMENT_MESSAGE_BYTES } from "../src/experiment-server.js";
import { cleanupRelays, http, list, records, rpc, setup } from "./helpers/experiment-relay-fixture.js";
import { MARKER } from "./fixtures/experiment-mcp.js";

afterEach(cleanupRelays);

const CATALOG_BODY = '{"models":[{"slug":"fixture-model","display_name":"Fixture π"}]}';

test("catalog support is optional", async () => {
  const relay = await setup();
  expect(relay.catalogUrl).toBeUndefined();
  expect(relay.catalogServed).toBe(false);
  expect(records(relay)[0]).toMatchObject({ kind: "run_start", catalog_override: false });
  expect((await http(relay, "", { method: "GET", path: "/catalog/missing", token: null })).status).toBe(404);
});

test.each([null, "Bearer synthetic-catalog-authorization"])("catalog GET serves exact JSON independently of bearer authorization: %s", async (token) => {
  const relay = await setup(undefined, { catalog: { body: CATALOG_BODY } });
  expect(typeof relay.catalogUrl).toBe("string");
  const catalog = new URL(relay.catalogUrl!);
  expect(catalog.origin === new URL(relay.url).origin).toBe(true);
  expect(/^\/catalog\/[a-f0-9]{64}$/.test(catalog.pathname)).toBe(true);
  expect(catalog.pathname.endsWith(relay.token)).toBe(false);
  expect(relay.catalogServed).toBe(false);
  const response = await http(relay, "", { method: "GET", path: catalog.pathname, token });
  expect(response).toMatchObject({ status: 200, body: CATALOG_BODY, type: "application/json" });
  expect(response.etag).toBeUndefined();
  expect(relay.catalogServed).toBe(true);
  const captured = records(relay);
  expect(captured[0]).toMatchObject({ kind: "run_start", catalog_override: true });
  expect(captured.filter((record) => record.kind === "http_request")).toEqual([
    expect.objectContaining({ method: "GET", path: "/catalog", client_version: null,
      authorization_present: token !== null, bytes_base64: "", body_complete: true }),
  ]);
  expect(captured.find((record) => record.kind === "catalog_served")).toMatchObject({
    client_version: null, bytes: Buffer.byteLength(CATALOG_BODY),
  });
  expect(captured.some((record) => record.kind === "server_stdin")).toBe(false);
});

test("catalog requests record only client_version and discard headers, nonce, other queries, and body", async () => {
  const relay = await setup(undefined, { catalog: { body: CATALOG_BODY } });
  expect(typeof relay.catalogUrl).toBe("string");
  const catalog = new URL(relay.catalogUrl!);
  const response = await http(relay, "synthetic-discarded-body", { method: "GET",
    path: `${catalog.pathname}?client_version=0.165.0&other=synthetic-discarded-query`,
    token: "Bearer synthetic-discarded-authorization", headers: { "X-Synthetic-Secret": "synthetic-discarded-header",
      "Content-Length": String(Buffer.byteLength("synthetic-discarded-body")) } });
  expect(response.status).toBe(200);
  const captured = records(relay);
  const request = captured.find((record) => record.kind === "http_request");
  const { run_id: _runId, seq: _seq, kind: _kind, t: _t, ...fields } = request;
  expect(fields).toEqual({ method: "GET", path: "/catalog", client_version: "0.165.0",
    authorization_present: true, bytes_base64: "", body_complete: true });
  expect(captured.find((record) => record.kind === "catalog_served")).toMatchObject({
    client_version: "0.165.0", bytes: Buffer.byteLength(CATALOG_BODY),
  });
  const recording = readFileSync(relay.recordingPath, "utf8");
  for (const omitted of [catalog.pathname.slice("/catalog/".length), "synthetic-discarded-body",
    "synthetic-discarded-query", "synthetic-discarded-authorization", "synthetic-discarded-header", "X-Synthetic-Secret"]) {
    expect(recording.includes(omitted)).toBe(false);
  }
});

test("catalog non-GET methods receive 405 with Allow GET and never mark delivery", async () => {
  const relay = await setup(undefined, { catalog: { body: CATALOG_BODY } });
  expect(typeof relay.catalogUrl).toBe("string");
  for (const method of ["POST", "HEAD", "PUT", "DELETE"]) {
    const response = await http(relay, "synthetic-discarded-body", { method, path: new URL(relay.catalogUrl!).pathname, token: null });
    expect(response).toMatchObject({ status: 405, body: "", allow: "GET" });
  }
  expect(relay.catalogServed).toBe(false);
  expect(records(relay).some((record) => record.kind === "catalog_served" || record.kind === "server_stdin")).toBe(false);
});

test("a catalog 405 answered before the request body arrives closes the connection, never poisons the socket (lane C30, item 6)", async () => {
  // The flake: the helper above sends chunked bodies over the agent's
  // reused socket, and a 405 answered while the body was still in flight
  // left the late chunks to be parsed as the next request's start — the
  // next request then answered 400 (once in 24 full gates, under load).
  // The split that reproduces it: headers first, body after a delay, on
  // one raw socket. The 405 must carry Connection: close, and nothing
  // else may follow it on the wire.
  const relay = await setup(undefined, { catalog: { body: CATALOG_BODY } });
  const catalog = new URL(relay.catalogUrl!);
  const { connect } = await import("node:net");
  const socket = connect({ port: Number(catalog.port), host: "127.0.0.1" });
  socket.on("error", () => { /* the closed side of a cut upload; the reply already arrived */ });
  const received: Buffer[] = [];
  socket.on("data", (chunk) => received.push(Buffer.from(chunk)));
  // Registered before the exchange: the relay may close the socket the
  // moment its 405 is out, before the delayed body is even written.
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  socket.write(
    `POST ${catalog.pathname} HTTP/1.1\r\nHost: 127.0.0.1:${catalog.port}\r\nTransfer-Encoding: chunked\r\n\r\n`
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  socket.end("19\r\nsynthetic-discarded-body\r\n0\r\n\r\n");
  await closed;
  const raw = Buffer.concat(received).toString("latin1");
  expect(raw).toMatch(/^HTTP\/1\.1 405 /);
  expect(raw).toContain("Connection: close");
  // Exactly one reply: no 400 ever follows on the wire for the leftovers.
  expect(raw.match(/HTTP\/1\.\d \d{3}/g)).toEqual(["HTTP/1.1 405"]);
});

test("catalog missing and incorrect nonces receive 404 without revealing them in recordings", async () => {
  const relay = await setup(undefined, { catalog: { body: CATALOG_BODY } });
  expect(typeof relay.catalogUrl).toBe("string");
  const catalog = new URL(relay.catalogUrl!);
  for (const path of ["/catalog", "/catalog/", "/catalog/synthetic-wrong-nonce", `${catalog.pathname}/extra`]) {
    expect((await http(relay, "", { method: "GET", path: `${path}?other=synthetic-discarded-query`, token: null })).status).toBe(404);
  }
  expect(relay.catalogServed).toBe(false);
  expect(records(relay).filter((record) => record.kind === "http_request").every((record) => record.path === "/catalog")).toBe(true);
  const recording = readFileSync(relay.recordingPath, "utf8");
  for (const omitted of [catalog.pathname.slice("/catalog/".length), "synthetic-wrong-nonce", "synthetic-discarded-query"]) {
    expect(recording.includes(omitted)).toBe(false);
  }
});

test("catalog support retains bearer authentication on the MCP route", async () => {
  const relay = await setup(undefined, { catalog: { body: CATALOG_BODY } });
  expect((await http(relay, rpc(1, "ping"), { token: null })).status).toBe(401);
  expect((await http(relay, rpc(1, "ping"))).status).toBe(200);
  expect(relay.catalogServed).toBe(false);
});

test("catalog nonces are unique to each relay and cannot authorize the MCP route", async () => {
  const first = await setup(undefined, { catalog: { body: CATALOG_BODY } });
  const second = await setup(undefined, { catalog: { body: CATALOG_BODY } });
  expect(typeof first.catalogUrl).toBe("string");
  expect(typeof second.catalogUrl).toBe("string");
  const firstPath = new URL(first.catalogUrl!).pathname;
  const secondPath = new URL(second.catalogUrl!).pathname;
  expect(firstPath === secondPath).toBe(false);
  expect((await http(second, "", { method: "GET", path: firstPath, token: null })).status).toBe(404);
  expect((await http(first, rpc(1, "ping"), { token: `Bearer ${firstPath.slice("/catalog/".length)}` })).status).toBe(401);
  expect(first.catalogServed || second.catalogServed).toBe(false);
});

test("loopback relay preserves request and response bytes and tool-call ordinals", async () => {
  const relay = await setup();
  expect(relay.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  expect(Buffer.from(relay.token, "hex")).toHaveLength(32);
  expect(statSync(relay.recordingPath).mode & 0o777).toBe(0o600);
  expect((await http(relay, rpc(0, "initialize"))).status).toBe(200);
  expect((await list(relay)).status).toBe(200);
  const body = '{ "jsonrpc":"2.0", "id":2, "method":"tools/call", "params":{"name":"bash","arguments":{"command":"π"}} }';
  const response = await http(relay, body);
  expect(response.status).toBe(200);
  expect(response.type).toBe("application/json");
  expect(JSON.parse(response.body)).toEqual({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: MARKER }] } });
  expect(relay.calls).toEqual([{ relay_index: 0, call_id: "native-0", rpc_ids: [2], name: "bash",
    input: { command: "π" }, result: { content: [{ type: "text", text: MARKER }] } }]);
  expect([...relay.toolNames]).toEqual(["bash"]);
  relay.finish();
  await relay.close();
  const captured = records(relay);
  expect(captured.filter((record) => record.kind === "http_request").at(-1)).toMatchObject({ method: "POST", path: "/mcp",
    token_matched: true, bytes_base64: Buffer.from(body).toString("base64") });
  expect(captured.filter((record) => record.kind === "http_response").at(-1)).toMatchObject({ status: 200,
    bytes_base64: Buffer.from(response.body).toString("base64") });
  for (const kind of ["tool_call", "mcp_request", "server_tool_result"]) {
    expect(captured.find((record) => record.kind === kind && record.relay_index === 0)).toBeDefined();
  }
  expect(captured.at(-1)).toMatchObject({ kind: "run_end", tool_calls: 1, error: null, code: null });
  expect(captured.map((record) => record.seq)).toEqual(captured.map((_, index) => index));
  expect(captured.every((record) => record.run_id === relay.runId)).toBe(true);
});

test("relay resolves a native call ID before server dispatch and preserves request metadata", async () => {
  const relay = await setup();
  await list(relay);
  let release!: (id: string) => void;
  relay.resolveCallId = (_call, request) => {
    expect(request).toMatchObject({ method: "tools/call", params: { _meta: { upstream: "kept" } } });
    return new Promise((resolveId) => { release = resolveId; });
  };
  const pending = http(relay, rpc(2, "tools/call", { name: "bash", arguments: {}, _meta: { upstream: "kept" } }));
  while (!release) await Bun.sleep(1);
  expect(records(relay).filter((record) => record.kind === "server_stdin")).toHaveLength(1);
  release("call-native");
  expect((await pending).status).toBe(200);
  const captured = records(relay);
  const stdin = captured.filter((record) => record.kind === "server_stdin").at(-1);
  const message = JSON.parse(Buffer.from(stdin.bytes_base64, "base64").toString());
  expect(message.params._meta).toEqual({ upstream: "kept", "codemux/callId": "call-native" });
  expect(captured.find((record) => record.kind === "tool_call")).toMatchObject({ call_id: "call-native", relay_index: 0 });
  expect(captured.find((record) => record.kind === "mcp_request" && record.relay_index === 0)?.message).toEqual(message);
});

test.each(["missing", "empty", "timeout"])("unresolved native call ID (%s) never dispatches to the server", async (reason) => {
  const relay = await setup();
  await list(relay);
  relay.resolveCallId = reason === "missing" ? undefined : async () => {
    if (reason === "timeout") throw new Error("native ID resolution timed out");
    return "";
  };
  expect((await http(relay, rpc(2, "tools/call", { name: "bash", arguments: {} }))).status).toBe(400);
  expect(records(relay).filter((record) => record.kind === "server_stdin")).toHaveLength(1);
  expect(relay.failureCode).toBe(ExperimentFailureCode.CallIdUnresolved);
  await relay.close().catch(() => {});
  expect(records(relay).find((record) => record.kind === "failure")).toMatchObject({ code: ExperimentFailureCode.CallIdUnresolved });
  expect(records(relay).at(-1)).toMatchObject({ kind: "run_end", code: ExperimentFailureCode.CallIdUnresolved });
});

test("native call ID resolution preserves a typed harness evidence failure", async () => {
  const relay = await setup();
  await list(relay);
  relay.resolveCallId = async () => { throw new ExperimentFailure(ExperimentFailureCode.MessageIdMissing, "missing native message ID"); };
  expect((await http(relay, rpc(2, "tools/call", { name: "bash", arguments: {} }))).status).toBe(400);
  expect(relay.failureCode).toBe(ExperimentFailureCode.MessageIdMissing);
  expect(records(relay).filter((record) => record.kind === "server_stdin")).toHaveLength(1);
});

test("parallel resolution reserves relay ordinals before either native ID is available", async () => {
  const relay = await setup();
  await list(relay);
  const releases: ((id: string) => void)[] = [];
  relay.resolveCallId = (call) => new Promise((resolveId) => { releases[call.relay_index] = resolveId; });
  const first = http(relay, rpc(2, "tools/call", { name: "bash", arguments: { command: "first" } }));
  while (!releases[0]) await Bun.sleep(1);
  const second = http(relay, rpc(3, "tools/call", { name: "bash", arguments: { command: "second" } }));
  while (!releases[1]) await Bun.sleep(1);
  expect(relay.calls.map((call) => call.relay_index)).toEqual([0, 1]);
  releases[1]!("second-native");
  expect((await second).status).toBe(200);
  releases[0]!("first-native");
  expect((await first).status).toBe(200);
  expect(relay.calls.map((call) => call.call_id)).toEqual(["first-native", "second-native"]);
});

test("relay shutdown cancels unresolved native ID work without waiting for the resolver", async () => {
  const relay = await setup();
  await list(relay);
  let release!: (id: string) => void;
  relay.resolveCallId = () => new Promise((resolveId) => { release = resolveId; });
  const pending = http(relay, rpc(2, "tools/call", { name: "bash", arguments: {} })).catch(() => undefined);
  while (!release) await Bun.sleep(1);
  const closing = relay.close().then(() => undefined, (error) => error);
  const outcome = await Promise.race([closing, Bun.sleep(100).then(() => "still waiting")]);
  release("too-late-native");
  await pending;
  await closing;
  expect(outcome).toMatchObject({ code: ExperimentFailureCode.CallIdUnresolved });
  expect(records(relay).filter((record) => record.kind === "server_stdin")).toHaveLength(1);
});

test("notifications receive 202 without a fabricated JSON-RPC body", async () => {
  const relay = await setup();
  const response = await http(relay, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  expect(response).toMatchObject({ status: 202, body: "" });
  expect(records(relay).find((record) => record.kind === "mcp_request")).toMatchObject({ rpc_id: null });
});

test("a forwarded JSON-RPC error keeps its 200 response and fails the run", async () => {
  const relay = await setup();
  const response = await http(relay, rpc(1, "fixture/unknown"));
  expect(response.status).toBe(200);
  expect(response.type).toBe("application/json");
  expect(JSON.parse(response.body)).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } });
  expect(() => relay.finish()).toThrow("JSON-RPC error: Method not found");
  expect(relay.failureCode).toBe(ExperimentFailureCode.ServerError);
  await expect(relay.close()).rejects.toThrow("JSON-RPC error: Method not found");
});

test("HTTP rejects authorization, methods, paths, malformed JSON, and batches before forwarding", async () => {
  const relay = await setup();
  for (const token of ["", "Bearer wrong", `bearer ${relay.token}`, `Bearer ${relay.token}x`]) {
    expect((await http(relay, rpc(1, "ping"), { token })).status).toBe(401);
  }
  for (const method of ["GET", "DELETE", "PUT"]) expect((await http(relay, "", { method })).status).toBe(405);
  expect((await http(relay, rpc(1, "ping"), { path: "/other" })).status).toBe(404);
  for (const body of ["", "{", "[]", '[{"jsonrpc":"2.0","id":1,"method":"ping"}]', "null", "1",
    '{"jsonrpc":"1.0","id":1,"method":"ping"}', '{"jsonrpc":"2.0","id":null,"method":"ping"}',
    '{"jsonrpc":"2.0","id":1}', '{"jsonrpc":"2.0","id":1,"method":"ping","params":[]}']) {
    expect((await http(relay, body)).status).toBe(400);
  }
  expect(records(relay).some((record) => record.kind === "server_stdin")).toBe(false);
});

test("an oversized body receives 413 and never reaches the stdio server", async () => {
  const relay = await setup();
  expect((await http(relay, "x".repeat(MAX_EXPERIMENT_MESSAGE_BYTES + 1))).status).toBe(413);
  expect(records(relay).some((record) => record.kind === "server_stdin")).toBe(false);
  expect(records(relay).find((record) => record.kind === "http_response")?.status).toBe(413);
  expect(records(relay).find((record) => record.kind === "http_request")?.body_complete).toBe(false);
});

test("tool calls require the validated inventory and reject unadvertised names", async () => {
  for (const beforeList of [true, false]) {
    const relay = await setup();
    if (!beforeList) await list(relay);
    expect((await http(relay, rpc(2, "tools/call", { name: beforeList ? "bash" : "other", arguments: {} }))).status).toBe(400);
    expect(() => relay.finish()).toThrow(beforeList ? "inventory" : "unknown");
  }
});

test("concurrent tools/call replies retain their original relay ordinals", async () => {
  const relay = await setup(`import { createInterface } from 'node:readline';
    for await (const line of createInterface({input:process.stdin})) {
      const m = JSON.parse(line); if (m.id === undefined) continue;
      const result = m.method === 'tools/list' ? {tools:[{name:'bash'}]}
        : {content:[{type:'text',text:m.params.arguments.value}]};
      setTimeout(() => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n'), m.params?.arguments?.delay ?? 0);
    }`);
  await list(relay);
  const responses = await Promise.all([http(relay, rpc(2, "tools/call", { name: "bash", arguments: { value: "first", delay: 20 } })),
    http(relay, rpc(3, "tools/call", { name: "bash", arguments: { value: "second", delay: 0 } }))]);
  expect(responses.map((response) => JSON.parse(response.body).id)).toEqual([2, 3]);
  expect(relay.calls.map((call) => ({ relay_index: call.relay_index, text: call.result?.content[0].text })))
    .toEqual([{ relay_index: 0, text: "first" }, { relay_index: 1, text: "second" }]);
  expect(records(relay).filter((record) => record.kind === "server_tool_result").map((record) => record.relay_index)).toEqual([1, 0]);
});

test.each(["structuredContent", "_meta"])("HTTP results refuse %s before sending model-visible bytes", async (field) => {
  const relay = await setup(`import { createInterface } from 'node:readline';
    for await (const line of createInterface({input:process.stdin})) {
      const m = JSON.parse(line); if (m.id === undefined) continue;
      const result = m.method === 'tools/list' ? {tools:[{name:'bash'}]} : {content:[],[${JSON.stringify(field)}]:{}};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
    }`);
  await list(relay);
  expect((await http(relay, rpc(2, "tools/call", { name: "bash", arguments: {} }))).status).toBe(400);
  expect(() => relay.finish()).toThrow(field);
  expect(relay.failureCode).toBe(ExperimentFailureCode.UnsupportedResult);
});

test("external evidence failures survive relay finalization", async () => {
  const relay = await setup();
  await list(relay);
  relay.fail(new Error("fixture evidence mismatch"));
  await expect(relay.close()).rejects.toThrow("fixture evidence mismatch");
  expect(records(relay).at(-1)).toMatchObject({ kind: "run_end", error: "fixture evidence mismatch", code: ExperimentFailureCode.Protocol });
});

test("failure subscriptions abort promptly and can be removed", async () => {
  const relay = await setup();
  let removed = 0;
  let active = 0;
  const unsubscribe = relay.onFailure(() => { removed++; });
  unsubscribe();
  relay.onFailure((error) => { expect(error.message).toBe("fixture failure"); active++; });
  relay.fail(new Error("fixture failure"));
  relay.fail(new Error("later failure"));
  let late = "";
  relay.onFailure((error) => { late = error.message; });
  expect(removed).toBe(0);
  expect(active).toBe(1);
  expect(late).toBe("fixture failure");
});

test("finish failures appear in run_end even without an external failure reporter", async () => {
  const relay = await setup();
  expect(() => relay.finish()).toThrow("validated tool inventory");
  await expect(relay.close()).rejects.toThrow("validated tool inventory");
  expect(records(relay).at(-1)?.error).toContain("validated tool inventory");
});

test.each([false, true])("relay inventory follows every page and rechecks tool-list notifications: changed=%s", async (changed) => {
  const relay = await setup(`import { createInterface } from 'node:readline';
    let generation = 0;
    for await (const line of createInterface({input:process.stdin})) {
      const m = JSON.parse(line); if (m.id === undefined) continue;
      const result = m.method === 'tools/list' ? (m.params?.cursor === undefined
        ? {tools:[{name:'bash',inputSchema:{type:'object'}}],nextCursor:''}
        : {tools:[{name:'read',description:generation && ${changed} ? 'changed' : 'stable'}]}) : {content:[]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
      if (m.method === 'tools/call') { generation++;
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed'})+'\\n'); }
    }`);
  const inventory = JSON.parse((await list(relay)).body).result;
  expect(inventory).toEqual({ tools: [{ name: "bash", inputSchema: { type: "object" } }, { name: "read", description: "stable" }] });
  expect((await http(relay, rpc(2, "tools/call", { name: "bash", arguments: {} }))).status).toBe(200);
  const deadline = Date.now() + 1000;
  while (!records(relay).some((record) => record.kind === "tool_inventory_recheck") && Date.now() < deadline) await Bun.sleep(5);
  expect(records(relay).find((record) => record.kind === "tool_inventory_recheck")?.equal).toBe(!changed);
  if (changed) {
    expect(() => relay.finish()).toThrow("definitions changed");
    await expect(relay.close()).rejects.toThrow("definitions changed");
  } else {
    relay.finish();
    await relay.close();
  }
});

test.each([false, true])("synchronous cleanup records one failure and stops the endpoint; priorFailure=%s", async (priorFailure) => {
  const relay = await setup();
  const code = priorFailure ? ExperimentFailureCode.ResultChanged : ExperimentFailureCode.Protocol;
  const message = priorFailure ? "synthetic changed result" : "process exited before asynchronous experiment cleanup completed";
  if (priorFailure) relay.fail(new ExperimentFailure(code, message));
  relay.closeSync(); relay.closeSync();
  await expect(http(relay, rpc(1, "ping"))).rejects.toThrow();
  const log = records(relay);
  expect(log.filter((entry) => entry.kind === "failure")).toEqual([expect.objectContaining({ code, message })]);
  expect(log.at(-1)).toMatchObject({ kind: "run_end", code, error: message });
  expect(log.findIndex((entry) => entry.kind === "failure")).toBeLessThan(log.length - 1);
});

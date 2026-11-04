/**
 * The experiment message bound at the HTTP relay and the stdio forwarder
 * (review rounds 73 and 74): the JSON body alone counts, a tools/call is
 * measured in its final forwarded form before it is registered, and a
 * refusal consumes no relay index.
 */
import { afterEach, expect, test } from "bun:test";
import { ExperimentFailureCode } from "../src/experiment-records.js";
import { MAX_NATIVE_CALL_ID_CHARS } from "../src/experiment-relay-respond.js";
import { MAX_EXPERIMENT_MESSAGE_BYTES } from "../src/experiment-server.js";
import { MARKER } from "./fixtures/experiment-mcp.js";
import { cleanupRelays, http, list, records, rpc, setup } from "./helpers/experiment-relay-fixture.js";

afterEach(cleanupRelays);

test("a body of exactly the bound is accepted end to end; one byte more never reaches the server (review round 73)", async () => {
  const relay = await setup();
  await list(relay);
  // A request the relay forwards verbatim (a cursorless tools/list; ping
  // it answers locally): the bound is measured on the JSON body alone, so
  // the boundary itself must pass everywhere.
  const bodyOf = (bytes: number): string => {
    const message = { jsonrpc: "2.0", id: 2, method: "tools/list", params: { pad: "" } };
    const bare = Buffer.byteLength(JSON.stringify(message));
    message.params.pad = "x".repeat(bytes - bare);
    const body = JSON.stringify(message);
    expect(Buffer.byteLength(body)).toBe(bytes);
    return body;
  };
  const forwardedCount = (): number => records(relay).filter((record) => record.kind === "server_stdin").length;
  // One byte past the bound, as a valid request: refused at HTTP, and
  // the stdio server never sees it (the listing stays the only forward).
  const forwardedBefore = forwardedCount();
  expect((await http(relay, bodyOf(MAX_EXPERIMENT_MESSAGE_BYTES + 1))).status).toBe(413);
  expect(forwardedCount()).toBe(forwardedBefore);
  // Exactly the bound: HTTP accepts the body, and the forwarder accepts
  // it too — it measures the JSON body alone, so the newline it appends
  // for framing cannot push a boundary request past the same limit.
  const accepted = await http(relay, bodyOf(MAX_EXPERIMENT_MESSAGE_BYTES));
  expect(accepted.status).toBe(200);
  expect(JSON.parse(accepted.body)).toMatchObject({ id: 2, result: { tools: [{ name: "bash" }] } });
  expect(forwardedCount()).toBe(forwardedBefore + 1);
  const line = Buffer.from(records(relay).filter((record) => record.kind === "server_stdin").at(-1)!.bytes_base64,
    "base64").toString("utf8");
  expect(line.endsWith("\n")).toBe(true); // framing rode along, uncounted
  expect(Buffer.byteLength(line)).toBe(MAX_EXPERIMENT_MESSAGE_BYTES + 1);
});

test("a tools/call whose injected call id crosses the bound is refused at HTTP, before registration (review rounds 73, 74)", async () => {
  const relay = await setup();
  await list(relay);
  // The relay injects `,"_meta":{"codemux/callId":"<id>"}` into the
  // params; the acceptance probe measures the longest id the resolver may
  // answer, so a body inside that bound always forwards. One byte over is
  // a 413 that never reaches the server, consumes no relay index, leaves
  // no correlation state, and is recorded as the refusal it is.
  const injected = Buffer.byteLength(`,"_meta":{"codemux/callId":"${"x".repeat(MAX_NATIVE_CALL_ID_CHARS)}"}`);
  const callOf = (bytes: number): string => {
    const message = { jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "bash", arguments: { command: "boundary", pad: "" } } };
    const bare = Buffer.byteLength(JSON.stringify(message));
    message.params.arguments.pad = "x".repeat(bytes - bare);
    const body = JSON.stringify(message);
    expect(Buffer.byteLength(body)).toBe(bytes);
    return body;
  };
  expect((await http(relay, callOf(MAX_EXPERIMENT_MESSAGE_BYTES - injected + 1))).status).toBe(413);
  expect(records(relay).filter((record) => record.kind === "server_stdin")).toHaveLength(1); // only the tools/list
  expect(records(relay).filter((record) => record.kind === "tool_call")).toHaveLength(0);
  expect(records(relay).filter((record) => record.kind === "request_refused")).toMatchObject([{ rpc_id: 3, method: "tools/call", reason: "oversized" }]);
  expect(relay.calls).toHaveLength(0);
  expect(relay.failureCode).toBeNull();
  expect(() => relay.finish()).not.toThrow(); // the refused call was never registered
  const accepted = await http(relay, callOf(MAX_EXPERIMENT_MESSAGE_BYTES - injected));
  expect(accepted.status).toBe(200);
  expect(JSON.parse(accepted.body)).toMatchObject({ id: 3, result: { content: [{ type: "text", text: MARKER }] } });
  // The accepted call took the first relay index: the refusal consumed none.
  expect(relay.calls.map((call) => call.relay_index)).toEqual([0]);
});

test("a native call id over the injected bound fails the run as unresolved; the bound is JSON bytes (review rounds 74, 75)", async () => {
  // 512 quote characters serialize to 1024 bytes between the quotes: the
  // acceptance probe measured 512, so such an id is refused at resolution
  // (the UTF-16 length alone would have let it past the probe).
  for (const id of ["n".repeat(MAX_NATIVE_CALL_ID_CHARS + 1), '"'.repeat(MAX_NATIVE_CALL_ID_CHARS), "\u00e9".repeat(MAX_NATIVE_CALL_ID_CHARS)]) {
    const relay = await setup();
    await list(relay);
    relay.resolveCallId = async () => id;
    const response = await http(relay, rpc(3, "tools/call", { name: "bash", arguments: { command: "x" } }));
    expect(response.status).not.toBe(200);
    expect(relay.failureCode).toBe(ExperimentFailureCode.CallIdUnresolved);
  }
  // Exactly the bound in ASCII still resolves.
  const relay = await setup();
  await list(relay);
  relay.resolveCallId = async () => "n".repeat(MAX_NATIVE_CALL_ID_CHARS);
  expect((await http(relay, rpc(3, "tools/call", { name: "bash", arguments: { command: "x" } }))).status).toBe(200);
});

test("a server response body of exactly the bound is accepted; one byte more fails the run (review round 75)", async () => {
  // The stdio reader used to count the framing newline, so a valid
  // response of exactly MAX_EXPERIMENT_MESSAGE_BYTES was refused and its
  // request never resolved.
  for (const extra of [0, 1]) {
    const relay = await setup(`import { createInterface } from 'node:readline';
      for await (const line of createInterface({input:process.stdin})) {
        const m = JSON.parse(line); if (m.id === undefined) continue;
        if (m.method !== 'tools/list') { process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:m.id, result:{}})+'\\n'); continue; }
        const reply = {jsonrpc:'2.0', id:m.id, result:{tools:[{name:'bash', description:''}]}};
        const bare = Buffer.byteLength(JSON.stringify(reply));
        reply.result.tools[0].description = 'x'.repeat(${MAX_EXPERIMENT_MESSAGE_BYTES + extra} - bare);
        process.stdout.write(JSON.stringify(reply)+'\\n');
      }`);
    const response = await list(relay);
    if (extra === 0) {
      expect(response.status).toBe(200);
      expect(Buffer.byteLength(response.body)).toBe(MAX_EXPERIMENT_MESSAGE_BYTES);
      expect(relay.failureCode).toBeNull();
    } else {
      expect(response.status).not.toBe(200);
      expect(relay.failureCode).not.toBeNull();
    }
  }
});

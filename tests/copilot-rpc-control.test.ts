import { expect, test } from "bun:test";
import { CopilotRpcControl } from "../src/session/copilot-rpc-control.js";
import { CopilotRpcFramer, copilotRpcBodyLimit, encodeCopilotRpc } from "../src/session/copilot-rpc-framing.js";

const copilotRpcId = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function copilotRpcFixture(denyPermissions = true, timeoutMs?: number) {
  const writes: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const failures: Error[] = [];
  const control = new CopilotRpcControl({ sessionId: copilotRpcId, denyPermissions, timeoutMs,
    write(bytes) { writes.push(new CopilotRpcFramer().push(bytes)[0] as Record<string, unknown>); },
    onEvent(event) { events.push(event); }, onFailure(error) { failures.push(error); } });
  const reply = (index: number, result: unknown) => control.receive(encodeCopilotRpc({
    jsonrpc: "2.0", id: writes[index]!.id, result,
  }));
  const notify = (event: unknown, sessionId = copilotRpcId) => control.receive(encodeCopilotRpc({
    jsonrpc: "2.0", method: "session.event", params: { sessionId, event },
  }));
  return { control, writes, events, failures, reply, notify };
}

test("Copilot RPC framing handles fragmented Unicode and adjacent bodies without newline", () => {
  const frame = encodeCopilotRpc({ jsonrpc: "2.0", result: "é🙂" });
  const framer = new CopilotRpcFramer();
  const messages = [...frame].flatMap((byte) => framer.push(Uint8Array.of(byte)));
  expect(messages).toEqual([{ jsonrpc: "2.0", result: "é🙂" }]);
  expect(framer.push(Buffer.concat([frame, frame]))).toHaveLength(2);
  expect(() => framer.end()).not.toThrow();
});

test("Copilot RPC framing rejects malformed lengths, encoding, oversized data and truncation", () => {
  for (const header of ["", "Content-Length: -1", "Content-Length: 0",
    "Content-Length: 1\r\nContent-Length: 2", `Content-Length: ${copilotRpcBodyLimit + 1}`]) {
    expect(() => new CopilotRpcFramer().push(Buffer.from(`${header}\r\n\r\n`))).toThrow();
  }
  expect(() => new CopilotRpcFramer().push(Buffer.from("h".repeat(8193)))).toThrow("header");
  expect(() => new CopilotRpcFramer().push(Buffer.from(`${"h".repeat(8193)}\r\n\r\n`))).toThrow("header");
  expect(() => new CopilotRpcFramer().push(Buffer.alloc(copilotRpcBodyLimit + 8193))).toThrow("buffered");
  expect(() => encodeCopilotRpc({ text: "x".repeat(copilotRpcBodyLimit) })).toThrow("byte limit");
  expect(() => new CopilotRpcFramer().push(Buffer.concat([Buffer.from("Content-Length: 1\r\n\r\n"), Buffer.from([255])]))).toThrow();
  expect(() => new CopilotRpcFramer().push(Buffer.from("Content-Length: 1\r\n\r\nx"))).toThrow();
  const partial = new CopilotRpcFramer();
  partial.push(Buffer.from("Content-Length: 5\r\n\r\n{"));
  expect(() => partial.end()).toThrow("truncated");
});

test("Copilot RPC opens and resumes with a permission handler and disables automatic grants", async () => {
  const f = copilotRpcFixture();
  try {
    const opening = f.control.open(false, { workingDirectory: "/fixture", availableTools: ["codemux-no-tools"] });
    expect(f.writes[0]).toMatchObject({ method: "session.create", params: {
      sessionId: copilotRpcId, requestPermission: true, workingDirectory: "/fixture", availableTools: ["codemux-no-tools"],
    } });
    f.reply(0, { sessionId: copilotRpcId });
    await Promise.resolve();
    expect(f.writes[1]).toMatchObject({ method: "session.permissions.configure", params: {
      approveAllToolPermissionRequests: false, approveAllReadPermissionRequests: false,
    } });
    f.reply(1, { success: true });
    await opening;
    const resumed = f.control.open(true, { workingDirectory: "/fixture" });
    expect(f.writes[2]!.method).toBe("session.resume");
    f.reply(2, { sessionId: copilotRpcId });
    await Promise.resolve();
    f.reply(3, { success: true });
    await resumed;
    expect(f.failures).toEqual([]);
  } finally { f.control.close(); }
});

test("Copilot RPC sends prompt and abort over framed stdin, and reports native usage", async () => {
  const f = copilotRpcFixture(false);
  try {
    const open = f.control.open(false, { workingDirectory: "/fixture" });
    f.reply(0, { sessionId: copilotRpcId });
    await open;
    const prompt = f.control.send("secret\né🙂");
    expect(f.writes[1]).toMatchObject({ method: "session.send", params: { prompt: "secret\né🙂" } });
    f.reply(1, { messageId: "one" });
    await prompt;
    const abort = f.control.abort();
    expect(f.writes[2]).toMatchObject({ method: "session.abort", params: { sessionId: copilotRpcId } });
    f.reply(2, {});
    await abort;
    const usage = f.control.usage();
    f.reply(3, { modelMetrics: { actual: { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1 } } } });
    expect((await usage).total_tokens).toBe(12);
    f.control.end();
    await expect(f.control.abort()).rejects.toThrow("closed");
  } finally { f.control.close(); }
});

test("Copilot RPC deny responds with native reject and preserves hook-resolved decisions", async () => {
  const f = copilotRpcFixture();
  try {
    f.notify({ type: "permission.requested", data: { requestId: "pending" } });
    expect(f.writes[0]).toMatchObject({ method: "session.permissions.handlePendingPermissionRequest",
      params: { sessionId: copilotRpcId, requestId: "pending", result: { kind: "reject" } } });
    f.reply(0, { success: true });
    f.notify({ type: "permission.requested", data: { requestId: "hook", resolvedByHook: true } });
    expect(f.writes).toHaveLength(1);
    expect(f.events).toHaveLength(2);
    f.control.receive(encodeCopilotRpc({ jsonrpc: "2.0", id: "server", method: "userInput.request", params: {} }));
    expect(f.writes[1]).toMatchObject({ id: "server", error: { code: -32601 } });
    f.control.receive(encodeCopilotRpc({ jsonrpc: "2.0", method: "session.lifecycle", params: {} }));
    expect(f.failures).toHaveLength(0);
    await Promise.resolve();
  } finally { f.control.close(); }
});

test("Copilot RPC rejects foreign identities and failed permission configuration", async () => {
  for (const failure of ["identity", "permissions"] as const) {
    const f = copilotRpcFixture();
    const opening = f.control.open(false, { workingDirectory: "/fixture" });
    f.reply(0, { sessionId: failure === "identity" ? "foreign" : copilotRpcId });
    if (failure === "permissions") { await Promise.resolve(); f.reply(1, { success: false }); }
    await expect(opening).rejects.toThrow(failure === "identity" ? "different session" : "automatic permission");
    expect(f.failures).toHaveLength(1);
  }
});

test("Copilot RPC malformed frames settle every pending request and stop events", async () => {
  for (const message of [null, { jsonrpc: "1.0" }, { jsonrpc: "2.0", id: 999, result: {} },
    { jsonrpc: "2.0", id: 1, error: [] },
    { jsonrpc: "2.0", method: "session.event", params: { sessionId: "foreign", event: {} } },
    { jsonrpc: "2.0", method: "session.event", params: { sessionId: copilotRpcId, event: {} } },
    { jsonrpc: "2.0", method: "session.event", params: { sessionId: copilotRpcId, event: { type: "permission.requested", data: {} } } },
  ]) {
    const f = copilotRpcFixture();
    const pending = f.control.send("prompt");
    const body = JSON.stringify(message);
    f.control.receive(Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
    await expect(pending).rejects.toThrow();
    f.notify({ type: "assistant.message" });
    expect(f.events).toHaveLength(0);
    expect(f.failures).toHaveLength(1);
    f.control.close();
  }
});

test("Copilot RPC errors and malformed responses reject the corresponding request", async () => {
  const f = copilotRpcFixture();
  const first = f.control.abort();
  f.control.receive(encodeCopilotRpc({ jsonrpc: "2.0", id: 1, error: { message: "native error" } }));
  await expect(first).rejects.toThrow("native error");
  const second = f.control.abort();
  f.control.receive(encodeCopilotRpc({ jsonrpc: "2.0", id: 2 }));
  await expect(second).rejects.toThrow("neither result nor error");
  f.control.close();
});

test("Copilot RPC write failures, truncation, timeouts and queue limits cannot leave pending work", async () => {
  const broken = new CopilotRpcControl({ sessionId: copilotRpcId, denyPermissions: true,
    write() { throw "write failure"; }, onEvent() {}, onFailure() {} });
  await expect(broken.abort()).rejects.toThrow("write failure");
  const truncated = copilotRpcFixture();
  truncated.control.receive(Buffer.from("Content-Length: 9\r\n\r\n{"));
  truncated.control.end();
  expect(truncated.failures[0]!.message).toContain("truncated");
  const timeout = copilotRpcFixture(true, 1);
  const expired = timeout.control.abort();
  await expect(expired).rejects.toThrow("timed out");
  const limited = copilotRpcFixture();
  const promises = Array.from({ length: 64 }, () => limited.control.abort().catch((error: Error) => error.message));
  await expect(limited.control.abort()).rejects.toThrow("too many pending");
  limited.control.close();
  expect(await Promise.all(promises)).toHaveLength(64);
  for (const sessionId of ["", "../foreign"]) {
    expect(() => new CopilotRpcControl({ sessionId, denyPermissions: true, write() {}, onEvent() {}, onFailure() {} })).toThrow("invalid");
  }
  expect(() => new CopilotRpcControl({ sessionId: copilotRpcId, timeoutMs: 0, denyPermissions: true,
    write() {}, onEvent() {}, onFailure() {} })).toThrow("positive integer");
});

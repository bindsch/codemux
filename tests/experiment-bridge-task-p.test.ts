import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ExperimentFailureCode as Code } from "../src/experiment-records.js";
import { cleanupPeers, peer } from "./helpers/experiment-peer.js";

afterEach(cleanupPeers);

test("Claude classifies a reused tool ID with changed arguments as protocol", async () => {
  const p = peer();
  await p.ready();
  const assistant = (command: string) => p.push({ type: "assistant", message: {
    id: "message-1", role: "assistant", usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: "tool_use", id: "call-1",
      name: "mcp__experiment__bash", input: { command } }],
  } });
  assistant("first");
  expect(() => assistant("first")).not.toThrow();
  expect(() => assistant("changed")).toThrow(expect.objectContaining({ code: Code.Protocol }));
  expect(p.bridge.failureCode).toBe(Code.Protocol);
  expect(p.records().filter((record) => record.kind === "failure")).toMatchObject([{ code: Code.Protocol }]);
  expect(p.records().filter((record) => record.kind === "tool_call")).toHaveLength(1);
});

test.each([null, [], "text", 1, true].map((input) => ({ input })))("Claude refuses non-object MCP arguments %j before dispatch", async ({ input }) => {
  const p = peer();
  await p.ready();
  p.call("call-1");
  p.mcp("invalid-input", { id: 2, method: "tools/call", params: {
    name: "bash", arguments: input, _meta: { "claudecode/toolUseId": "call-1" },
  } });
  await new Promise((resolve) => setImmediate(resolve));
  expect(p.bridge.failureCode).toBe(Code.Protocol);
  expect(p.request.mock.calls.filter(([message]) => message.method === "tools/call")).toHaveLength(0);
  expect(p.records().filter((record) => record.kind === "failure")).toMatchObject([{ code: Code.Protocol }]);
});

test("Claude forwards the same default object used for native argument correlation", async () => {
  const p = peer();
  await p.ready();
  p.call("call-1");
  p.request.mockImplementation(async (message) => ({ jsonrpc: "2.0", id: message.id,
    result: { content: [{ type: "text", text: "OK" }] } }));
  p.mcp("default-input", { id: 2, method: "tools/call", params: {
    name: "bash", _meta: { "claudecode/toolUseId": "call-1" },
  } });
  await new Promise((resolve) => setImmediate(resolve));
  expect(p.bridge.failureCode).toBeNull();
  const forwarded = p.request.mock.calls.find(([message]) => message.method === "tools/call")![0];
  expect(forwarded.params.arguments).toEqual({});
  const call = p.records().find((record) => record.kind === "tool_call")!;
  expect(forwarded.params.arguments).toEqual(call.input);
});

test("experiment specification documents each harness prompt transport limit", () => {
  const guide = readFileSync(resolve("docs/experiment-mcp.md"), "utf8");
  const specification = guide.split("## Specification\n")[1]!.split("## Runnable fixture example")[0]!;
  expect(specification).toContain("Claude and Z.AI");
  expect(specification).toContain("1 MiB");
  expect(specification).toContain("Codex");
  expect(specification).toContain("16 MiB stdin");
  expect(specification).toContain("Kimi");
  expect(specification).toContain("32 KiB argv");
  expect(specification).not.toContain("This is tighter than the general prompt limit");
});

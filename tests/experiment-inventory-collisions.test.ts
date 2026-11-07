import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ExperimentBridge } from "../src/experiment-bridge.js";
import { ExperimentInventory } from "../src/experiment-inventory.js";
import type { ExperimentSpec } from "../src/experiment-mcp.js";
import { ExperimentFailureCode } from "../src/experiment-records.js";
import { ExperimentHttpRelay } from "../src/experiment-relay.js";
import { ExperimentServer } from "../src/experiment-server.js";

const TOOLS = [{ name: "foo-bar" }, { name: "foo_bar" }];

test.each([false, true])("shared inventory rejects Kimi underscore collisions across pages=%s", async (paginated) => {
  const tools = [{ name: "foo__bar" }, { name: "foo_bar" }];
  const inventory = new ExperimentInventory("experiment", async (request) => ({
    jsonrpc: "2.0", id: request.id, result: { tools: tools.slice(1) },
  }), () => {}, () => {}, () => true);
  await expect(inventory.accept({ jsonrpc: "2.0", id: 1, result: paginated
    ? { tools: tools.slice(0, 1), nextCursor: "next" } : { tools } }, null))
    .rejects.toMatchObject({ code: ExperimentFailureCode.InventoryMismatch });
  expect(inventory.definitions).toBeUndefined();
  expect(inventory.names.size).toBe(0);
});

test("pagination past the page bound is refused instead of collected without end", async () => {
  // Review round 286: every cursor a server offers must be unique, so a
  // server that keeps answering with empty pages and fresh cursors kept
  // collection — and its mcp_request records — running without end. The
  // pre-fix code accepted this server's 150 pages; the bound refuses
  // past it. The last page here carries a real tool, so without a bound
  // the collection would have completed.
  let requests = 0;
  const inventory = new ExperimentInventory("experiment", async (request) => {
    requests += 1;
    return {
      jsonrpc: "2.0", id: request.id,
      ...(requests > 150
        ? { result: { tools: [{ name: "tool-a" }] } }
        : { result: { tools: [], nextCursor: `cursor-${requests}` } }),
    };
  }, () => {}, () => {}, () => true);
  await expect(inventory.accept(
    { jsonrpc: "2.0", id: 1, result: { tools: [], nextCursor: "cursor-0" } }, null
  )).rejects.toMatchObject({
    code: ExperimentFailureCode.InventoryMismatch,
    message: expect.stringContaining("tools/list pages"),
  });
  expect(inventory.definitions).toBeUndefined();
  expect(requests).toBeLessThanOrEqual(100);
});

function fixture() {
  const parent = resolve("scratch/session-14c66a93/exp/inventory-collision-fixtures");
  mkdirSync(parent, { recursive: true });
  const cwd = mkdtempSync(join(parent, "case-"));
  const spec: ExperimentSpec = { name: "experiment", command: process.execPath,
    args: [], env: [], recording: join(cwd, "records") };
  return { cwd, spec };
}

function inventoryPeer(): () => void {
  const start = spyOn(ExperimentServer.prototype, "start").mockImplementation(() => {});
  const request = spyOn(ExperimentServer.prototype, "request").mockImplementation(async (message) => ({
    jsonrpc: "2.0", id: message.id, result: { tools: TOOLS },
  }));
  return () => { request.mockRestore(); start.mockRestore(); };
}

function records(path: string): Record<string, any>[] {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test.each([false, true])("shared inventory rejects sanitizer collisions before calls, paginated=%s", async (paginated) => {
  const inventory = new ExperimentInventory("experiment", async (request) => ({
    jsonrpc: "2.0", id: request.id, result: { tools: TOOLS.slice(1) },
  }), () => {}, () => {}, () => true);
  await expect(inventory.accept({ jsonrpc: "2.0", id: 1, result: paginated
    ? { tools: TOOLS.slice(0, 1), nextCursor: "next" } : { tools: TOOLS } }, null))
    .rejects.toMatchObject({ code: ExperimentFailureCode.InventoryMismatch });
  expect(inventory.definitions).toBeUndefined();
  expect(inventory.names.size).toBe(0);
});

test.each(["codex", "kimi"] as const)("%s HTTP relay rejects a colliding inventory without any tool call", async (harness) => {
  const { cwd, spec } = fixture();
  const restore = inventoryPeer();
  spec.accept_harness_prefix = [harness === "codex" ? "codex-wall-time" : "kimi-wall-time"];
  const relay = new ExperimentHttpRelay(spec, cwd, {});
  try {
    await relay.start();
    const response = await fetch(relay.url, { method: "POST", headers: {
      Authorization: `Bearer ${relay.token}`, "Content-Type": "application/json",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    await response.text();
    expect(response.status).toBe(400);
    expect(relay.failureCode).toBe(ExperimentFailureCode.InventoryMismatch);
    expect(relay.toolDefinitions).toBeUndefined();
    expect(relay.calls).toHaveLength(0);
    expect(records(relay.recordingPath).some((record) => record.kind === "tool_call")).toBe(false);
  } finally { await relay.close().catch(() => {}); restore(); }
});

test.each(["claude", "zai"])("%s SDK bridge rejects a colliding inventory before exposing it", async () => {
  const { cwd, spec } = fixture();
  const restore = inventoryPeer();
  const bridge = new ExperimentBridge(spec, cwd, "probe", {});
  const sent: Record<string, any>[] = [];
  try {
    bridge.start((line) => sent.push(JSON.parse(line)), () => {}, () => {});
    bridge.push(JSON.stringify({ type: "control_request", request_id: "list", request: {
      subtype: "mcp_message", server_name: "experiment", message: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    } }) + "\n");
    const deadline = Date.now() + 1000;
    while (!bridge.failureCode && !sent.some((frame) => frame.response?.request_id === "list") && Date.now() < deadline) {
      await Bun.sleep(1);
    }
    expect(bridge.failureCode).toBe(ExperimentFailureCode.InventoryMismatch);
    expect(sent.some((frame) => frame.response?.request_id === "list")).toBe(false);
    expect(records(bridge.recordingPath).some((record) => record.kind === "tool_call")).toBe(false);
  } finally { await bridge.close().catch(() => {}); restore(); }
});

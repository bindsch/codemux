import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ExperimentCodexEvidence } from "../src/experiment-codex.js";
import type { JsonObject } from "../src/experiment-server.js";
import { respond } from "./fixtures/experiment-mcp.js";
import { codexWorldState } from "./fixtures/experiment-codex.js";

const fixture: JsonObject = JSON.parse(readFileSync(new URL("./fixtures/experiment-codex-native-excerpt.json", import.meta.url), "utf8"));

function replay(extraDeclaration?: JsonObject) {
  const lines: JsonObject[] = structuredClone(fixture.lines);
  // Synthetic restricted inventory isolates historical catalog and output coverage.
  // The preserved native excerpt has no world_state and is not accepted as live evidence.
  lines.splice(1, 0, codexWorldState(["bash"], "experiment", lines[0]!.timestamp));
  if (extraDeclaration) {
    lines.find((line) => line.payload.type === "additional_tools")!.payload.tools.push(extraDeclaration);
  }
  const thread = lines[0]!.payload.id;
  const parent = resolve("scratch/session-14c66a93/exp/native-codex-replay");
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "case-"));
  const sessions = join(home, "sessions", "2026", "10", "29");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `rollout-2026-10-29T01-13-24-${thread}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const records: JsonObject[] = [];
  const evidence = new ExperimentCodexEvidence({
    spec: { name: "experiment", accept_harness_prefix: ["codex-wall-time"] },
    toolNames: new Set(["bash"]), toolDefinitions: (respond({ id: 1, method: "tools/list" }) as JsonObject).result.tools,
    calls: [structuredClone(fixture.relay_call)], catalogServed: true,
    record: (kind, fields) => records.push({ kind, ...fields }),
  }, { catalogRequired: true });
  evidence.accept({ type: "thread.started", thread_id: thread });
  evidence.accept({ type: "item.completed", item: structuredClone(fixture.exec_completion) });
  return { evidence, home, records, lines };
}

test("replays the historical Codex catalog and saved result with a synthetic restricted inventory", () => {
  expect(fixture.provenance).toMatchObject({ kind: "native evidence excerpt",
    source_run_id: "c008786c-0ec2-4909-a1df-37e6b51eec44", source_rollout_bytes: 81131,
    source_rollout_sha256: "ebdd57261e4bbbff7d751bf1738f7476f04a9032c95d7c4721a4bf0b3851c033" });
  const { evidence, home, records, lines } = replay();
  expect(() => evidence.finish(home)).not.toThrow();
  expect(records.find((record) => record.kind === "harness_top_level_tools")?.tools)
    .toEqual(codexWorldState(["bash"]).payload.state.top_level_tools);
  const catalog = records.find((record) => record.kind === "harness_tool_catalog")!;
  expect(catalog.item).toEqual(lines.find((line) => line.payload.type === "additional_tools")!.payload);
  expect(catalog.declarations.filter((tool: JsonObject) => tool.classification === "builtin")).toHaveLength(14);
  expect(catalog.declarations.filter((tool: JsonObject) => tool.classification === "experiment"))
    .toEqual([{ namespace: "mcp__experiment", name: "bash", type: "function", classification: "experiment", catalog_pruned_paths: [] }]);
  expect(records.filter((record) => record.kind === "turn").map((record) => record.message_id)).toEqual([
    "msg_0a36d4efa34409ca016ae29db7844481918997cd8f7c4dede8",
    "msg_0a36d4efa34409ca016ae29dbb15e08191a3a99127325717b9",
  ]);
  expect(records.filter((record) => record.kind === "turn_usage").map((record) => record.usage)).toEqual([
    { input: 7764, output: 43, cache_read: 0, cache_write: 0 },
    { input: 165, output: 16, cache_read: 7680, cache_write: 0 },
  ]);
  expect(records.filter((record) => record.kind === "result_comparison"))
    .toEqual([{ kind: "result_comparison", call_id: fixture.relay_call.call_id, relay_index: 0,
      equal: true, harness_prefix: "codex-wall-time", header: "Wall time: 0.0051 seconds\nOutput:" }]);
  expect(records.filter((record) => record.kind === "tool_result_delivered")).toHaveLength(1);
});

test("rejects a foreign declaration in the synthetic restricted-inventory replay", () => {
  const { evidence, home, records } = replay({ type: "function", name: "foreign_tool",
    parameters: { type: "object", properties: {} }, strict: false });
  let failure: unknown;
  try { evidence.finish(home); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: "inventory_mismatch" });
  const catalog = records.find((record) => record.kind === "harness_tool_catalog")!;
  expect(catalog.declarations.filter((tool: JsonObject) => tool.classification === "builtin")).toHaveLength(14);
  expect(catalog.declarations.at(-1)).toEqual({ namespace: null, name: "foreign_tool", type: "function", classification: "foreign" });
  expect(records.some((record) => record.kind === "result_comparison")).toBe(false);
});

import { expect, test } from "bun:test";
import fixture from "./fixtures/live/opencode-1.19.5-experiment.json";
import { verifyOpencodeExperimentEvidence } from "../src/opencode-experiment-run.js";
import { installOpencodeExperimentObserver } from "../src/opencode-experiment-plugin.js";
import type { JsonObject } from "../src/experiment-server.js";

// Live G recording b6fbe2f1: decoded opencode_evidence_copy and harness_stdout,
// plus tools/list and server_tool_result. No payload bytes were synthesized.
test("OpenCode 1.19.5 title request has no tools; main requests retain exact inventory and results", async () => {
  const records: JsonObject[] = structuredClone(fixture.evidence);
  const observed: JsonObject[] = [];
  const runtime = { fetch };
  const hooks = installOpencodeExperimentObserver(runtime, (kind, fields) => observed.push({ kind, fields }));
  try {
    // The old observer omitted agent.name. Replay the native hook metadata
    // established by the installed bundle, preserving the recorded payload.
    await hooks["chat.headers"]({ sessionID: records[0]!.fields.session_id, agent: "title" }, { headers: {} });
    records[0]!.fields = observed[0]!.fields;
  } finally { await hooks.dispose(); }
  const audit: JsonObject[] = [];
  const source = { spec: { name: "gateEcho" }, toolDefinitions: fixture.definitions,
    calls: fixture.calls, record: (kind: string, fields: JsonObject) => { audit.push({ kind, fields }); } };
  expect(() => verifyOpencodeExperimentEvidence(source, records, fixture.stdout)).not.toThrow();
  expect(audit.filter((r) => r.kind === "tool_inventory")).toHaveLength(2);
  expect(audit.filter((r) => r.kind === "tool_result_delivered")).toHaveLength(1);
  for (const tools of [null, {}, "invalid", [records[3]!.fields.payload.tools[0]]]) {
    const malformed = structuredClone(records);
    malformed[1]!.fields.payload.tools = tools;
    expect(() => verifyOpencodeExperimentEvidence(source, malformed, fixture.stdout)).toThrow();
  }
  const missingInventory = structuredClone(records);
  delete missingInventory[3]!.fields.payload.tools;
  expect(() => verifyOpencodeExperimentEvidence(source, missingInventory, fixture.stdout)).toThrow("array");
  const unclassified = structuredClone(records);
  delete unclassified[0]!.fields.agent;
  expect(() => verifyOpencodeExperimentEvidence(source, unclassified, fixture.stdout)).toThrow("array");
  const changed = structuredClone(records);
  changed[10]!.fields.payload.input.at(-1).output = "changed";
  expect(() => verifyOpencodeExperimentEvidence(source, changed, fixture.stdout)).toThrow("changed");
  const hiddenCall = structuredClone(records);
  hiddenCall[1]!.fields.payload = { messages: [{ role: "assistant", content: [
    { type: "tool_use", id: fixture.calls[0]!.call_id, name: "gateEcho_bash", input: { command: "gate" } },
  ] }] };
  expect(() => verifyOpencodeExperimentEvidence(source, hiddenCall, fixture.stdout)).toThrow("identity");
});

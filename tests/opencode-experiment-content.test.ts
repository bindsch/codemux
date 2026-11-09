import { describe, expect, test } from "bun:test";
import { assertOpencodeExperimentResult, opencodeEvidenceObject, opencodeExperimentToolName, verifyOpencodeProviderPayload } from "../src/opencode-experiment-content.js";
import { verifyOpencodeExperimentEvidence } from "../src/opencode-experiment-run.js";
import { definitions, call, payload, stdout, evidence, source } from "./fixtures/live/fake-opencode-experiment.js";


describe("OpenCode experiment final provider payload", () => {
  test.each(["chat", "responses", "anthropic"])("checks %s inventory, call IDs and unmodified results", (kind) => {
    expect(verifyOpencodeProviderPayload("test", definitions, payload(kind), new Map([["call-1", call()]]))).toEqual(["call-1"]);
    expect(verifyOpencodeProviderPayload("test", definitions, payload(kind, false), new Map())).toEqual([]);
  });
  test("supports exact error text and verifies native error status", () => {
    const error = call(); error.result!.isError = true;
    const p = payload("anthropic"); p.messages[1].content[0].is_error = true;
    expect(verifyOpencodeProviderPayload("test", definitions, p, new Map([["call-1", error]]))).toEqual(["call-1"]);
    p.messages[1].content[0].is_error = false;
    expect(() => verifyOpencodeProviderPayload("test", definitions, p, new Map([["call-1", error]]))).toThrow("error status");
  });
  test.each([null, [], { content: [] }, { content: [{ type: "image", data: "YQ==", mimeType: "image/png" }] },
    { content: [{ type: "text", text: "x", annotations: {} }] }, { content: [{ type: "text", text: " " }], isError: true },
    { content: [{ type: "text", text: "x" }], isError: "true" }, { content: [{ type: "text", text: "x" }], structuredContent: {} }].map((value) => ({ value })))("refuses lossy result %#", ({ value }) => {
    expect(() => assertOpencodeExperimentResult(value)).toThrow();
  });
  test("validates objects, names, text concatenation and unsupported APIs", () => {
    expect(opencodeEvidenceObject({})).toEqual({}); expect(opencodeExperimentToolName("server.x", "tool/y")).toBe("server_x_tool_y");
    assertOpencodeExperimentResult({ content: [{ type: "text", text: "" }], isError: false });
    const c = call(); c.result!.content.push({ type: "text", text: "second" });
    const p = payload(); p.messages[1].content = "unchanged\n\nsecond";
    expect(verifyOpencodeProviderPayload("test", definitions, p, new Map([["call-1", c]]))).toEqual(["call-1"]);
    expect(() => verifyOpencodeProviderPayload("test", definitions, {}, new Map())).toThrow("decoder");
    p.tools = "invalid"; expect(() => verifyOpencodeProviderPayload("test", definitions, p, new Map())).toThrow("array");
  });
  test.each(["extra-tool", "schema", "description", "name", "arguments", "missing-call", "repeated-call", "repeated-result", "missing-result", "truncation", "block-change"])("fails closed on %s", (kind) => {
    const p = payload(kind === "block-change" ? "anthropic" : "chat");
    if (kind === "extra-tool") p.tools.push(p.tools[0]);
    if (kind === "schema") p.tools[0].function.parameters.required = [];
    if (kind === "description") p.tools[0].function.description = "changed";
    if (kind === "name") p.messages[0].tool_calls[0].function.name = "bash";
    if (kind === "arguments") p.messages[0].tool_calls[0].function.arguments = "{}";
    if (kind === "missing-call") p.messages.shift();
    if (kind === "repeated-call") p.messages[0].tool_calls.push(p.messages[0].tool_calls[0]);
    if (kind === "repeated-result") p.messages.push(p.messages[1]);
    if (kind === "missing-result") p.messages.pop();
    if (kind === "truncation") p.messages[1].content = "unch...";
    if (kind === "block-change") p.messages[1].content[0].content[0].text = "changed";
    expect(() => verifyOpencodeProviderPayload("test", definitions, p, new Map([["call-1", call()]]))).toThrow();
  });
});

describe("OpenCode experiment evidence join", () => {
  test("joins native hooks, relay results, final requests, stdout and usage", () => {
    const s = source(); const records = evidence();
    records.push({ kind: "provider_model", fields: { request_id: "2", served_model: "actual-provider-model" }, t: 8 });
    verifyOpencodeExperimentEvidence(s, records, stdout());
    expect(s.records.filter((r) => r.kind === "tool_result_delivered")).toEqual([{ kind: "tool_result_delivered", fields: { call_id: "call-1", t: 6 } }]);
    expect(s.records.filter((r) => r.kind === "turn")).toHaveLength(2);
    expect(s.records.some((r) => r.kind === "tool_inventory")).toBe(true);
    records.push({ kind: "provider_model", fields: { request_id: "unknown", served_model: 4 }, t: 9 });
    expect(() => verifyOpencodeExperimentEvidence(source(), records, stdout())).toThrow("malformed");
  });
  test("accepts an authenticated retry only after the same final request succeeds", () => {
    const records = evidence();
    records.splice(2, 0, { kind: "provider_response", fields: { request_id: "1", status: 401 }, t: 2.1 }, records[1]!);
    verifyOpencodeExperimentEvidence(source(), records, stdout());
  });
  test("an instruction canary can complete without invoking a tool", () => {
    const s = source(); s.calls = [];
    verifyOpencodeExperimentEvidence(s, evidence().slice(0, 3), stdout().split("\n").slice(2).join("\n"));
  });
  test.each(["same", "missing", "mixed", "unknown"])("served model requires complete consistent responses: %s", (kind) => {
    const records = evidence();
    records.push({ kind: "provider_model", fields: { request_id: "1", served_model: "actual-provider-model" }, t: 8 });
    if (kind !== "missing") records.push({ kind: "provider_model", fields: { request_id: "2",
      served_model: kind === "same" ? "actual-provider-model" : kind === "mixed" ? "different-model" : null }, t: 9 });
    expect(verifyOpencodeExperimentEvidence(source(), records, stdout())).toBe(kind === "same" ? "actual-provider-model" : null);
  });
  test.each(["no-inventory", "incomplete-call", "repeated-relay", "session", "timestamp", "repeated-turn", "unknown-kind", "native-name", "repeated-native", "missing-marker", "http-error", "no-response", "no-terminal", "stdout-duplicate", "stdout-changed", "stdout-error", "no-stdout-call", "result-before-call"])("rejects %s", (kind) => {
    const s = source(); const e = evidence(); let out = stdout();
    if (kind === "no-inventory") s.toolDefinitions = [];
    if (kind === "incomplete-call") delete s.calls[0]!.result;
    if (kind === "repeated-relay") s.calls.push(call());
    if (kind === "session") e[3]!.fields.session_id = "other";
    if (kind === "timestamp") delete e[0]!.t;
    if (kind === "repeated-turn") e.splice(1, 0, e[0]!);
    if (kind === "unknown-kind") e[0]!.kind = "other";
    if (kind === "native-name") e[3]!.fields.name = "bash";
    if (kind === "repeated-native") e.splice(4, 0, e[3]!);
    if (kind === "missing-marker") e[1]!.fields.request_id = "missing";
    if (kind === "http-error") e[2]!.fields.status = 500;
    if (kind === "no-response") e.pop();
    if (kind === "no-terminal") out = out.replace('"stop"', '"length"');
    if (kind === "stdout-duplicate") out = out.split("\n")[0] + "\n" + out;
    if (kind === "stdout-changed") out = out.replace('"output":"unchanged"', '"output":"changed"');
    if (kind === "stdout-error") out += JSON.stringify({ type: "error", sessionID: "ses_0123456789abcdef" }) + "\n";
    if (kind === "no-stdout-call") out = out.split("\n").slice(1).join("\n");
    if (kind === "result-before-call") e.splice(3, 1);
    expect(() => verifyOpencodeExperimentEvidence(s, e, out)).toThrow();
  });
});

import { describe, expect, test } from "bun:test";
import { CodexRolloutParser } from "../src/experiment-codex-parser.js";
import { ExperimentFailure, ExperimentFailureCode as Code } from "../src/experiment-records.js";
import { sanitizeCodexToolName } from "../src/experiment-tool-names.js";
import type { JsonObject } from "../src/experiment-server.js";
import { codexCatalog, codexDefinitions } from "./fixtures/experiment-codex.js";

const timestamp = "2026-10-29T01:02:03Z";
const line = (payload: JsonObject) => ({ timestamp, type: "response_item", payload });
const resourceNames = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];
const coreNames = [
  "update_plan", "plan", "exec_command", "write_stdin", "apply_patch",
  "wait_for_environment", "request_user_input", "request_user_input_async", "send_message_to_user_async",
  "request_permissions", "new_context", "get_context_remaining", "test_sync_tool", "view_image",
  "list_available_plugins_to_install", "request_plugin_install", "tool_search", "tool_search_tool", "exec", "wait",
  "spawn_agent", "send_input", "resume_agent", "close_agent", "send_message", "followup_task", "wait_agent",
  "interrupt_agent", "list_agents", "web_search",
  "get_goal", "create_goal", "update_goal", "multi_env_copy_file",
  "create_channel", "get_channels", "list_threads", "search_posts", "read_thread", "read_post", "subscribe", "unsubscribe", "post",
];
const namespacedNames = [
  ["clock", "curr_time"], ["clock", "sleep"], ["web", "run"], ["image_gen", "imagegen"],
  ["multi_agent_v1", "spawn_agent"], ["multi_agent_v1", "send_input"], ["multi_agent_v1", "resume_agent"],
  ["multi_agent_v1", "wait_agent"], ["multi_agent_v1", "close_agent"],
  ["collaboration", "spawn_agent"], ["collaboration", "send_message"], ["collaboration", "followup_task"],
  ["collaboration", "wait_agent"], ["collaboration", "interrupt_agent"], ["collaboration", "list_agents"],
  ["collaboration", "create_channel"], ["collaboration", "get_channels"], ["collaboration", "list_threads"],
  ["collaboration", "search_posts"], ["collaboration", "read_thread"], ["collaboration", "read_post"],
  ["collaboration", "subscribe"], ["collaboration", "unsubscribe"], ["collaboration", "post"],
  ["history", "list_windows"], ["history", "list_items"], ["history", "read_item"], ["history", "search_contents"],
  ["notes", "list_files_by_prefix"], ["notes", "read_file"], ["notes", "search_contents"],
  ["notes", "append_to_file"], ["notes", "write_file"],
  ["memories", "add_ad_hoc_note"], ["memories", "list"], ["memories", "read"], ["memories", "search"],
  ["skills", "list"], ["skills", "read"], ["skills", "installations"],
  ["user_message", "search_messages"], ["user_message", "read_messages"],
];

function fixture(names = ["clock__wait"]) {
  const records: JsonObject[] = [];
  const parser = new CodexRolloutParser("thread", "experiment", () => new Set(names),
    (kind, fields) => records.push({ kind, ...fields }), () => codexDefinitions(names));
  parser.accept(codexCatalog(names));
  return { parser, records };
}

function rejectedCall(namespace: string | undefined, name: string, type = "function_call") {
  const { parser, records } = fixture();
  let failure: unknown;
  try {
    parser.accept(line({ type, namespace, name, id: "fc_bad", call_id: "bad", arguments: "{}", input: "raw" }));
    const nativeName = namespace && namespace !== "functions" ? namespace + name : name;
    parser.accept(line({ type: type === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output",
      call_id: "bad", output: `${type === "custom_tool_call" ? "unsupported custom tool call" : "unsupported call"}: ${nativeName}` }));
    parser.accept({ timestamp, type: "event_msg", payload: { type: "token_count",
      info: { last_token_usage: { input_tokens: 8, cached_input_tokens: 0, output_tokens: 2 } } } });
    parser.finish();
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(ExperimentFailure);
  expect(failure).toMatchObject({ code: Code.UnknownTool });
  expect(records.filter((record) => record.kind === "model_tool_error")).toHaveLength(0);
}

function resourceCall(namespace: string | undefined, name: string) {
  const { parser, records } = fixture();
  const qualified = namespace ? `${namespace}.${name}` : name;
  const harness_output = `unsupported call: ${name}`;
  parser.accept(line({ type: "function_call", namespace, name, id: "fc_resource", call_id: "resource", arguments: "{}" }));
  parser.accept(line({ type: "function_call_output", call_id: "resource", output: harness_output }));
  parser.accept({ timestamp, type: "event_msg", payload: { type: "token_count",
    info: { last_token_usage: { input_tokens: 8, cached_input_tokens: 0, output_tokens: 2 } } } });
  expect(() => parser.finish()).not.toThrow();
  expect(records.filter((record) => record.kind === "harness_builtin_call")).toEqual([
    { kind: "harness_builtin_call", call_id: "resource", name: qualified, input: {}, harness_output },
  ]);
  expect(records.filter((record) => record.kind === "model_tool_error")).toHaveLength(0);
  expect(parser.calls).toHaveLength(0);
}

describe("Codex restricted built-in calls", () => {
  test.each(coreNames)("rejects undeclared built-in %s despite its matching unsupported-call error", (name) => {
    rejectedCall("functions", name);
  });

  test.each(coreNames)("rejects flattened built-in functions.%s", (name) => {
    rejectedCall(undefined, `functions.${name}`);
  });

  test.each(resourceNames)("records native resource built-in functions.%s despite its unsupported-call output", (name) => {
    resourceCall("functions", name);
  });

  test.each(resourceNames)("rejects a literal functions prefix in resource call name functions.%s", (name) => {
    rejectedCall(undefined, `functions.${name}`);
  });

  test.each(namespacedNames)("rejects undeclared built-in %s.%s", (namespace, name) => {
    rejectedCall(namespace, name);
  });

  test.each(namespacedNames)("rejects flattened built-in %s.%s", (namespace, name) => {
    rejectedCall("functions", `${namespace}.${name}`);
  });

  test.each(["apply_patch", "view_image", "exec"])("rejects custom built-in %s", (name) => {
    rejectedCall("functions", name, "custom_tool_call");
  });

  test.each(["node_repl", "node_repl__", "mcp__node_repl", "mcp__node_repl__",
    "cua_repl", "cua_repl__", "mcp__cua_repl", "mcp__cua_repl__"])(
    "rejects browser or computer actor namespace %s", (namespace) => rejectedCall(namespace, "js"));

  test.each(["node_repl__js", "mcp__node_repl__js", "cua_repl__js", "mcp__cua_repl__js"])(
    "rejects flattened browser or computer actor %s", (name) => rejectedCall(undefined, name));

  for (const namespace of ["mcp__experiment", "functions", undefined]) {
    test.each(["view_image", "exec", "clock.sleep", "web.run", "image_gen.imagegen", "mcp__cua_repl__js",
      "get_goal", "multi_env_copy_file", "post", "memories.read", "skills.list"])(
      `preserves experiment inventory tool %s in namespace ${namespace}`, (name) => {
        const { parser } = fixture([name]);
        const nativeName = `${namespace === "mcp__experiment" ? "" : "mcp__experiment__"}${sanitizeCodexToolName(name)}`;
        parser.accept(line({ type: "function_call", namespace, name: nativeName,
          id: "fc_good", call_id: "good", arguments: "{}" }));
        expect(parser.calls).toMatchObject([{ callId: "good", name, input: {} }]);
      });
  }

  test.each([["invented", "pause"], ["invented", "sleep"], ["invented", "read"], ["invented", "append"], ["node_repl_other", "js"],
    ["other", "mcp__cua_repl__js"], [undefined, "mcp__node_repl_other__js"]])(
    "keeps unsupported-call errors for unrelated tool %s.%s", (namespace, name) => {
    const { parser, records } = fixture();
    parser.accept(line({ type: "function_call", namespace, name, id: "fc_bad", call_id: "bad", arguments: "{}" }));
    parser.accept(line({ type: "function_call_output", call_id: "bad", output: `unsupported call: ${namespace ?? ""}${name}` }));
    parser.accept({ timestamp, type: "event_msg", payload: { type: "token_count",
      info: { last_token_usage: { input_tokens: 8, cached_input_tokens: 0, output_tokens: 2 } } } });
    expect(() => parser.finish()).not.toThrow();
    expect(records.find((record) => record.kind === "model_tool_error")).toMatchObject({
      name: namespace ? `${namespace}.${name}` : name });
  });
});

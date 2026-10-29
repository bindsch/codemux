import { expect, test } from "bun:test";
import { kimiToolName } from "../src/experiment-kimi-content.js";
import { sanitizeCodexToolName } from "../src/experiment-tool-names.js";
import { ExperimentInventory } from "../src/experiment-inventory.js";

// Vectors from Kimi's mcpCore/tool-naming.ts and Codex's
// codex-mcp/src/mcp/mod.rs sanitize_responses_api_tool_name.
test.each([
  ["", "_"],
  ["mcp__my-server__foo-bar", "mcp__my_server__foo_bar"],
  ["mcp__server__foo___bar", "mcp__server__foo___bar"],
  ["mcp__server__lookup.😀", "mcp__server__lookup__"],
])("Codex sanitizer matches the upstream character rule: %s", (input, expected) => {
  expect(sanitizeCodexToolName(input!)).toBe(expected!);
});

test("Kimi qualification preserves hyphens and collapses underscores per component", () => {
  expect(kimiToolName("my--server", "foo___bar")).toBe("mcp__my--server__foo_bar");
  expect(kimiToolName("my..server", "lookup.😀")).toBe("mcp__my_server__lookup_");
});

test("shared sanitizer checks retain distinct supported tool names", async () => {
  const tools = ["foo__bar", "foo___baz", "lookup-x"].map((name) => ({ name }));
  const inventory = new ExperimentInventory("my-server", async () => undefined, () => {}, () => {}, () => true);
  await inventory.accept({ jsonrpc: "2.0", id: 1, result: { tools } }, null);
  expect(inventory.definitions).toEqual(tools);
  expect([...inventory.names]).toEqual(tools.map(({ name }) => `mcp__my-server__${name}`));
});

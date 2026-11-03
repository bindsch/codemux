import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertNoCodexSystemMcp } from "../src/experiment-codex-config.js";

test.each([
  ["", false], ['model = "fixture"', false], ["[mcp_servers]", false],
  ['[mcp_servers.foreign]\ncommand = "server"', true],
  ['[profiles.custom.mcp_servers.foreign]\ncommand = "server"', true],
  ['mcp_servers = []', true], ['broken = [', true], ["#".repeat(1024 * 1024 + 1), true],
])("system MCP preflight bounds and validates external configuration case %#", (text, refused) => {
  const parent = resolve("scratch/session-14c66a93/exp/system-config-fixtures");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "case-"));
  const path = join(directory, "config.toml");
  expect(() => assertNoCodexSystemMcp(path)).not.toThrow();
  writeFileSync(path, text as string);
  if (refused) expect(() => assertNoCodexSystemMcp(path)).toThrow(path);
  else expect(() => assertNoCodexSystemMcp(path)).not.toThrow();
});

test("system MCP preflight refuses unreadable non-file config", () => {
  const path = resolve("scratch/session-14c66a93/exp/system-config-directory");
  mkdirSync(path, { recursive: true });
  expect(() => assertNoCodexSystemMcp(path)).toThrow(path);
});

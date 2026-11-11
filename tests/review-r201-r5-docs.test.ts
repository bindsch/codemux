import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { registerSessionOptions } from "../src/session/cli-options.js";
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("hermetic session help states Qwen's native-store exception", () => {
  const command = new Command();
  registerSessionOptions(command, "claude");
  expect(command.helpInformation()).toContain("Qwen keeps its native state store");
});

test("Agy effort documentation leaves model suffix compatibility to the harness", () => {
  expect(read("docs/harnesses.md")).toContain("codemux passes both the model and effort flags to the harness");
  expect(read("docs/harnesses.md")).not.toContain("codemux refuses `--effort` beside it");
});

test("provider model brace restrictions name only the enforcing adapters", () => {
  expect(read("docs/provider-overrides.md")).toContain("Droid, OpenCode, and Pi reject interpolation braces in model names");
});

test("both TUI summaries state the Playwright safe-mode exception", () => {
  for (const path of ["docs/isolation.md", "docs/harnesses.md"]) {
    expect(read(path)).toContain("except with `--enable-playwright-mcp`, which keeps the user settings source");
  }
});

test("both stale-sweep definitions include an unended record with a dead owner", () => {
  expect(read("docs/sessions.md").match(/an unended record whose owner process is dead/g)).toHaveLength(2);
});

test("legacy key comment names all six tolerated omissions", () => {
  const source = read("src/session/registry/format.ts");
  const comment = source.slice(source.indexOf("// Only `provider_base_url`"), source.indexOf("const LEGACY_OPTIONAL_KEYS"));
  for (const key of ["provider_base_url", "project_settings", "sandbox_block", "final", "model_alias", "caller_owned_home"]) {
    expect(comment).toContain(`\`${key}\``);
  }
});

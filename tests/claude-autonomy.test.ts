import { expect, test } from "bun:test";
import { claudeAutonomyFlags, grantRule } from "../src/claude-autonomy.js";

test("headless medium grants scoped edits, shell commands, and the web tools", () => {
  expect(claudeAutonomyFlags("medium", "/tmp/launch")).toEqual([
    "--permission-mode", "acceptEdits", "--allowedTools",
    grantRule("/tmp/launch"), "Bash", "WebSearch", "WebFetch",
  ]);
});

test("headless medium keeps its shell grant when the web tools are denied", () => {
  expect(claudeAutonomyFlags("medium", "/tmp/launch", { web: "deny" })).toEqual([
    "--permission-mode", "acceptEdits", "--allowedTools",
    grantRule("/tmp/launch"), "Bash", "--disallowedTools", "WebSearch", "WebFetch",
  ]);
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { knownClaudeTools } from "../src/session/ceiling.js";

/** Tools present in the recorded init `tools` fixture but absent from
 * the ceiling table would fall to default deny — correct but silent.
 * Anything here is a deliberate extra: named by claude versions other
 * than the recorded one, kept so drift shows up in the diff below. */
const DOCUMENTED_EXTRAS = [
  "Agent",
  "BashOutput",
  "Glob",
  "Grep",
  "KillShell",
  "LS",
  "SlashCommand",
  "TodoWrite",
];

describe("the tool table tracks the recorded harness", () => {
  test("every tool in the recorded init fixture is known to the ceiling", () => {
    const text = readFileSync(
      join(import.meta.dir, "fixtures/live/zai-permission3.ndjson"),
      "utf8"
    );
    const tools = (text
      .trim()
      .split("\n")
      .map((record) => JSON.parse(record))
      .filter((entry: { dir: string }) => entry.dir === "out")
      .map((entry: { line: string }) => JSON.parse(entry.line))
      .find((event: { type?: string; subtype?: string }) =>
        event.type === "system" && event.subtype === "init"
      )!.tools) as string[];
    expect(tools.length).toBe(26);
    const known = new Set(knownClaudeTools());
    const missing = tools.filter((tool) => !known.has(tool));
    expect(missing).toEqual([]);
  });

  test("the table holds the fixture tools plus the documented extras only", () => {
    const known = knownClaudeTools();
    const fixtureAndExtras = new Set([
      "Task", "AskUserQuestion", "Bash", "CronCreate", "CronDelete",
      "CronList", "DesignSync", "Edit", "EnterPlanMode", "EnterWorktree",
      "ExitPlanMode", "ExitWorktree", "ListAgents", "Monitor",
      "NotebookEdit", "PushNotification", "Read", "ReportFindings",
      "ScheduleWakeup", "SendMessage", "Skill", "TaskStop", "WebFetch",
      "WebSearch", "Workflow", "Write",
      ...DOCUMENTED_EXTRAS,
    ]);
    expect(known.sort()).toEqual([...fixtureAndExtras].sort());
  });
});

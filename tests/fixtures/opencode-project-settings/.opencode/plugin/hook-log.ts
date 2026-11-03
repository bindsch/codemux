/**
 * A fixture plugin for an OpenCode `--experiment-project-settings` run:
 * the PreToolUse/PostToolUse equivalent, one JSON line per hook call,
 * appended to `hook-log.jsonl` beside this file so a live check can read
 * exactly which tool calls fired. Dependency-free on purpose — OpenCode
 * loads any exported function as a plugin (the legacy shape in
 * packages/opencode/src/plugin/index.ts), and this file must also
 * typecheck inside codemux's own tree.
 */
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface HookInput {
  tool: string;
  sessionID: string;
  callID: string;
}

interface HookList {
  "tool.execute.before"?: (input: HookInput, output: { args: unknown }) => Promise<void>;
  "tool.execute.after"?: (
    input: HookInput & { args: unknown },
    output: { title: string; output: string; metadata: unknown }
  ) => Promise<void>;
}

const logFile = join(dirname(fileURLToPath(import.meta.url)), "hook-log.jsonl");

function line(hook: string, input: HookInput): string {
  return (
    JSON.stringify({
      hook,
      tool: input.tool,
      sessionID: input.sessionID,
      callID: input.callID,
      time: new Date().toISOString(),
    }) + "\n"
  );
}

export const hookLog = async (_input: unknown): Promise<HookList> => ({
  "tool.execute.before": async (input) => {
    appendFileSync(logFile, line("tool.execute.before", input));
  },
  "tool.execute.after": async (input) => {
    appendFileSync(logFile, line("tool.execute.after", input));
  },
});

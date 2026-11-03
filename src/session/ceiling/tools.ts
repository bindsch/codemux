// The tool-table side of the autonomy ceiling: the tool x level grants
// and the request-level verdicts (claudeCeiling) built on them; path
// questions delegate to ./paths.js. src/session/ceiling.ts owns the
// ceiling and re-exports this.

import type { AutonomyLevel } from "../../types.js";
import { pathInsideScope, type CeilingVerdict } from "./paths.js";

const DENY_READ_ONLY: CeilingVerdict = {
  allowable: false,
  reason: "read-only allows no tool use",
};

const ALLOW_LOW: CeilingVerdict = {
  allowable: true,
  reason: "low allows every request",
};

/** The editing tools: judged on a target path inside the grant scope at
 * medium, on the bare grant at high. `pathKey` is the argument that names
 * the target; `inputKeys` is the tool's full known argument schema — an
 * argument outside it means codemux cannot tell what the action is. */
interface EditToolSpec {
  kind: "edit";
  pathKey: string;
  inputKeys: readonly string[];
}

/** Bash: granted bare at high, never at medium. */
interface BashToolSpec {
  kind: "bash";
  inputKeys: readonly string[];
}

/** Every other tool the recorded harnesses name: not granted at any
 * launchable level, so deny everywhere but low. */
interface OtherToolSpec {
  kind: "other";
}

type ToolSpec = EditToolSpec | BashToolSpec | OtherToolSpec;

/** The tool × level table (§4.1). Tools a harness may add without
 * codemux knowing them are NOT here — they hit the default-deny branch,
 * and the test suite diffs this table against the recorded init `tools`
 * fixture so the named set stays complete for the pinned versions. */
const TOOL_SPECS: Readonly<Record<string, ToolSpec>> = {
  Edit: { kind: "edit", pathKey: "file_path", inputKeys: ["file_path", "old_string", "new_string", "replace_all"] },
  Write: { kind: "edit", pathKey: "file_path", inputKeys: ["file_path", "content"] },
  NotebookEdit: { kind: "edit", pathKey: "notebook_path", inputKeys: ["notebook_path", "new_source", "cell_id", "cell_type", "edit_mode"] },
  Bash: { kind: "bash", inputKeys: ["command", "timeout", "description", "run_in_background"] },
  Read: { kind: "other" },
  Grep: { kind: "other" },
  Glob: { kind: "other" },
  LS: { kind: "other" },
  WebFetch: { kind: "other" },
  WebSearch: { kind: "other" },
  Task: { kind: "other" },
  Agent: { kind: "other" },
  Skill: { kind: "other" },
  SlashCommand: { kind: "other" },
  ExitPlanMode: { kind: "other" },
  TodoWrite: { kind: "other" },
  BashOutput: { kind: "other" },
  KillShell: { kind: "other" },
  AskUserQuestion: { kind: "other" },
  CronCreate: { kind: "other" },
  CronDelete: { kind: "other" },
  CronList: { kind: "other" },
  DesignSync: { kind: "other" },
  EnterPlanMode: { kind: "other" },
  EnterWorktree: { kind: "other" },
  ExitWorktree: { kind: "other" },
  ListAgents: { kind: "other" },
  Monitor: { kind: "other" },
  PushNotification: { kind: "other" },
  ReportFindings: { kind: "other" },
  ScheduleWakeup: { kind: "other" },
  SendMessage: { kind: "other" },
  TaskStop: { kind: "other" },
  Workflow: { kind: "other" },
};

/** MCP tools arrive as `mcp__<server>__<tool>`; no level grants them. */
const MCP_TOOL_PREFIX = "mcp__";

export function knownClaudeTools(): string[] {
  return Object.keys(TOOL_SPECS).sort();
}

function specFor(tool: string): ToolSpec | null {
  if (Object.hasOwn(TOOL_SPECS, tool)) return TOOL_SPECS[tool] as ToolSpec;
  if (tool.startsWith(MCP_TOOL_PREFIX)) return { kind: "other" };
  return null;
}

/** Reject any argument key the tool's known schema does not carry — an
 * `updated_input` (or a request) codemux cannot fully read is one it
 * cannot judge. */
function schemaCheck(spec: EditToolSpec | BashToolSpec, input: Record<string, unknown>): CeilingVerdict | null {
  const unknown = Object.keys(input).find((key) => !spec.inputKeys.includes(key));
  if (unknown !== undefined) {
    return {
      allowable: false,
      reason: `argument "${unknown}" is outside the known schema for this tool`,
    };
  }
  return null;
}

/**
 * Judge one claude-family permission request (`can_use_tool`). `input`
 * is the input the answer acts on — the request's own input, or the
 * caller's `updated_input` when the decision carries one (a substitute,
 * so the ceiling judges exactly what would run). Pure: same arguments,
 * same verdict.
 */
export function claudeCeiling(
  level: AutonomyLevel,
  tool: string,
  input: Record<string, unknown>,
  launchDir: string
): CeilingVerdict {
  if (level === "read-only") return DENY_READ_ONLY;
  const spec = specFor(tool);
  if (spec === null) {
    // Default deny for unknown tools; low is the level whose meaning is
    // "the caller answers", and no schema exists to check against.
    return level === "low"
      ? ALLOW_LOW
      : { allowable: false, reason: `tool ${tool} is not granted at ${level}` };
  }
  if (spec.kind === "other") {
    return level === "low"
      ? ALLOW_LOW
      : { allowable: false, reason: `tool ${tool} is not granted at ${level}` };
  }
  const schemaFailure = schemaCheck(spec, input);
  if (schemaFailure !== null) return schemaFailure;
  if (level === "low") return ALLOW_LOW;
  if (spec.kind === "bash") {
    return level === "high"
      ? { allowable: true, reason: "high grants Bash" }
      : { allowable: false, reason: "medium keeps Bash gated" };
  }
  if (level === "high") {
    // High grants every editing tool (`--allowedTools Edit Write
    // NotebookEdit Bash`), so any path is in scope; the schema check
    // above still applies.
    return { allowable: true, reason: "high grants the editing tools" };
  }
  // medium: the editing tools, scoped to the launch directory.
  const target = input[spec.pathKey];
  if (typeof target !== "string" || target.length === 0) {
    return { allowable: false, reason: `argument "${spec.pathKey}" is missing or not a path` };
  }
  return pathInsideScope(target, launchDir);
}

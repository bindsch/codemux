import { dirname, isAbsolute, resolve } from "node:path";
import { statSync } from "node:fs";
import { readUtf8FileBounded } from "./file-io.js";
import { experimentUserFrameBytes, MAX_EXPERIMENT_MESSAGE_BYTES } from "./experiment-bridge.js";
import type { AgentId, RunRequest } from "./types.js";

/** Refuse before reading the spec, starting its command, or spending a request.
 * A server transcript is not proof of the bytes the model receives.
 * See docs/experiment-mcp-report.md for the checked harness mechanisms.
 */
export function assertExperimentMcpUnavailable(agent: AgentId, spec: unknown): void {
  if (spec === undefined) return;
  if (typeof spec !== "string" || spec.trim().length === 0 || spec.includes("\0")) {
    throw new Error("--experiment-mcp requires a nonempty specification path without NUL bytes");
  }
  // zai runs the same Claude Code binary and SDK control bridge against the
  // Z.AI endpoint, so the claude mechanism applies unchanged.
  if (agent === "claude" || agent === "zai") return;
  const reason = agent === "codex"
      ? "Codex adds its own Wall time: header to MCP results; the experiment cannot control every result byte"
      : `${agent} has no verified experiment MCP mechanism`;
  throw new Error(`--experiment-mcp is unavailable: ${reason}. See docs/experiment-mcp-report.md`);
}

export interface ExperimentSpec {
  name: string;
  command: string;
  args: string[];
  env: string[];
  /** Directory for per-run JSONL recordings; the state directory's
   * experiments/ subtree when omitted. */
  recording?: string;
  /** Internal paired-check designation, never accepted from a spec file. */
  control?: boolean;
}

const MAX_SPEC_BYTES = 64 * 1024;
const canaryControls = new WeakSet<RunRequest>();
/** Only check's deliberately non-hermetic, planted control uses this path. */
export function experimentCanaryControl(request: RunRequest): RunRequest {
  const control = { ...request, hermetic: false };
  canaryControls.add(control);
  return control;
}
export function readExperimentRunSpec(request: RunRequest): ExperimentSpec {
  const spec = readExperimentSpec(request.experimentMcp!);
  if (canaryControls.has(request)) spec.control = true;
  return spec;
}
export function readExperimentSpec(path: string): ExperimentSpec {
  const value = JSON.parse(readUtf8FileBounded(path, { maxBytes: MAX_SPEC_BYTES, label: "experiment MCP spec" }));
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !["name", "command", "args", "env", "recording"].includes(key)) ||
      typeof value.name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value.name) ||
      typeof value.command !== "string" || !isAbsolute(value.command) || value.command.includes("\0") ||
      !Array.isArray(value.args) || value.args.some((arg: unknown) => typeof arg !== "string" || arg.includes("\0")) ||
      !Array.isArray(value.env) || value.env.some((name: unknown) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ||
      new Set(value.env).size !== value.env.length ||
      (value.recording !== undefined && (typeof value.recording !== "string" || value.recording.length === 0 || value.recording.includes("\0")))) {
    throw new Error("experiment MCP spec requires name, absolute command, string args, unique env variable names, and an optional recording path only");
  }
  // A relative recording path resolves against the spec file's directory:
  // the spec is the operator's coordinate system for its own artifacts.
  if (value.recording !== undefined && !isAbsolute(value.recording)) {
    value.recording = resolve(dirname(path), value.recording);
  }
  if (value.recording !== undefined) {
    const stat = statSync(value.recording, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new Error("experiment MCP recording must name a directory");
  }
  return value as ExperimentSpec;
}

export function validateExperimentRequest(request: RunRequest): void {
  assertExperimentMcpUnavailable(request.agent, request.experimentMcp);
  if (request.experimentMcp === undefined) return;
  if ((!request.hermetic && !canaryControls.has(request)) || request.tools !== "none" || request.autonomy !== "read-only" ||
      !request.sandboxed || request.enablePlaywrightMcp) {
    throw new Error("--experiment-mcp requires --hermetic --tools none --auto read-only with scode, and no Playwright MCP");
  }
  readExperimentSpec(request.experimentMcp);
  // The prompt rides the control frame, so its serialized size is bound by
  // the control-frame limit, tighter than validatePrompt's 16 MiB. Refuse
  // before anything is spawned: a failure after the spawn pays for a run
  // that cannot deliver its prompt.
  if (experimentUserFrameBytes(request.prompt) > MAX_EXPERIMENT_MESSAGE_BYTES) {
    throw new Error(`experiment MCP prompt exceeds the ${MAX_EXPERIMENT_MESSAGE_BYTES}-byte control frame limit`);
  }
}

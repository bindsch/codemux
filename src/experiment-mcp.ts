import { dirname, isAbsolute, resolve } from "node:path";
import { statSync } from "node:fs";
import { readUtf8FileBounded } from "./file-io.js";
import { experimentUserFrameBytes, MAX_EXPERIMENT_MESSAGE_BYTES } from "./experiment-bridge.js";
import type { AgentId, RunRequest } from "./types.js";

/** Refuse unsupported harnesses before reading the spec or starting its command.
 * A server transcript is not proof of the bytes the model receives.
 * Codex and Kimi require an explicit opt-in to their model-bound result headers.
 */
export function assertExperimentMcpUnavailable(agent: AgentId, spec: unknown): void {
  if (spec === undefined) return;
  if (typeof spec !== "string" || spec.trim().length === 0 || spec.includes("\0")) {
    throw new Error("--experiment-mcp requires a nonempty specification path without NUL bytes");
  }
  // zai runs the same Claude Code binary and SDK control bridge against the
  // Z.AI endpoint, so the claude mechanism applies unchanged.
  if (agent === "claude" || agent === "zai") return;
  if (agent === "codex") {
    if (!readExperimentSpec(spec).accept_harness_prefix?.includes("codex-wall-time")) {
      throw new Error('--experiment-mcp on codex requires accept_harness_prefix: ["codex-wall-time"]; Codex prepends "Wall time: {secs:.4} seconds\\nOutput:" to model-bound MCP results');
    }
    return;
  }
  if (agent === "kimi") {
    if (!readExperimentSpec(spec).accept_harness_prefix?.includes("kimi-wall-time")) {
      throw new Error('--experiment-mcp on kimi requires accept_harness_prefix: ["kimi-wall-time"]; Kimi prepends "Wall time: {secs:.3} seconds\\n" to model-bound MCP results');
    }
    return;
  }
  throw new Error(`--experiment-mcp is unavailable: ${agent} has no verified experiment MCP mechanism. See docs/experiment-mcp-report.md`);
}

export interface ExperimentSpec {
  name: string;
  command: string;
  args: string[];
  env: string[];
  /** Directory for per-run JSONL recordings; the state directory's
   * experiments/ subtree when omitted. */
  recording?: string;
  /** Accepted harness additions to the model-bound server result. */
  accept_harness_prefix?: string[];
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
  if (value && typeof value === "object" && !Array.isArray(value) && value.accept_harness_prefix !== undefined &&
      (!Array.isArray(value.accept_harness_prefix) ||
       value.accept_harness_prefix.some((prefix: unknown) => prefix !== "codex-wall-time" && prefix !== "kimi-wall-time") ||
       new Set(value.accept_harness_prefix).size !== value.accept_harness_prefix.length)) {
    throw new Error("experiment MCP spec accept_harness_prefix must be an array of unique supported prefixes: codex-wall-time, kimi-wall-time");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !["name", "command", "args", "env", "recording", "accept_harness_prefix"].includes(key)) ||
      typeof value.name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value.name) ||
      typeof value.command !== "string" || !isAbsolute(value.command) || value.command.includes("\0") ||
      !Array.isArray(value.args) || value.args.some((arg: unknown) => typeof arg !== "string" || arg.includes("\0")) ||
      !Array.isArray(value.env) || value.env.some((name: unknown) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ||
      new Set(value.env).size !== value.env.length ||
      (value.recording !== undefined && (typeof value.recording !== "string" || value.recording.length === 0 || value.recording.includes("\0")))) {
    throw new Error("experiment MCP spec requires name, absolute command, string args, unique env variable names, and optional recording and accept_harness_prefix fields only");
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
  if ((request.agent === "codex" || request.agent === "kimi") && request.sandboxNoNet) {
    throw new Error(`--experiment-mcp on ${request.agent} uses a loopback HTTP relay and refuses --sandbox-no-net`);
  }
  if ((request.agent === "codex" || request.agent === "kimi") && request.sandboxTrust === "untrusted") {
    throw new Error(`--experiment-mcp on ${request.agent} uses a loopback HTTP relay and refuses --sandbox-trust untrusted`);
  }
  if ((!request.hermetic && !canaryControls.has(request)) || request.tools !== "none" || request.autonomy !== "read-only" ||
      !request.sandboxed || request.enablePlaywrightMcp) {
    throw new Error("--experiment-mcp requires --hermetic --tools none --auto read-only with scode, and no Playwright MCP");
  }
  readExperimentSpec(request.experimentMcp);
  // Claude and Z.AI carry prompts in a control frame. Codex uses stdin;
  // Kimi's argv limit is enforced by the adapter's request validation.
  if ((request.agent === "claude" || request.agent === "zai") &&
      experimentUserFrameBytes(request.prompt) > MAX_EXPERIMENT_MESSAGE_BYTES) {
    throw new Error(`experiment MCP prompt exceeds the ${MAX_EXPERIMENT_MESSAGE_BYTES}-byte control frame limit`);
  }
}

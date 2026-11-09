import { dirname, isAbsolute, resolve } from "node:path";
import { statSync } from "node:fs";
import { readUtf8FileBounded } from "./file-io.js";
import { UsageRefusalError } from "./validation.js";
import { MAX_EXPERIMENT_MESSAGE_BYTES } from "./experiment-server.js";
import type { AgentId, RunRequest } from "./types.js";
import { refuseAgyExperiment } from "./agy-experiment-run.js";
import { refuseOpenhandsExperiment } from "./openhands-experiment-run.js";

/** Measure the serialized user frame, including its envelope and newline.
 * Prompt preflight and the bridge's frames share one byte bound, so the
 * frame this computes is what `--experiment-mcp` refuses to carry (round
 * 391 moved it here from experiment-bridge.ts, which stays at its cap). */
export function experimentUserFrameBytes(prompt: string): number {
  return Buffer.byteLength(JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n");
}

/** The harnesses `--experiment-mcp` supports and, for each, the wall-time
 * prefix codemux itself prepends to that harness's model-bound MCP
 * results (codex and kimi; claude and zai results carry no header, so
 * their list is empty). zai runs the same Claude Code binary and SDK
 * control bridge against the Z.AI endpoint, so the claude mechanism
 * applies unchanged. assertExperimentMcpUnavailable reads this table, so
 * the validator, `codemux list --json` (candidate discovery), and the
 * release gate's probe G set share one spelling and cannot drift. */
export const EXPERIMENT_MCP_HARNESSES: Readonly<Partial<Record<AgentId, readonly string[]>>> = {
  claude: [],
  zai: [],
  codex: ["codex-wall-time"],
  kimi: ["kimi-wall-time"],
  gemini: ["gemini-untrusted-context"],
  opencode: [],
  copilot: [],
  pi: [],
  goose: [],
  qwen: [],
  cline: [],
};

/** The tool-schema changes a harness makes that an experiment spec must
 * accept explicitly (accept_harness_schema). The validator and the release
 * gate's probe G spec read this one table, so the gate cannot build a spec
 * the validator refuses. */
export const EXPERIMENT_MCP_HARNESS_SCHEMAS: Readonly<Partial<Record<AgentId, readonly string[]>>> = {
  gemini: ["gemini-wait-for-previous"],
};

const HARNESS_SCHEMA_CHANGES: Readonly<Record<string, string>> = {
  "gemini-wait-for-previous": "Gemini adds the optional boolean wait_for_previous scheduling property to object tool schemas",
};

/** The header each harness prefix stands for, in the refusal's own words:
 * the operator who forgot the opt-in sees exactly what is prepended. */
const HARNESS_PREFIX_HEADERS: Readonly<Record<string, string>> = {
  "gemini-untrusted-context": 'Gemini wraps each text block in "<untrusted_context>\\n" and "\\n</untrusted_context>" and joins blocks with newlines',
  "codex-wall-time": 'Codex prepends "Wall time: {secs:.4} seconds\\nOutput:" to model-bound MCP results',
  "kimi-wall-time": 'Kimi prepends "Wall time: {secs:.3} seconds\\n" to model-bound MCP results',
};

/** Refuse unsupported harnesses before reading the spec or starting its command.
 * A server transcript is not proof of the bytes the model receives.
 * Codex and Kimi require an explicit opt-in to their model-bound result headers.
 */
export function assertExperimentMcpUnavailable(agent: AgentId, spec: unknown): void {
  if (spec === undefined) return;
  if (typeof spec !== "string" || spec.trim().length === 0 || spec.includes("\0")) {
    throw new UsageRefusalError("--experiment-mcp requires a nonempty specification path without NUL bytes");
  }
  const prefixes = EXPERIMENT_MCP_HARNESSES[agent];
  if (agent === "agy") refuseAgyExperiment();
  if (agent === "openhands") refuseOpenhandsExperiment();
  if (prefixes === undefined) {
    throw new UsageRefusalError(`--experiment-mcp is unavailable: ${agent} has no verified experiment MCP mechanism. See docs/archive/experiment-mcp-report.md`);
  }
  for (const schema of EXPERIMENT_MCP_HARNESS_SCHEMAS[agent] ?? []) {
    if (!readExperimentSpec(spec).accept_harness_schema?.includes(schema)) {
      throw new UsageRefusalError(`--experiment-mcp on ${agent} requires accept_harness_schema: [${JSON.stringify(schema)}]; ${HARNESS_SCHEMA_CHANGES[schema]}`);
    }
  }
  for (const prefix of prefixes) {
    if (!readExperimentSpec(spec).accept_harness_prefix?.includes(prefix)) {
      throw new UsageRefusalError(`--experiment-mcp on ${agent} requires accept_harness_prefix: [${JSON.stringify(prefix)}]; ${HARNESS_PREFIX_HEADERS[prefix]}`);
    }
  }
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
  /** Explicit acceptance of a documented native tool-schema addition. */
  accept_harness_schema?: string[];
  /** Harness MCP tool deadline; the transport itself has no call deadline. */
  tool_timeout_seconds?: number;
  /** Internal paired-check designation, never accepted from a spec file. */
  control?: boolean;
}

const MAX_SPEC_BYTES = 64 * 1024;
const DEFAULT_TOOL_TIMEOUT_SECONDS = 7200;
const MAX_TOOL_TIMEOUT_SECONDS = 86400;
export function experimentToolTimeoutSeconds(spec: Pick<ExperimentSpec, "tool_timeout_seconds">): number {
  return spec.tool_timeout_seconds ?? DEFAULT_TOOL_TIMEOUT_SECONDS;
}
const canaryControls = new WeakSet<RunRequest>();
/** Only check's deliberately non-hermetic, planted control uses this path.
 * `kimiBrandHome` is the check's planted scratch brand home: carrying it on
 * the request makes the control run's private MCP configuration writes land
 * inside the canary scratch by construction, not through the planted
 * adapter's environment. */
export function experimentCanaryControl(request: RunRequest, kimiBrandHome?: string): RunRequest {
  const control = { ...request, hermetic: false,
    ...(kimiBrandHome === undefined ? {} : { kimiControlBrandHome: kimiBrandHome }) };
  canaryControls.add(control);
  return control;
}
export function readExperimentRunSpec(request: RunRequest): ExperimentSpec {
  const spec = readExperimentSpec(request.experimentMcp!);
  if (canaryControls.has(request)) spec.control = true;
  return spec;
}
export function readExperimentSpec(path: string): ExperimentSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readUtf8FileBounded(path, { maxBytes: MAX_SPEC_BYTES, label: "experiment MCP spec" }));
  } catch (error) {
    // A spec the operator wrote that does not parse is a caller mistake, so
    // it refuses with 64 like the other spec refusals; unreadable and
    // oversized files keep the read's own I/O error (exit 1).
    if (error instanceof SyntaxError) {
      throw new UsageRefusalError(`experiment MCP spec does not parse as JSON: ${error.message}`);
    }
    throw error;
  }
  // JSON.parse answers any JSON value; every check below runs through this
  // record view after its own shape guard.
  const value = parsed as Record<string, unknown> | null;
  if (value !== null && typeof value === "object" && !Array.isArray(value) && value.tool_timeout_seconds !== undefined &&
      (typeof value.tool_timeout_seconds !== "number" || !Number.isInteger(value.tool_timeout_seconds) ||
       value.tool_timeout_seconds <= 0 || value.tool_timeout_seconds > MAX_TOOL_TIMEOUT_SECONDS)) {
    throw new UsageRefusalError(`experiment MCP spec tool_timeout_seconds must be a positive integer at most ${MAX_TOOL_TIMEOUT_SECONDS}`);
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value) && value.accept_harness_prefix !== undefined &&
      (!Array.isArray(value.accept_harness_prefix) ||
       value.accept_harness_prefix.some((prefix: unknown) => prefix !== "codex-wall-time" && prefix !== "kimi-wall-time" && prefix !== "gemini-untrusted-context") ||
       new Set(value.accept_harness_prefix).size !== value.accept_harness_prefix.length)) {
    throw new UsageRefusalError("experiment MCP spec accept_harness_prefix must be an array of unique supported prefixes: codex-wall-time, kimi-wall-time, gemini-untrusted-context");
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value) && value.accept_harness_schema !== undefined &&
      (!Array.isArray(value.accept_harness_schema) ||
       value.accept_harness_schema.some((schema: unknown) => schema !== "gemini-wait-for-previous") ||
       new Set(value.accept_harness_schema).size !== value.accept_harness_schema.length)) {
    throw new UsageRefusalError("experiment MCP spec accept_harness_schema must be an array of unique supported schemas: gemini-wait-for-previous");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !["name", "command", "args", "env", "recording", "accept_harness_prefix", "accept_harness_schema", "tool_timeout_seconds"].includes(key)) ||
      typeof value.name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value.name) ||
      typeof value.command !== "string" || !isAbsolute(value.command) || value.command.includes("\0") ||
      !Array.isArray(value.args) || value.args.some((arg: unknown) => typeof arg !== "string" || arg.includes("\0")) ||
      !Array.isArray(value.env) || value.env.some((name: unknown) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ||
      new Set(value.env).size !== value.env.length ||
      (value.recording !== undefined && (typeof value.recording !== "string" || value.recording.length === 0 || value.recording.includes("\0")))) {
    throw new UsageRefusalError("experiment MCP spec requires name, absolute command, string args, unique env variable names, and optional recording, accept_harness_prefix, accept_harness_schema, and tool_timeout_seconds fields only");
  }
  // The shape check above has passed, so the record carries the spec's
  // fields; the recording path resolves against the spec file's directory:
  // the spec is the operator's coordinate system for its own artifacts.
  const spec = value as unknown as ExperimentSpec;
  if (spec.recording !== undefined && !isAbsolute(spec.recording)) {
    spec.recording = resolve(dirname(path), spec.recording);
  }
  if (spec.recording !== undefined) {
    const stat = statSync(spec.recording, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new UsageRefusalError("experiment MCP recording must name a directory");
  }
  return spec;
}

/** Every experiment harness except the stdio-bridged claude family is
 * relay-bound and needs loopback: the sandbox policy flags that would cut
 * it are refused (review m2: derived from the table, so a new entry
 * cannot skip the refusals). Shared with the check
 * command, which runs this before its own codex refusal so the policy
 * refusals keep their precedence there (review round 381). */
export function assertExperimentLoopbackPolicy(
  request: Pick<RunRequest, "agent" | "sandboxNoNet" | "sandboxTrust">
): void {
  const needsLoopback = request.agent in EXPERIMENT_MCP_HARNESSES &&
    request.agent !== "claude" && request.agent !== "zai";
  if (needsLoopback && request.sandboxNoNet) {
    throw new UsageRefusalError(`--experiment-mcp on ${request.agent} uses a loopback HTTP relay and refuses --sandbox-no-net`);
  }
  if (needsLoopback && request.sandboxTrust === "untrusted") {
    throw new UsageRefusalError(`--experiment-mcp on ${request.agent} uses a loopback HTTP relay and refuses --sandbox-trust untrusted`);
  }
}

export function validateExperimentRequest(request: RunRequest): void {
  assertExperimentMcpUnavailable(request.agent, request.experimentMcp);
  // Ahead of the --experiment-mcp early return: the field is internal to
  // the control probe on EVERY request, with or without the experiment
  // (review round 15, minor 4 — behind the return, a plain request
  // carrying it slipped past the refusal).
  if (request.kimiControlBrandHome !== undefined && !canaryControls.has(request)) {
    throw new UsageRefusalError("kimiControlBrandHome is internal to the experiment control probe and cannot be set on a request");
  }
  if (request.experimentMcp === undefined) return;
  assertExperimentLoopbackPolicy(request);
  if ((!request.hermetic && !canaryControls.has(request)) || request.tools !== "none" || request.autonomy !== "read-only" ||
      !request.sandboxed || request.enablePlaywrightMcp) {
    throw new UsageRefusalError("--experiment-mcp requires --hermetic --tools none --auto read-only with scode, and no Playwright MCP");
  }
  readExperimentSpec(request.experimentMcp);
  // Claude and Z.AI carry prompts in a control frame. Codex uses stdin;
  // Kimi's argv limit is enforced by the adapter's request validation.
  if ((request.agent === "claude" || request.agent === "zai") &&
      experimentUserFrameBytes(request.prompt) > MAX_EXPERIMENT_MESSAGE_BYTES) {
    throw new UsageRefusalError(`experiment MCP prompt exceeds the ${MAX_EXPERIMENT_MESSAGE_BYTES}-byte control frame limit`);
  }
}

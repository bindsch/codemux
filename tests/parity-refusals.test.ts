import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { Command } from "commander";
import { AGENT_IDS, BaseAdapter, getAdapter } from "../src/adapters/index.js";
import { QwenAdapter } from "../src/adapters/qwen.js";
import * as adapters from "../src/adapters/index.js";
import { validateRunRequestFor, validateTuiRequestFor } from "../src/adapters/base-validate.js";
import { resolveAutonomyForAdapter, resolveEffortForAdapter } from "../src/cli-runtime/options.js";
import { getDefaultConfig } from "../src/config.js";
import { assertHermeticCheckSupported } from "../src/check-hermetic-plan.js";
import { registerRunCommand } from "../src/run-command.js";
import { registerCheckCommand } from "../src/check-command.js";
import { registerTuiCommand } from "../src/tui-command.js";
import { assertExperimentMcpUnavailable, EXPERIMENT_MCP_HARNESSES } from "../src/experiment-mcp.js";
import * as fileIo from "../src/file-io.js";
import { assertProjectSettingsAgent, PROJECT_SETTINGS_AGENTS } from "../src/claude-project-settings.js";
import { supportsPlaywrightMcpAgent } from "../src/mcp.js";
import { PARITY, agentsSupporting, PARITY_FEATURES, type ParityFeature } from "../src/parity/index.js";
import { refusalSites, type RefusalSite } from "./helpers/refusal-scan.js";
import { REFUSAL_FEATURE } from "../src/parity/probe-features.js";
import { providerOverrideEnvNames } from "../src/provider-override.js";
import { SERVED_MODEL_EVIDENCE_HARNESSES } from "../src/result-envelope/index.js";
import { parseClaudeResultEnvelope } from "../src/result-envelope.js";
import { answerCompleteOutcome } from "./helpers/parity-answer-complete.js";
import { codexReporting } from "./helpers/parity-codex-reporting.js";
import { parseCursorResultEnvelope } from "../src/result-envelope/cursor.js";
import { parseAiderAnalytics } from "../src/result-envelope/aider.js";
import { parseDroidResultEnvelope } from "../src/result-envelope/droid.js";
import { parseGeminiResultEnvelope } from "../src/result-envelope/gemini.js";
import { parseGooseResultEnvelope } from "../src/result-envelope/goose.js";
import { parsePiResultEnvelope } from "../src/result-envelope/pi.js";
import { xmReporting, xmReportingOutcome, xmSessionCaps, xmSessionUsageOutcome } from "./helpers/parity-xm-reporting.js";
import { kimiWireUsage } from "../src/kimi-wire-log.js";
import { ClaudeStreamParser, claudeSessionCapabilities } from "../src/session/claude-session.js";
import { CodexStreamParser, codexSessionCapabilities } from "../src/session/codex-session.js";
import { parseAgySessionLine, agySessionCapabilities } from "../src/session/agy-session.js";
import { parseOpenCodeRunLine, normalizeOpenCodeUsage, opencodeSessionCapabilities } from "../src/session/opencode-session.js";
import { aiderSessionCapabilities } from "../src/session/aider-session.js";
import { kimiSessionCapabilities } from "../src/session/kimi-session.js";
import { parseCursorSessionTurn, cursorSessionCapabilities } from "../src/session/cursor-session.js";
import { parseDroidSessionTurn, droidSessionCapabilities } from "../src/session/droid-session.js";
import { parseGooseSessionTurn, gooseSessionCapabilities } from "../src/session/goose-session.js";
import type { ResultUsageBlock } from "../src/types.js";
import { w3Reporting, w3SessionCaps, w3SessionUsage } from "./helpers/parity-w3-reporting.js";
import { clineReporting, clineSessionUsage, clineSessionCapabilities } from "./helpers/parity-cline-reporting.js";
import { MAX_ARGV_PROMPT_BYTES } from "../src/process-runner.js";
import { emptyAnswerFinish, enforceNonEmptyResult } from "../src/result-empty.js";
import { SessionOutputQueue } from "../src/session/completion.js";
import { SESSION_AGENTS } from "../src/session/cli-agents.js";
import { resolveSessionRequest, type SessionCommandOptions } from "../src/session/cli-request.js";
import { UsageRefusalError } from "../src/validation.js";
import type { AgentId, RunRequest } from "../src/types.js";
import { refusingCall } from "./helpers/session-cli-hermetic.js";

const root = resolve(import.meta.dir, "..");
let cleanCwd: string;
beforeAll(() => { cleanCwd = fs.mkdtempSync(join(root, "scratch/fix/parity-refusals-")); });
afterAll(() => { fs.rmdirSync(cleanCwd); });

// These validate modes every adapter already supports, not a per-agent
// feature in the parity vocabulary. Pinning the universal facts below means
// making one conditional cannot escape the declaration gate.
const universalRefusals = ["does not support non-interactive execution", "does not support interactive execution", "does not support autonomy in TUI mode"];
function capabilityGate(site: RefusalSite): boolean {
  return site.agentBound || /supports\w*|caps\.(budgetLimit|autonomyLevels|effortLevels|toolsNoneRequiresHermetic)|sessionSupport\.(tools|hermetic|approvals|interrupt)|sessionSupport === undefined|PROJECT_SETTINGS_AGENTS|promptInArgv/.test(site.conditions)
    || /(?:agentId|request\.agent)\s*[!=]==\s*"/.test(site.conditions)
    || /provider override supports headless|reasoning effort supports headless|has no verified experiment MCP|has no project setting source mapping|cannot be honored:|requires an explicit --cwd owned|cannot remove its apply_patch|opencode --tools none requires|gemini --tools none is delivered/.test(site.message);
}

// These compare agent ids for an operational precondition rather than a
// missing capability. They are explicitly excluded, never swallowed by a
// catch-all regex. The command's existing tests cover these combinations.
const combinationRefusals = [
  "Unknown agent '",
  "--print-sandbox cannot be combined with --tools none for agy",
  "--agy-isolation-probe requires -a agy", "agy canary checks require default read-only scode",
  "--enable-playwright-mcp requires --auto low for sessions",
  "--enable-playwright-mcp for copilot sessions requires --auto medium or high",
  "experiment MCP prompt exceeds the", "--session cannot carry --pass-env",
];

describe("capability refusal inventory", () => {
  test("each capability-gated validation site has a feature", () => {
    const files = new Set(REFUSAL_FEATURE.map((entry) => entry.file));
    const missing: string[] = [];
    for (const file of files) for (const site of refusalSites(file)) {
      if (!capabilityGate(site) || [...universalRefusals, ...combinationRefusals].some((part) => site.message.includes(part))) continue;
      if (!REFUSAL_FEATURE.some((entry) => entry.file === file && site.message.includes(entry.message))) {
        missing.push(`${file}:${site.line}: ${site.message}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("inventory entries resolve to actual refusal expressions", () => {
    for (const entry of REFUSAL_FEATURE) {
      expect(refusalSites(entry.file).some((site) => site.message.includes(entry.message)), `${entry.file}: ${entry.message}`).toBe(true);
    }
  });

  test("the scanner handles concatenation and ignores commented-out refusals", () => {
    const tree = ts.createSourceFile("synthetic.ts", "// usageError('stale')\nif (!caps.supportsModel) { usageError(`agent ${id}` + ' cannot select'); }", ts.ScriptTarget.Latest, true);
    const sites = refusalSites("synthetic.ts", tree);
    expect(sites.map((site) => site.message)).toEqual(["agent * cannot select"]);
    expect(capabilityGate(sites[0]!)).toBe(true);
  });

  test("all adapters support the three universally available modes", () => {
    for (const agent of AGENT_IDS) {
      const adapter = getAdapter(agent, {});
      expect(adapter.capabilities().supportsNonInteractive, agent).toBe(true);
      expect(adapter.capabilities().supportsInteractive, agent).toBe(true);
      expect(adapter.supportsTuiAutonomy(), agent).toBe(true);
    }
  });
});

type Outcome = { message: string | null; code: number | null; observedAbsence?: true; omittedMetric?: true };
const accepted: Outcome = { message: null, code: null };
const usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 };
const resultFrame = { type: "result", subtype: "success", result: "parity", usage, total_cost_usd: 0.25, modelUsage: { "parity-served": {} } };
const agyFrame = { status: "SUCCESS", response: "parity", usage: { input_tokens: 13, output_tokens: 2, cache_read_tokens: 3, total_tokens: 15 } };
const opencodePart = { cost: 0.25, tokens: { input: 10, output: 2, total: 15, cache: { read: 3, write: 0 } } };
const sessionId = "11111111-1111-4111-8111-111111111111";
// Cursor runs parse a stream-json wire: model_call usage events (inputTokens
// net of both cache counters, so 10 stays 10) plus the closing result line.
const cursorStream = [
  { type: "usage", subtype: "model_call", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 }, session_id: sessionId },
  { type: "result", subtype: "success", result: "parity", session_id: sessionId },
].map((frame) => JSON.stringify(frame)).join("\n");
const sessionCaps = { cline: clineSessionCapabilities, claude: claudeSessionCapabilities, zai: claudeSessionCapabilities, codex: codexSessionCapabilities,
  agy: agySessionCapabilities, aider: aiderSessionCapabilities, kimi: kimiSessionCapabilities, opencode: opencodeSessionCapabilities,
  cursor: cursorSessionCapabilities, droid: droidSessionCapabilities, goose: gooseSessionCapabilities, ...w3SessionCaps, ...xmSessionCaps };

function reporting(agent: AgentId): { usage: ResultUsageBlock; servedModel?: string | null } | undefined {
  const synthetic = clineReporting(agent) ?? w3Reporting(agent, sessionId) ?? xmReporting(agent, sessionId);
  if (synthetic) return synthetic;
  const json = JSON.stringify;
  switch (agent) {
    case "claude": case "zai": return parseClaudeResultEnvelope(json(resultFrame)) ?? undefined;
    case "aider": return parseAiderAnalytics(json({ event: "message_send", properties: { completion_tokens: 2, total_cost: 0.25 } }));
    case "cursor": return parseCursorResultEnvelope(cursorStream) ?? undefined;
    case "droid": return parseDroidResultEnvelope(json(resultFrame)) ?? undefined;
    case "codex": return codexReporting(sessionId);
    case "gemini": return parseGeminiResultEnvelope(json({ response: "parity", stats: { input_tokens: 13, output_tokens: 2, cached: 3 } })) ?? undefined;
    case "goose": return parseGooseResultEnvelope(json({ content: "parity", session_id: sessionId,
      usage: { inputTokens: 13, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, cost: 0.25 },
      metadata: { inference: { resolvedModel: "parity-served" } } })) ?? undefined;
    case "pi": return parsePiResultEnvelope(json({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "parity" }], model: "parity-served", stopReason: "stop",
      usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 0, cost: { total: 0.25 } } } })) ?? undefined;
    case "opencode": return { usage: normalizeOpenCodeUsage(opencodePart) };
    case "kimi": return { usage: kimiWireUsage("synthetic-usage.jsonl") };
    default: return undefined;
  }
}

function reportingOutcome(agent: AgentId, feature: ParityFeature): Outcome | undefined {
  const native = xmReportingOutcome(agent, feature, sessionId);
  if (native) return native;
  const state = PARITY[agent][feature];
  if (agent === "opencode" && ["run.served-model-evidence", "check.provider-override.served-model"].includes(feature)) {
    const result = getAdapter(agent, { PATH: "" }).processRunResult({
      stdout: JSON.stringify({ type: "text", sessionID: "ses_parity123", modelID: "requested", part: { text: "parity" } }),
      stderr: "", exitCode: 0, success: true,
    }, { agent, prompt: "parity", model: "requested", resultJson: true });
    expect(result.servedModel).toBeNull();
    expect(JSON.parse(result.stdout).codemux.served_model).toBeNull();
    return { message: null, code: null, observedAbsence: true };
  }
  // Aider, codex, cursor, droid, kimi, and cline keep their served-model
  // cells as documented limitations: the pin names the upstream source
  // each declaration cites (aider's run cell alone; the others' check
  // cells share theirs), and the synthetic parse reports no model.
  const evidencePin: Partial<Record<AgentId, string>> = {
    aider: "aider-chat 0.86.2", codex: "codex 0.166.0", cursor: "1706.index.js", droid: "0.221.0",
    kimi: "kimi-code 2.5.2", cline: "cli-v3.0.74",
  };
  const pin = evidencePin[agent];
  if (pin !== undefined && state.state === "harness-limitation" &&
      (agent !== "aider" || feature === "run.served-model-evidence") &&
      ["run.served-model-evidence", "check.provider-override.served-model"].includes(feature)) {
    expect(state.reason).not.toContain("OPEN:");
    expect(state.evidence).toContain(pin);
    expect(reporting(agent)?.servedModel ?? null, agent).toBeNull();
    return { message: null, code: null, observedAbsence: true };
  }
  const early = reporting(agent);
  if (state.state === "harness-limitation" && !state.reason.startsWith("OPEN:") &&
      ["codex", "copilot", "gemini", "cursor", "droid", "kimi"].includes(agent) && early && feature === "run.cost") {
    expect(early.usage.cost_usd, agent).toBeNull();
    return { message: null, code: null, omittedMetric: true };
  }
  if (state.state !== "supported") return undefined;
  const report = reporting(agent);
  expect(report, `${agent}: synthetic reporting parser`).toBeDefined();
  if (feature.endsWith("served-model-evidence")) expect(report!.servedModel, agent).toBe("parity-served");
  else if (feature === "run.cost") expect(report!.usage.cost_usd, agent).toBe(0.25);
  else if (agent === "aider") expect(report!.usage).toMatchObject({ input_tokens: null, output_tokens: 2, cached_input_tokens: null, total_tokens: null });
  else expect(report!.usage, agent).toMatchObject({ input_tokens: 10, output_tokens: 2, cached_input_tokens: 3, total_tokens: 15 });
  return accepted;
}

function sessionUsageOutcome(agent: AgentId): Outcome | undefined {
  const native = xmSessionUsageOutcome(agent, sessionId);
  if (native) return native;
  if (PARITY[agent]["session.usage"].state !== "supported") return undefined;
  if (agent === "aider") return reportingOutcome(agent, "run.usage");
  const json = JSON.stringify;
  let frames: Array<{ kind: string; usage?: ResultUsageBlock }> = [];
  if (agent === "claude" || agent === "zai") frames = new ClaudeStreamParser().feed(json({ ...resultFrame, session_id: sessionId }), { expectedSessionId: sessionId });
  if (agent === "codex") frames = new CodexStreamParser().feed(json({ method: "thread/tokenUsage/updated", params: { threadId: sessionId, turnId: "turn", tokenUsage: {
    last: { inputTokens: 13, cachedInputTokens: 3, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 15 } } } }), { threadId: sessionId, activeTurnId: "turn" });
  if (agent === "agy") frames = [parseAgySessionLine(json({ event: "result", result: agyFrame }), { knownConversationId: null })];
  // kimi's print wire carries no counts; the session driver reads the
  // native session's wire log at each turn's child exit (the mocked
  // synthetic-usage.jsonl stands in for it), so the parser under test is
  // kimiWireUsage itself (tests/kimi-session-usage.test.ts drives the
  // driver read end to end).
  if (agent === "kimi") frames = [{ kind: "result", usage: kimiWireUsage("synthetic-usage.jsonl") }];
  if (agent === "opencode") frames = [parseOpenCodeRunLine(json({ type: "step_finish", sessionID: "ses_parity123", part: opencodePart }), { knownSessionId: null })];
  if (agent === "cursor") frames = [{ kind: "result", usage: parseCursorSessionTurn(cursorStream, { sessionId }).usage }];
  if (agent === "droid") frames = [{ kind: "result", usage: parseDroidSessionTurn(json({ ...resultFrame, session_id: sessionId }), { knownSessionId: null }).usage }];
  if (agent === "goose") frames = [{ kind: "result", usage: parseGooseSessionTurn(json({
    content: "parity", session_id: sessionId,
    usage: { inputTokens: 13, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 },
    metadata: { inference: { resolvedModel: "parity-served" } },
  }), { knownSessionId: null }).usage }];
  const nativeUsage = w3SessionUsage(agent, sessionId) ?? clineSessionUsage(agent, sessionId, cleanCwd);
  if (nativeUsage) frames.push({ kind: "result", usage: nativeUsage });
  expect(frames.find((frame) => "usage" in frame)?.usage, `${agent}: session usage frame`).toMatchObject({ input_tokens: 10, output_tokens: 2, cached_input_tokens: 3, total_tokens: 15 });
  return accepted;
}

function capture(call: () => unknown): Outcome {
  try { call(); return { message: null, code: null }; }
  catch (error) {
    if (!(error instanceof UsageRefusalError)) throw error;
    return { message: error.message, code: 64 };
  }
}

const validationPassed = new Error("synthetic validation boundary");
function sessionOutcome(agent: AgentId, options: SessionCommandOptions): Outcome {
  // Session capability gates run before the run validator. Stop there:
  // this test never resolves an executable, home, registry, or credential.
  const runBoundary = spyOn(BaseAdapter.prototype, "validateRunRequest").mockImplementation(() => { throw validationPassed; });
  const override = spyOn(BaseAdapter.prototype, "providerOverride").mockReturnValue(null);
  const lstat = fs.lstatSync;
  const ancestors = options.experimentProjectSettings ? spyOn(fs, "lstatSync").mockImplementation(((path, statOptions) => {
    if (!String(path).startsWith(cleanCwd)) {
      if ((statOptions as { throwIfNoEntry?: boolean } | undefined)?.throwIfNoEntry === false) return undefined;
      throw Object.assign(new Error("synthetic absent ancestor configuration"), { code: "ENOENT" });
    }
    return lstat(path, statOptions);
  }) as typeof fs.lstatSync) : undefined;
  try {
    const result = refusingCall(() => resolveSessionRequest({ agent, sandbox: true, auto: "high", cwd: cleanCwd, ...options }, getDefaultConfig()));
    return { message: result.message || null, code: result.code };
  } catch (error) {
    if (error === validationPassed) return { message: null, code: null };
    if (error instanceof UsageRefusalError) return { message: error.message, code: 64 };
    throw error;
  } finally { ancestors?.mockRestore(); override.mockRestore(); runBoundary.mockRestore(); }
}

const basicOptions: Partial<Record<ParityFeature, Partial<RunRequest>>> = {
  "run.model": { model: "parity-model" }, "run.effort": { effort: "low" },
  "run.effort.none-native": { effort: "none" }, "run.hermetic": { hermetic: true },
  "run.result-json": { resultJson: true }, "run.max-budget-usd": { maxBudgetUsd: 1 },
  "run.tools-none": { tools: "none" }, "run.playwright-mcp": { enablePlaywrightMcp: true },
  "run.prompt-stdin": { prompt: "x".repeat(MAX_ARGV_PROMPT_BYTES + 1) },
};
const sessionOptions: Partial<Record<ParityFeature, SessionCommandOptions>> = {
  "session.driver": {}, "session.interrupt": { turnTimeout: "1" },
  "session.tools": { tools: "none" }, "session.hermetic": { hermetic: true },
  "session.final": { hermetic: true, final: true }, "session.private-home": { hermetic: true },
  "session.permission-policy-deny": { permissionPolicy: "deny", hermetic: true },
  "session.print-sandbox": { printSandbox: true },
  "session.playwright-mcp": { enablePlaywrightMcp: true, auto: "low" },
  "session.experiment-project-settings": { experimentProjectSettings: true, hermetic: true, auto: "low" },
};
function providerOutcome(agent: AgentId, feature: ParityFeature): Outcome {
  const names = providerOverrideEnvNames(agent);
  const environment = { [names.baseUrl]: "https://parity.invalid/v1", [names.apiKey]: "synthetic-key", [names.model]: "parity-model" };
  if (feature.endsWith("max-output-tokens")) environment[names.maxOutputTokens] = "128";
  if (feature.endsWith("max-context-tokens")) environment[names.maxContextTokens] = "4096";
  const adapter = getAdapter(agent, environment);
  if (feature === "tui.provider-override") return capture(() => adapter.validateTuiRequest(undefined, cleanCwd, "high"));
  const issue = adapter.providerOverrideIssue();
  return { message: issue, code: issue === null ? null : 64 };
}

async function commandOutcome(agent: AgentId, command: "run" | "check" | "tui", args: string[]): Promise<Outcome> {
  const program = new Command();
  const register = { run: registerRunCommand, check: registerCheckCommand, tui: registerTuiCommand }[command];
  register(program, getDefaultConfig(), () => {});
  const messages: string[] = [];
  let code: number | null = null;
  const exit = new Error("synthetic command exit");
  const mocks = [
    spyOn(console, "error").mockImplementation((...values: unknown[]) => { messages.push(values.join(" ")); }),
    spyOn(process, "exit").mockImplementation(((value?: number) => { code = value ?? 0; throw exit; }) as typeof process.exit),
    spyOn(BaseAdapter.prototype, "validateRunRequest").mockImplementation(() => { throw validationPassed; }),
    spyOn(BaseAdapter.prototype, "isAvailable").mockImplementation(() => { throw validationPassed; }),
    spyOn(QwenAdapter.prototype, "isAvailable").mockImplementation(() => { throw validationPassed; }),
    spyOn(BaseAdapter.prototype, "providerOverride").mockReturnValue(null),
  ];
  try {
    await program.parseAsync(["node", "codemux", command, "-a", agent, "--sandbox", ...args]);
  } catch (error) { if (error !== exit) throw error; }
  finally { for (const mock of mocks.reverse()) mock.mockRestore(); }
  const message = messages.join("\n");
  return message.includes(validationPassed.message) ? { message: null, code: null } : { message, code };
}

/** Each request varies the advertised feature while keeping prerequisites
 * valid. Unsupported features must produce their declared usage refusal. */
async function exercise(agent: AgentId, feature: ParityFeature): Promise<Outcome | undefined> {
  const names = providerOverrideEnvNames(agent);
  const adapter = getAdapter(agent, agent === "cline" || (["goose", "openhands"].includes(agent) && feature === "run.hermetic.any-cwd")
    ? { HOME: cleanCwd, [names.baseUrl]: "https://parity.invalid/v1", [names.apiKey]: "synthetic-key", [names.model]: "parity-model" } : {});
  const request: RunRequest = { agent, prompt: "parity", autonomy: "read-only", sandboxed: true, cwd: cleanCwd };
  if (feature === "run.empty-answer-fails") {
    const result = enforceNonEmptyResult({ stdout: " \n", stderr: "", exitCode: 0, success: true }, request, 0);
    expect(result.exitCode).toBe(1);
    expect(result.success).toBe(false);
    expect(result.stderr).toContain(`Error: ${agent} exited 0 with an empty answer`);
    expect(emptyAnswerFinish(result)).toBe("empty-answer");
    return accepted;
  }
  if (feature === "run.answer-complete") return answerCompleteOutcome(agent);
  if (feature === "session.empty-answer-fails") {
    const events: Record<string, unknown>[] = [];
    const queue = new SessionOutputQueue((line) => { events.push(JSON.parse(line)); },
      () => { throw new Error("unexpected synthetic session output failure"); });
    queue.enqueue(JSON.stringify({ type: "turn_started", turn_id: "parity" }));
    queue.enqueue(JSON.stringify({ type: "assistant_message", turn_id: "parity", text: " \n" }));
    queue.enqueue(JSON.stringify({ type: "turn_completed", turn_id: "parity", finish: "end" }));
    await queue.flush();
    expect(events.at(-1)).toMatchObject({ finish: "failed", reason: "empty answer" });
    return accepted;
  }
  const input = basicOptions[feature];
  if (input) return capture(() => validateRunRequestFor(adapter, { ...request, ...input }));
  if (["run.served-model-evidence", "run.usage", "run.cost"].includes(feature)) return reportingOutcome(agent, feature);
  if (feature === "session.usage" && agent === "openhands") return sessionUsageOutcome(agent);
  if (feature.startsWith("session.") && !SESSION_AGENTS[agent]) return sessionOutcome(agent, {});
  if (feature === "session.harness-home")
    return sessionOutcome(agent, { harnessHome: join(cleanCwd, "..", "parity-caller-home") });
  if (feature === "session.usage") return sessionUsageOutcome(agent);
  if (feature === "session.resume") {
    const capabilities = sessionCaps[agent as keyof typeof sessionCaps];
    expect(capabilities, `${agent}: resume capabilities`).toBeDefined();
    expect(capabilities().resume, agent).toBe(true);
    return accepted;
  }
  if (feature in sessionOptions) {
    const options = { ...sessionOptions[feature] };
    if ((agent === "agy" || agent === "qwen") && feature === "session.tools" && !SESSION_AGENTS[agent]?.tools) options.tools = "default";
    if (agent === "opencode" && feature === "session.tools") options.hermetic = true;
    if (agent === "aider" && (feature === "session.permission-policy-deny" || feature === "session.experiment-project-settings")) options.hermetic = false;
    // Cursor sessions have no hermetic mode; with hermetic left on, the
    // hermetic refusal would fire before the feature's own gate.
    if (agent === "cursor" && (feature === "session.permission-policy-deny" || feature === "session.experiment-project-settings")) options.hermetic = false;
    if ((agent === "copilot" || agent === "cline") && feature === "session.playwright-mcp") options.auto = "medium";
    return sessionOutcome(agent, options);
  }
  if (feature === "run.no-web") return commandOutcome(agent, "run", ["-p", "parity", "--no-web"]);
  if (feature === "check.hermetic") return capture(() => assertHermeticCheckSupported(agent));
  if (feature === "check.experiment-mcp") {
    return commandOutcome(agent, "check", ["--experiment-mcp", "synthetic-spec.json", "--hermetic", "--tools", "none"]);
  }
  if (feature === "check.provider-override.served-model") {
    if (agent === "cline" || agent === "opencode" || agent === "codex" || agent === "copilot" || agent === "cursor" || agent === "droid" || agent === "kimi" || agent === "openhands") return reportingOutcome(agent, feature);
    const provider = providerOutcome(agent, "run.provider-override");
    if (provider.message !== null) return provider;
    const envelope = capture(() => validateRunRequestFor(adapter, { ...request, resultJson: true }));
    if (envelope.message !== null) return envelope;
    if (!SERVED_MODEL_EVIDENCE_HARNESSES.has(agent)) return undefined;
    expect(reporting(agent)?.servedModel, agent).toBe("parity-served");
    return envelope;
  }
  if (feature.includes("provider-override")) {
    if (feature.startsWith("session.") && !SESSION_AGENTS[agent]) return sessionOutcome(agent, {});
    return providerOutcome(agent, feature);
  }
  if (feature === "run.autonomy.all-four") return capture(() => {
    for (const level of ["read-only", "low", "medium", "high"] as const) resolveAutonomyForAdapter(agent, adapter.capabilities(), level);
  });
  if (feature === "run.experiment-project-settings") return capture(() => assertProjectSettingsAgent(agent));
  if (feature === "run.experiment-mcp") {
    return capture(() => assertExperimentMcpUnavailable(agent, "synthetic-spec.json"));
  }
  if (feature === "tui.model") return capture(() => validateTuiRequestFor(adapter, { model: "parity-model", autonomy: "high" }));
  if (feature === "tui.effort") return commandOutcome(agent, "tui", ["--effort", "low", "--auto", "high", "--cwd", cleanCwd,
    ...(agent === "opencode" ? ["--model", "synthetic/model"] : [])]);
  if (feature === "run.tools-none.plain" || feature === "run.tools-none.writable-autonomy") return capture(() => adapter.validateRunRequest({
    ...request, tools: "none", autonomy: feature.endsWith("writable-autonomy") ? "medium" : "read-only",
    ...(agent === "codex" ? { model: "parity-model" } : {}),
    hermetic: feature.endsWith("writable-autonomy") && adapter.capabilities().toolsNoneRequiresHermetic === true,
  }));
  if (feature === "run.hermetic.any-cwd") {
    if (agent === "cline" || agent === "codex" || agent === "kimi") {
      // Plant only the metadata read by each real guard, in memory. The
      // guard still chooses and validates the offending configuration.
      const target = join(cleanCwd, agent === "codex" ? ".agents/skills" : "AGENTS.md");
      const lstat = fs.lstatSync;
      const entries = fs.readdirSync;
      const metadata = fs.statSync(cleanCwd);
      const statMock = spyOn(fs, "lstatSync").mockImplementation(((path, options) => String(path) === target ? metadata : lstat(path, options)) as typeof fs.lstatSync);
      const listMock = spyOn(fs, "readdirSync").mockImplementation(((path, options) => String(path) === target ? ["synthetic-skill"] : Reflect.apply(entries, fs, [path, options])) as typeof fs.readdirSync);
      try { return capture(() => adapter.validateRunRequest({ ...request, hermetic: true })); }
      finally { listMock.mockRestore(); statMock.mockRestore(); }
    }
    const requiresExplicitCwd = ["agy", "aider", "droid", "gemini", "goose", "openhands"].includes(agent);
    return capture(() => adapter.validateRunRequest({ ...request, cwd: requiresExplicitCwd ? undefined : cleanCwd, hermetic: true }));
  }
  return undefined;
}

describe("declared capabilities at synthetic validation boundaries", () => {
  const restores: Array<() => void> = [];
  beforeEach(() => {
    // Synthetic repository boundary: adapters inspect this empty directory
    // and stop before walking into the checkout or operator configuration.
    const exists = fs.existsSync;
    const stat = fs.statSync;
    const gitPath = join(cleanCwd, ".git");
    const existsMock = spyOn(fs, "existsSync").mockImplementation((path) => String(path) === gitPath || exists(path));
    const statMock = spyOn(fs, "statSync").mockImplementation(((path, options) => stat(String(path) === gitPath ? cleanCwd : path, options)) as typeof fs.statSync);
    const which = spyOn(Bun, "which").mockReturnValue(null);
    const construct = adapters.getAdapter;
    const adapterEnv = spyOn(adapters, "getAdapter").mockImplementation((agent, env) => construct(agent, env ?? {}));
    restores.push(() => existsMock.mockRestore(), () => statMock.mockRestore(), () => which.mockRestore(), () => adapterEnv.mockRestore());
    // A memory-backed specification exercises the real parser and prefix
    // opt-in gate without creating a server or an on-disk fixture.
    const read = fileIo.readUtf8FileBounded;
    const spec = spyOn(fileIo, "readUtf8FileBounded").mockImplementation((path, options) => {
      if (String(path).endsWith("/models_cache.json")) return JSON.stringify({ client_version: "0.166.0", models: [{ slug: "parity-model", apply_patch_tool_type: "freeform" }] });
      if (path === "synthetic-usage.jsonl") return JSON.stringify({ type: "usage.record", usage: { inputOther: 10, output: 2, inputCacheRead: 3, inputCacheCreation: 0 } });
      if (path === "synthetic-spec.json") return JSON.stringify({ name: "parity", command: "/synthetic/unused", args: [], env: [], accept_harness_prefix: ["codex-wall-time", "kimi-wall-time", "gemini-untrusted-context"], accept_harness_schema: ["gemini-wait-for-previous"] });
      return read(path, options);
    });
    restores.push(() => spec.mockRestore());
    // A future validator moving a process call earlier must fail this test,
    // including accidental version, security, or credential helper calls.
    for (const name of ["spawn", "spawnSync"] as const) {
      const mock = spyOn(Bun, name).mockImplementation(() => { throw new Error(`unexpected Bun.${name} in parity validation`); });
      restores.push(() => mock.mockRestore());
    }
  });
  afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); });

  for (const feature of PARITY_FEATURES) test(feature, async () => {
    const untested: string[] = [];
    const problems: string[] = [];
    for (const agent of AGENT_IDS) {
      try {
        const state = PARITY[agent][feature];
        const outcome = await exercise(agent, feature);
        if (outcome === undefined) {
          expect(state.state, `${agent} ${feature}: supported path lacks an executable check`).toBe("harness-limitation");
          if (state.state === "harness-limitation") untested.push(`${agent}: ${state.refusal}`);
          continue;
        }
        if (state.state === "supported") expect(outcome.message, `${agent} ${feature}`).toBeNull();
        else if (outcome.omittedMetric) expect(state.reason.startsWith("OPEN:")).toBe(false);
        else if (outcome.observedAbsence) {
          expect(["run.served-model-evidence", "check.provider-override.served-model"]).toContain(feature);
          expect(state.refusal).toBe("served_model: null");
        } else {
          expect(outcome.code, `${agent} ${feature}: ${outcome.message}`).toBe(64);
          expect(outcome.message, `${agent} ${feature}`).toContain(state.refusal);
        }
      } catch (error) { problems.push(`${agent} ${feature}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    expect(problems, `${feature}: every agent was exercised`).toEqual([]);
    expect(untested, `${feature}: limitations require an executable refusal check`).toEqual([]);
  });

  test("effort none remains an omission when no native none level exists", () => {
    for (const agent of AGENT_IDS) {
      const caps = getAdapter(agent, {}).capabilities();
      expect(resolveEffortForAdapter(agent, caps, "none")).toBe(caps.effortLevels.includes("none") ? "none" : undefined);
    }
  });
});

describe("hard-coded capability lists agree with the declaration", () => {
  test("project settings, Playwright, experiment MCP and session membership", () => {
    for (const [feature, actual] of [
      ["run.experiment-project-settings", [...PROJECT_SETTINGS_AGENTS]],
      ["run.playwright-mcp", AGENT_IDS.filter(supportsPlaywrightMcpAgent)],
      ["run.experiment-mcp", Object.keys(EXPERIMENT_MCP_HARNESSES)],
      ["session.driver", Object.keys(SESSION_AGENTS)],
    ] as const) expect([...actual].sort(), feature).toEqual(agentsSupporting(feature).sort());
  });
});

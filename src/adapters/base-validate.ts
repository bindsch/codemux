/** The request validators of BaseAdapter, split from src/adapters/base.ts:
 * the row-by-row capability validation every adapter shares, written once
 * as free functions over the members they read. BaseAdapter's methods
 * delegate here; subclasses keep overriding and calling super. */

import { validateExperimentRequest } from "../experiment-mcp.js";
import { resolveInstructionDir } from "../claude-family.js";
import { assertProjectSettingsAgent } from "../claude-project-settings.js";
import {
  MAX_ARGV_PROMPT_BYTES,
  validateTimeout,
} from "../process-runner.js";
import {
  BUDGET_USD_PATTERN,
  UsageRefusalError,
  validateAutonomy,
  validateEffort,
  validateEnvironmentNames,
  validateModelName,
  validatePrompt,
  validateWorkingDirectory,
} from "../validation.js";
import { PLAYWRIGHT_MCP_AGENT_LIST, supportsPlaywrightMcpAgent } from "../mcp.js";
import { TOOL_SELECTIONS, isToolSelection } from "../types.js";
import type {
  AdapterCapabilities,
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
} from "../types.js";

/** The BaseAdapter members the validators read — the class satisfies this
 * structurally, so no import cycle and no protected access is needed. */
export interface ValidationAdapter {
  readonly id: AgentId;
  capabilities(): AdapterCapabilities;
  promptInArgv(request: RunRequest): boolean;
  supportsTuiModel(): boolean;
  supportsTuiAutonomy(): boolean;
  supportsTuiEffort(): boolean;
  assertNoUnsupportedProviderOverride(): void;
}

export function validateRunRequestFor(
  adapter: ValidationAdapter,
  request: RunRequest
): void {
  if (typeof request !== "object" || request === null) {
    throw new Error("run request must be an object");
  }
  if (request.agent !== adapter.id) {
    throw new Error(
      `request agent '${request.agent}' does not match adapter '${adapter.id}'`
    );
  }
  validateExperimentRequest(request);
  const caps = adapter.capabilities();
  if (!caps.supportsNonInteractive) {
    throw new UsageRefusalError(`${adapter.id} does not support non-interactive execution`);
  }
  adapter.assertNoUnsupportedProviderOverride();
  // Validated like every other boolean before the agent check reads it
  // (review round 9, edges): a programmatic caller can pass any truthy
  // value, and an unmapped agent's request must be refused on the value.
  if (request.experimentProjectSettings !== undefined && typeof request.experimentProjectSettings !== "boolean") {
    throw new Error("experimentProjectSettings must be a boolean");
  }
  if (request.experimentProjectSettings) assertProjectSettingsAgent(adapter.id);
  validatePrompt(request.prompt);
  if (request.model !== undefined) {
    validateModelName(request.model);
    if (!caps.supportsModel) {
      throw new UsageRefusalError(`${adapter.id} does not support model selection`);
    }
  }
  const autonomy = validateAutonomy(request.autonomy);
  if (
    autonomy !== undefined &&
    (!caps.supportsAutonomy || !caps.autonomyLevels.includes(autonomy))
  ) {
    throw new UsageRefusalError(`${adapter.id} does not support autonomy level '${autonomy}'`);
  }
  const effort = validateEffort(request.effort);
  if (
    effort !== undefined &&
    (!caps.supportsEffort || !caps.effortLevels.includes(effort))
  ) {
    throw new UsageRefusalError(`${adapter.id} does not support reasoning effort '${effort}'`);
  }
  validateWorkingDirectory(request.cwd);
  validateEnvironmentNames(request.passthroughEnv);
  if (request.web !== undefined && typeof request.web !== "boolean") {
    throw new Error("web must be a boolean");
  }
  if (request.sandboxed !== undefined && typeof request.sandboxed !== "boolean") {
    throw new Error("sandboxed must be a boolean");
  }
  if (request.enablePlaywrightMcp !== undefined && typeof request.enablePlaywrightMcp !== "boolean") {
    throw new Error("enablePlaywrightMcp must be a boolean");
  }
  if (request.enablePlaywrightMcp === true) {
    // The CLI's rules, in the shared validator where a programmatic
    // request meets them too (review round 147): the server rides the
    // carrier each adapter builds, and only PLAYWRIGHT_MCP_AGENTS have one.
    // The same wording the CLI prints, so every entry names the same
    // refusal.
    if (request.sandboxed !== true) {
      throw new UsageRefusalError("--enable-playwright-mcp requires --sandbox");
    }
    if (!supportsPlaywrightMcpAgent(adapter.id)) {
      throw new UsageRefusalError(`--enable-playwright-mcp is supported only by ${PLAYWRIGHT_MCP_AGENT_LIST}`);
    }
    // The CLI's third rule, for the same reason: a hermetic run starts
    // the harness with its MCP servers off, and a run with no tools has
    // nothing to call the server with, so either would accept an option
    // that cannot take effect.
    if (request.hermetic === true || request.tools === "none") {
      throw new UsageRefusalError("--hermetic and --tools none cannot be combined with --enable-playwright-mcp");
    }
  }
  if (request.hermetic !== undefined && typeof request.hermetic !== "boolean") {
    throw new Error("hermetic must be a boolean");
  }
  if (request.resultJson !== undefined && typeof request.resultJson !== "boolean") {
    throw new Error("resultJson must be a boolean");
  }
  if (request.resultJson && !caps.supportsResultJson) {
    // Refuse rather than run and return plain text: a caller that asked for usage and got
    // none would record a run as costing nothing.
    throw new UsageRefusalError(
      `${adapter.id} cannot return a structured result envelope; --result-json is unsupported`
    );
  }
  if (request.maxBudgetUsd !== undefined) {
    // The CLI parses the flag before the request exists, so a programmatic
    // caller is the only one that can hand over a raw value: the same
    // shape rule applies to it before the capability is read.
    // The same shape the CLI accepts (BUDGET_USD_PATTERN): a programmatic
    // 0.001, 1e100, or eleven-digit amount would otherwise reach the
    // harness rounded or as a cap the caller did not write (review round
    // 277).
    if (
      typeof request.maxBudgetUsd !== "number" ||
      !Number.isFinite(request.maxBudgetUsd) ||
      request.maxBudgetUsd <= 0 ||
      !BUDGET_USD_PATTERN.test(String(request.maxBudgetUsd))
    ) {
      throw new UsageRefusalError(
        "maxBudgetUsd must be a positive amount with at most ten integer digits and two fraction digits"
      );
    }
    if (!caps.budgetLimit) {
      // A dropped limit would run uncapped under a caller who set one, so
      // the request is refused before any spawn, the same rule
      // --result-json has.
      throw new UsageRefusalError(
        `${adapter.id} has no spend limit flag; --max-budget-usd is unsupported`
      );
    }
  }
  if (request.hermetic && !caps.supportsHermetic) {
    // Capabilities explicitly opt in; docs/isolation.md records each
    // supported mechanism and its verification evidence, including
    // Antigravity.
    throw new UsageRefusalError(
      `${adapter.id} has no verified hermetic mode; see docs/isolation.md`
    );
  }
  if (request.tools !== undefined) {
    if (typeof request.tools !== "string" || !isToolSelection(request.tools)) {
      throw new Error(`tools must be one of: ${TOOL_SELECTIONS.join(", ")}`);
    }
    if (request.tools === "none" && !caps.supportsToolSelection) {
      throw new UsageRefusalError(
        `${adapter.id} cannot remove its built-in tools; see docs/isolation.md`
      );
    }
  }
  if (request.instructionDirs !== undefined) {
    if (!Array.isArray(request.instructionDirs)) {
      throw new Error("instructionDirs must be an array of directories");
    }
    // A relative instruction directory reaches the harness unchanged
    // (--add-dir, --read), and the harness resolves it against the run's
    // working directory — the same base the spawn uses — so that is the
    // tree it is validated against. Resolving against codemux's own
    // process directory passed or refused for the wrong repository
    // (review round 232).
    const base = request.cwd ?? process.cwd();
    for (const dir of request.instructionDirs) {
      // The raw entry is judged first: resolving an empty string against
      // the base would make it the working directory itself, pass, and
      // reach the harness as an empty argument (review round 241).
      if (typeof dir !== "string" || dir.length === 0 || dir.includes("\0")) {
        throw new UsageRefusalError("instructionDirs entries must be non-empty paths without NUL bytes");
      }
      validateWorkingDirectory(resolveInstructionDir(dir, base));
    }
  }
  if (request.timeoutMs !== undefined) validateTimeout(request.timeoutMs);
  // The argv rules key on where the prompt goes (promptInArgv), not on
  // whether getStdinInput is null: aider's stdin carries canned declines
  // while the prompt itself still rides `--message=` argv, so both rules
  // must apply there too — the NUL refusal as a usage error before launch,
  // not the spawn-time "invalid command" it used to become (review round
  // 153). A NUL cannot survive real argv and the bound keeps the launch
  // inside the OS limit.
  if (adapter.promptInArgv(request)) {
    if (request.prompt.includes("\0")) {
      throw new UsageRefusalError(`${adapter.id} cannot pass a NUL byte in an argv prompt`);
    }
    if (Buffer.byteLength(request.prompt, "utf8") > MAX_ARGV_PROMPT_BYTES) {
      throw new UsageRefusalError(
        `${adapter.id} passes prompts in argv; prompt exceeds the ${MAX_ARGV_PROMPT_BYTES}-byte safe limit`
      );
    }
  }
}

export interface TuiValidationInput {
  model?: string;
  cwd?: string;
  autonomy?: AutonomyLevel;
  effort?: ReasoningEffort;
  passthroughEnv?: readonly string[];
  enablePlaywrightMcp?: boolean;
}

export function validateTuiRequestFor(
  adapter: ValidationAdapter,
  input: TuiValidationInput
): void {
  const {
    model,
    cwd,
    autonomy = "read-only",
    effort,
    passthroughEnv = [],
    enablePlaywrightMcp = false,
  } = input;
  const caps = adapter.capabilities();
  if (!caps.supportsInteractive) {
    throw new UsageRefusalError(`${adapter.id} does not support interactive execution`);
  }
  adapter.assertNoUnsupportedProviderOverride();
  if (model !== undefined) {
    validateModelName(model);
    if (!adapter.supportsTuiModel()) {
      throw new UsageRefusalError(`${adapter.id} does not support model selection in TUI mode`);
    }
  }
  validateAutonomy(autonomy);
  if (!adapter.supportsTuiAutonomy()) {
    throw new UsageRefusalError(`${adapter.id} does not support autonomy in TUI mode`);
  }
  if (!caps.autonomyLevels.includes(autonomy)) {
    throw new UsageRefusalError(`${adapter.id} does not support autonomy level '${autonomy}'`);
  }
  if (effort !== undefined) {
    validateEffort(effort);
    if (!adapter.supportsTuiEffort() || !caps.effortLevels.includes(effort)) {
      throw new UsageRefusalError(
        `${adapter.id} does not support reasoning effort '${effort}' in TUI mode`
      );
    }
  }
  validateWorkingDirectory(cwd);
  validateEnvironmentNames(passthroughEnv);
  if (typeof enablePlaywrightMcp !== "boolean") {
    throw new Error("enablePlaywrightMcp must be a boolean");
  }
  if (enablePlaywrightMcp && !supportsPlaywrightMcpAgent(adapter.id)) {
    // The CLI's agent rule (review round 147): an adapter whose command
    // never carries the server refuses the option instead of ignoring it.
    // The sandbox rule cannot live here — a sandboxed TUI validates this
    // same request — so the unsandboxed entry point (runInteractive)
    // refuses the option outright.
    throw new UsageRefusalError(`--enable-playwright-mcp is supported only by ${PLAYWRIGHT_MCP_AGENT_LIST}`);
  }
}

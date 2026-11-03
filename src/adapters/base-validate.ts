/** The request validators of BaseAdapter, split from src/adapters/base.ts:
 * the row-by-row capability validation every adapter shares, written once
 * as free functions over the members they read. BaseAdapter's methods
 * delegate here; subclasses keep overriding and calling super. */

import { validateExperimentRequest } from "../experiment-mcp.js";
import { assertProjectSettingsAgent } from "../claude-project-settings.js";
import {
  MAX_ARGV_PROMPT_BYTES,
  validateTimeout,
} from "../process-runner.js";
import {
  UsageRefusalError,
  validateAutonomy,
  validateEffort,
  validateEnvironmentNames,
  validateModelName,
  validatePrompt,
  validateWorkingDirectory,
} from "../validation.js";
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
  getStdinInput(request: RunRequest): string | null;
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
    for (const dir of request.instructionDirs) validateWorkingDirectory(dir);
  }
  if (request.timeoutMs !== undefined) validateTimeout(request.timeoutMs);
  if (adapter.getStdinInput(request) === null) {
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
}

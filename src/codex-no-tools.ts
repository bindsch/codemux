import { dirname, join } from "node:path";
import type { RunContext } from "./adapters/base.js";
import type { RunRequest } from "./types.js";
import { CODEX_EXPERIMENT_FLAGS, SCRATCH_PARENT_DIR_NAME } from "./adapters/codex-flags.js";
import { codexExperimentModel } from "./experiment-codex-model.js";
import { writeOwnedSync } from "./fs-durable.js";
import { UsageRefusalError } from "./validation.js";
import { compareVersions, parseVersionParts } from "./harness-compatibility.js";
import type { ScodeTrustLevel } from "./sandbox.js";

export const CODEX_NO_TOOLS_CATALOG_BASENAME = "no-tools-model-catalog.json";
const CATALOG_PATH_REFUSAL = "codex --tools none at writable autonomy requires a sandbox-readable catalog file; untrusted sandbox mode denies its harness-state directory";
export const CODEX_NO_TOOLS_CATALOG_FLOOR = "0.166.0";

/** Native file carrier, read from the installed 0.166.0 binary on
 * 2026-11-09: ConfigToml model_catalog_json at byte 204760632; its path
 * parser diagnostics at 203451123 require valid JSON with >=1 model.
 * The existing catalog sanitizer removes apply_patch_tool_type and other
 * model-selected tools. A local file preserves provider/auth selection. */
export function needsCodexNoToolsCatalog(request: RunRequest): boolean {
  return request.tools === "none" && (request.autonomy ?? "read-only") !== "read-only" && !request.experimentMcp;
}

export function codexNoToolsCatalogBody(model: string | undefined, realCodexHome: string): string {
  if (!model) throw new UsageRefusalError("codex --tools none at writable autonomy requires an explicit --model or provider override model for its native tool-free catalog");
  try {
    return codexExperimentModel(model, realCodexHome).catalog!.body;
  } catch (error) {
    throw new UsageRefusalError(`codex --tools none cannot prepare its native model catalog: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function catalogPath(context: RunContext): string {
  if (!context.lastMessagePath) {
    throw new UsageRefusalError(CATALOG_PATH_REFUSAL);
  }
  return join(dirname(context.lastMessagePath), CODEX_NO_TOOLS_CATALOG_BASENAME);
}

export function prepareCodexNoToolsCatalog(context: RunContext, body: string, trust?: ScodeTrustLevel): void {
  if (trust === "untrusted") throw new UsageRefusalError(CATALOG_PATH_REFUSAL);
  writeOwnedSync(catalogPath(context), body, 0o600);
}

export function assertCodexNoToolsCatalogVersion(version: string | null | undefined): void {
  if (!version || parseVersionParts(version) === null || compareVersions(version, CODEX_NO_TOOLS_CATALOG_FLOOR) < 0) {
    throw new UsageRefusalError(`codex --tools none at writable autonomy requires verified Codex ${CODEX_NO_TOOLS_CATALOG_FLOOR} or later for model_catalog_json`);
  }
}

export function codexNoToolsCatalogArgs(request: RunRequest, context: RunContext | undefined, realCodexHome: string): string[] {
  if (!needsCodexNoToolsCatalog(request)) return [];
  if (context !== undefined) assertCodexNoToolsCatalogVersion(context.harnessVersion);
  const path = context === undefined
    ? join(realCodexHome, request.hermetic ? ".codemux-hermetic" : SCRATCH_PARENT_DIR_NAME, "unprepared", CODEX_NO_TOOLS_CATALOG_BASENAME)
    : catalogPath(context);
  return [...CODEX_EXPERIMENT_FLAGS, "-c", `model_catalog_json=${JSON.stringify(path)}`];
}

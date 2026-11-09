import { CODEX_EXPERIMENT_FLAGS, CODEX_HERMETIC_FLAGS, CODEX_NO_TOOLS_FLAGS, CODEX_PROJECT_SETTINGS_HERMETIC_FLAGS } from "../adapters/codex-flags.js";
import { UsageRefusalError } from "../validation.js";
import type { AutonomyLevel } from "../types.js";
import type { CodexSessionCatalog } from "./codex-catalog.js";

export interface CodexSessionSettings {
  hermetic?: boolean;
  projectSettings?: boolean;
  tools?: "none" | "default";
  noToolsCatalog?: CodexSessionCatalog | null;
}

export function validateCodexSessionTools(
  tools: CodexSessionSettings["tools"], autonomy: AutonomyLevel, catalog?: CodexSessionCatalog | null
): void {
  if (tools === "none" && autonomy !== "read-only") {
    if (!catalog) throw new UsageRefusalError("codex session --tools none at writable autonomy requires a prepared native model catalog");
    catalog.assertPrepared();
  }
}

/** App-server uses the same config keys as exec. Convert root --disable
 * flags to -c assignments, which app-server accepts after its subcommand.
 * Evidence: installed 0.166.0 binary, read 2026-11-09: ConfigToml,
 * project_doc_max_bytes, include_apps_instructions, and the feature table
 * shell_tool/unified_exec; ThreadStartParams and ThreadResumeParams both
 * carry config overrides. No harness invocation is needed to read them. */
function configAssignments(flags: readonly string[]): string[] {
  const assignments: string[] = [];
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (value === undefined || (flag !== "-c" && flag !== "--disable")) {
      throw new Error("unsupported Codex session configuration flag");
    }
    assignments.push(flag === "--disable" ? `features.${value}=false` : value);
  }
  return assignments;
}

/** Apply account suppression before app-server initialization as well as
 * thread creation. Project settings retain repository documents/hooks. */
export function codexSessionConfigArgs(settings: CodexSessionSettings): string[] {
  const flags = settings.hermetic
    ? settings.projectSettings ? CODEX_PROJECT_SETTINGS_HERMETIC_FLAGS : CODEX_HERMETIC_FLAGS
    : [];
  return [...configAssignments(flags), ...Object.entries(codexSessionToolConfig(settings.tools, settings.noToolsCatalog))
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)].flatMap((assignment) => ["-c", assignment]);
}

/** Reapply tool selection on fresh and resumed threads. Writable sessions
 * use the same native catalog and flags as run; provider selection stays
 * in its existing config. MCP/tool combinations use the run gate. */
export function codexSessionToolConfig(
  tools: CodexSessionSettings["tools"], catalog?: Pick<CodexSessionCatalog, "path"> | null
): Record<string, unknown> {
  if (tools !== "none") return {};
  const flags = [...CODEX_NO_TOOLS_FLAGS, ...(catalog ? CODEX_EXPERIMENT_FLAGS : [])];
  return { ...(catalog ? { model_catalog_json: catalog.path } : {}), ...Object.fromEntries(configAssignments(flags).map((assignment) => {
    const separator = assignment.indexOf("=");
    return [assignment.slice(0, separator), JSON.parse(assignment.slice(separator + 1)) as unknown];
  })) };
}

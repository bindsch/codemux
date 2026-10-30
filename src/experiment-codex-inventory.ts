import { object } from "./experiment-codex-content.js";
import { sanitizeCodexToolName } from "./experiment-tool-names.js";
import { ExperimentFailure, ExperimentFailureCode as Code, type ExperimentRecord } from "./experiment-records.js";
import type { JsonObject } from "./experiment-server.js";

export const CODEX_RESOURCE_TOOLS: ReadonlySet<string> = new Set([
  "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
]);

/** Only default-namespace function calls can reach Codex's MCP resource handlers. */
export function isCodexResourceCall(call: JsonObject): boolean {
  if (call.type !== "function_call" || (call.namespace && call.namespace !== "functions")) return false;
  return typeof call.name === "string" && CODEX_RESOURCE_TOOLS.has(call.name);
}

/** World-state maps include both namespace headers and qualified tool leaves. */
export class CodexTopLevelInventory {
  checked = false;

  constructor(private readonly server: string, private readonly names: () => ReadonlySet<string>,
    private readonly record: ExperimentRecord) {}

  accept(payload: JsonObject, t: number): void {
    const state = object(payload.state);
    if (this.checked && state && !Object.hasOwn(state, "top_level_tools") && payload.full === false) return;
    const tools = object(state?.top_level_tools);
    if (!tools || Object.values(tools).some((hash) => typeof hash !== "string" || !hash)) {
      throw new ExperimentFailure(Code.HarnessLogMissing, "Codex world_state has no valid top_level_tools map");
    }
    this.record("harness_top_level_tools", { tools, t });
    const sanitized = sanitizeCodexToolName(this.server);
    const namespace = sanitized.startsWith("mcp__") ? sanitized : `mcp__${sanitized}`;
    const allowed = new Set([namespace, "functions"]);
    for (const name of this.names()) {
      const tool = sanitizeCodexToolName(name);
      allowed.add(`${namespace}.${tool}`);
      allowed.add(`${namespace}__${tool}`);
      allowed.add(`functions.${namespace}__${tool}`);
    }
    for (const name of CODEX_RESOURCE_TOOLS) { allowed.add(name); allowed.add(`functions.${name}`); }
    const extra = Object.keys(tools).filter((name) => !allowed.has(name));
    if (extra.length) throw new ExperimentFailure(Code.InventoryMismatch,
      `Codex top_level_tools contains tools outside the experiment set: ${extra.join(", ")}`);
    this.checked = true;
  }
}

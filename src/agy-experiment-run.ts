import { UsageRefusalError } from "./validation.js";

/**
 * Read as data on 2026-11-09: installed bin/agy 1.5.3, version literal
 * at byte 173135732. The embedded MCP guide at byte 62586860 names
 * ".gemini/config/mcp_config.json" and "Streamable HTTP"; injection exists.
 *
 * The headless changelog at byte 69027511 lists "init", "step_update",
 * and terminal "result" events. At byte 69027973, "tool_info" contains
 * "canonical tool name, parameters, and output", not the complete tool
 * definitions sent to the model. steps.ExtractToolInfo calls
 * steps.filterToolParameters and steps.boundParamValue (byte 93876586).
 * These display fields cannot prove unmodified arguments or result bytes.
 * MCP enabled_tools/disabled_tools belong to McpServerConfig (66002415),
 * not the top-level inventory. A configured server's tools/list alone
 * therefore cannot establish the experiment's model-bound inventory.
 */
export const AGY_EXPERIMENT_LIMITATION = {
  reason: "Agy 1.5.3 loads private MCP servers, but its headless stream exposes per-call display fields rather than the complete model-bound tool inventory and raw results. Its tool_info extraction filters parameters and bounds values. The native output cannot establish the experiment inventory and byte-preservation contract.",
  evidence: "2026-11-09: installed bin/agy 1.5.3, version literal at byte 173135732; embedded MCP guide at 62586860 supports mcp_config.json and Streamable HTTP; changelog at 69027511 lists init/step_update/result, and 69027973 describes tool_info; symbols at 93876586 include steps.ExtractToolInfo, steps.filterToolParameters, and steps.boundParamValue.",
  refusal: "agy cannot verify the native tool inventory and raw MCP results",
} as const;

export function refuseAgyExperiment(): never {
  throw new UsageRefusalError(`--experiment-mcp is unavailable: ${AGY_EXPERIMENT_LIMITATION.refusal}. See docs/harnesses.md (agy run.experiment-mcp); bin/agy 1.5.3 headless stream.`);
}

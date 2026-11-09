import { UsageRefusalError } from "./validation.js";

/** Read 2026-11-09: openhands-1.16.0.dist-info/METADATA and
 * openhands_sdk-1.21.0.dist-info/METADATA. CLI locations.py names
 * MCP_CONFIG_FILE = "mcp.json" under OPENHANDS_PERSISTENCE_DIR.
 * SDK mcp/tool.py:273-300 always calls _create_mcp_action_type for MCP
 * provider declarations. tool/schema.py:201-239 copies property types,
 * descriptions, and required fields, dropping constraints such as enum.
 * tool/tool.py:427-428 always calls _create_action_type_with_summary.
 * No MCP config option bypasses either conversion. The original schema
 * in telemetry is not provider evidence: llm/utils/telemetry.py:361-367
 * removes kwargs.tools when the original ToolDefinition list is present.
 */
export const OPENHANDS_EXPERIMENT_LIMITATION = {
  reason: "OpenHands 1.16.0 with SDK 1.21.0 loads private MCP servers but always rebuilds their input schemas through Pydantic, drops constraints such as enum, and adds a summary property. Its completion logger removes the final provider tools and retains original MCP definitions instead. The native MCP path cannot preserve and verify arbitrary experiment tool schemas.",
  evidence: "2026-11-09: openhands-1.16.0.dist-info/METADATA and openhands_sdk-1.21.0.dist-info/METADATA; openhands_cli/locations.py MCP_CONFIG_FILE=mcp.json; openhands/sdk/mcp/tool.py:273-300 _create_mcp_action_type; tool/schema.py:201-239 rebuilds properties; tool/tool.py:427-428 _create_action_type_with_summary; llm/utils/telemetry.py:361-367 pops kwargs.tools.",
  refusal: "openhands cannot preserve and verify native MCP input schemas",
} as const;

export function refuseOpenhandsExperiment(): never {
  throw new UsageRefusalError(`--experiment-mcp is unavailable: ${OPENHANDS_EXPERIMENT_LIMITATION.refusal}. See docs/harnesses.md (openhands run.experiment-mcp); OpenHands 1.16.0 / SDK 1.21.0 schema conversion.`);
}

import { ExperimentFailure, ExperimentFailureCode as Code } from "./experiment-records.js";
import { sanitizeKimiToolNamePart } from "./experiment-kimi-tool-names.js";
import type { JsonObject } from "./experiment-server.js";

export function kimiObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

/** Matches mcpCore/tool-naming.ts, including its signed FNV hash representation. */
export function kimiToolName(server: string, tool: string): string {
  const full = `mcp__${sanitizeKimiToolNamePart(server)}__${sanitizeKimiToolNamePart(tool)}`;
  if (full.length <= 64) return full;
  let hash = 0x811c9dc5;
  for (let index = 0; index < full.length; index++) {
    hash ^= full.codePointAt(index)!;
    hash = Math.trunc(Math.imul(hash, 0x01000193));
  }
  const suffix = hash.toString(16).padStart(8, "0");
  return `${full.slice(0, 64 - suffix.length - 1)}_${suffix}`;
}

/** Exact text/image conversion and media-only framing from agent/mcp/output.ts. */
export function kimiContentParts(content: unknown[], qualifiedName: string): JsonObject[] {
  const parts = content.map(kimiContentPart);
  if (parts.some((part) => part.type === "image_url") && !parts.some((part) => part.type === "text" && part.text!.length > 0)) {
    return [{ type: "text", text: `<mcp_tool_result name="${qualifiedName}">` }, ...parts,
      { type: "text", text: "</mcp_tool_result>" }];
  }
  return parts;
}

function kimiContentPart(value: unknown): JsonObject {
  const block = kimiObject(value);
  if (block?.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
  if (block?.type === "image" && typeof block.data === "string" &&
      (block.mimeType == null || typeof block.mimeType === "string")) {
    return { type: "image_url", imageUrl: { url: `data:${block.mimeType ?? "image/png"};base64,${block.data}` } };
  }
  throw new ExperimentFailure(Code.UnsupportedResult, `Kimi experiment MCP does not support content type ${String(block?.type)}`);
}

export function assertKimiResult(value: unknown): asserts value is JsonObject {
  const result = kimiObject(value);
  if (!result || !Array.isArray(result.content)) throw new ExperimentFailure(Code.UnsupportedResult, "Kimi experiment MCP result requires a content array");
  for (const field of ["structuredContent", "_meta"]) {
    if (Object.hasOwn(result, field)) throw new ExperimentFailure(Code.UnsupportedResult, `Kimi experiment MCP results cannot include ${field}`);
  }
  if (result.isError !== undefined && typeof result.isError !== "boolean") throw new ExperimentFailure(Code.Protocol, "Kimi experiment MCP isError must be a boolean");
  for (const block of result.content) kimiContentPart(block);
  const parts = result.content.map(kimiObject);
  const only = parts.length === 1 ? parts[0] : undefined;
  if (parts.every((part: JsonObject | undefined) => part?.type === "text" && typeof part.text === "string" && !part.text.trim()) ||
      (result.isError !== true && only?.type === "text" && typeof only.text === "string" && only.text.trim() === "Tool output is empty.")) {
    throw new ExperimentFailure(Code.UnsupportedResult, "Kimi experiment MCP refuses empty server output");
  }
}

export function kimiOutputParts(output: unknown): unknown {
  return typeof output === "string" ? [{ type: "text", text: output }] : output;
}

const TOOL_ERROR_STATUS = "<system>ERROR: Tool execution failed.</system>";
const TOOL_EMPTY_STATUS = "<system>Tool output is empty.</system>";
const TOOL_EMPTY_ERROR_STATUS = "<system>ERROR: Tool execution failed. Tool output is empty.</system>";
const text = (value: string): JsonObject => ({ type: "text", text: value });

/** Reproduces contextMemory/toolResultRender.ts before projection drops blank text. */
export function kimiStatusParts(content: JsonObject[], isError: boolean): JsonObject[] {
  const first = content[0];
  const single = content.length === 1 && first?.type === "text" ? first.text as string : undefined;
  if (single !== undefined) {
    if (isError) return [text(single.length === 0 ? TOOL_EMPTY_ERROR_STATUS : `${TOOL_ERROR_STATUS}\n${single}`)];
    return [text(!single.trim() || single.trim() === "Tool output is empty." ? TOOL_EMPTY_STATUS : single)];
  }
  if (content.every((part) => part.type === "text" && !part.text.trim())) {
    return [text(isError ? TOOL_EMPTY_ERROR_STATUS : TOOL_EMPTY_STATUS)];
  }
  return isError ? [text(TOOL_ERROR_STATUS), ...content] : [...content];
}

const KIMI_WALL_TIME_HEADER = /^Wall time: \d+\.\d{3} seconds\n/;

/** The valid `Wall time: <secs> seconds` header at the start of `text`, or
 * null when the text opens with nothing valid. Kimi's header carries three
 * decimals and no `Output:` line (kimiProjectedResult builds it with
 * toFixed(3) plus the boundary newline), unlike codex's four-decimal
 * `Wall time: <secs> seconds\nOutput:` spelling
 * (src/experiment-codex-content.ts). Kept in lockstep with the construction
 * by tests/experiment-kimi.test.ts. */
export function kimiWallTimeHeader(text: string): string | null {
  const match = KIMI_WALL_TIME_HEADER.exec(text);
  return match === null ? null : match[0]!;
}

/** Wire tool messages are raw. The provider receives this reconstructed projection. */
export function kimiProjectedResult(content: JsonObject[], result: JsonObject): { content: JsonObject[]; header: string | null } {
  const rendered = kimiStatusParts(content, result.isError === true);
  const header = result.durationMs === undefined ? null :
    `Wall time: ${(result.durationMs / 1000).toFixed(3)} seconds${rendered[0]?.type === "text" ? "\n" : ""}`;
  if (header !== null) {
    const first = rendered[0];
    if (first?.type === "text") rendered.splice(0, 1, text(`${header}${first.text}`));
    else rendered.unshift(text(header));
  }
  if (result.note !== undefined && result.note.length > 0) {
    const first = rendered[0];
    if (rendered.length === 1 && first?.type === "text") rendered.splice(0, 1, text(`${first.text}\n${result.note}`));
    else rendered.push(text(result.note));
  }
  const projected = rendered.filter((part) => part.type !== "text" || part.text.trim().length > 0);
  if (!projected.length) throw new ExperimentFailure(Code.Protocol, "Kimi tool result is empty after removing blank text blocks");
  return { header, content: projected };
}

export function kimiWithoutHeader(content: JsonObject[], header: string | null): JsonObject[] | undefined {
  const first = content[0];
  if (header === null || first?.type !== "text") return undefined;
  if (first.text === header) return content.slice(1);
  return first.text.startsWith(header) ? [text(first.text.slice(header.length)), ...content.slice(1)] : undefined;
}

import { isDeepStrictEqual } from "node:util";
import type { JsonObject } from "./experiment-server.js";
import { ExperimentFailure, ExperimentFailureCode as Code } from "./experiment-records.js";

const WALL_TIME_HEADER = /^Wall time: \d+\.\d{4} seconds\nOutput:$/;
const IMAGE_DETAILS = new Set(["auto", "low", "high", "original"]);

/** Matches protocol/src/models.rs convert_mcp_content_to_items in rust-v0.165.0. */
export function codexContentItems(content: unknown[]): JsonObject[] {
  return content.map((value) => {
    const block = object(value);
    if (block?.type === "text" && typeof block.text === "string") {
      return object(block._meta)?.["codex/encryptedContent"] === true
        ? { type: "encrypted_content", encrypted_content: block.text }
        : { type: "input_text", text: block.text };
    }
    const mime = block?.mimeType ?? block?.mime_type;
    const duplicateMime = block && "mimeType" in block && "mime_type" in block;
    if (block && (block.type === "image" || block.type === "audio") && typeof block.data === "string" &&
        (mime === undefined || mime === null || typeof mime === "string") && !duplicateMime) {
      const url = block.data.startsWith("data:") ? block.data : `data:${mime ?? "application/octet-stream"};base64,${block.data}`;
      if (block.type === "audio") return { type: "input_audio", audio_url: url };
      const detail = object(block._meta)?.["codex/imageDetail"];
      return { type: "input_image", image_url: url, detail: IMAGE_DETAILS.has(detail) ? detail : "high" };
    }
    return { type: "input_text", text: JSON.stringify(value) };
  });
}

export function compareCodexOutput(content: unknown[], output: unknown): { equal: boolean; header: string | null } {
  const expected = codexContentItems(content);
  if (Array.isArray(output)) {
    const first = object(output[0]);
    const header = first?.type === "input_text" && typeof first.text === "string" ? first.text : null;
    return { equal: header !== null && WALL_TIME_HEADER.test(header) &&
      isDeepStrictEqual(first, { type: "input_text", text: header }) && isDeepStrictEqual(output.slice(1), expected), header };
  }
  if (typeof output === "string") {
    const separator = output.indexOf("\nOutput:");
    const header = separator === -1 ? null : output.slice(0, separator + "\nOutput:".length);
    const text = expected.length === 0 ? "" : expected.length === 1 && expected[0]?.type === "input_text" ? expected[0].text : undefined;
    return { equal: header !== null && WALL_TIME_HEADER.test(header) && text !== undefined &&
      output === (text === "" ? header : `${header}\n${text}`), header };
  }
  return { equal: false, header: null };
}

export function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

export function assertCodexResult(result: unknown, label: string): asserts result is JsonObject {
  const value = object(result);
  if (!value || !Array.isArray(value.content)) throw new ExperimentFailure(Code.UnsupportedResult, `${label} requires a content array`);
  for (const key of ["structuredContent", "_meta"]) {
    if (key in value) throw new ExperimentFailure(Code.UnsupportedResult, `${label} carrying ${key} is unsupported by Codex experiment MCP`);
  }
}

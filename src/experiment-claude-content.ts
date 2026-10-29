import { isDeepStrictEqual } from "node:util";
import type { JsonObject } from "./experiment-server.js";

// Claude Code 2.1.300 delivers a server result whose content is one text
// block as that block's text, a plain string, with trailing whitespace removed
// (seen on an `isError` Playwright result: "...\n" arrived without the newline).
// That canonical form is accepted in either error state. The only other
// accepted difference is an oversize-result spill verified by compareSpill;
// anything else (another block type, more than one block, a changed
// character, leading whitespace) still fails the run.
// Claude Code 2.1.300 rebuilds each MCP content block before delivery (its
// `ho()`): a text block as {type, text} plus a truthy _meta, with annotations
// dropped; an image block whose media type it inlines (PNG, JPEG, GIF, WebP;
// "image/jpg" read as JPEG) as the API's base64 image source with the same
// bytes, as long as the image is within its size and dimension budgets (a
// larger one is resized, and its changed bytes fail the run). Other blocks
// (audio, resource, resource_link) become Claude's own text and are not
// reproduced here, so they fail the run too.
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export function claudeContentBlocks(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const { type, text, data, mimeType, _meta } = block as JsonObject;
    if (type === "text" && typeof text === "string") return { type: "text", text, ...(_meta ? { _meta } : {}) };
    if (type === "image" && typeof data === "string" && typeof mimeType === "string") {
      const media = mimeType.split(";")[0]!.trim().toLowerCase();
      const mediaType = media === "image/jpg" ? "image/jpeg" : media;
      if (INLINE_IMAGE_TYPES.has(mediaType)) return { type: "image", source: { type: "base64", media_type: mediaType, data } };
    }
    return block;
  });
}

export function modelResultMatches(expected: unknown, actual: unknown): boolean {
  const canonical = claudeContentBlocks(expected);
  if (isDeepStrictEqual(canonical, actual)) return true;
  if (!Array.isArray(canonical) || canonical.length !== 1) return false;
  const block = canonical[0];
  if (!block || typeof block !== "object" || (block as JsonObject).type !== "text") return false;
  const text = (block as JsonObject).text;
  // Claude removes trailing whitespace; it never adds any, so only the
  // removed form is accepted, never an actual with whitespace the server did not send.
  return typeof text === "string" && typeof actual === "string" && (actual === text || actual === text.trimEnd());
}

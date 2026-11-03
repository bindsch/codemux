import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JsonObject } from "../src/experiment-server.js";
import { persistedPreview, persistedSizeLabel } from "../src/experiment-spill.js";
import { cleanupPeers, type PeerOptions } from "./helpers/experiment-peer.js";
import { spillPeer, spillText } from "./helpers/experiment-spill.js";

afterEach(cleanupPeers);

// Claude Code 2.1.300's second oversize form: the generic persistence step
// (maxResultSizeChars, 50,000) writes the text blocks, rebuilt as {type, text}
// plus any _meta, as indented JSON to <tool-results>/<tool_use_id>.json and
// delivers a <persisted-output> message with a size label and a 2,000-character preview.
test("the persisted-output size label and preview follow Claude Code's formatter", () => {
  // Labels and cut observed in a recorded 2.1.300 run: a 124,076-character file is "121.2KB";
  // the preview unit, 2,000 characters, is "2KB".
  expect(persistedSizeLabel(124076)).toBe("121.2KB");
  expect(persistedSizeLabel(2000)).toBe("2KB");
  expect(persistedSizeLabel(1023)).toBe("1023 bytes");
  expect(persistedSizeLabel(1024)).toBe("1KB");
  expect(persistedSizeLabel(1075)).toBe("1KB");
  expect(persistedSizeLabel(1076)).toBe("1.1KB");
  expect(persistedSizeLabel(3 * 1024 * 1024)).toBe("3MB");
  expect(persistedSizeLabel(1.55 * 1024 * 1024 * 1024)).toBe("1.6GB");
  const flat = "x".repeat(3000);
  expect(persistedPreview(flat)).toEqual({ preview: flat.slice(0, 2000), hasMore: true });
  // A newline past the half-way point ends the preview; an earlier one does not.
  const late = "a".repeat(1500) + "\n" + "b".repeat(1500);
  expect(persistedPreview(late)).toEqual({ preview: late.slice(0, 1500), hasMore: true });
  const early = "a".repeat(500) + "\n" + "b".repeat(2500);
  expect(persistedPreview(early)).toEqual({ preview: early.slice(0, 2000), hasMore: true });
  expect(persistedPreview("short")).toEqual({ preview: "short", hasMore: false });
});

const persistedBlocks = {
  one: [{ type: "text", text: spillText }],
  many: Array.from({ length: 12000 }, (_, i) => ({ type: "text", text: `row ${i}` })),
  small: [{ type: "text", text: "y".repeat(20000) }],
  huge: [{ type: "text", text: "z".repeat(500000) }],
  // Claude rebuilds each block as {type, text} and keeps _meta; key order and annotations are its own.
  reordered: [{ annotations: { audience: ["user"] }, text: spillText, type: "text", _meta: { source: "probe" } }],
};
const persistedFile = (blocks: JsonObject[], withMeta = true) => JSON.stringify(blocks.map((b) => ({ type: "text", text: b.text, ...(withMeta && b._meta ? { _meta: b._meta } : {}) })), null, 2);
function persistedMessage(path: string, saved: string, cap?: string, file = saved) {
  const { preview, hasMore } = persistedPreview(saved);
  const header = cap === undefined ? `Output too large (${persistedSizeLabel(file.length)}). Full output saved to: ${path}`
    : `Output exceeded the ${cap} persist limit; only the first ${cap} were saved to: ${path}`;
  return `<persisted-output>\n${header}\n\nPreview (first 2KB):\n${preview}${hasMore ? "\n..." : ""}\n</persisted-output>`;
}
async function persistedPeer(content: JsonObject[], options: PeerOptions = {}, withMeta = true) {
  const p = await spillPeer(options, content);
  return { ...p, file: persistedFile(content, withMeta), path: join(dirname(p.path), "first.json") };
}
// A capped persisted file: the prefix up to an ASCII boundary past 2,400 characters, labeled by its byte count.
function cappedJson(file: string) {
  const saved = file.slice(0, file.indexOf("output", 2400));
  const bytes = Buffer.byteLength(saved);
  return { saved, cap: `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")}KB` };
}
// The longest prefix of whole code points within `cap` bytes, as Claude truncates.
function prefixWithinBytes(text: string, cap: number) {
  let end = 0;
  for (const char of text) {
    if (Buffer.byteLength(text.slice(0, end + char.length)) > cap) break;
    end += char.length;
  }
  return text.slice(0, end);
}

test.each(["one", "many", "reordered", "metadata dropped", "capped", "capped below the preview", "symlinked cwd", "result cap from the tool's metadata",
  "annotated tool past the token limit"])(
  "persisted oversize output passes and records its verification: %s", async (variant) => {
  const shape = variant === "many" ? "many" : variant === "reordered" || variant === "metadata dropped" ? "reordered" : variant.startsWith("result cap") ? "small"
    : variant.startsWith("annotated") ? "huge" : "one";
  // Claude's MCP client keeps a text block's _meta in the file; its remote-tool path drops it. Both spellings pass.
  // A tool whose definition carries anthropic/maxResultSizeChars spills past that cap instead of 50,000.
  const p = await persistedPeer(persistedBlocks[shape], { symlinkCwd: variant === "symlinked cwd",
    // An annotated tool never takes the token form, so its persisted spill may exceed the token limit many times over.
    toolMeta: variant.startsWith("result cap") || variant.startsWith("annotated") ? { "anthropic/maxResultSizeChars": 10000 } : undefined }, variant !== "metadata dropped");
  const truncated = variant.startsWith("capped");
  // Claude previews the saved prefix: a 1 KB cap leaves less than the 2,000-character preview, with no ellipsis.
  const capped = variant === "capped below the preview" ? { saved: prefixWithinBytes(p.file, 1024), cap: "1KB" } : cappedJson(p.file);
  writeFileSync(p.path, truncated ? capped.saved : p.file);
  p.deliver(persistedMessage(p.path, truncated ? capped.saved : p.file, truncated ? capped.cap : undefined, p.file));
  p.result();
  expect(JSON.parse(p.bridge.finish()).result).toBe("OK");
  await p.bridge.closeProtocol();
  const comparison = p.records().find((r) => r.kind === "result_comparison");
  expect(comparison).toMatchObject({ equal: true, spilled: true, spill_kind: "persisted", chars: p.file.length, path: p.path, truncated,
    preview_chars: persistedPreview(truncated ? capped.saved : p.file).preview.length });
  expect(comparison).not.toHaveProperty("spill_rejected");
  expect(comparison).not.toHaveProperty("guidance");
  // The preview cut differs by shape: one long line is cut at 2,000, many short lines at a newline.
  if (shape === "one" && !truncated) expect(comparison.preview_chars).toBe(2000);
  if (variant === "capped below the preview") expect(comparison.preview_chars).toBe(capped.saved.length);
  if (shape === "many") expect(comparison.preview_chars).toBeLessThan(2000);
});

test.each([
  ["wrong size label", "size label"], ["cap labels that differ", "oversize message"],
  ["other tool's file", "basename"], ["txt extension", "basename"],
  ["preview of another text", "preview"], ["missing ellipsis", "preview"], ["preview too long", "preview"],
  ["different file", "file content"], ["prefix without the cap header", "file content"],
  ["empty prefix with the cap header", "file content"], ["prefix short of the cap", "truncation cap"],
  ["cap header with the full file", "truncation cap"],
  ["failed save", "oversize message"], ["image block", "text blocks"], ["result below the result cap", "result size"],
  ["result the token form takes first", "result size"], ["annotated result below its own cap", "result size"], ["error flag", "error flag"],
  ["outside path", "project directory"],
])("persisted oversize output rejection records the failed check: %s", async (variant, reason) => {
  const p = await persistedPeer(variant === "image block" ? [{ type: "image", data: "AA==", mimeType: "image/png" }]
    : variant === "result below the result cap" ? [{ type: "text", text: "x".repeat(40000) }]
    // round(500,000 / 4) = 125,000 tokens, past four times the 25,000 default: the token form fires first.
    : variant === "result the token form takes first" ? [{ type: "text", text: "x".repeat(500000) }]
    // Claude honors an annotation above 50,000 (up to 500,000): 55,000 characters stay below a 60,000 cap.
    : variant === "annotated result below its own cap" ? [{ type: "text", text: "x".repeat(55000) }] : persistedBlocks.one,
    variant === "annotated result below its own cap" ? { toolMeta: { "anthropic/maxResultSizeChars": 60000 } } : {});
  let path = p.path;
  if (variant === "other tool's file") path = join(dirname(p.path), "second.json");
  if (variant === "txt extension") path = join(dirname(p.path), "first.txt");
  if (variant === "outside path") path = join(p.environment.HOME, "first.json");
  const capped = cappedJson(p.file);
  writeFileSync(path, variant === "different file" ? p.file.replace("browser", "browsed") : variant === "prefix without the cap header" ? capped.saved
    : variant === "empty prefix with the cap header" ? "" : variant === "prefix short of the cap" ? p.file.slice(0, 100) : p.file);
  const withCap = variant === "empty prefix with the cap header" || variant === "prefix short of the cap" || variant === "cap header with the full file";
  let message: unknown = persistedMessage(path, p.file, withCap ? capped.cap : undefined);
  if (variant === "wrong size label") message = persistedMessage(path, p.file).replace(/Output too large \([^)]+\)/, "Output too large (9.9KB)");
  if (variant === "cap labels that differ") message = persistedMessage(path, p.file, "1GB").replace("only the first 1GB", "only the first 2GB");
  if (variant === "preview of another text") message = persistedMessage(path, p.file.replace("browser", "browsed"));
  if (variant === "missing ellipsis") message = persistedMessage(path, p.file).replace("\n...\n</persisted-output>", "\n</persisted-output>");
  if (variant === "preview too long") message = persistedMessage(path, p.file).replace("\n...\n</persisted-output>", `${p.file.slice(2000, 2010)}\n...\n</persisted-output>`);
  if (variant === "failed save") message = `<truncated-output>\nOutput too large (${persistedSizeLabel(p.file.length)}). It could not be saved, so only the first 1KB are shown; the rest was dropped. If the tool can page or filter its results, call it again for the part you need.\n\n${p.file.slice(0, 1024)}\n</truncated-output>`;
  expect(() => p.deliver(message, variant === "error flag" ? true : undefined)).toThrow("Claude changed the experiment tool result before model delivery");
  const comparison = p.records().find((r) => r.kind === "result_comparison");
  expect(comparison).toMatchObject({ equal: false, spilled: false, spill_rejected: reason });
  // The kind is recorded once the message parsed as the persisted form; a save failure or a broken header has none.
  if (reason === "oversize message") expect(comparison).not.toHaveProperty("spill_kind");
  else expect(comparison).toMatchObject({ spill_kind: "persisted" });
  expect(comparison).not.toHaveProperty("text");
});

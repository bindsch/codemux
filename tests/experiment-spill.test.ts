import { afterEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { assertExperimentConfigRootSingleLine, claudeChildProject, claudeEnvironmentInteger } from "../src/adapters/claude.js";
import type { JsonObject } from "../src/experiment-server.js";
import { persistedPreview, persistedSizeLabel } from "../src/experiment-spill.js";
import { cleanupPeers, peer, type PeerOptions } from "./helpers/experiment-peer.js";

afterEach(cleanupPeers);

// 3,000 lines of 18 characters and 23 bytes: 57,000 characters, past the 50,000-character result cap
// and the token estimate (round(57,000 / 4) = 14,250 > 12,500) that make Claude spill.
const spillText = "\uFEFFbrowser output \u{1F30D}\n".repeat(3000);
type Localize = (n: number) => string;
const enUS: Localize = (n) => n.toLocaleString("en-US");
const tokenHeader = (path: string, localize: Localize, count = spillText.length, lines = 3000) =>
  `Error: result (${localize(count)} characters across ${localize(lines)} ${lines === 1 ? "line" : "lines"}) exceeds maximum allowed tokens. Output has been saved to ${path}.\nFormat: Plain text\n`;
const defaultGuidance = (path: string) =>
  "Use offset and limit parameters to read specific portions of the file, search within it for specific content, and jq to make structured queries.\nREQUIREMENTS FOR SUMMARIZATION/ANALYSIS/REVIEW:\n" +
  `- You MUST read the content from the file at ${path} in sequential chunks until 100% of the content has been read.\n` +
  "- If you receive truncation warnings when reading the file, reduce the chunk size until you have read 100% of the content without truncation.\n" +
  "- Before producing ANY summary or analysis, you MUST explicitly describe what portion of the content you have read. ***If you did not read the entire content, you MUST explicitly state this.***\n" +
  "- If after a few attempts you cannot read the file (file not found, lines too long for Read's offset/limit, no shell access), STOP retrying. Summarize what you were able to read, explicitly state which portion you could not read and why, and proceed.\n";
// Chunk size: floor(80,000 / (18 + 8)) = 3,076 lines for the 25,000-token default; any positive chunk is Claude's.
const subagentGuidance = (path: string, localize: Localize, perChunk: number | string = 3076) =>
  `- For targeted searches (find a line, locate a string): use grep on the file directly.\n- For analysis or summarization that requires reading the full content: read ${path} in chunks of ~${perChunk} lines using offset/limit until you have read 100% of it.\n` +
  `- If the Agent tool is available, do this inside a subagent so the full output stays out of your main context. Give it the instruction above verbatim, and be explicit about what it must return — e.g. "Read ${path} in chunks of ~${perChunk} lines using offset/limit until you have read all ${localize(3000)} lines, then summarize and quote any key findings verbatim." A vague "summarize this" may lose detail.\n`;
// A read limit of 5 tokens gives Claude a 16-character span, below the 18-character lines; the limit itself
// is not modeled, so the span is any count below the longest line.
const slicingGuidance = (path: string, localize: Localize, span = 16) =>
  `- For targeted searches (find a string): use grep on the file directly.\n- For analysis or summarization that requires reading the full content: the file's lines are too long for Read's offset/limit. Slice by character range via Bash instead — e.g. python3 -c 'print(open("${path.replace(/'/g, "'\\''")}").read()[A:B])' in ~${localize(span)}-char spans until you have read 100% of it.\n` +
  `- If the Agent tool is available, do this inside a subagent so the full output stays out of your main context. Give it the instruction above verbatim, and be explicit about what it must return — e.g. "Slice ${path} in ~${localize(span)}-char spans via python (read()[A:B]) until you have read all ${localize(spillText.length)} characters, then summarize and quote any key findings verbatim." A vague "summarize this" may lose detail.\n`;
const persistNote = (cap: string) =>
  `\nNote: the output exceeded the persist byte limit; the saved file contains only the first ${cap} of it and may end mid-structure (a JSON parse of the whole file can fail). Any line/character counts or parsing recipes above describe the full output, not the truncated file.`;
type SpillMessage = { localize?: Localize; count?: number; lines?: number; guidance?: "default" | "subagent" | "slicing"; cap?: string; span?: number; chunk?: number | string };
function spillMessage(path: string, { localize = enUS, count, lines, guidance = "default", cap, span, chunk }: SpillMessage = {}) {
  const body = guidance === "default" ? defaultGuidance(path) : guidance === "subagent" ? subagentGuidance(path, localize, chunk) : slicingGuidance(path, localize, span);
  return tokenHeader(path, localize, count, lines) + body + (cap === undefined ? "" : persistNote(cap));
}
// Claude keeps the longest prefix of whole code points within the cap: 44 full lines (1,012 bytes),
// the BOM (3) and nine ASCII characters make exactly 1,024 bytes, labeled "1KB"; 1,075 bytes are
// still "1KB" (1,075 / 1,024 = 1.0498, which prints as 1.0) and 1,076 bytes are "1.1KB" (1.0508).
const cappedSaved = spillText.slice(0, 44 * 19 + 10);
const cappedSavedUpper = spillText.slice(0, 46 * 19 + 15);
const SESSION = "37088a82-b0d8-4aa7-a212-e4694a8cd920"; // Claude Code session ids are UUIDs
const localize = (zero: string, group: string): Localize => (n) =>
  String(n).replace(/\B(?=(\d{3})+$)/g, group).replace(/[0-9]/g, (d) => String.fromCodePoint(zero.codePointAt(0)! + Number(d)));

async function spillPeer(options: PeerOptions = {}, content: JsonObject[] = [{ type: "text", text: spillText }]) {
  const p = peer(options);
  await p.ready();
  p.request.mockResolvedValue({ jsonrpc: "2.0", id: 10, result: { content } });
  p.call("first");
  p.invoke("first", 10);
  await Promise.resolve();
  const slug = options.projectDirName ?? realpathSync(p.cwd).normalize("NFC").replace(/[^A-Za-z0-9]/g, "-");
  const home = options.symlinkHome ? realpathSync(p.environment.HOME) : p.environment.HOME;
  // Past 200 characters Claude appends the base-36 absolute value of its 32-bit string hash of the cwd.
  const canonical = realpathSync(p.cwd).normalize("NFC");
  let hash = 0;
  for (let i = 0; i < canonical.length; i++) hash = ((hash << 5) - hash + canonical.charCodeAt(i)) | 0;
  const project = join(options.configDir || options.spacedConfigDir || options.newlineConfigDir || options.delimiterConfigDir ? p.environment.CLAUDE_CONFIG_DIR! : join(home, ".claude"), "projects",
    slug.length > 200 ? `${slug.slice(0, 200)}-${Math.abs(hash).toString(36)}` : slug);
  const path = join(project, SESSION, "tool-results", "mcp-experiment-bash-1792387031137.txt");
  mkdirSync(dirname(path), { recursive: true });
  const deliver = (content: unknown, is_error?: boolean) => p.push({ type: "user", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "first", content, is_error },
  ] } });
  return { ...p, path, project, deliver };
}

test.each(["exact", "subagent guidance", "capped", "capped at the label's upper edge", "locale separators", "ungrouped digits", "Swiss apostrophe", "Arabic-Indic digits", "Devanagari digits",
  "long cwd", "config directory", "Arabic comma", "Adlam digits", "slicing guidance from a small read limit",
  "chunked guidance with another chunk size", "chunked guidance with a 21-digit chunk", "chunked guidance with an exponent chunk",
  "sanitized server name", "a block with _meta"])(
  "oversize spill passes and records its verification: %s", async (variant) => {
    // Claude drops a text block's truthy _meta before unwrapping it to plain text.
    const p = await spillPeer({ longCwd: variant === "long cwd", configDir: variant === "config directory", server: variant === "sanitized server name" ? "my.server" : undefined },
      variant === "a block with _meta" ? [{ type: "text", text: spillText, _meta: { source: "probe" } }] : undefined);
    const truncated = variant.startsWith("capped");
    const path = variant === "sanitized server name" ? join(dirname(p.path), "mcp-my_server-bash-1.txt") : p.path;
    writeFileSync(path, variant === "capped" ? cappedSaved : variant === "capped at the label's upper edge" ? cappedSavedUpper : spillText);
    const guidance = variant === "subagent guidance" || variant.startsWith("chunked guidance") ? "subagent" : variant.startsWith("slicing guidance") ? "slicing" : "default";
    const recorded = guidance === "default" ? "default" : "subagent"; // the slicing text is the subagent template
    // A template literal prints a chunk of 1e21 or more in exponent form, below that in full.
    const chunk = variant === "chunked guidance with another chunk size" ? 7 : variant.endsWith("21-digit chunk") ? "152380952380952380000"
      : variant.endsWith("exponent chunk") ? String(1.5e21) : undefined; // "1.5e+21", as String() prints it
    const message = spillMessage(path, { guidance, cap: truncated ? "1KB" : undefined, chunk,
      localize: variant === "Arabic-Indic digits" ? localize("٠", "٬") : variant === "Devanagari digits" ? localize("०", ",")
        : variant === "locale separators" ? (n) => n.toLocaleString("fr-FR") : variant === "Swiss apostrophe" ? localize("0", "'")
        : variant === "ungrouped digits" ? (n) => n.toLocaleString("es-ES") // es-ES leaves 3000 ungrouped
        : variant === "Arabic comma" ? localize("\u07C0", "\u060C") // N'Ko digits, as the runtime's locale prints them
        : variant === "Adlam digits" ? localize("\u{1E950}", "\u2E41") : enUS }); // ff-Adlm: Adlam digits and comma
    p.deliver(message);
    p.result();
    expect(JSON.parse(p.bridge.finish()).result).toBe("OK");
    await p.bridge.closeProtocol();
    const comparison = p.records().find((r) => r.kind === "result_comparison");
    expect(comparison).toMatchObject({ equal: true, spilled: true, spill_kind: "token", chars: spillText.length, path, truncated, guidance: recorded });
    expect(comparison).not.toHaveProperty("spill_rejected");
    expect(comparison).not.toHaveProperty("text");
  });

test.each([
  ["different content", "file content"], ["missing file", "real path"],
  ["outside path", "project directory"], ["outside symlink into project", "project directory"],
  ["inside symlink out of project", "resolved project directory"], ["sibling project", "project directory"],
  ["wrong basename", "basename"], ["unsanitized server name", "basename"], ["wrong count", "guidance"],
  ["failed save", "oversize message"], ["ordinary string", "oversize message"],
  ["wrong format", "plain text format"], ["relative path", "absolute path"],
  ["directory", "regular file"], ["oversized file", "file size"],
  ["prefix without note", "file content"], ["empty prefix", "file content"],
  ["different prefix with note", "file content"], ["prefix short of the cap", "truncation cap"],
  ["prefix past the cap", "truncation cap"], ["invalid UTF-8", "file read"],
  ["error flag", "error flag"], ["non-string content", "oversize message"],
  ["extra guidance", "guidance"], ["guidance naming another file", "guidance"], ["header without lines", "guidance"],
  ["wrong line count", "guidance"], ["note before the guidance", "guidance"],
  ["subagent guidance while legacy is passed through", "guidance"], ["default guidance while subagent is passed through", "guidance"],
  ["project symlink out of the config tree", "resolved project directory"],
  ["wrong count in Arabic-Indic digits", "guidance"],
  ["symlink to a file inside the project", "symlink"],
  ["slug directory while the project name is overridden", "project directory"],
  ["a block with a falsy _meta", "single text block"], ["two blocks", "single text block"],
  ["count grouped in a shape no locale uses", "oversize message"], ["count with a three-digit middle group", "oversize message"],
  ["count with a leading zero", "guidance"], ["six digits ungrouped", "guidance"],
  // A plain space is no locale's grouping mark, so these counts leave no parseable header.
  ["digits from two numeral sets", "guidance"], ["counts from two numeral sets", "guidance"],
  ["slicing span not below the longest line", "guidance"], ["chunk size of zero", "guidance"], ["chunked guidance for one line", "guidance"],
  ["counts with two grouping marks", "guidance"], ["counts in two grouping styles", "guidance"],
  ["grouped and ungrouped counts no locale prints together", "guidance"], ["Arabic comma with Arabic-Indic digits", "guidance"],
  ["chunk spelled with an exponent below 1e21", "guidance"], ["chunk spelled with a leading zero", "guidance"], ["fractional chunk", "guidance"],
  ["result below the token threshold", "result size"], ["token form from an annotated tool", "result size"],
  // The path ends at the first line break: a config directory with one leaves no parseable header or a wrong basename.
  ["config directory with a newline", "oversize message"], ["config directory containing the header's own text", "basename"],
  ["file beside the session directory", "tool-results directory"], ["session that is not a UUID", "tool-results directory"],
  ["file under another directory of the session", "tool-results directory"], ["garbled count", "oversize message"],
  ["note with the full file", "truncation cap"], ["count with a mark no locale uses", "oversize message"],
])("oversize spill rejection records the failed check: %s", async (variant, reason) => {
  // Claude drops a truthy _meta before the unwrap; a falsy one stays and sends the block to the JSON form.
  const content = variant === "six digits ungrouped" || variant === "counts in two grouping styles" ? [{ type: "text", text: "line\n".repeat(120000) }]
    : variant === "chunked guidance for one line" ? [{ type: "text", text: "x".repeat(60000) }]
    // round(40,000 / 4) = 10,000 tokens, below half of the 25,000 default: Claude would not have spilled it.
    : variant === "result below the token threshold" ? [{ type: "text", text: "x".repeat(40000) }]
    : variant === "a block with a falsy _meta" ? [{ type: "text", text: spillText, _meta: null }]
    : variant === "two blocks" ? [{ type: "text", text: spillText }, { type: "text", text: "" }] : undefined;
  const p = await spillPeer({ projectDirName: variant.includes("overridden") ? "probe" : undefined, server: variant === "unsanitized server name" ? "my.server" : undefined,
    newlineConfigDir: variant === "config directory with a newline", delimiterConfigDir: variant.includes("header's own text"),
    toolMeta: variant === "token form from an annotated tool" ? { "anthropic/maxResultSizeChars": 10000 } : undefined,
    truncationPrompt: variant.endsWith("legacy is passed through") ? "legacy" : variant.endsWith("subagent is passed through") ? "subagent" : undefined }, content);
  let path = p.path;
  if (variant.includes("overridden")) {
    path = join(dirname(p.project), realpathSync(p.cwd).normalize("NFC").replace(/[^A-Za-z0-9]/g, "-"), SESSION, "tool-results", "mcp-experiment-bash-1.txt");
    mkdirSync(dirname(path), { recursive: true });
  }
  if (variant === "symlink to a file inside the project") {
    writeFileSync(join(dirname(p.path), "real.txt"), spillText);
    path = join(dirname(p.path), "mcp-experiment-bash-3.txt");
    symlinkSync(join(dirname(p.path), "real.txt"), path);
  }
  if (variant === "project symlink out of the config tree") {
    // <configDir>/projects/<slug> itself is a symlink to a directory outside the config tree.
    const outside = join(p.environment.HOME, "elsewhere", SESSION, "tool-results");
    mkdirSync(outside, { recursive: true });
    rmSync(p.project, { recursive: true, force: true });
    symlinkSync(join(p.environment.HOME, "elsewhere"), p.project);
  }
  if (variant === "outside path") path = join(p.environment.HOME, "mcp-experiment-bash-1.txt");
  if (variant === "file beside the session directory") path = join(p.project, "mcp-experiment-bash-1.txt");
  if (variant === "session that is not a UUID") { path = join(p.project, "session", "tool-results", "mcp-experiment-bash-1.txt"); mkdirSync(dirname(path), { recursive: true }); }
  if (variant === "file under another directory of the session") { path = join(p.project, SESSION, "results", "mcp-experiment-bash-1.txt"); mkdirSync(dirname(path), { recursive: true }); }
  if (variant === "wrong basename") path = join(dirname(path), "mcp-other-bash-1.txt");
  if (variant === "sibling project") {
    path = join(p.project + "-other", "mcp-experiment-bash-1.txt");
    mkdirSync(dirname(path), { recursive: true });
  }
  if (variant === "directory") mkdirSync(path);
  else if (variant !== "missing file" && variant !== "symlink to a file inside the project") writeFileSync(path, spillText);
  if (variant === "outside symlink into project") {
    const link = join(p.environment.HOME, "outside-link");
    symlinkSync(dirname(path), link);
    path = join(link, "mcp-experiment-bash-1792387031137.txt");
  }
  if (variant === "inside symlink out of project") {
    const outside = join(p.environment.HOME, "outside.txt");
    writeFileSync(outside, spillText);
    path = join(dirname(path), "mcp-experiment-bash-2.txt");
    symlinkSync(outside, path);
  }
  if (variant === "different content" || variant === "different prefix with note") writeFileSync(path, "changed");
  if (variant === "prefix without note") writeFileSync(path, cappedSaved);
  if (variant === "empty prefix") writeFileSync(path, "");
  if (variant === "prefix short of the cap") writeFileSync(path, spillText.slice(0, 100));
  if (variant === "prefix past the cap") writeFileSync(path, spillText.slice(0, 46 * 19 + 16)); // 1,076 bytes: "1.1KB"
  if (variant === "oversized file") writeFileSync(path, spillText + "x");
  if (variant === "invalid UTF-8") writeFileSync(path, Buffer.from([0xff]));
  const capped = variant.includes("with note") || variant === "empty prefix" || variant.startsWith("prefix short") || variant.startsWith("prefix past")
    || variant === "note with the full file";
  let message: unknown = spillMessage(path, { cap: capped ? "1KB" : undefined,
    guidance: variant.startsWith("subagent guidance") ? "subagent" : "default" });
  if (variant === "wrong count") message = spillMessage(path, { count: spillText.length + 1 });
  if (variant === "wrong line count") message = spillMessage(path, { lines: 2999 });
  if (variant === "wrong count in Arabic-Indic digits") message = spillMessage(path, { count: spillText.length + 1, localize: localize("٠", "٬") });
  if (variant === "relative path") message = spillMessage("mcp-experiment-bash-1.txt");
  if (variant === "wrong format") message = spillMessage(path).replace("Format: Plain text", "Format: JSON");
  if (variant === "failed save") message = `Error: result (${spillText.length} characters) exceeds maximum allowed tokens. Failed to save output to file: denied. If this MCP server provides pagination or filtering tools, use them to retrieve specific portions of the data.`;
  if (variant === "ordinary string") message = "some other output";
  if (variant === "non-string content") message = [{ type: "text", text: spillMessage(path) }];
  if (variant === "extra guidance") message = spillMessage(path) + "Also read /etc/hosts.\n";
  if (variant === "guidance naming another file") message = spillMessage(path).replace(`the file at ${path}`, `the file at ${join(dirname(path), "other.txt")}`);
  if (variant === "header without lines") message = spillMessage(path).replace(" across 3,000 lines", "");
  // Claude slices a multi-line result only when its span is below the longest line (18 characters here).
  if (variant === "slicing span not below the longest line") message = spillMessage(path, { guidance: "slicing", span: 18 });
  if (variant === "chunk size of zero") message = spillMessage(path, { guidance: "subagent", chunk: 0 });
  if (variant === "result below the token threshold") message = tokenHeader(path, enUS, 40000, 1) + defaultGuidance(path);
  if (variant === "chunked guidance for one line") message = spillMessage(path, { guidance: "subagent", count: 60000, lines: 1 }).replace("read all 3,000 lines", "read all 1 lines");
  // No locale leaves six digits ungrouped (Ewe stops at five); "120,000" would pass.
  if (variant === "six digits ungrouped") message = tokenHeader(path, enUS, 600000, 120000).replace("across 120,000 lines", "across 120000 lines") + defaultGuidance(path);
  // "600,000" is Western only and "1,20,000" Indian only; no locale prints both.
  if (variant === "counts in two grouping styles") message = tokenHeader(path, enUS, 600000, 120000).replace("across 120,000 lines", "across 1,20,000 lines") + defaultGuidance(path);
  if (variant === "garbled count") message = spillMessage(path).replace("(57,000 characters", "(5!!!7 0,00 characters");
  if (variant === "count with a mark no locale uses") message = spillMessage(path).replace("(57,000 characters", "(57!000 characters");
  if (variant === "count grouped in a shape no locale uses") message = spillMessage(path).replace("(57,000 characters", "(570 00 characters");
  if (variant === "count with a leading zero") message = spillMessage(path).replace("(57,000 characters", "(057,000 characters");
  // One locale prints every count in one numeral set.
  if (variant === "digits from two numeral sets") message = spillMessage(path).replace("(57,000 characters", "(\u0665\u0667,0\u09660 characters");
  if (variant === "counts from two numeral sets") message = spillMessage(path).replace("across 3,000 lines", "across \u0663\u066C\u0660\u0660\u0660 lines");
  if (variant === "count with a three-digit middle group") message = spillMessage(path).replace("across 3,000 lines", "across 30 00 lines");
  if (variant === "counts with two grouping marks") message = spillMessage(path).replace("across 3,000 lines", "across 3.000 lines");
  // Locales that leave four digits ungrouped group with a period, space, or apostrophe, never a comma.
  if (variant === "grouped and ungrouped counts no locale prints together") message = spillMessage(path).replace("across 3,000 lines", "across 3000 lines");
  // The Arabic comma belongs to N'Ko's digits; Arabic-Indic digits group with the Arabic thousands separator.
  if (variant === "Arabic comma with Arabic-Indic digits") message = spillMessage(path, { localize: localize("\u0660", "\u060C") });
  if (variant === "chunk spelled with an exponent below 1e21") message = spillMessage(path, { guidance: "subagent", chunk: "7e+0" });
  if (variant === "chunk spelled with a leading zero") message = spillMessage(path, { guidance: "subagent", chunk: "07" });
  if (variant === "fractional chunk") message = spillMessage(path, { guidance: "subagent", chunk: "1.5" }); // Claude floors the chunk
  if (variant === "note before the guidance") message = tokenHeader(path, enUS) + persistNote("1KB") + "\n" + defaultGuidance(path);
  expect(() => p.deliver(message, variant === "error flag" ? true : undefined))
    .toThrow("Claude changed the experiment tool result before model delivery");
  await expect(p.bridge.closeProtocol()).rejects.toThrow("Claude changed the experiment tool result before model delivery");
  const comparison = p.records().find((r) => r.kind === "result_comparison");
  expect(comparison).toMatchObject({ equal: false, spilled: false, spill_rejected: reason });
  // The kind is recorded once the token form is recognized, not for strings that match no form
  // (a header whose count holds a character no count has is no header).
  if (!["failed save", "ordinary string", "non-string content", "garbled count", "count with a mark no locale uses", "config directory with a newline",
    "count grouped in a shape no locale uses", "count with a three-digit middle group"].includes(variant)) expect(comparison).toMatchObject({ spill_kind: "token" });
  else expect(comparison).not.toHaveProperty("spill_kind");
  expect(comparison).not.toHaveProperty("text");
});

test("a changed character, a dropped error flag, leading whitespace, or a second block still fails the comparison", async () => {
  const text = '### Error\nwaiting until "load"\n';
  const cases: Array<[unknown, boolean]> = [
    ['### Error\nwaiting until "idle"', true], // one word changed
    [text.trimEnd(), false],                   // is_error dropped
    [" " + text.trimEnd(), true],              // leading whitespace
    [text + "\n", true],                       // added trailing whitespace
    [text.trimEnd() + " ", true],              // replaced trailing whitespace
    [[{ type: "text", text: text.trimEnd() }, { type: "text", text: "" }], true], // a second block
  ];
  for (const [content, isError] of cases) {
    const p = peer();
    await p.ready();
    p.request.mockResolvedValue({ jsonrpc: "2.0", id: 10,
      result: { content: [{ type: "text", text }], isError: true } });
    p.call("first");
    p.invoke("first", 10);
    await Promise.resolve();
    expect(() => p.push({ type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "first", content, is_error: isError },
    ] } })).toThrow("Claude changed the experiment tool result before model delivery");
    expect(p.records().find((r) => r.kind === "result_comparison")).toMatchObject({ equal: false });
  }
});

test.each(["symlinked cwd", "ambient config directory", "decomposed cwd", "symlinked HOME",
  "subagent guidance naming the spill path", "config directory with a space and an apostrophe", "project directory override"])(
  "oversize spill verification follows the child's view: %s", async (variant) => {
    const p = await spillPeer({ symlinkCwd: variant === "symlinked cwd", ambientConfigDir: variant === "ambient config directory",
      nfcCwd: variant === "decomposed cwd", symlinkHome: variant === "symlinked HOME", spacedConfigDir: variant.startsWith("config directory"),
      projectDirName: variant === "project directory override" ? "probe" : undefined });
    writeFileSync(p.path, spillText);
    // The slicing template quotes the path for python inside single quotes: an apostrophe becomes '\''.
    p.deliver(spillMessage(p.path, { guidance: variant.startsWith("subagent") ? "subagent" : variant.startsWith("config directory") ? "slicing" : "default" }));
    p.result();
    expect(JSON.parse(p.bridge.finish()).result).toBe("OK");
    expect(p.records().find((r) => r.kind === "result_comparison")).toMatchObject({ equal: true, spilled: true, truncated: false });
  });

test("a read limit past 1e21 still matches its span, which toLocaleString() prints in full", async () => {
  // CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS=1e22 makes a 32,000,000,000,000,000,000,000-character span; one long line keeps the slicing template.
  const text = "x".repeat(60000);
  const p = await spillPeer({ truncationPrompt: "subagent" }, [{ type: "text", text }]);
  writeFileSync(p.path, text);
  const span = (3.2e22).toLocaleString("en-US");
  expect(span).toBe("32,000,000,000,000,000,000,000");
  const message = tokenHeader(p.path, enUS, text.length, 1) +
    `- For targeted searches (find a string): use grep on the file directly.\n- For analysis or summarization that requires reading the full content: the file's lines are too long for Read's offset/limit. Slice by character range via Bash instead \u2014 e.g. python3 -c 'print(open("${p.path}").read()[A:B])' in ~${span}-char spans until you have read 100% of it.\n` +
    `- If the Agent tool is available, do this inside a subagent so the full output stays out of your main context. Give it the instruction above verbatim, and be explicit about what it must return \u2014 e.g. "Slice ${p.path} in ~${span}-char spans via python (read()[A:B]) until you have read all ${enUS(text.length)} characters, then summarize and quote any key findings verbatim." A vague "summarize this" may lose detail.\n`;
  p.deliver(message);
  p.result();
  expect(JSON.parse(p.bridge.finish()).result).toBe("OK");
  expect(p.records().find((r) => r.kind === "result_comparison")).toMatchObject({ equal: true, spilled: true, guidance: "subagent" });
});

test.each(["one line", "many lines"])("a read limit that overflows the span to Infinity matches Claude's infinity sign and \"Infinity\": %s", async (variant) => {
  // CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS=1e308: the span is Infinity, printed by toLocaleString() as the sign
  // in the slicing template and by a template literal as "Infinity" in the chunked one.
  const text = variant === "one line" ? "x".repeat(60000) : spillText;
  const p = await spillPeer({ truncationPrompt: "subagent" }, [{ type: "text", text }]);
  writeFileSync(p.path, text);
  const message = variant === "one line"
    ? tokenHeader(p.path, enUS, text.length, 1) +
      `- For targeted searches (find a string): use grep on the file directly.\n- For analysis or summarization that requires reading the full content: the file's lines are too long for Read's offset/limit. Slice by character range via Bash instead \u2014 e.g. python3 -c 'print(open("${p.path}").read()[A:B])' in ~\u221E-char spans until you have read 100% of it.\n` +
      `- If the Agent tool is available, do this inside a subagent so the full output stays out of your main context. Give it the instruction above verbatim, and be explicit about what it must return \u2014 e.g. "Slice ${p.path} in ~\u221E-char spans via python (read()[A:B]) until you have read all ${enUS(text.length)} characters, then summarize and quote any key findings verbatim." A vague "summarize this" may lose detail.\n`
    : spillMessage(p.path, { guidance: "subagent", chunk: "Infinity" });
  p.deliver(message);
  p.result();
  expect(JSON.parse(p.bridge.finish()).result).toBe("OK");
  expect(p.records().find((r) => r.kind === "result_comparison")).toMatchObject({ equal: true, spilled: true, guidance: "subagent" });
});

test("a message repeating the header's own text thousands of times is rejected in bounded time", async () => {
  const p = await spillPeer();
  // ~1 MiB of what looks like candidate splits: the path ends at the first line break, so one is tried.
  const unit = "/mcp-experiment-bash-1.txt.\nFormat: Plain text\n";
  const message = `Error: result (3,800 characters across 200 lines) exceeds maximum allowed tokens. Output has been saved to ${unit.repeat(20000)}${defaultGuidance(p.path)}`;
  const started = performance.now();
  expect(() => p.deliver(message)).toThrow("Claude changed the experiment tool result before model delivery");
  expect(performance.now() - started).toBeLessThan(2000);
  expect(p.records().find((r) => r.kind === "result_comparison")).toMatchObject({ equal: false, spill_kind: "token" });
});

test("Indian grouping is accepted when every count uses it", async () => {
  const text = "line\n".repeat(120000);
  const p = await spillPeer({}, [{ type: "text", text }]);
  writeFileSync(p.path, text);
  const hiIN = (n: number) => n.toLocaleString("hi-IN");
  expect(hiIN(600000)).toBe("6,00,000");
  p.deliver(tokenHeader(p.path, hiIN, text.length, 120000) + defaultGuidance(p.path));
  p.result();
  expect(JSON.parse(p.bridge.finish()).result).toBe("OK");
  expect(p.records().find((r) => r.kind === "result_comparison")).toMatchObject({ equal: true, spilled: true });
});

test("a passed-through MAX_MCP_OUTPUT_TOKENS lowers the size a token spill must reach", async () => {
  // round(40,000 / 4) = 10,000 tokens, above half of a 5,000-token limit; 8,000 lines keep the chunked guidance.
  const text = "line\n".repeat(8000);
  const p = await spillPeer({ tokenLimit: 5000 }, [{ type: "text", text }]);
  writeFileSync(p.path, text);
  p.deliver(tokenHeader(p.path, enUS, text.length, 8000) + defaultGuidance(p.path));
  p.result();
  expect(JSON.parse(p.bridge.finish()).result).toBe("OK");
  expect(p.records().find((r) => r.kind === "result_comparison")).toMatchObject({ equal: true, spilled: true, chars: 40000 });
});

test("an experiment run refuses a config root with a line break, which no spill path could carry", () => {
  expect(() => assertExperimentConfigRootSingleLine({ HOME: "/home/x" }, ["CLAUDE_CONFIG_DIR"])).not.toThrow();
  expect(() => assertExperimentConfigRootSingleLine({ HOME: "/home/x", CLAUDE_CONFIG_DIR: "/two\nlines" })).not.toThrow(); // not passed through
  expect(() => assertExperimentConfigRootSingleLine({ HOME: "/home/x", CLAUDE_CONFIG_DIR: "/two\nlines" }, ["CLAUDE_CONFIG_DIR"])).toThrow("CLAUDE_CONFIG_DIR without a line break");
  expect(() => assertExperimentConfigRootSingleLine({ HOME: "/home/two\nlines" })).toThrow("HOME without a line break");
  // A passed-through config directory replaces $HOME/.claude, so HOME's spelling no longer matters; an empty one too.
  expect(() => assertExperimentConfigRootSingleLine({ HOME: "/home/two\nlines", CLAUDE_CONFIG_DIR: "/plain" }, ["CLAUDE_CONFIG_DIR"])).not.toThrow();
  expect(() => assertExperimentConfigRootSingleLine({ HOME: "/home/two\nlines", CLAUDE_CONFIG_DIR: "" }, ["CLAUDE_CONFIG_DIR"])).not.toThrow();
});

test("a lone surrogate in the server text matches the U+FFFD Claude's UTF-8 file holds", async () => {
  const text = "lone \ud800 surrogate\n".repeat(3000);
  const p = await spillPeer({}, [{ type: "text", text }]);
  writeFileSync(p.path, text); // Node writes the lone surrogate as U+FFFD, as Claude does
  const message = tokenHeader(p.path, enUS, text.length, 3000) + defaultGuidance(p.path);
  p.deliver(message);
  p.result();
  expect(JSON.parse(p.bridge.finish()).result).toBe("OK");
  expect(p.records().find((r) => r.kind === "result_comparison")).toMatchObject({ equal: true, spilled: true, chars: text.length });
});

test("the bridge follows the directory the runner spawned the child in, not the path it was given", async () => {
  const p = peer({ symlinkCwd: true });
  // The runner froze the link's target before launch checks; the link now points elsewhere.
  const frozen = realpathSync(p.cwd);
  mkdirSync(join(p.environment.HOME, "real2"));
  rmSync(p.cwd);
  symlinkSync(join(p.environment.HOME, "real2"), p.cwd);
  p.bridge.start(() => {}, () => {}, () => {}, frozen);
  await p.ready();
  p.request.mockResolvedValue({ jsonrpc: "2.0", id: 10, result: { content: [{ type: "text", text: spillText }] } });
  p.call("first");
  p.invoke("first", 10);
  await Promise.resolve();
  const path = join(p.environment.HOME, ".claude", "projects", frozen.replace(/[^A-Za-z0-9]/g, "-"), SESSION, "tool-results", "mcp-experiment-bash-1.txt");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, spillText);
  p.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "first", content: spillMessage(path) }] } });
  p.result();
  expect(JSON.parse(p.bridge.finish()).result).toBe("OK");
  expect(p.records().find((r) => r.kind === "result_comparison")).toMatchObject({ equal: true, spilled: true, path });
});

test("a working-directory symlink retargeted during the run keeps the project Claude started in", async () => {
  const p = await spillPeer({ symlinkCwd: true });
  // p.project was derived from the link's target when the bridge started; retarget the link now.
  mkdirSync(join(p.environment.HOME, "real2"));
  rmSync(p.cwd);
  symlinkSync(join(p.environment.HOME, "real2"), p.cwd);
  writeFileSync(p.path, spillText);
  p.deliver(spillMessage(p.path));
  p.result();
  expect(JSON.parse(p.bridge.finish()).result).toBe("OK");
  expect(p.records().find((r) => r.kind === "result_comparison")).toMatchObject({ equal: true, spilled: true, path: p.path });
});

test("an ambient CLAUDE_CONFIG_DIR that was not passed through does not name the spill directory", async () => {
  const p = await spillPeer({ ambientConfigDir: true });
  const ambient = join(p.environment.CLAUDE_CONFIG_DIR!, "projects", basename(p.project), SESSION, "tool-results", "mcp-experiment-bash-1.txt");
  mkdirSync(dirname(ambient), { recursive: true });
  writeFileSync(ambient, spillText);
  expect(() => p.deliver(spillMessage(ambient))).toThrow("Claude changed the experiment tool result before model delivery");
  expect(p.records().find((r) => r.kind === "result_comparison")).toMatchObject({ equal: false, spill_rejected: "project directory" });
});

test("the adapter resolves the child's project placement and spill settings from HOME unless the overrides are passed through", () => {
  const environment = { HOME: "/home/x", CLAUDE_CONFIG_DIR: "/alt", CLAUDE_CODE_PROJECT_DIR_NAME: "probe", MAX_MCP_OUTPUT_TOKENS: "4,000", MCP_TRUNCATION_PROMPT_OVERRIDE: "subagent" };
  expect(claudeChildProject(environment)).toEqual({ configDir: join("/home/x", ".claude"), projectDirName: undefined, tokenLimit: undefined, truncationPrompt: undefined });
  expect(claudeChildProject(environment, ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_PROJECT_DIR_NAME", "MAX_MCP_OUTPUT_TOKENS", "MCP_TRUNCATION_PROMPT_OVERRIDE"]))
    .toEqual({ configDir: "/alt", projectDirName: "probe", tokenLimit: 4000, truncationPrompt: "subagent" });
  // The binary's environment integer: trimmed; exponent, grouped, or parseInt forms; positive only.
  const limit = (value: string) => claudeChildProject({ HOME: "/home/x", MAX_MCP_OUTPUT_TOKENS: value }, ["MAX_MCP_OUTPUT_TOKENS"]).tokenLimit;
  for (const invalid of ["", "0", "-5", "abc", " ", "1.5e0"]) expect(limit(invalid)).toBeUndefined();
  expect(limit("4e3")).toBe(4000);
  expect(limit("1.5")).toBe(1);
  expect(limit(" 7 ")).toBe(7);
  expect(limit("4,00")).toBe(4); // not a grouped form, so parseInt stops at the comma
  expect(claudeEnvironmentInteger("4_000_000")).toBe(4000000);
  // The override counts only alongside a passed-through CLAUDE_CONFIG_DIR.
  expect(claudeChildProject(environment, ["CLAUDE_CODE_PROJECT_DIR_NAME"])).toMatchObject({ configDir: join("/home/x", ".claude"), projectDirName: undefined });
  expect(claudeChildProject({ CLAUDE_CONFIG_DIR: "/alt" }).configDir).toBeUndefined();
  for (const invalid of ["", "two words", "x".repeat(65), "con", "LPT1"]) {
    expect(claudeChildProject({ HOME: "/home/x", CLAUDE_CONFIG_DIR: "/alt", CLAUDE_CODE_PROJECT_DIR_NAME: invalid }, ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_PROJECT_DIR_NAME"]).projectDirName).toBeUndefined();
  }
  // An empty passed-through CLAUDE_CONFIG_DIR keeps the binary's root empty: no directory is known, spills are rejected.
  expect(claudeChildProject({ HOME: "/home/x", CLAUDE_CONFIG_DIR: "" }, ["CLAUDE_CONFIG_DIR"]).configDir).toBeUndefined();
  expect(claudeChildProject({ HOME: "/home/x", MCP_TRUNCATION_PROMPT_OVERRIDE: "" }, ["MCP_TRUNCATION_PROMPT_OVERRIDE"]).truncationPrompt).toBeUndefined();
  expect(claudeChildProject({ HOME: "/home/x", MCP_TRUNCATION_PROMPT_OVERRIDE: " legacy " }, ["MCP_TRUNCATION_PROMPT_OVERRIDE"]).truncationPrompt).toBe("legacy");
});

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

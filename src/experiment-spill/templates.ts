// Claude Code's spill-message templates and message parsing: the guidance
// templates the token form prints, the persisted form's header and preview,
// and the candidate messages cut out of a harness reply.
// src/experiment-spill.ts owns the spill comparison and calls these.
import type { ClaudeChildProject } from "../claude-family.js";
import { fitsLocale, groupMarkClass, localeSignatures, localizedDigits, plainDigits, type LocalizedCount } from "./locale.js";

// A message template: literal text, localized counts, and Claude's own
// numbers derived from its file-read limit (a span of characters, a chunk
// of lines). The limit may come from the child's environment, a settings
// file, or a flag, so those numbers are not predicted: a span is any count
// (or the infinity sign) printed the same wherever it recurs, a chunk any
// positive number as a template literal prints it (plain digits below 1e21,
// an exponent form above, or "Infinity"), and the message's counts and span
// share one numeral set.
export type Part = string | { count: number } | { span: true } | { chunk: true };
export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export type TemplateMatch = { span?: bigint | "infinite" };
export function matchesTemplate(parts: Part[], actual: string): TemplateMatch | undefined {
  const pattern = parts.map((part) => typeof part === "string" ? escapeRegExp(part)
    : "count" in part ? `((?:\\p{Nd}|${groupMarkClass()}){1,512}?)`
    : "span" in part ? `((?:\\p{Nd}|${groupMarkClass()}){1,512}?|\u221E)`
    : "([0-9][0-9.e+]{0,30}|Infinity)").join("");
  const match = new RegExp(`^${pattern}$`, "su").exec(actual);
  if (!match) return undefined;
  const slots = parts.filter((part): part is Exclude<Part, string> => typeof part !== "string");
  const localized: LocalizedCount[] = [];
  const seen: Partial<Record<"span" | "chunk", string>> = {};
  let span: bigint | "infinite" | undefined;
  for (const [index, slot] of slots.entries()) {
    const captured = match[index + 1]!;
    if (!("count" in slot)) {
      const kind = "span" in slot ? "span" : "chunk";
      if (seen[kind] === undefined) seen[kind] = captured;
      else if (seen[kind] !== captured) return undefined;
      // A chunk is a template literal's print of a floored number: exactly what String() gives back for an integer.
      if (kind === "chunk") {
        if (captured !== "Infinity" && (String(Number(captured)) !== captured || Number(captured) < 1 || !Number.isInteger(Number(captured)))) return undefined;
        continue;
      }
      if (captured === "\u221E") { span = "infinite"; continue; }
    }
    const parsed = localizedDigits(captured);
    if (parsed === undefined) return undefined;
    localized.push(parsed);
    if ("count" in slot) { if (parsed.digits !== plainDigits(slot.count)) return undefined; }
    else span = BigInt(parsed.digits);
  }
  // One locale printed every count: its numeral set, mark, style, and minimum grouping fit them all.
  if (!localeSignatures().some((locale) => localized.every((count) => fitsLocale(count, locale)))) return undefined;
  return { span };
}
/** Claude Code's formatFileSize: KiB steps, one decimal, a trailing ".0" dropped. */
export function persistedSizeLabel(chars: number): string {
  const kb = chars / 1024;
  if (kb < 1) return `${chars} bytes`;
  const fixed = (n: number) => n.toFixed(1).replace(/\.0$/, "");
  if (kb < 1024) return `${fixed(kb)}KB`;
  const mb = kb / 1024;
  return mb < 1024 ? `${fixed(mb)}MB` : `${fixed(mb / 1024)}GB`;
}
const PREVIEW_CHARS = 2000;
/** Claude Code's preview: the first 2,000 characters, cut back to the last newline past the half-way point. */
export function persistedPreview(file: string): { preview: string; hasMore: boolean } {
  if (file.length <= PREVIEW_CHARS) return { preview: file, hasMore: false };
  const newline = file.slice(0, PREVIEW_CHARS).lastIndexOf("\n");
  return { preview: file.slice(0, newline > PREVIEW_CHARS * 0.5 ? newline : PREVIEW_CHARS), hasMore: true };
}
// Claude Code's leaf-name escaping of the tool_use_id: [A-Za-z0-9_-] and a
// non-leading "." pass, everything else becomes %XX per UTF-8 byte (a lone
// surrogate %uXXXX), and a Windows device name gets its first character escaped.
export function escapeLeafName(id: string): string {
  const escapeChar = (char: string) => {
    const code = char.charCodeAt(0);
    if (char.length === 1 && code >= 0xd800 && code <= 0xdfff) return `%u${code.toString(16).toUpperCase()}`;
    return Array.from(Buffer.from(char), (byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("");
  };
  let name = "";
  for (const char of id) name += /^[A-Za-z0-9_-]$/.test(char) || (char === "." && name !== "") ? char : escapeChar(char);
  if (name === "") return "%";
  const stem = name.slice(0, name.indexOf(".") === -1 ? undefined : name.indexOf(".")).replace(/ +$/, "");
  return /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i.test(stem) ? escapeChar(name.charAt(0)) + name.slice(1) : name;
}
/** Claude Code's MCP name sanitizer for file names (claude.ai servers also collapse runs of "_"). */
export function mcpName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return name.startsWith("claude.ai ") ? sanitized.replace(/_+/g, "_").replace(/^_|_$/g, "") : sanitized;
}
/** The saved file of a capped spill is the longest prefix of whole code points
 * fitting in the cap; the cap is unknown beyond its label, so the saved byte
 * length must reach the label with the next code point left out. */
export function cappedPrefix(content: string, saved: string, label: string): boolean {
  const last = saved.charCodeAt(saved.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) return false;
  const savedBytes = Buffer.byteLength(saved);
  const nextBytes = Buffer.byteLength(String.fromCodePoint(content.codePointAt(saved.length)!));
  for (let cap = savedBytes; cap < savedBytes + nextBytes; cap++) if (persistedSizeLabel(cap) === label) return true;
  return false;
}

// A spill path holds no line break: codemux refuses an experiment run whose
// config root (a passed-through CLAUDE_CONFIG_DIR, else HOME) has one, and
// the rest of the path is Claude's own naming. The path therefore ends at
// the message's first line break, which the delimiter after it must follow.
function splitAtLine(text: string, delimiter: string): [string, string] | undefined {
  const line = text.indexOf("\n");
  if (line <= 0) return undefined;
  const start = line - (delimiter.indexOf("\n"));
  return start > 0 && text.startsWith(delimiter, start) ? [text.slice(0, start), text.slice(start + delimiter.length)] : undefined;
}
type PersistedCandidate = { size?: string; cap?: string; path: string; body: string };
export function persistedCandidates(message: string): PersistedCandidate[] {
  const header = /^<persisted-output>\n(?:Output too large \((\d+ bytes|\d+(?:\.\d)?[KMG]B)\)\. Full output saved to: |Output exceeded the (\d+ bytes|\d+(?:\.\d)?[KMG]B) persist limit; only the first (\d+ bytes|\d+(?:\.\d)?[KMG]B) were saved to: )/.exec(message);
  if (!header) return [];
  const cap = header[2];
  if (cap !== undefined && cap !== header[3]) return [];
  const split = splitAtLine(message.slice(header[0].length), "\n\nPreview (first 2KB):\n");
  if (!split || !split[1].endsWith("\n</persisted-output>")) return [];
  return [{ size: header[1], cap, path: split[0], body: split[1].slice(0, -"\n</persisted-output>".length) }];
}

// The token form's header and the note; the guidance between them is matched
// as a whole template below.
type TokenCandidate = { path: string; format: string; cap?: string };
export function tokenCandidates(message: string): TokenCandidate[] {
  // Bounded, greedy captures and the single split keep this linear in the message; the template match decides the values.
  const header = new RegExp(`^Error: result \\((?:\\p{Nd}|${groupMarkClass()}){1,512} characters(?: across (?:\\p{Nd}|${groupMarkClass()}){1,512} lines?)?\\) exceeds maximum allowed tokens\\. Output has been saved to `, "u").exec(message);
  if (!header) return [];
  const note = /\nNote: the output exceeded the persist byte limit; the saved file contains only the first (\d+ bytes|\d+(?:\.\d)?[KMG]B) of it and may end mid-structure \(a JSON parse of the whole file can fail\)\. Any line\/character counts or parsing recipes above describe the full output, not the truncated file\.$/.exec(message);
  const split = splitAtLine(message.slice(header[0].length), ".\nFormat: ");
  if (!split) return [];
  const line = split[1].indexOf("\n");
  return line > 0 ? [{ path: split[0], format: split[1].slice(0, line), cap: note?.[1] }] : [];
}

export type Guidance = "default" | "subagent";
type TokenTemplate = { guidance: Guidance; parts: Part[]; slicing: boolean };
/** Claude Code's token-form messages for this text: each guidance template in
 * its chunked and slicing variants, since the read limit that picks one is not
 * known here. The chunked variants need more than one line; a slicing variant
 * for several lines needs a span below the longest line. */
export function tokenMessages(path: string, text: string, cap: string | undefined, child: ClaudeChildProject): { templates: TokenTemplate[]; count: number; maxLen: number } {
  const lines = text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const count = lines.length;
  let maxLen = 0;
  for (const line of lines) if (line.length > maxLen) maxLen = line.length;
  const header: Part[] = ["Error: result (", { count: text.length }, " characters across ", { count }, ` ${count === 1 ? "line" : "lines"}) exceeds maximum allowed tokens. Output has been saved to ${path}.\nFormat: Plain text\n`];
  const note = cap === undefined ? "" : `\nNote: the output exceeded the persist byte limit; the saved file contains only the first ${cap} of it and may end mid-structure (a JSON parse of the whole file can fail). Any line/character counts or parsing recipes above describe the full output, not the truncated file.`;
  const requirements = (chunked: boolean) => `- You MUST read the content from the file at ${path} in sequential chunks until 100% of the content has been read.\n` +
    (chunked ? "" : "- Note: this file's lines are too long for Read's offset/limit chunking. If a shell tool is available, slice by character range (e.g. python read()[A:B], dd, or cut -c) instead.\n") +
    "- If you receive truncation warnings when reading the file, reduce the chunk size until you have read 100% of the content without truncation.\n" +
    "- Before producing ANY summary or analysis, you MUST explicitly describe what portion of the content you have read. ***If you did not read the entire content, you MUST explicitly state this.***\n" +
    "- If after a few attempts you cannot read the file (file not found, lines too long for Read's offset/limit, no shell access), STOP retrying. Summarize what you were able to read, explicitly state which portion you could not read and why, and proceed.\n";
  const defaultGuidance = (chunked: boolean): Part[] => [...header, (chunked
    ? "Use offset and limit parameters to read specific portions of the file, search within it for specific content, and jq to make structured queries.\n"
    : "Search within the file for specific content, and use jq if the content is JSON.\n") + "REQUIREMENTS FOR SUMMARIZATION/ANALYSIS/REVIEW:\n" + requirements(chunked) + note];
  const python = process.platform === "win32" ? "python" : "python3";
  const quoted = path.replaceAll("\\", "/").replaceAll("'", "'\\''");
  const chunk: Part = { chunk: true };
  const span: Part = { span: true };
  const subagentChunked: Part[] = [...header, `- For targeted searches (find a line, locate a string): use grep on the file directly.\n- For analysis or summarization that requires reading the full content: read ${path} in chunks of ~`, chunk, ` lines using offset/limit until you have read 100% of it.\n- If the Agent tool is available, do this inside a subagent so the full output stays out of your main context. Give it the instruction above verbatim, and be explicit about what it must return \u2014 e.g. "Read ${path} in chunks of ~`, chunk, " lines using offset/limit until you have read all ", { count }, ` lines, then summarize and quote any key findings verbatim." A vague "summarize this" may lose detail.\n${note}`];
  const subagentSlicing: Part[] = [...header, `- For targeted searches (find a string): use grep on the file directly.\n- For analysis or summarization that requires reading the full content: the file's lines are too long for Read's offset/limit. Slice by character range via Bash instead \u2014 e.g. ${python} -c 'print(open("${quoted}").read()[A:B])' in ~`, span, `-char spans until you have read 100% of it.\n- If the Agent tool is available, do this inside a subagent so the full output stays out of your main context. Give it the instruction above verbatim, and be explicit about what it must return \u2014 e.g. "Slice ${path} in ~`, span, "-char spans via python (read()[A:B]) until you have read all ", { count: text.length }, ` characters, then summarize and quote any key findings verbatim." A vague "summarize this" may lose detail.\n${note}`];
  // A passed-through MCP_TRUNCATION_PROMPT_OVERRIDE selects the template; otherwise a remote flag may.
  const override = child.truncationPrompt;
  const templates: TokenTemplate[] = [];
  if (override === undefined || override === "legacy") {
    if (count > 1) templates.push({ guidance: "default", parts: defaultGuidance(true), slicing: false });
    templates.push({ guidance: "default", parts: defaultGuidance(false), slicing: true });
  }
  if (override === undefined || override !== "legacy") {
    if (count > 1) templates.push({ guidance: "subagent", parts: subagentChunked, slicing: false });
    templates.push({ guidance: "subagent", parts: subagentSlicing, slicing: true });
  }
  return { templates, count, maxLen };
}

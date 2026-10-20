import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import type { ClaudeChildProject } from "./adapters/claude.js";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

// Claude Code 2.1.300 replaces an oversize MCP result in one of two forms,
// both read from its binary and checked against recorded runs.
//
// Token form (the MCP tool's own limit, MAX_MCP_OUTPUT_TOKENS): the text of a
// single text block (no _meta) is saved as mcp-<server>-<tool>-<ms>.txt under
// the project's tool-results directory, and the model receives a header
// ("Error: result (N characters across L lines) exceeds maximum allowed
// tokens. Output has been saved to <path>.\nFormat: Plain text\n"), one of
// two guidance templates (the default one, or the subagent one behind a
// remote flag or MCP_TRUNCATION_PROMPT_OVERRIDE), and, when the persist byte
// cap was hit, a note naming the cap. The counts use an unpinned
// toLocaleString(), so their digits may be any script's and the grouping
// mark any locale's. A failed save has no path and is not a spill.
//
// Persisted form (the generic tool-result step, maxResultSizeChars clamped
// to 50,000 unless a remote flag raises it; it fires when the token form did
// not): the text blocks, rebuilt as {type, text} plus any _meta, are written
// as JSON.stringify(blocks, null, 2) to <tool-results>/<escaped tool_use_id>.json
// and the model receives "<persisted-output>\nOutput too large (<size>). Full
// output saved to: <path>\n\nPreview (first 2KB):\n<preview>\n...\n</persisted-output>",
// where <size> is Claude's file-size label of the JSON's length and the
// preview its first 2,000 characters, cut back to the last newline past the
// half-way point; "\n..." follows only when the file is longer. When the
// persist cap is hit the header reads "Output exceeded the <cap> persist
// limit; only the first <cap> were saved to: <path>". A save failure yields
// a <truncated-output> message with no file, which is not a spill.
//
// In both forms a capped file is the longest prefix of whole code points
// whose UTF-8 fits in the cap, so the saved bytes must be consistent with
// the cap label.

// Unicode encodes every decimal-digit set (Nd) as a complete, ordered run of
// ten code points, so a digit's value is its position within the run of
// consecutive Nd code points it belongs to, modulo ten.
let digitValues: Map<number, number> | undefined;
function digitValue(codePoint: number): number | undefined {
  if (!digitValues) {
    digitValues = new Map();
    let run = 0;
    for (let cp = 0; cp <= 0x1ffff; cp++) {
      if (/\p{Nd}/u.test(String.fromCodePoint(cp))) digitValues.set(cp, run++ % 10);
      else run = 0;
    }
  }
  return digitValues.get(codePoint);
}
// A count is digits, or digits grouped by a locale's mark in a locale's
// shape: groups of three, or the Indian shape of a final group of three
// behind groups of two; no leading zero. Which marks, shapes, numeral sets,
// and minimum groupings go together is not written down here: it is read
// from this runtime's own locale data, once per process, as the set of
// locale signatures below, and a message's counts must all fit one of them.
type GroupingStyle = "western" | "indian";
type LocaleSignature = { mark: string; style: GroupingStyle; ungroupedMax: number; zero: number };
let signatures: LocaleSignature[] | undefined;
/** The number formats this runtime's locales print: grouping mark, grouping
 * style, the longest integer left ungrouped, and the numeral set's zero. */
export function localeSignatures(): LocaleSignature[] {
  if (signatures) return signatures;
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const bases: string[] = [];
  for (const a of letters) for (const b of letters) { bases.push(a + b); for (const c of letters) bases.push(a + b + c); }
  // Scripts that change a language's digits or marks (Adlam, Arabic, N'Ko,
  // ...), and regions that change its grouping.
  const scripts = ["Adlm", "Arab", "Latn", "Cyrl", "Deva", "Hans", "Hant", "Beng", "Tfng", "Vaii", "Mong", "Guru", "Thaa", "Olck", "Mtei", "Rohg",
    "Nkoo", "Hebr", "Grek", "Ethi", "Khmr", "Mymr", "Tibt", "Taml", "Telu", "Knda", "Mlym", "Sinh", "Thai", "Laoo", "Cakm", "Java", "Hmnp", "Yiii", "Cher", "Orya", "Gujr"];
  // A script variant counts only where it prints differently from its base:
  // the runtime resolves an unknown script tag to the base, so the base's
  // signature already covers it.
  const differing = (base: string) => scripts.map((script) => `${base}-${script}`)
    .filter((code) => { try { return (1234567).toLocaleString(code) !== (1234567).toLocaleString(base); } catch { return false; } });
  const codes = Intl.NumberFormat.supportedLocalesOf(bases).flatMap((base) => [base, ...differing(base)]);
  codes.push("en-IN", "hi-IN", "bn-IN", "ta-IN", "te-IN", "mr-IN", "gu-IN", "kn-IN", "ml-IN", "pa-IN", "de-CH", "fr-CH", "it-CH", "de-AT",
    "es-MX", "es-US", "es-419", "pt-PT", "pt-BR", "fr-CA", "en-ZA", "en-CA", "en-GB", "en-AU", "ar-EG", "ar-SA", "ar-MA", "fa-IR", "ur-PK",
    "zh-CN", "zh-TW", "ja-JP", "ko-KR", "ru-RU", "uk-UA", "tr-TR", "nl-BE", "nl-NL", "sv-SE", "nb-NO", "da-DK", "fi-FI", "pl-PL", "cs-CZ",
    "hu-HU", "el-GR", "he-IL", "en-US");
  const seen = new Set<string>();
  const found: LocaleSignature[] = [];
  const probes = [1000, 10000, 100000, 1000000, 10000000];
  for (const code of codes) {
    const printed = probes.map((n) => n.toLocaleString(code));
    const marks = new Set(printed.flatMap((text) => [...text].filter((char) => digitValue(char.codePointAt(0)!) === undefined)));
    if (marks.size !== 1) continue;
    const mark = [...marks][0]!;
    let ungroupedMax = 3;
    probes.forEach((n, index) => { if (!printed[index]!.includes(mark)) ungroupedMax = Math.max(ungroupedMax, String(n).length); });
    const groups = (123456789).toLocaleString(code).split(mark).map((group) => [...group].length);
    const style: GroupingStyle = groups.length > 2 && groups.slice(1, -1).every((length) => length === 2) && groups.at(-1) === 3 ? "indian" : "western";
    const zero = (0).toLocaleString(code).codePointAt(0)!;
    const key = `${mark}|${style}|${ungroupedMax}|${zero}`;
    if (!seen.has(key)) { seen.add(key); found.push({ mark, style, ungroupedMax, zero }); }
  }
  return (signatures = found);
}
/** The grouping marks the runtime's locales print, as a regular-expression class. */
function groupMarkClass(): string {
  return `[${[...new Set(localeSignatures().map((locale) => locale.mark))].map((mark) => mark.replace(/[\]\\^-]/g, "\\$&")).join("")}]`;
}
// The count's value is returned as its ASCII digits with the numeral set's
// zero (one locale prints every count in one set): a span derived from a
// huge passed-through read limit may exceed what a number holds exactly.
type LocalizedCount = { digits: string; zero: number; mark?: string; styles?: GroupingStyle[] };
/** A count fits a locale when its numeral set is the locale's and it is grouped exactly where the locale groups. */
function fitsLocale(count: LocalizedCount, locale: LocaleSignature): boolean {
  if (count.zero !== locale.zero) return false;
  if (count.mark === undefined) return count.digits.length <= locale.ungroupedMax;
  return count.mark === locale.mark && count.styles!.includes(locale.style) && count.digits.length > locale.ungroupedMax;
}
function localizedDigits(text: string): LocalizedCount | undefined {
  const chars = [...text];
  const marks = new Set(chars.filter((char) => digitValue(char.codePointAt(0)!) === undefined));
  if (marks.size > 1) return undefined;
  const mark = [...marks][0];
  if (mark !== undefined && !localeSignatures().some((locale) => locale.mark === mark)) return undefined;
  if (chars.length > 1 && digitValue(chars[0]!.codePointAt(0)!) === 0) return undefined;
  // A grouped count's shape may fit one style or both ("57,000" is Western
  // and Indian alike); the message's counts must share one.
  let styles: GroupingStyle[] | undefined;
  if (mark !== undefined) {
    const groups = text.split(mark).map((group) => [...group].length);
    if (groups.some((length) => length === 0)) return undefined;
    const western = groups[0]! <= 3 && groups.slice(1).every((length) => length === 3);
    const indian = groups.length >= 2 && groups[0]! <= 2 && groups.slice(1, -1).every((length) => length === 2) && groups.at(-1) === 3;
    if (!western && !indian) return undefined;
    styles = [...(western ? ["western" as const] : []), ...(indian ? ["indian" as const] : [])];
  }
  let digits = "";
  let zero: number | undefined;
  for (const char of chars) {
    const codePoint = char.codePointAt(0)!;
    const value = digitValue(codePoint);
    if (value === undefined) continue;
    if (zero === undefined) zero = codePoint - value;
    else if (zero !== codePoint - value) return undefined;
    digits += value;
  }
  return zero === undefined ? undefined : { digits, zero, mark, styles };
}
// toLocaleString() prints a number's shortest round-trip digits, expanded with
// zeros past 1e21 where toString() switches to an exponent.
function plainDigits(count: number): string {
  const text = count.toString();
  const exponent = /^(\d)(?:\.(\d+))?e\+(\d+)$/.exec(text);
  if (!exponent) return text;
  const mantissa = exponent[1]! + (exponent[2] ?? "");
  return mantissa.padEnd(Number(exponent[3]) + 1, "0");
}

// A message template: literal text, localized counts, and Claude's own
// numbers derived from its file-read limit (a span of characters, a chunk
// of lines). The limit may come from the child's environment, a settings
// file, or a flag, so those numbers are not predicted: a span is any count
// (or the infinity sign) printed the same wherever it recurs, a chunk any
// positive number as a template literal prints it (plain digits below 1e21,
// an exponent form above, or "Infinity"), and the message's counts and span
// share one numeral set.
type Part = string | { count: number } | { span: true } | { chunk: true };
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
type TemplateMatch = { span?: bigint | "infinite" };
function matchesTemplate(parts: Part[], actual: string): TemplateMatch | undefined {
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
function escapeLeafName(id: string): string {
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
function mcpName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return name.startsWith("claude.ai ") ? sanitized.replace(/_+/g, "_").replace(/^_|_$/g, "") : sanitized;
}
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The saved file of a capped spill is the longest prefix of whole code points
 * fitting in the cap; the cap is unknown beyond its label, so the saved byte
 * length must reach the label with the next code point left out. */
function cappedPrefix(content: string, saved: string, label: string): boolean {
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
function persistedCandidates(message: string): PersistedCandidate[] {
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
function tokenCandidates(message: string): TokenCandidate[] {
  // Bounded, greedy captures and the single split keep this linear in the message; the template match decides the values.
  const header = new RegExp(`^Error: result \\((?:\\p{Nd}|${groupMarkClass()}){1,512} characters(?: across (?:\\p{Nd}|${groupMarkClass()}){1,512} lines?)?\\) exceeds maximum allowed tokens\\. Output has been saved to `, "u").exec(message);
  if (!header) return [];
  const note = /\nNote: the output exceeded the persist byte limit; the saved file contains only the first (\d+ bytes|\d+(?:\.\d)?[KMG]B) of it and may end mid-structure \(a JSON parse of the whole file can fail\)\. Any line\/character counts or parsing recipes above describe the full output, not the truncated file\.$/.exec(message);
  const split = splitAtLine(message.slice(header[0].length), ".\nFormat: ");
  if (!split) return [];
  const line = split[1].indexOf("\n");
  return line > 0 ? [{ path: split[0], format: split[1].slice(0, line), cap: note?.[1] }] : [];
}

type Guidance = "default" | "subagent";
type TokenTemplate = { guidance: Guidance; parts: Part[]; slicing: boolean };
/** Claude Code's token-form messages for this text: each guidance template in
 * its chunked and slicing variants, since the read limit that picks one is not
 * known here. The chunked variants need more than one line; a slicing variant
 * for several lines needs a span below the longest line. */
function tokenMessages(path: string, text: string, cap: string | undefined, child: ClaudeChildProject): { templates: TokenTemplate[]; count: number; maxLen: number } {
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

type SpillKind = "token" | "persisted";
type SpillComparison =
  | { equal: true; spilled: true; spill_kind: "token"; chars: number; path: string; truncated: boolean; guidance: Guidance }
  | { equal: true; spilled: true; spill_kind: "persisted"; chars: number; path: string; truncated: boolean; preview_chars: number }
  | { equal: false; spilled: false; spill_kind?: SpillKind; spill_rejected: string };

function under(directory: string, path: string): boolean {
  const suffix = relative(directory, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function realpathOr(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}
// Claude Code 2.1.300 binary: the project directory is the cwd with every
// character outside [A-Za-z0-9] replaced by "-"; past 200 characters it is
// the first 200 plus "-" and the base-36 absolute value of a 32-bit string
// hash (h = h * 31 + code unit, as Java hashes) of the cwd itself.
export function projectName(canonicalCwd: string): string {
  const slug = canonicalCwd.replace(/[^A-Za-z0-9]/g, "-");
  if (slug.length <= 200) return slug;
  let hash = 0;
  for (let index = 0; index < canonicalCwd.length; index++) hash = ((hash << 5) - hash + canonicalCwd.charCodeAt(index)) | 0;
  return `${slug.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}
/** The working directory as Claude Code reads its own at startup: absolute, symlinks resolved, NFC. */
export function canonicalWorkingDirectory(cwd: string): string {
  return realpathOr(resolve(cwd)).normalize("NFC");
}

type Rejection = { check: string };
// `configDir` is the CHILD's Claude config directory, resolved by the adapter
// (HOME is inherited by the child; CLAUDE_CONFIG_DIR reaches it only when
// passed through), never read from codemux's own environment here. Claude
// Code resolves its own cwd (realpathSync at startup) and NFC-normalizes the
// cwd and the projects path before slugging, so the slug comes from the
// canonical, NFC-normalized working directory; a sandbox may also hand Claude
// a HOME with its symlinks resolved, so the spill path may be spelled with
// either the configured or the resolved projects directory. Containment is
// decided on resolved paths: the file's real path must lie under the real
// projects directory, at <project>/<session id>/tool-results/<name>, with
// the project component the slug names. The canonical cwd is the one taken
// when the bridge started, as Claude took its own; a working directory
// retargeted during the run does not move the project.
function verifySavedFile(path: string, expected: string, cap: string | undefined, canonicalCwd: string,
  { configDir, projectDirName }: ClaudeChildProject): Rejection | { truncated: boolean; saved: string } {
  // Claude writes the string as UTF-8, which turns a lone surrogate into
  // U+FFFD; the file is compared with that well-formed form.
  const content = expected.toWellFormed();
  if (!isAbsolute(path)) return { check: "absolute path" };
  if (!configDir || !isAbsolute(configDir) || configDir.includes("\n")) return { check: "config directory" };
  // Claude NFC-normalizes the projects path before writing. On macOS the
  // filesystem ignores normalization and realpath returns the stored form,
  // so resolved paths compare NFC-normalized there; elsewhere two spellings
  // are two directories and resolved paths compare exactly.
  const canon = (resolved: string) => process.platform === "darwin" ? resolved.normalize("NFC") : resolved;
  const projects = join(configDir, "projects");
  const projectsNfc = projects.normalize("NFC");
  const realProjects = canon(realpathOr(projectsNfc));
  if (!under(projects, path) && !under(projectsNfc, path) && !under(realProjects, canon(path))) return { check: "project directory" };
  // A passed-through CLAUDE_CODE_PROJECT_DIR_NAME replaces the slug outright.
  const expectedProject = projectDirName ?? projectName(canonicalCwd);
  const matchesSlug = (project: string) => project === expectedProject;
  let check = "real path";
  let fd: number | undefined;
  try {
    const real = realpathSync(path);
    if (!under(realProjects, canon(real))) return { check: "resolved project directory" };
    const components = relative(realProjects, canon(real)).split(sep);
    if (!matchesSlug(components[0]!)) return { check: "project directory" };
    if (components.length !== 4 || !SESSION_ID.test(components[1]!) || components[2] !== "tool-results") return { check: "tool-results directory" };
    // Claude writes a regular file; a symlink at the reported path, even one
    // resolving inside the project, is not its spill.
    check = "file stat";
    if (lstatSync(path).isSymbolicLink()) return { check: "symlink" };
    // Opened at the reported path without following a final symlink and
    // without blocking (a FIFO would otherwise stall the run). O_NOFOLLOW
    // covers the last component only, so the path is resolved again after
    // the open and must still name the checked location, and the open file
    // must be that location's inode: a parent directory swapped for a
    // symlink before the open changes the resolution, and one swapped and
    // restored around it leaves the opened inode different from the
    // location's. The read is bounded by the content's byte length, so a
    // file growing after the stat cannot be read past it.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { check: "regular file" };
    if (realpathSync(path) !== real) return { check: "file identity" };
    const resolved = statSync(real);
    if (stat.dev !== resolved.dev || stat.ino !== resolved.ino) return { check: "file identity" };
    const bound = Buffer.byteLength(content);
    if (stat.size > bound) return { check: "file size" };
    check = "file read";
    const buffer = Buffer.allocUnsafe(bound + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, bound + 1 - length, length);
      if (read === 0) break;
      length += read;
      if (length > bound) return { check: "file size" };
    }
    const saved = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
    // Claude names a cap only when it cut the file, so a complete file and a
    // cap header are as inconsistent as a prefix and no header.
    if (saved === content) return cap === undefined ? { truncated: false, saved } : { check: "truncation cap" };
    if (cap === undefined || saved.length === 0 || !content.startsWith(saved)) return { check: "file content" };
    return cappedPrefix(content, saved, cap) ? { truncated: true, saved } : { check: "truncation cap" };
  } catch { return { check }; } finally { if (fd !== undefined) closeSync(fd); }
}

// Claude Code 2.1.300 spills only past a size. The token form fires when
// its estimate, the sum over text blocks of round(chars / 4), exceeds half
// of MAX_MCP_OUTPUT_TOKENS (25,000 unless the child's environment or a
// remote flag sets it; a passed-through value is honored), for sure when it
// exceeds four times that limit, and by a tokenizer's count in between. The
// persisted form fires when the token form did not and the text blocks'
// characters exceed the tool's result cap: 50,000 for a plain tool, or the
// tool's own `_meta["anthropic/maxResultSizeChars"]` capped at 500,000 for
// an annotated one, which Claude then also exempts from the token form.
// A result that could not have taken a form is not that form's spill.
export const PERSISTED_THRESHOLD_CHARS = 50000;
const ANNOTATED_THRESHOLD_CEILING = 500000;
const DEFAULT_MCP_OUTPUT_TOKENS = 25000;
const tokenEstimate = (blocks: Block[]) => blocks.reduce((total, block) => total + Math.round((block.text as string).length / 4), 0);
type Block = { type?: unknown; text?: unknown; _meta?: unknown };
export function compareSpill(expected: unknown, actual: unknown, canonicalCwd: string, child: ClaudeChildProject,
  server: string, tool: string, toolUseId: string, resultCap = Number.POSITIVE_INFINITY): SpillComparison {
  if (typeof actual !== "string") return { equal: false, spilled: false, spill_rejected: "oversize message" };
  const blocks = Array.isArray(expected) ? expected as Block[] : [];
  const isText = (block: Block) => block?.type === "text" && typeof block.text === "string";
  // A <truncated-output> message is the persisted step's save failure: no file, no spill.
  if (actual.startsWith("<truncated-output>")) return { equal: false, spilled: false, spill_rejected: "oversize message" };
  if (actual.startsWith("<persisted-output>")) {
    // Claude persists only text blocks (an image or document block leaves
    // the result undelivered as a spill), rebuilt as {type, text}. Its MCP
    // client keeps a block's _meta on that rebuild while its remote-tool
    // path drops it, so a file is accepted in either spelling of the same
    // server blocks; the file decides.
    const candidates = persistedCandidates(actual);
    if (candidates.length === 0) return { equal: false, spilled: false, spill_rejected: "oversize message" };
    const reject = (check: string): SpillComparison => ({ equal: false, spilled: false, spill_kind: "persisted", spill_rejected: check });
    if (blocks.length === 0 || !blocks.every(isText)) return reject("text blocks");
    const annotated = Number.isFinite(resultCap);
    const tokenLimit = child.tokenLimit ?? DEFAULT_MCP_OUTPUT_TOKENS;
    const threshold = annotated ? Math.min(resultCap, ANNOTATED_THRESHOLD_CEILING) : PERSISTED_THRESHOLD_CHARS;
    if (blocks.reduce((total, block) => total + (block.text as string).length, 0) <= threshold
      || (!annotated && tokenEstimate(blocks) > tokenLimit * 4)) return reject("result size");
    const spell = (withMeta: boolean) => JSON.stringify(blocks.map((block) =>
      ({ type: "text", text: block.text, ...(withMeta && block._meta ? { _meta: block._meta } : {}) })), null, 2);
    const spellings = blocks.some((block) => block._meta) ? [spell(true), spell(false)] : [spell(false)];
    let rejection = "basename";
    for (const candidate of candidates) {
      if (basename(candidate.path) !== `${escapeLeafName(toolUseId)}.json`) continue;
      for (const file of spellings) {
        // The size label counts the JSON's characters (Claude's originalSize); a cap label counts bytes.
        if (candidate.size !== undefined && candidate.size !== persistedSizeLabel(file.length)) { rejection = "size label"; continue; }
        const verified = verifySavedFile(candidate.path, file, candidate.cap, canonicalCwd, child);
        if ("check" in verified) { rejection = verified.check; continue; }
        // Claude previews what it saved: the capped prefix when the cap was hit.
        const { preview, hasMore } = persistedPreview(verified.saved);
        if (candidate.body !== (hasMore ? `${preview}\n...` : preview)) { rejection = "preview"; continue; }
        return { equal: true, spilled: true, spill_kind: "persisted", chars: file.length, path: candidate.path, truncated: verified.truncated, preview_chars: preview.length };
      }
    }
    return reject(rejection);
  }
  const candidates = tokenCandidates(actual);
  if (candidates.length === 0) return { equal: false, spilled: false, spill_rejected: "oversize message" };
  const reject = (check: string): SpillComparison => ({ equal: false, spilled: false, spill_kind: "token", spill_rejected: check });
  // Claude drops a text block's truthy _meta, then unwraps exactly one text
  // block to its text; a block keeping a falsy _meta, or any other
  // content, is saved as JSON instead.
  if (blocks.length !== 1 || !isText(blocks[0]!) || ("_meta" in blocks[0]! && !blocks[0]!._meta)) return reject("single text block");
  const text = blocks[0]!.text as string;
  if (Number.isFinite(resultCap) || tokenEstimate(blocks) <= (child.tokenLimit ?? DEFAULT_MCP_OUTPUT_TOKENS) * 0.5) return reject("result size");
  let rejection = "plain text format";
  for (const candidate of candidates) {
    if (candidate.format !== "Plain text") continue;
    if (!new RegExp(`^mcp-${escapeRegExp(mcpName(server))}-${escapeRegExp(mcpName(tool))}-[0-9]+\\.txt$`).test(basename(candidate.path))) { rejection = "basename"; continue; }
    const { templates, count, maxLen } = tokenMessages(candidate.path, text, candidate.cap, child);
    let guidance: Guidance | undefined;
    for (const template of templates) {
      const matched = matchesTemplate(template.parts, actual);
      if (!matched) continue;
      // Claude slices a multi-line result only when its span is below the longest line.
      if (template.slicing && count > 1 && matched.span !== undefined && (matched.span === "infinite" || matched.span >= BigInt(maxLen))) continue;
      guidance = template.guidance;
    }
    if (guidance === undefined) { rejection = "guidance"; continue; }
    const verified = verifySavedFile(candidate.path, text, candidate.cap, canonicalCwd, child);
    if ("check" in verified) { rejection = verified.check; continue; }
    return { equal: true, spilled: true, spill_kind: "token", chars: text.length, path: candidate.path, truncated: verified.truncated, guidance };
  }
  return reject(rejection);
}

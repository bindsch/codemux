import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import type { ClaudeChildProject } from "./claude-family.js";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  cappedPrefix,
  escapeLeafName,
  escapeRegExp,
  matchesTemplate,
  mcpName,
  persistedCandidates,
  persistedPreview,
  persistedSizeLabel,
  tokenCandidates,
  tokenMessages,
  type Guidance,
} from "./experiment-spill/templates.js";

export { localeSignatures } from "./experiment-spill/locale.js";
export { persistedPreview, persistedSizeLabel } from "./experiment-spill/templates.js";

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
// The templates themselves, the locale-digit reading, and the message
// parsing live in experiment-spill/templates.ts and
// experiment-spill/locale.ts; this module owns the comparison and the
// saved-file verification.

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
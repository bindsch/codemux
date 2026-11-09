/** Gemini 0.60.0 ChatRecordingService appends/upserts message ids with
 * tokens {input,output,cached}; projects.json maps cwd to tmp/<slug>/chats.
 * Active chunk-M6NSK26M.js:253277,286066,286189,286252 (2026-11-09). */
import { createHash } from "node:crypto";
import { opendirSync } from "node:fs";
import { join, resolve } from "node:path";
import { readUtf8FileBounded } from "../file-io.js";
import { emptyUsage } from "../result-envelope.js";
import { reportedTokenCount, safeTokenSum } from "../result-envelope/common.js";

const GEMINI_TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024;
const GEMINI_PROJECTS_MAX_BYTES = 1024 * 1024;
const GEMINI_TRANSCRIPT_MAX_ENTRIES = 10000;
type GeminiTokenCounts = { input: number; output: number; cached: number };
type GeminiTranscript = Map<string, GeminiTokenCounts | null>;
function geminiObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** An unreadable, ambiguous, malformed, or foreign transcript is unknown.
 * No best-effort partial sum may masquerade as a complete turn count. */
export function readGeminiAcpTranscript(brandHome: string, cwd: string, sessionId: string): GeminiTranscript | null {
  try {
    const registry = JSON.parse(readUtf8FileBounded(join(brandHome, "projects.json"), {
      maxBytes: GEMINI_PROJECTS_MAX_BYTES, label: "Gemini projects", noFollow: false,
    })) as { projects?: Record<string, unknown> };
    const normalized = process.platform === "win32" ? resolve(cwd).toLowerCase() : resolve(cwd);
    const slug = registry.projects?.[normalized];
    if (typeof slug !== "string" || !/^[a-zA-Z0-9_-]+$/.test(slug)) return null;
    const chats = join(brandHome, "tmp", slug, "chats");
    const directory = opendirSync(chats);
    let selected: string | null = null;
    try {
      let count = 0;
      for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
        if (++count > GEMINI_TRANSCRIPT_MAX_ENTRIES) return null;
        if (!entry.name.startsWith("session-") || !entry.name.endsWith(`-${sessionId.slice(0, 8)}.jsonl`)) continue;
        if (!entry.isFile() || selected !== null) return null;
        selected = join(chats, entry.name);
      }
    } finally { directory.closeSync(); }
    if (selected === null) return null;
    const text = readUtf8FileBounded(selected, { maxBytes: GEMINI_TRANSCRIPT_MAX_BYTES, label: "Gemini transcript", noFollow: true });
    const lines = text.trimEnd().split("\n");
    const metadata = JSON.parse(lines.shift()!);
    if (!geminiObject(metadata) || metadata.sessionId !== sessionId ||
        metadata.projectHash !== createHash("sha256").update(cwd).digest("hex")) return null;
    const messages: GeminiTranscript = new Map();
    const accept = (message: unknown): void => {
      if (!geminiObject(message) || typeof message.id !== "string" || message.type !== "gemini") return;
      const tokens = message.tokens;
      if (!geminiObject(tokens)) { messages.set(message.id, null); return; }
      const input = reportedTokenCount(tokens.input), output = reportedTokenCount(tokens.output), cached = reportedTokenCount(tokens.cached);
      messages.set(message.id, input === null || output === null || cached === null || cached > input ? null : { input, output, cached });
    };
    for (const line of lines) {
      const record: unknown = JSON.parse(line);
      if (!geminiObject(record)) return null;
      if (geminiObject(record.$set) &&
          ((record.$set.sessionId !== undefined && record.$set.sessionId !== sessionId) ||
           (record.$set.projectHash !== undefined && record.$set.projectHash !== metadata.projectHash))) return null;
      if (geminiObject(record) && geminiObject(record.$set) && Array.isArray(record.$set.messages)) {
        messages.clear(); for (const message of record.$set.messages) accept(message);
      } else accept(record);
    }
    return messages;
  } catch { return null; }
}

export function geminiAcpTranscriptUsage(before: GeminiTranscript | null, after: GeminiTranscript | null) {
  if (before === null || after === null) return null;
  let input = 0, output = 0, cached = 0;
  let reported = false;
  for (const [id, counts] of after) {
    if (before.has(id)) continue;
    if (counts === null) return null;
    reported = true;
    input += counts.input - counts.cached; output += counts.output; cached += counts.cached;
  }
  const total = safeTokenSum(input, output, cached);
  if (!reported || total === null) return null;
  return { ...emptyUsage(), input_tokens: input, output_tokens: output, cached_input_tokens: cached, total_tokens: total };
}

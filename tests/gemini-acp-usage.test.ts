import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readGeminiAcpTranscript, geminiAcpTranscriptUsage } from "../src/session/gemini-acp-usage.js";

const geminiUsageId = "11111111-1111-4111-8111-111111111111";
function geminiTranscriptFixture() {
  const root = mkdtempSync(join(tmpdir(), "gemini-transcript-"));
  const cwd = join(root, "work"); const home = join(root, ".gemini");
  const chats = join(home, "tmp", "work", "chats"); mkdirSync(chats, { recursive: true });
  const projects = join(home, "projects.json"); writeFileSync(projects, JSON.stringify({ projects: { [cwd]: "work" } }));
  const transcript = join(chats, `session-2026-11-09T12-30-${geminiUsageId.slice(0, 8)}.jsonl`);
  writeFileSync(transcript, JSON.stringify({ sessionId: geminiUsageId, projectHash: createHash("sha256").update(cwd).digest("hex") }) + "\n");
  const append = (value: unknown) => appendFileSync(transcript, JSON.stringify(value) + "\n");
  const read = () => readGeminiAcpTranscript(home, cwd, geminiUsageId);
  return { root, cwd, home, chats, projects, transcript, append, read, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("Gemini ACP native transcript usage", () => {
  test("deduplicates native message upserts and excludes pre-prompt history", () => {
    const f = geminiTranscriptFixture();
    try {
      f.append({ id: "old", type: "gemini", tokens: { input: 100, output: 50, cached: 20 } });
      const before = f.read();
      f.append({ id: "user", type: "user", content: "prompt" });
      f.append({ id: "new", type: "gemini", tokens: null });
      f.append({ id: "new", type: "gemini", tokens: { input: 8, output: 3, cached: 2 } });
      expect(geminiAcpTranscriptUsage(before, f.read())).toEqual({ input_tokens: 6, output_tokens: 3, cached_input_tokens: 2, total_tokens: 11, cost_usd: null });
      expect(geminiAcpTranscriptUsage(f.read(), f.read())).toBeNull();
    } finally { f.cleanup(); }
  });

  test("native messages replacement is folded and unknown token counts remain unknown", () => {
    const f = geminiTranscriptFixture();
    try {
      const before = f.read();
      f.append({ $set: { messages: [{ id: "new", type: "gemini", tokens: { input: 8, output: 3, cached: 2 } }] } });
      expect(geminiAcpTranscriptUsage(before, f.read())?.total_tokens).toBe(11);
      f.append({ id: "new", type: "gemini", tokens: { input: 2, output: 3, cached: 9 } });
      expect(geminiAcpTranscriptUsage(before, f.read())).toBeNull();
      f.append({ id: "new", type: "gemini", tokens: null });
      expect(geminiAcpTranscriptUsage(before, f.read())).toBeNull();
      f.append({ id: "new", type: "gemini", tokens: { input: Number.MAX_SAFE_INTEGER, output: 3, cached: 0 } });
      expect(geminiAcpTranscriptUsage(before, f.read())).toBeNull();
      expect(geminiAcpTranscriptUsage(null, f.read())).toBeNull();
    } finally { f.cleanup(); }
  });

  test("foreign identities, malformed data, missing files, ambiguous names, and symlinks are unknown", () => {
    const f = geminiTranscriptFixture();
    try {
      expect(readGeminiAcpTranscript(f.home, f.cwd + "other", geminiUsageId)).toBeNull();
      expect(readGeminiAcpTranscript(f.home, f.cwd, "11111111-other-session")).toBeNull();
      const duplicate = join(f.chats, `session-other-${geminiUsageId.slice(0, 8)}.jsonl`);
      symlinkSync(f.transcript, duplicate); expect(f.read()).toBeNull(); rmSync(duplicate);
      writeFileSync(duplicate, "{}"); expect(f.read()).toBeNull(); rmSync(duplicate);
      f.append("bad record"); expect(f.read()).toBeNull();
      appendFileSync(f.transcript, "truncated{"); expect(f.read()).toBeNull();
      writeFileSync(f.projects, JSON.stringify({ projects: { [f.cwd]: "../escape" } })); expect(f.read()).toBeNull();
      writeFileSync(f.projects, "{"); expect(f.read()).toBeNull();
    } finally { f.cleanup(); }
  });
});

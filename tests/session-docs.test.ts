import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeSessionCapabilities, CLAUDE_SESSION_FLOOR } from "../src/session/claude-session.js";
import { zaiSessionCapabilities, ZAI_SESSION_FLOOR } from "../src/session/zai-session.js";
import { codexSessionCapabilities, CODEX_SESSION_FLOOR } from "../src/session/codex-session.js";
import { agySessionCapabilities, AGY_SESSION_FLOOR } from "../src/session/agy-session.js";
import { opencodeSessionCapabilities, OPENCODE_SESSION_FLOOR } from "../src/session/opencode-session.js";
import { aiderSessionCapabilities, AIDER_SESSION_FLOOR } from "../src/session/aider-session.js";
import { kimiSessionCapabilities, KIMI_SESSION_FLOOR } from "../src/session/kimi-session.js";
import { cursorSessionCapabilities, CURSOR_SESSION_FLOOR } from "../src/session/cursor-session.js";
import { droidSessionCapabilities, DROID_SESSION_FLOOR } from "../src/session/droid-session.js";
import { piSessionCapabilities, PI_SESSION_FLOOR } from "../src/session/pi-session.js";
import { qwenSessionCapabilities, QWEN_SESSION_FLOOR } from "../src/session/qwen-session.js";
import { geminiSessionCapabilities, GEMINI_SESSION_FLOOR } from "../src/session/gemini-session.js";
import { copilotSessionCapabilities, COPILOT_SESSION_FLOOR } from "../src/session/copilot-session.js";
import { gooseSessionCapabilities, GOOSE_SESSION_FLOOR } from "../src/session/goose-session.js";
import { MAX_INPUT_TEXT_BYTES, MAX_AUTHOR_CODEPOINTS, MAX_REASON_CHARS, MAX_ID_CHARS } from "../src/session/protocol.js";
import { MAX_HARNESS_LINE_BYTES, MAX_INPUT_LINE_BYTES, MAX_PENDING_EVENTS, MAX_PENDING_EVENT_BYTES } from "../src/session/process.js";

const read = (path: string): string => readFileSync(join(import.meta.dir, "..", path), "utf8");
const guide = read("docs/sessions.md");
const protocol = read("docs/session-protocol.md");
const historical = read("docs/archive/LIVE-SESSIONS-DESIGN.md");

const agents = [
  ["claude", CLAUDE_SESSION_FLOOR, claudeSessionCapabilities],
  ["zai", ZAI_SESSION_FLOOR, zaiSessionCapabilities],
  ["codex", CODEX_SESSION_FLOOR, codexSessionCapabilities],
  ["agy", AGY_SESSION_FLOOR, agySessionCapabilities],
  ["opencode", OPENCODE_SESSION_FLOOR, opencodeSessionCapabilities],
  ["aider", AIDER_SESSION_FLOOR, aiderSessionCapabilities],
  ["kimi", KIMI_SESSION_FLOOR, kimiSessionCapabilities],
  ["cursor", CURSOR_SESSION_FLOOR, cursorSessionCapabilities],
  ["droid", DROID_SESSION_FLOOR, droidSessionCapabilities],
  ["pi", PI_SESSION_FLOOR, piSessionCapabilities],
  ["qwen", QWEN_SESSION_FLOOR, qwenSessionCapabilities],
  ["gemini", GEMINI_SESSION_FLOOR, geminiSessionCapabilities],
  ["copilot", COPILOT_SESSION_FLOOR, copilotSessionCapabilities],
  ["goose", GOOSE_SESSION_FLOOR, gooseSessionCapabilities],
] as const;

describe("published session contract", () => {
  test.each(agents)("%s capability row agrees with the driver", (agent, floor, capabilities) => {
    const caps = capabilities();
    const yesNo = (value: boolean): string => value ? "yes" : "no";
    const expected = [
      agent, floor, caps.user_during_turn === "queue" ? "queued" : "rejected",
      yesNo(caps.steer), yesNo(caps.interrupt), yesNo(caps.permissions),
      yesNo(caps.deltas), caps.file_changes || "no", yesNo(caps.usage_stream),
    ];
    const row = guide.split("\n").find((line) => line.startsWith("| `" + agent + "` |"));
    expect(row).toBeDefined();
    expect(row!.split("|").slice(1, -1).map((cell) => cell.trim().replaceAll("`", ""))).toEqual(expected);
    expect(caps.live_input).toBe(true);
    expect(caps.resume).toBe(true);
  });

  test("the protocol documents every emitted event and rejection reason", () => {
    const source = read("src/session/protocol.ts");
    for (const name of ["EventName", "InputRejectionReason"]) {
      const declaration = source.match(new RegExp("export type " + name + " =([\\s\\S]*?);"));
      expect(declaration).not.toBeNull();
      const values = [...declaration![1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) expect(protocol).toContain("| `" + value + "` |");
    }
  });

  test("the documented framing and queue bounds match public constants", () => {
    const mib = (bytes: number): string => bytes / (1024 * 1024) + " MiB";
    for (const bytes of [MAX_INPUT_TEXT_BYTES, MAX_INPUT_LINE_BYTES, MAX_HARNESS_LINE_BYTES, MAX_PENDING_EVENT_BYTES]) {
      expect(protocol).toContain(mib(bytes));
    }
    expect(protocol).toContain(MAX_PENDING_EVENTS + " ordinary events");
    expect(protocol).toContain("1–" + MAX_AUTHOR_CODEPOINTS + " Unicode code points");
    expect(protocol).toContain(MAX_REASON_CHARS + " UTF-16 code units");
    expect(protocol).toContain("1–" + MAX_ID_CHARS + " UTF-16 code units");
  });

  test("current entry points link the operational and wire references", () => {
    // The archived design doc links one level deeper (../) after the move
    // under docs/archive/, so each page expects its own relative form.
    const pages: [string, string][] = [
      ["docs/architecture.md", ""],
      ["docs/archive/LIVE-SESSIONS-DESIGN.md", "../"],
    ];
    for (const [path, depth] of pages) {
      expect(read(path)).toContain("(" + depth + "sessions.md)");
      expect(read(path)).toContain("(" + depth + "session-protocol.md)");
    }
    expect(guide).toContain("(results-and-usage.md)");
    expect(protocol).toContain("(results-and-usage.md)");
  });

  test("the historical summary preserves the unrun probe and unavailable scratch limits", () => {
    expect(historical).toMatch(/probe 6[\s\S]*?not run/i);
    expect(historical).toContain("scratch/probes/");
    expect(historical).toContain("unavailable in");
    expect(historical).toContain("../tests/fixtures/live/README.md");
  });
});

// These implementation ordering checks predate the reference rewrite.
// Keep the security/lifecycle invariants without pinning comments or review labels.
describe("session lifecycle source invariants", () => {
  const before = (path: string, first: string, second: string): void => {
    const source = read(path);
    const firstIndex = source.indexOf(first);
    const secondIndex = source.indexOf(second);
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThanOrEqual(0);
    expect(firstIndex).toBeLessThan(secondIndex);
  };

  test("Aider validates history ownership before creating directories", () => {
    before("src/session/aider-session.ts",
      "assertOwnedHistoryChain(historyPath, true)", "mkdirSync(sessionDir");
  });

  test("Aider revalidates history before spawning each turn", () => {
    before("src/session/aider-driver.ts",
      "assertAiderHistoryForTurn(this.options.historyPath)", "this.options.spawnTurn(argv,");
  });

  test("Codex settles provider state before releasing registry ownership", () => {
    before("src/session/codex-driver.ts",
      "this.options.settleSessionHome(this.threadId, resumable)",
      "releaseSessionRecord(this.options.registryPath, this.threadId)");
    expect(read("src/session/codex-driver.ts")).toContain("resumable: resumable && settledHome");
  });

  test("Aider reads a turn delta instead of the full accumulated history", () => {
    // The driver is one class split across a chain of files, and a
    // refactor may move a member between them; the invariant holds over
    // the chain as a whole, not over whichever file holds the read today.
    const chain = [
      "src/session/aider-driver.ts",
      "src/session/aider-turns.ts",
      "src/session/aider-input.ts",
      "src/session/aider-finalize.ts",
    ].map(read).join("\n");
    expect(chain).toContain("readAiderHistoryDelta(this.options.historyPath, this.consumedBytes)");
    expect(chain).not.toContain("readAiderHistory(this.options.historyPath)");
  });

  test("OpenCode sums turn cost instead of adopting a lifetime cost", () => {
    const driver = read("src/session/opencode-driver.ts");
    expect(driver).toContain("addUsage(this.cumulative, usage)");
    expect(driver).not.toContain("addTurnUsage(this.cumulative");
  });
});

/** The unanswered-prompt rule as a unit table (review round 162, finding
 * 1): which history deltas record the turn's prompt with no reply. The
 * end-to-end consequences — the failed turn, the non-resumable session
 * end — live in tests/session-aider-e2e-unanswered.test.ts; this table
 * pins the parser-level shapes the e2e scenarios stand on. */

import { describe, expect, test } from "bun:test";
import {
  aiderDeltaRecordsUnansweredPrompt,
  aiderHistoryHeader,
} from "../src/aider-history-text.js";

describe("the unanswered-prompt rule over a turn's delta", () => {
  const prompt = "fix the parser";
  const header = aiderHistoryHeader(prompt);

  test("prompt-only deltas are unanswered whatever wraps them", () => {
    // The banner every process start writes sits ahead of the block.
    const banner = "\n# aider chat started at 2026-11-06 04:00:00\n\n";
    expect(aiderDeltaRecordsUnansweredPrompt(banner + header, prompt)).toBe(true);
    expect(aiderDeltaRecordsUnansweredPrompt(header, prompt)).toBe(true);
    // Tool chatter blockquotes after the header are not a reply either.
    expect(aiderDeltaRecordsUnansweredPrompt(`${header}\n> Running tests\n`, prompt)).toBe(true);
    // A model reply made only of blockquote lines is written exactly
    // like tool chatter, and aider's own restore parser drops it as
    // tool output: the next process would see the prompt unanswered, so
    // the rule says so too (review round 166).
    expect(aiderDeltaRecordsUnansweredPrompt(`${header}\n> quoted answer\n\n`, prompt)).toBe(true);
    // The same holds for the other two shapes aider's parser never
    // restores as assistant text (review round 167): `# ` lines are
    // skipped and `#### ` lines are read as user text.
    expect(aiderDeltaRecordsUnansweredPrompt(`${header}\n# Answer\n\n`, prompt)).toBe(true);
    expect(aiderDeltaRecordsUnansweredPrompt(`${header}\n#### Answer\n\n`, prompt)).toBe(true);
    // Whitespace alone is no message, in Python's sense of whitespace.
    expect(aiderDeltaRecordsUnansweredPrompt(`${header}\n \t\x1f\x85\n\n`, prompt)).toBe(true);
  });

  test("deltas with an assistant block, or with no exchange, are not unanswered", () => {
    expect(aiderDeltaRecordsUnansweredPrompt(`${header}\nDone\n\n`, prompt)).toBe(false);
    // No `#### ` at all: nothing was written, the "records no exchange"
    // case — not this rule's refusal.
    expect(aiderDeltaRecordsUnansweredPrompt("\n# aider chat started\n\n", prompt)).toBe(false);
    // A reply that is nothing but a leading thinking block has no text
    // for the caller, but aider recorded an assistant block and restores
    // it: the prompt is answered in the history (review round 163).
    const thinking =
      "<thinking-content-0123abcd>\nlet me think\n</thinking-content-0123abcd>";
    expect(aiderDeltaRecordsUnansweredPrompt(`${header}\n${thinking}\n\n`, prompt)).toBe(false);
    expect(aiderDeltaRecordsUnansweredPrompt(`#### altered\n${thinking}\n\n`, prompt)).toBe(false);
    // The fallback anchor (the harness wrote the prompt back altered)
    // follows the same rule in both directions.
    expect(aiderDeltaRecordsUnansweredPrompt("#### altered\n> chatter\n", prompt)).toBe(true);
    expect(aiderDeltaRecordsUnansweredPrompt("#### altered", prompt)).toBe(true);
    // Aider's parser takes only `> ` and `# ` WITH the space as its own
    // marks: `>quoted`, `#Answer`, and `#####` lines are assistant text.
    expect(aiderDeltaRecordsUnansweredPrompt(`${header}\n>quoted\n\n`, prompt)).toBe(false);
    expect(aiderDeltaRecordsUnansweredPrompt(`${header}\n#Answer\n\n`, prompt)).toBe(false);
    expect(aiderDeltaRecordsUnansweredPrompt(`${header}\n##### five\n\n`, prompt)).toBe(false);
    // One line of plain text beside a quote is an assistant block, and
    // so is text after a form feed, which Python treats as a line break.
    expect(aiderDeltaRecordsUnansweredPrompt(`${header}\nSee:\n> quoted answer\n\n`, prompt)).toBe(false);
    expect(aiderDeltaRecordsUnansweredPrompt(`${header}\n> chatter\fDone\n`, prompt)).toBe(false);
    // The same block followed by the answer is answered.
    expect(aiderDeltaRecordsUnansweredPrompt(`${header}\n${thinking}\nDone\n\n`, prompt)).toBe(false);
  });
});

/** The reply-extraction text rules as a unit table (review round 331):
 * which lines are tool chatter and which reasoning blocks strip, both
 * matching aider's own parser marks exactly. An answer line the rule
 * misreads as chatter is discarded, and a discarded line could have carried
 * the text an exact-answer check refuses — so the rule decides what the
 * isolation check certifies. */

import { describe, expect, test } from "bun:test";
import { aiderDeltaRecordsUnansweredPrompt, extractAiderReply } from "../src/aider-history-text.js";

describe("tool-chatter lines in the reply extraction", () => {
  const history = (body: string): string =>
    "# Aider chat conversation\n\n" + body;

  test("a > line without the space is assistant text, not tool output", () => {
    // Aider's own parser reads only `> ` as tool output (round 372: a bare
    // `>` is assistant text too, as the restore mirror reads it);
    // `>unexpected` is text the model wrote. Reading every `>`-prefixed
    // line as chatter reduced this answer to "OK" and passed an
    // exact-answer check over discarded assistant text (round 331).
    expect(extractAiderReply(history("#### q\n\n>unexpected\nOK\n")))
      .toBe(">unexpected\nOK");
  });

  test("> chatter before the answer is skipped; a bare > line is the answer (round 372, item 12)", () => {
    // A bare `>` is assistant text, so it STARTS the answer here and the
    // next `> `-with-space line ends it: the extraction is ">" — the
    // same text aider's restore parser keeps. Round 331 read the bare
    // line as chatter and extracted "OK", discarding a line the exact-
    // answer check must see.
    expect(
      extractAiderReply(history("#### q\n\n> Added a file\n>\n> Repo-map: off\n\nOK\n"))
    ).toBe(">");
    expect(
      extractAiderReply(history("#### q\n\n> Added a file\n> Repo-map: off\n\nOK\n"))
    ).toBe("OK");
  });

  test("a bare > line is assistant text, as the restore mirror reads it (round 372, item 12)", () => {
    // Aider's restore parser skips only `> `-with-space lines; a bare `>`
    // restores as assistant text. Extraction dropped it, so a reply that
    // was exactly ">" extracted as "" while the resumability verdict said
    // the prompt was answered — the two functions disagreed on the same
    // input. The mirror's rule (aider's own) now decides both.
    expect(extractAiderReply(history("#### q\n\n>\n"))).toBe(">");
    expect(aiderDeltaRecordsUnansweredPrompt("#### q\n\n>\n", "q")).toBe(false);
  });

  test("a > line without the space after the answer stays in the answer", () => {
    // Only `> ` ends the answer (round 372); a `>`-without-space line is
    // text the model wrote, and dropping it would trim a tail the
    // exact-answer check must see.
    expect(extractAiderReply(history("#### q\n\nOK\n>unexpected tail\n")))
      .toBe("OK\n>unexpected tail");
  });
});

describe("the leading reasoning block", () => {
  const history = (body: string): string =>
    "# Aider chat conversation\n\n" + body;

  test("mismatched opening and closing identifiers are not stripped", () => {
    // Both spellings are valid identifiers, so only the pair rule catches
    // the mismatch: stripping here would again reduce the answer to "OK"
    // (round 331).
    expect(
      extractAiderReply(
        history("#### q\n\n<thinking-content-aaa>unexpected</thinking-content-bbb>\nOK\n")
      )
    ).toBe("<thinking-content-aaa>unexpected</thinking-content-bbb>\nOK");
  });

  test("matching identifiers still strip the block", () => {
    expect(
      extractAiderReply(
        history("#### q\n\n<thinking-content-aaa>reasoning</thinking-content-aaa>\nOK\n")
      )
    ).toBe("OK");
  });
});

import { describe, expect, test } from "bun:test";
import { CodexPlainFold, codexPlainStreamResult } from "../src/plain-unwrap.js";
import { codexWarningNoteBytes, emptyUsage } from "../src/result-envelope.js";
import { MAX_CAPTURE_BYTES } from "../src/process-runner.js";
import {
  agentMessage,
  codexFoldStream,
  completeStream,
  finished,
  FULL_BLOCK,
  rerouteItem,
  THREAD,
  toolItem,
  turnCompleted,
  turnFailed,
  turnStarted,
  USAGE_FULL,
  warningItem,
  WARNING_TEXT,
} from "./helpers/plain-unwrap.js";

const foldStream = codexFoldStream;

describe("CodexPlainFold", () => {
  // The streaming sink the launcher feeds instead of capturing the whole
  // `--json` event stream (0.12.0, the ul3 fix). The builders mirror the
  // wire grammar the whole-capture parse pins (result-envelope.test.ts);
  // the fold and codexPlainStreamResult share one reduction and one
  // verdict, so the drift grammar itself is covered there.

  test("the fold keeps the reply and the usage snapshot while the tool events are dropped as they arrive (ul3)", () => {
    // The finding's shape: a plain run's `--json` stream carries every
    // tool's output, so capturing it whole dies at exit 125. The fold
    // keeps only the final-message candidate, the last usage snapshot,
    // and the served model.
    const fold = new CodexPlainFold();
    fold.push(THREAD + "\n" + turnStarted() + "\n");
    const blob = "x".repeat(1024 * 1024);
    for (let i = 0; i < 20; i++) fold.push(toolItem(blob) + "\n");
    fold.push(agentMessage("the reply") + "\n");
    fold.push(turnCompleted(USAGE_FULL) + "\n");
    expect(fold.keptBytes()).toBeLessThan(1024); // 20 MiB streamed, ~0 kept
    const out = fold.verdict(finished(""));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("the reply\n");
    expect(out.usage).toEqual(FULL_BLOCK);
    expect(out.servedModel).toBeNull();
  });

  test("the reply is human mode's byte for byte: interior newlines kept, exactly one trailing newline added, always (al11)", () => {
    expect(foldStream(completeStream("line one\nline two")).verdict(finished("")).stdout)
      .toBe("line one\nline two\n");
    // The pinned processor prints the message with println! (rust-v0.160.1
    // event_processor_with_human_output.rs), which appends its own
    // newline whatever the message ends with: a message already
    // terminated gains a second (al11 — al10's spelling kept it at one),
    // and a whitespace-only message keeps its bytes too (below).
    expect(foldStream(completeStream("already terminated\n")).verdict(finished("")).stdout)
      .toBe("already terminated\n\n");
    // A whitespace-only agent_message prints its bytes and the newline,
    // never the emptied string al10 printed.
    expect(foldStream(completeStream("  \n")).verdict(finished("")).stdout)
      .toBe("  \n\n");
  });

  test("a rerouted model is the served model, and the note says who served the run", () => {
    const stream = [
      THREAD,
      turnStarted(),
      rerouteItem("gpt-5.1", "gpt-5.2", "model unavailable"),
      agentMessage("the reply"),
      turnCompleted(USAGE_FULL),
    ].join("\n") + "\n";
    const out = foldStream(stream).verdict(finished(""));
    expect(out.success).toBe(true);
    expect(out.servedModel).toBe("gpt-5.2");
    expect(out.stderr).toContain("served by gpt-5.2");
  });

  test("a completed error item that is not a reroute is a warning on stderr; the success is untouched (al22)", () => {
    // The correctness minor: codex reports configuration and runtime
    // warnings as completed error items the turn survives, and human mode
    // printed each message on stderr. The reduction read reroute notices
    // alone, so a warning followed by a completed reply exited 0 with
    // empty stderr — a fact codemux had seen went unreported where human
    // mode reported it. Every non-reroute message now rides stderr beside
    // the reply, one note per warning, and the verdict keeps its shape.
    const stream = [
      THREAD,
      turnStarted(),
      warningItem(),
      agentMessage("the reply"),
      turnCompleted(USAGE_FULL),
    ].join("\n") + "\n";
    const out = foldStream(stream).verdict(finished(""));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("the reply\n");
    expect(out.usage).toEqual(FULL_BLOCK);
    expect(out.stderr).toContain(`codemux: codex warning: ${WARNING_TEXT}`);
    // The streamed fold and the whole-capture replay share one reduction,
    // so both report the warning identically.
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));

    // A reroute beside the warning stays what it was — the served-model
    // note — never a second warning.
    const both = [
      THREAD,
      turnStarted(),
      warningItem(),
      rerouteItem("gpt-5.1", "gpt-5.2", "model unavailable"),
      agentMessage("the reply"),
      turnCompleted(USAGE_FULL),
    ].join("\n") + "\n";
    const bothOut = foldStream(both).verdict(finished(""));
    expect(bothOut.success).toBe(true);
    expect(bothOut.servedModel).toBe("gpt-5.2");
    expect(bothOut.stderr).toContain(`codemux: codex warning: ${WARNING_TEXT}`);
    expect(bothOut.stderr).toContain("served by gpt-5.2");

    // The kept bytes measure the warning's residue (ul7's rule): what is
    // kept is measured, and the warning is kept. The text is all-ASCII, so
    // its length is its UTF-8 byte count.
    const before = new CodexPlainFold();
    before.push(completeStream("the reply"));
    const after = new CodexPlainFold();
    after.push(stream);
    expect(after.keptBytes() - before.keptBytes()).toBeGreaterThanOrEqual(WARNING_TEXT.length);
  });

  test("every retained warning costs its rendered note: a flood of empty warnings trips the capture bound (al23, al29)", () => {
    // The edges major: takeWarning booked only the message bytes, so an
    // empty warning cost nothing while staying retained — 10,000 of them
    // left keptBytes() at 0 and the capture bound could never trip, though
    // the verdict prints one prefixed stderr line per warning and the
    // residue grows without bound. The value accounting's unit is the
    // note the verdict prints — prefix, message, newline — so an empty
    // message still costs its prefix (round al29; the al28 rule it
    // replaces booked the whole wire line, envelope included, which also
    // covered an empty message but never gave superseded bytes back).
    const emptyWarningItem = (): string =>
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_3", type: "error", message: "" },
      });
    // The per-warning cost is its rendered note — the value accounting's
    // unit (round al29).
    const perWarning = codexWarningNoteBytes("");

    // One empty warning in a completed stream: the note prints (empty
    // message, prefix and all), and the kept bytes grow by the line.
    const stream = [
      THREAD,
      turnStarted(),
      emptyWarningItem(),
      agentMessage("the reply"),
      turnCompleted(USAGE_FULL),
    ].join("\n") + "\n";
    const out = foldStream(stream).verdict(finished(""));
    expect(out.success).toBe(true);
    expect(out.stderr).toContain("codemux: codex warning: ");
    const before = new CodexPlainFold();
    before.push(completeStream("the reply"));
    const after = new CodexPlainFold();
    after.push(stream);
    expect(after.keptBytes() - before.keptBytes()).toBe(perWarning);

    // The flood: enough empty warnings that their lines alone pass the
    // capture bound — the runner's check (keptBytes() > the bound) fails
    // the run at the limit instead of retaining an unmeasured list.
    const count = Math.ceil((MAX_CAPTURE_BYTES + 1) / perWarning);
    const fold = new CodexPlainFold();
    fold.push(THREAD + "\n" + turnStarted() + "\n");
    const batch = (emptyWarningItem() + "\n").repeat(1_000);
    for (let i = 0; i < count; i += 1_000) fold.push(batch);
    expect(fold.keptBytes()).toBeGreaterThan(MAX_CAPTURE_BYTES);
  });

  test("a retained failure message costs its bytes: a MiB-scale warning and error trip the capture bound together (al25)", () => {
    // The correctness minor: every failure arm of the verdict renders the
    // retained failure message on stderr, but keptBytes() counted only
    // warnings — the review's stream of a 9 MiB warning plus a 9 MiB
    // error event reported ~9.4 MB retained while the verdict emitted
    // ~18.9 MB of stderr. The failure message books its bytes exactly
    // like a warning's note now, so the finding's own shape crosses the
    // capture bound here. Each line is under the per-line bound, so the
    // oversized-drop paths never fire.
    const big = "w".repeat(9 * 1024 * 1024);
    const fold = new CodexPlainFold();
    fold.push(THREAD + "\n" + turnStarted() + "\n");
    fold.push(
      JSON.stringify({ type: "item.completed", item: { id: "w0", type: "error", message: big } }) +
        "\n"
    );
    // Before the error event the warning alone is under the bound; the
    // error's retained message is what must push the residue over it.
    expect(fold.keptBytes()).toBeLessThan(MAX_CAPTURE_BYTES);
    fold.push(JSON.stringify({ type: "error", message: big }) + "\n");
    expect(fold.keptBytes()).toBeGreaterThan(MAX_CAPTURE_BYTES);
    // The verdict reports both retained messages on stderr — the warning
    // note beside the failure's own diagnostic.
    const out = fold.verdict(finished(""));
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("codemux: codex warning: ");
    expect(out.stderr.length).toBeGreaterThan(2 * 9 * 1024 * 1024);
  });

  test("a superseded message gives its bytes back: three 6 MiB replies stay under the bound (al29)", () => {
    // The correctness major's shape: the al28 rule added every retained
    // line's whole bytes and never subtracted the value a later line
    // replaced, so three distinct 6 MiB agent messages — only the last
    // retained — booked ~18 MiB and tripped the 16 MiB bound the process
    // runner kills on, losing a stream whose actual residue was one 6 MiB
    // reply. The value delta subtracts the superseded message's bytes
    // when the replacement sets its own, so retainedBytes reads what the
    // reduction holds NOW.
    const big = (tag: string): string => agentMessage(tag.repeat(6 * 1024 * 1024));
    const stream =
      [THREAD, turnStarted(), big("a"), big("b"), big("c"), turnCompleted(USAGE_FULL)].join("\n") +
      "\n";
    for (const [label, size] of [
      ["whole", stream.length],
      ["64 KiB", 64 * 1024],
    ] as const) {
      const fold = new CodexPlainFold();
      let over = false;
      for (let at = 0; at < stream.length; at += size) {
        fold.push(stream.slice(at, at + size));
        if (fold.keptBytes() > MAX_CAPTURE_BYTES) over = true; // the runner's poll
      }
      expect(over, label).toBe(false);
      expect(fold.keptBytes(), label).toBeLessThan(MAX_CAPTURE_BYTES);
      const out = fold.verdict(finished(""));
      expect(out.success, label).toBe(true);
      expect(out.stdout, label).toBe("c".repeat(6 * 1024 * 1024) + "\n");
      expect(out.usage, label).toEqual(FULL_BLOCK);
    }
    // The whole-capture replay answers the same success.
    expect(codexPlainStreamResult(finished(stream)).success).toBe(true);
  });

  test("32 progressively larger replies that each fit keep the residue under the bound (al29)", () => {
    // The property the value accounting buys: a stream may replace its
    // retained message any number of times — here one turn whose reply
    // candidate grows message by message, every message superseding the
    // last — and the residue tracks the values held NOW, never the sum
    // of every line that ever set one. 32 messages, each 320 KiB larger
    // than the last (the largest 10 MiB, every line under the per-line
    // bound), total ~165 MiB on the wire: the al28 line accounting had
    // booked all of it and died at exit 125, while the largest single
    // value stays under the bound by 6 MiB. The chunking-invariance
    // property (al28's test above) holds with it: the verdict is a
    // function of the completed lines alone.
    const lines: string[] = [THREAD, turnStarted()];
    for (let i = 1; i <= 32; i++) {
      lines.push(agentMessage("r".repeat(i * 320 * 1024)));
    }
    lines.push(turnCompleted(USAGE_FULL));
    const stream = lines.join("\n") + "\n";
    let over = false;
    const fold = new CodexPlainFold();
    for (let at = 0; at < stream.length; at += 64 * 1024) {
      fold.push(stream.slice(at, at + 64 * 1024));
      if (fold.keptBytes() > MAX_CAPTURE_BYTES) over = true; // the runner's poll
    }
    expect(over).toBe(false);
    expect(fold.keptBytes()).toBeLessThan(MAX_CAPTURE_BYTES);
    const out = fold.verdict(finished(""));
    expect(out.success).toBe(true);
    expect(out.stdout).toBe("r".repeat(32 * 320 * 1024) + "\n");
    expect(out.usage).toEqual(FULL_BLOCK);
    // And the whole-capture replay — one push — answers identically.
    expect(codexPlainStreamResult(finished(stream))).toEqual(out);
  }, 60_000);

  test("a turn.failed releases the reply it discards: a 9 MiB message before an 8 MiB failure stays under the bound (al31)", () => {
    // The correctness major: a failed turn's clearing of its assistant
    // message lived in toStream() alone, so the plain fold's per-event
    // accounting never saw the give-back — a stream whose last turn
    // failed booked the superseded 9 MiB message AND the 8 MiB failure
    // text and the runner killed the run at the capture limit, losing
    // the failure the caller was owed. The release at the event lets the
    // delta see it: the residue is the failure text the verdict actually
    // retains, and the run fails at exit 1 with codex's own text.
    const reply = "a".repeat(9 * 1024 * 1024);
    const failure = "f".repeat(8 * 1024 * 1024);
    const stream =
      [THREAD, turnStarted(), agentMessage(reply), turnFailed(failure)].join("\n") + "\n";
    const fold = new CodexPlainFold();
    let over = false;
    for (let at = 0; at < stream.length; at += 64 * 1024) {
      fold.push(stream.slice(at, at + 64 * 1024));
      if (fold.keptBytes() > MAX_CAPTURE_BYTES) over = true; // the runner's poll
    }
    expect(over).toBe(false);
    expect(fold.keptBytes()).toBeLessThan(MAX_CAPTURE_BYTES);
    const out = fold.verdict(finished(""));
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1); // the failure's verdict, never the limit's 125
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain(failure);
    expect(out.usage).toEqual(emptyUsage());
    // The whole-capture replay shares the reduction and the verdict.
    expect(codexPlainStreamResult(finished(stream)).exitCode).toBe(1);
  }, 60_000);

  test("an oversized human-mode line is accounted before it is discarded: the latch and the partial output both stand (al31, al37)", () => {
    // The correctness major's other half: an oversized line in human
    // mode tripped the latch but never joined raw, so the capture-limit
    // result carried only what preceded the line — while the
    // whole-stream capture the fold stands in for returns the first
    // bytes it could hold as its partial output. The bounded prefix of
    // the line joins raw before the discard now: keptBytes reports the
    // latch (MAX_CAPTURE_BYTES + 1, what the runner kills on) and
    // finish() returns the same partial output the whole-capture path
    // would have. al37 scopes the arm to a stream human mode has
    // already DECIDED — the regime is committed only by a line read
    // whole, so an oversized FIRST line commits nothing and retains
    // nothing.
    const line = "y".repeat(MAX_CAPTURE_BYTES + 1); // ASCII: bytes are chars
    const undecided = new CodexPlainFold();
    undecided.push(line + "\n");
    expect(undecided.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1); // the latch
    expect((undecided as unknown as { state: { mode: string | null } }).state.mode).toBeNull();
    expect(undecided.finish()).toBe(""); // no prefix on an undecided regime

    const fold = new CodexPlainFold();
    fold.push("plain\n"); // a small line read whole decides human mode
    fold.push(line + "\n");
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1); // the latch
    const partial = fold.finish();
    // All-ASCII, so the string length is the byte count: the whole line,
    // then the prefix the room beside the drop note held — near the
    // bound, never over it, and no newline from the discarded tail.
    expect(partial.startsWith("plain\n")).toBe(true);
    expect(partial.length).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
    expect(partial.length).toBeGreaterThan(MAX_CAPTURE_BYTES - 512);
    expect(partial.slice("plain\n".length).startsWith("y")).toBe(true);
    expect(partial.includes("\n", "plain\n".length)).toBe(false);
  }, 30_000);

});

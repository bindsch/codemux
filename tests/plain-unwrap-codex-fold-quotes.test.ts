import { describe, expect, test } from "bun:test";
import { codexPlainResult, codexPlainStreamResult } from "../src/plain-unwrap.js";
import { emptyUsage, parseCodexEventStream } from "../src/result-envelope.js";
import {
  agentMessage,
  codexFoldStream,
  finished,
  THREAD,
  turnCompleted,
  turnFailed,
  turnStarted,
  USAGE_FULL,
} from "./helpers/plain-unwrap.js";

const foldStream = codexFoldStream;

describe("CodexPlainFold", () => {
  // The streaming sink the launcher feeds instead of capturing the whole
  // `--json` event stream (0.12.0, the ul3 fix). The builders mirror the
  // wire grammar the whole-capture parse pins (result-envelope.test.ts);
  // the fold and codexPlainStreamResult share one reduction and one
  // verdict, so the drift grammar itself is covered there.

  test("a reply quoting the thread.started announcement passes through with exit 0 (al24)", () => {
    // The edges major: the hatch closed on ANY line that parsed as the
    // announcement, and the grammar puts thread.started first, so a
    // human-mode reply quoting the event — a code block showing it, prose
    // around it — lost its whole stdout to the banner drift and the run
    // exited 1. The announcement now closes the hatch only when no reply
    // text preceded it; a quote leaves the hatch open, and prose AFTER it
    // settles the run as the hatch's — the opencode fold's answer, where
    // lines that are not the wire beside event lines never lose the run.
    const quote = [
      "The stream opens with this event:",
      "",
      "```",
      THREAD,
      "```",
      "",
      "That is all you need.",
    ].join("\n") + "\n";
    const out = foldStream(quote).verdict(finished(quote));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(quote);
    expect(out).toEqual(codexPlainResult(finished(quote)));
    // The streaming fold and the whole-capture replay share the one rule.
    expect(out).toEqual(codexPlainStreamResult(finished(quote)));

    // The single-line quote shapes: the JSON inside a quoted string, and a
    // line with leading text. Neither parses as an event object, so both
    // were already the hatch's; pinned here beside the shape that was not.
    for (const stream of [
      '"{\\"type\\":\\"thread.started\\",\\"thread_id\\":\\"x\\"}"\n',
      `Here it is: ${THREAD} on one line.\n`,
    ]) {
      const single = foldStream(stream).verdict(finished(stream));
      expect(single.success, stream).toBe(true);
      expect(single.exitCode, stream).toBe(0);
      expect(single.stdout, stream).toBe(stream);
      expect(single, stream).toEqual(codexPlainStreamResult(finished(stream)));
    }

    // A quote can carry event lines too — the reply quotes the stream's
    // opening — and prose after it still settles the run as the hatch's.
    const quotedEvents = [
      "The first lines are:",
      THREAD,
      turnStarted(),
      "and then items follow.",
    ].join("\n") + "\n";
    const eventsOut = foldStream(quotedEvents).verdict(finished(quotedEvents));
    expect(eventsOut.success).toBe(true);
    expect(eventsOut.exitCode).toBe(0);
    expect(eventsOut.stdout).toBe(quotedEvents);
    expect(eventsOut).toEqual(codexPlainStreamResult(finished(quotedEvents)));

    // A quote can trail into event lines with NO prose after it — the
    // wire's shape with text before its opening — and the answer is the
    // same now (round al30, rule 3): the first line decided human mode,
    // and nothing later flips it, so the truncated-looking tail is reply
    // text like the rest.
    const truncated = ["a banner line", THREAD, turnStarted()].join("\n") + "\n";
    const truncatedOut = foldStream(truncated).verdict(finished(truncated));
    expect(truncatedOut.success).toBe(true);
    expect(truncatedOut.exitCode).toBe(0);
    expect(truncatedOut.stdout).toBe(truncated);
    expect(truncatedOut).toEqual(codexPlainStreamResult(finished(truncated)));
  });

  test("a reply ending in a JSON object after a quoted announcement is the hatch's, exit 0 (al28)", () => {
    // The al28 review's acceptance case, held by the redesign: prose, a
    // quoted thread.started (the hatch stays open under it, al24), and a
    // tail of `{"answer":42}` — a typeless object, reply text in al11's
    // vocabulary — is a JSON-only reply around a quote, the hatch's
    // verbatim stdout. Before al28 the tail reached the verdict only as
    // the wire regime's shape test (an object line among objects), which
    // answered the banner drift instead; the plain run's fallback file
    // could then overwrite even that. The tail rule reads the object
    // through the same vocabulary the objects-only arm does: typeless is
    // reply text, so prose FOLLOWS the quote, and the run is the hatch's.
    const stream = ["here is the stream:", THREAD, '{"answer":42}'].join("\n") + "\n";
    const out = foldStream(stream).verdict(finished(stream));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(stream);
    expect(out.usage).toBeUndefined();
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));
  });

  test("a truncated event line under a quoted announcement is reply text like the rest — the first line decided (al25, al30)", () => {
    // Al25's correctness major — a stream cut mid-write (banner,
    // announcement, turn.started, truncated `{"type":"turn.failed"`)
    // passing through the hatch with exit 0 — was answered by teaching
    // the per-line hatch to read the cut as the wire breaking under a
    // quote. Round al30 (rule 3) deletes that machinery: the regime is
    // the first non-empty line's, full stop, so the corrupted stream
    // under a banner IS human mode's bytes and passes through verbatim
    // with exit 0 — the quoted-cut shape is indistinguishable from a
    // reply quoting one, and the fold no longer tries. The wire regime
    // keeps al25's diagnostic for the shape that commits to it: a cut
    // AFTER the announcement (the drift test below).
    const cut = '{"type":"turn.failed"';
    for (const [label, stream] of [
      ["no footer", ["a wrapper banner", THREAD, turnStarted(), cut].join("\n") + "\n"],
      [
        "footer prose",
        ["a wrapper banner", THREAD, turnStarted(), cut, "wrapper footer"].join("\n") + "\n",
      ],
    ] as Array<readonly [string, string]>) {
      const out = foldStream(stream).verdict(finished(stream));
      expect(out.success, label).toBe(true);
      expect(out.exitCode, label).toBe(0);
      expect(out.stdout, label).toBe(stream);
      expect(out.usage, label).toBeUndefined();
      // The streamed fold and the whole-capture replay share the one rule.
      expect(out, label).toEqual(codexPlainStreamResult(finished(stream)));
    }

    // The same quote with a COMPLETE tail is the same verdict, and the
    // truncated line as the FIRST line is too — human mode either way.
    const quoted = ["a banner", THREAD, turnStarted(), "and the reply follows."].join("\n") + "\n";
    const quotedOut = foldStream(quoted).verdict(finished(quoted));
    expect(quotedOut.success).toBe(true);
    expect(quotedOut.stdout).toBe(quoted);
    const prose = '{"type":"turn.failed"\nlooks like a broken quote in reply text\n';
    const proseOut = foldStream(prose).verdict(finished(prose));
    expect(proseOut.success).toBe(true);
    expect(proseOut.stdout).toBe(prose);
  });

  test("a reply quoting a FAILED stream passes through with exit 0 — the regime was decided by the first line (al25, al30)", () => {
    // Round al30's correctness major, held: al25 taught the per-line
    // hatch to fail a quote that carried turn.failed ("the quoted event
    // stream carried a failure"), and that machinery is what turned THIS
    // run — a human reply whose fenced example quotes a failed stream's
    // events — into a failure: exit 0 became 1 with the reply lost. Rule
    // 3 deletes it: the first non-empty line ("a wrapper banner" here,
    // prose in the round's repro) decided human mode, and NOTHING later
    // flips it, however event-like or failure-like the quoted lines look.
    const failed = [
      "a wrapper banner",
      THREAD,
      turnStarted(),
      turnFailed("Usage limit reached"),
      "wrapper footer",
    ].join("\n") + "\n";
    const out = foldStream(failed).verdict(finished(failed));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(failed);
    expect(out.usage).toBeUndefined();
    expect(out).toEqual(codexPlainStreamResult(finished(failed)));

    const errored = [
      "a wrapper banner",
      THREAD,
      JSON.stringify({ type: "error", message: "provider down" }),
      "wrapper footer",
    ].join("\n") + "\n";
    const erroredOut = foldStream(errored).verdict(finished(errored));
    expect(erroredOut.success).toBe(true);
    expect(erroredOut.exitCode).toBe(0);
    expect(erroredOut.stdout).toBe(errored);
  });

  test("a stream with wire lines but no thread.started is human mode: passthrough, envelope path unchanged (al30)", () => {
    const stream = [turnStarted(), agentMessage("the reply"), turnCompleted(USAGE_FULL)].join("\n") + "\n";
    // The whole-capture parse still answers null for exactly these bytes
    // (the envelope path's rule is untouched); the fold's regime is the
    // FIRST non-empty line's, and turn.started is not the announcement,
    // so the plain run passes the bytes through verbatim (round al30,
    // rule 3 — the al5 objects-only drift arm is gone with the per-line
    // hatch).
    expect(parseCodexEventStream(stream)).toBeNull();
    const out = foldStream(stream).verdict(finished(stream));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(stream);
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));
  });

  test("a recovered top-level error remains a stderr note (al41)", () => {
    const stream = [
      THREAD, turnStarted(),
      JSON.stringify({ type: "error", message: "stream disconnected; retrying" }),
      agentMessage("the reply"), turnCompleted(USAGE_FULL),
    ].join("\n") + "\n";
    const out = foldStream(stream).verdict(finished(""));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("the reply");
    expect(out.stderr).toContain("codemux: codex warning:");
    expect(out.stderr).toContain("stream disconnected; retrying");
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));
  });

  test("an unsuperseded error event fails the run even at exit 0 (al6)", () => {
    // 0.11.0's plain verdict trusted the exit code alone; the stream's
    // own failure channels — turn.failed, or a top-level error no later
    // turn.completed superseded — fail the run at child exit 0 too, the
    // envelope path's long-standing rule (round al6's listing).
    const stream = [THREAD, JSON.stringify({ type: "error", message: "provider down" })].join("\n") + "\n";
    const out = foldStream(stream).verdict(finished(""));
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("provider down");
    expect(out.usage).toEqual(emptyUsage());
  });

  test("error events with no thread announcement are human mode's bytes: passthrough at the child's own exit (al7, al30)", () => {
    // Al7's arm — a plain run whose stdout is only {"type":"error",...}
    // lines failing with codex's own error text — ended with the
    // per-line hatch (round al30, rule 3): the first non-empty line is
    // an error event, not the announcement, so the stream is human
    // mode's — verbatim stdout, the child's exit code its own verdict,
    // success exactly when the exit was 0. A binary that honored `--json`
    // and errored before starting a thread is indistinguishable from one
    // that never honored it and printed JSON, and the round settled the
    // ambiguity for the hatch: the announcement, or passthrough. The
    // envelope path still fails these bytes
    // (parseCodexEventStream answers null, pinned beside), and a stream
    // that DID announce keeps failing its errors (al6 below).
    const stream = [
      JSON.stringify({ type: "error", message: "stream error: upstream refused" }),
      JSON.stringify({ type: "error", message: "retry failed: quota exhausted" }),
    ].join("\n") + "\n";
    expect(parseCodexEventStream(stream)).toBeNull();
    const out = foldStream(stream).verdict(finished(stream));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(stream);
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));
    // The child's own nonzero exit stays its verdict.
    const crashed = foldStream(stream).verdict({ stdout: stream, stderr: "", exitCode: 2, success: false });
    expect(crashed.success).toBe(false);
    expect(crashed.exitCode).toBe(2);
    expect(crashed.stdout).toBe(stream);
  });

});

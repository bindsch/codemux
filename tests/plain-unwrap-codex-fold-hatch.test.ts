import { describe, expect, test } from "bun:test";
import { codexPlainResult, codexPlainStreamResult } from "../src/plain-unwrap.js";
import { parseCodexEventStream } from "../src/result-envelope.js";
import type { RunResult } from "../src/types.js";
import {
  agentMessage,
  codexFoldStream,
  completeStream,
  finished,
  THREAD,
  turnCompleted,
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

  test("human-mode JSON lines — a bare number, string, array, or object without the event shape — are reply text, not wire evidence (al2)", () => {
    // Only the wire's own proof closes the hatch (al6): the thread.started
    // announcement. A reply like
    // "The answer is\n42\n" is human-mode stdout from a binary that
    // ignored `--json`: it passes through verbatim, exactly as the hatch
    // passes non-JSON text.
    const scalar = "The answer is\n42\n";
    const out = foldStream(scalar).verdict(finished(scalar));
    expect(out).toEqual(codexPlainResult(finished(scalar)));
    expect(out.success).toBe(true);
    expect(out.stdout).toBe("The answer is\n42\n");

    const withJson = "Here is the JSON:\n" + JSON.stringify({ answer: 42 }) + "\nDone.\n";
    const jsonOut = foldStream(withJson).verdict(finished(withJson));
    expect(jsonOut.success).toBe(true);
    expect(jsonOut.stdout).toBe(withJson);
    // An array and a bare string line are reply text the same way.
    for (const stream of ["[1,2,3]\n", '"quoted"\n']) {
      expect(foldStream(stream).verdict(finished(stream)).stdout, stream).toBe(stream);
    }
  });

  test("a JSON-only reply — one typeless object line and nothing else — passes through with exit 0 (al11)", () => {
    // The al2 rule made a typeless object line reply text only when some
    // other line already was; a stdout of exactly `{"answer":42}` — a
    // wrapper or fake that answers JSON and nothing else — reached the
    // objects-only arm and failed as the wire's shape without its
    // announcement. Those bytes are not the wire's shape: every codex
    // event carries a string `type`, and round al30 (rule 3) made the
    // FIRST non-empty line the one test — a typeless object first line is
    // human mode, verbatim stdout, exit 0 — and the replay agrees.
    const stream = '{"answer":42}\n';
    const out = foldStream(stream).verdict(finished(stream));
    expect(out).toEqual(codexPlainResult(finished(stream)));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(stream);
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));

    // The same object line ahead of a real stream is human mode's opening
    // now too (round al30, rule 3): the first line decided the regime, so
    // the stream that follows is reply text — the whole stdout verbatim,
    // exit 0. The envelope path still fails these bytes
    // (parseCodexEventStream answers null), and that divergence is the
    // design: a plain run's first line said human.
    const banner = '{"answer":42}\n' + completeStream("the reply");
    const bannerOut = foldStream(banner).verdict(finished(banner));
    expect(bannerOut.success).toBe(true);
    expect(bannerOut.exitCode).toBe(0);
    expect(bannerOut.stdout).toBe(banner);
    expect(bannerOut).toEqual(codexPlainStreamResult(finished(banner)));
  });

  test("a JSON-only reply typed with a name the wire never sends passes through with exit 0 (al11 re-review)", () => {
    // The al11 fix passed typeless objects through but left every STRING
    // type marking the wire's shape — so a wrapper that ignored `--json`
    // and answered `{"type":"invoice","amount":1}` (exit 0) failed as the
    // wire's shape without its announcement, an empty result for a
    // legitimate reply (round al11's re-review, edges 4). Round al30
    // (rule 3) settled the whole vocabulary question the one way the
    // first line can: any first non-empty line but the thread.started
    // announcement is human mode — unknown-named and event-named alike
    // (below), the run's whole stdout verbatim with exit 0.
    const stream = '{"type":"invoice","amount":1}\n';
    const out = foldStream(stream).verdict(finished(stream));
    expect(out).toEqual(codexPlainResult(finished(stream)));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(stream);
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));

    // A known event name is the same rule under al30: `{"type":"error",…}`
    // as the FIRST line did not announce a thread, so the stream is human
    // mode's — passthrough, exit 0 — not the al7 error-only failure the
    // per-line hatch answered (the announcement-decided stream still
    // fails its errors; the al6 pin below).
    const known = foldStream('{"type":"error","message":"x"}\n').verdict(
      finished('{"type":"error","message":"x"}\n')
    );
    expect(known.success).toBe(true);
    expect(known.exitCode).toBe(0);
    expect(known.stdout).toBe('{"type":"error","message":"x"}\n');

    // Ahead of a real stream the unknown-typed line is the same human
    // opening (round al30, rule 3): the whole stdout verbatim, exit 0.
    const banner = stream + completeStream("the reply");
    const bannerOut = foldStream(banner).verdict(finished(banner));
    expect(bannerOut.success).toBe(true);
    expect(bannerOut.exitCode).toBe(0);
    expect(bannerOut.stdout).toBe(banner);
    expect(bannerOut).toEqual(codexPlainStreamResult(finished(banner)));
  });

  test("a plain reply carrying an object line with a string type the fold does not read keeps the hatch open (al3)", () => {
    // A hatch run's stdout is plain text, and plain text can contain a
    // line that parses as an object with a string `type`. That alone is
    // not wire evidence: the hatch closes only on the thread.started
    // announcement (al6), so the reply is
    // never lost to a line inside it — before al3 the line was taken for
    // the wire, the hatch closed, and every later line became drift that
    // failed the run.
    const stream = 'Here is code:\n{"type":"object"}\nmore\n';
    const out = foldStream(stream).verdict(finished(stream));
    expect(out).toEqual(codexPlainResult(finished(stream)));
    expect(out.success).toBe(true);
    expect(out.stdout).toBe(stream);

    // The whole-capture replay answers the same bytes the same way, and
    // the announcement still closes the hatch: the rule is the wire's
    // proof, not the shape.
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));
    expect(foldStream(completeStream("the reply")).verdict(finished("")).stdout)
      .toBe("the reply\n");
  });

  test("a reply line shaped like a codex event — a name the reduction reads — never closes the hatch either (al5)", () => {
    // Finding 3: the al3 rule keyed on the event-name vocabulary, so a
    // hatch reply carrying {"type":"turn.started"} or {"type":"error",…}
    // — both names the reduction reads — closed the hatch, and the next
    // plain line became drift that failed the run with no stdout. The
    // hatch now closes only on the wire's own proof: the announcement
    // (a thread.started line; al6). Prose, a
    // bare number, and event-shaped object lines alike stay reply text.
    const stream =
      "notes:\n" +
      '{"type":"turn.started"}\n' +
      "and a count:\n" +
      "42\n" +
      '{"type":"error","message":"x"}\n' +
      "more\n";
    const out = foldStream(stream).verdict(finished(stream));
    expect(out).toEqual(codexPlainResult(finished(stream)));
    expect(out.success).toBe(true);
    expect(out.stdout).toBe(stream);
    // The streaming fold and the whole-capture replay share the one rule.
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));
  });

  test("a reply line shaped like turn.completed or turn.failed never loses the hatch run (al6)", () => {
    // Review al6, finding 1: the al5 comment claimed any event-shaped
    // line was safe reply text, but a line whose feeding drifts the
    // reduction — turn.completed and turn.failed close a turn none
    // opened — closed the hatch as "a drift the fed events raised" and
    // failed the run, so a valid human-mode reply quoting those events
    // was lost. Drift is not wire proof: only the announcement closes
    // the hatch, in either ordering — prose around the object lines, or
    // the drifting object line first with the prose after it.
    const proseAround = [
      "the turn events were:",
      JSON.stringify({ type: "turn.completed", usage: {} }),
      "and the failure:",
      JSON.stringify({ type: "turn.failed", error: { message: "stream disconnected" } }),
      "end of log",
    ].join("\n") + "\n";
    const objectFirst = JSON.stringify({ type: "turn.completed" }) + "\nthen the prose answer\n";
    for (const stream of [proseAround, objectFirst]) {
      const out = foldStream(stream).verdict(finished(stream));
      expect(out, JSON.stringify(stream)).toEqual(codexPlainResult(finished(stream)));
      expect(out.success).toBe(true);
      expect(out.stdout).toBe(stream);
      // The streaming fold and the whole-capture replay share the one rule.
      expect(out).toEqual(codexPlainStreamResult(finished(stream)));
    }
  });

  test("human-mode stdout keeps 0.11.0's plain verdict: stdout verbatim, success exactly when the exit was 0 (al6)", () => {
    // Review al6, finding 2: before this branch a plain codex run was
    // human mode, and its verdict was the child's own — stdout verbatim,
    // the exit code untouched, success exactly when the exit was 0
    // (codexPlainResult, the hatch's verdict). Every stdout that is not
    // the wire owes it the same answer, whatever lines it carries:
    // prose, blanks, JSON of every shape but object lines, object lines
    // with unrecognized or event-shaped types (al2, al3, al5, al6) — at
    // either exit code. The shapes that differ are the wire's own, each
    // pinned by its own test and listed with its reason in
    // docs/archive/align-0.12-report.md (round al6).
    const shapes = [
      "the reply\n",
      "line one\nline two\n",
      "\n\n",
      "",
      "The answer is\n42\n",
      "[1,2,3]\n",
      '"quoted"\n',
      'Here is code:\n{"type":"object"}\nmore\n',
      'notes:\n{"type":"turn.started"}\nand a count:\n42\n{"type":"error","message":"x"}\nmore\n',
      'log:\n{"type":"turn.completed","usage":{}}\nend\n',
      '{"type":"turn.completed"}\nthen the prose answer\n',
    ];
    for (const stream of shapes) {
      for (const exitCode of [0, 3]) {
        const label = `exit ${exitCode}: ${JSON.stringify(stream)}`;
        const result: RunResult = {
          stdout: stream,
          stderr: "",
          exitCode,
          success: exitCode === 0,
        };
        const out = foldStream(stream).verdict(result);
        expect(out.success, label).toBe(exitCode === 0);
        expect(out.exitCode, label).toBe(exitCode);
        expect(out.stdout, label).toBe(stream);
        expect(out, label).toEqual(codexPlainStreamResult({ ...result }));
      }
    }
  });

  test("a leading object whose type is not a known event decides human mode: passthrough, envelope path unchanged (al5, al30)", () => {
    // Finding 2's parity ended with the per-line hatch (round al30, rule
    // 3): parseCodexEventStream still feeds every object line to the
    // reduction, so the --result-json run fails these bytes as
    // unparseable — the later thread.started lands past the first event,
    // drift. The plain run's regime is its FIRST non-empty line's, and
    // an unknown-typed object is not the announcement, so the same bytes
    // are human mode there: verbatim stdout, exit 0. The two paths
    // answer differently by design now — a wrapper that prefixes a
    // JSON object to a real stream got its bytes past a plain run, and
    // the alternative was the quoted-reply loss the round's correctness
    // major pinned.
    const stream = [
      JSON.stringify({ type: "some.new.event" }),
      THREAD,
      turnStarted(),
      agentMessage("the reply"),
      turnCompleted(USAGE_FULL),
    ].join("\n") + "\n";
    expect(parseCodexEventStream(stream)).toBeNull();
    const out = foldStream(stream).verdict(finished(stream));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(stream);
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));
  });

  test("plain text before the announcement decides human mode: verbatim passthrough, envelope path unchanged (al5, al30)", () => {
    // The banner shape, same rule: the parse fails these bytes at the
    // text line before it ever reaches the announcement (pinned beside),
    // while the plain run's first line said human — the whole stdout
    // passes through with exit 0 (round al30, rule 3).
    const stream = [
      "a banner line",
      THREAD,
      turnStarted(),
      agentMessage("the reply"),
      turnCompleted(USAGE_FULL),
    ].join("\n") + "\n";
    expect(parseCodexEventStream(stream)).toBeNull();
    const out = foldStream(stream).verdict(finished(stream));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(stream);
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));
  });

});

import { describe, expect, test } from "bun:test";
import { CodexPlainFold } from "../src/plain-unwrap.js";
import { MAX_CAPTURE_BYTES } from "../src/process-runner.js";
import {
  agentMessage,
  captureLimitResult,
  finished,
  THREAD,
  turnCompleted,
  turnStarted,
  USAGE_FULL,
  warningItem,
} from "./helpers/plain-unwrap.js";

describe("CodexPlainFold", () => {
  // The streaming sink the launcher feeds instead of capturing the whole
  // `--json` event stream (0.12.0, the ul3 fix). The builders mirror the
  // wire grammar the whole-capture parse pins (result-envelope.test.ts);
  // the fold and codexPlainStreamResult share one reduction and one
  // verdict, so the drift grammar itself is covered there.

  test("an oversized tool-part line over the whole capture bound fails the run at the capture limit (ul5, al8, al37)", () => {
    // The realistic oversized line: an item event carrying a tool's bulk
    // output. Since al8 the drop of such a line was reserved for a head
    // a classifier could read before letting the line go; al37 deletes
    // the classifier with its premise — a fold that picked which unread
    // bytes were safe to lose by their first bytes was guessing about a
    // line it never read. One rule answers every oversized line now:
    // the latch, and the run fails at the capture limit — exit 125, the
    // partial output the fold held, nothing of the line itself.
    const oversizedToolLine = (itemHead: string): CodexPlainFold => {
      const fold = new CodexPlainFold();
      fold.push(THREAD + "\n" + turnStarted() + "\n");
      fold.push(`{"type":"item.completed","item":${itemHead}`);
      fold.push("x".repeat(MAX_CAPTURE_BYTES + 1));
      fold.push(`"}}\n`);
      fold.push(agentMessage("the reply") + "\n");
      fold.push(turnCompleted(USAGE_FULL) + "\n");
      return fold;
    };
    for (const head of [
      `{"type":"command_execution","command":"ls","aggregated_output":"`,
      `{"id":"i0","type":"mcp_tool_call","server":"srv","arguments":{},"output":"`,
    ]) {
      const fold = oversizedToolLine(head);
      expect(fold.keptBytes(), head).toBe(MAX_CAPTURE_BYTES + 1);
      // Nothing after the latch folds: the reply and the completion the
      // stream went on to carry are the pipe's business, never the
      // run's — no message was read whole, so there is no partial
      // output to return.
      expect(fold.finish(), head).toBe("");
      expect(captureLimitResult(""), head).toEqual({
        stdout: "",
        stderr: `Error: stdout exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit\n`,
        exitCode: 125,
        success: false,
      });
    }
  });

  test("an oversized collaboration event fails the run at the capture limit like every item type (al13, al37)", () => {
    // The al13 finding — the classifier's vocabulary could never be
    // complete, for it was enumerated from the item types the fixtures
    // had shown — is answered by deleting the classifier: no item type
    // is named by the drop rule anymore, because no head is read at
    // all. Both wire spellings the grammar uses (the item's type tag
    // first, a short id before it) take the one answer: the latch,
    // exit 125.
    for (const head of [
      `{"type":"collab_tool_call","tool":"spawn_agent","sender_thread_id":"th_1","receiver_thread_ids":["th_2"],"prompt":"spawn a helper","agents_states":{"th_2":{"status":"running","message":"`,
      `{"id":"i0","type":"collab_tool_call","tool":"wait","agents_states":{"th_2":{"status":"completed","message":"`,
    ]) {
      const fold = new CodexPlainFold();
      fold.push(THREAD + "\n" + turnStarted() + "\n");
      fold.push(`{"type":"item.updated","item":${head}`);
      fold.push("x".repeat(MAX_CAPTURE_BYTES + 1));
      fold.push(`"}}}}\n`);
      fold.push(agentMessage("the reply") + "\n");
      fold.push(turnCompleted(USAGE_FULL) + "\n");
      expect(fold.keptBytes(), head).toBe(MAX_CAPTURE_BYTES + 1);
      expect(fold.finish(), head).toBe("");
      expect(captureLimitResult("").exitCode, head).toBe(125);
    }
  });

  test("an oversized final-message line inside an open turn fails the run at the capture limit (al8, al37)", () => {
    // The seventh review's finding, re-answered by al37's one rule: the
    // drop once left the reduction standing on the lines it had read,
    // so a turn that went on to complete printed the PREVIOUS
    // agent_message as a successful reply — "I will now look at the
    // files." posing as the answer. The drift arm al8 answered with is
    // deleted with the classifier it served: the line's size fails the
    // run at the capture limit — exit 125 — and the partial output is
    // the message the fold read whole before the drop, the same partial
    // the whole-stream capture would return.
    const fold = new CodexPlainFold();
    fold.push(
      [THREAD, turnStarted(), agentMessage("I will now look at the files.")].join("\n") + "\n"
    );
    // The giant final message arrives in chunks; the drop fires while the
    // line is still unterminated past the bound, exactly as the pipe
    // delivers it (the ul5 shape).
    fold.push(`{"type":"item.completed","item":{"id":"big","type":"agent_message","text":"`);
    fold.push("x".repeat(MAX_CAPTURE_BYTES + 1));
    fold.push(`"}}\n`);
    fold.push(turnCompleted(USAGE_FULL) + "\n");
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    expect(fold.finish()).toBe("I will now look at the files.\n");
    expect(captureLimitResult("I will now look at the files.\n")).toEqual({
      stdout: "I will now look at the files.\n",
      stderr: `Error: stdout exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit\n`,
      exitCode: 125,
      success: false,
    });
  });

  test("an oversized `{`-shaped first line leaves the regime undecided and fails at the capture limit; a line READ WHOLE commits (al21, al30, al35, al37)", () => {
    // Round al37 deletes al35's oversized-commit rule with the premise
    // it served: the regime is committed only by an announcement read
    // whole, so a first line past the bound commits NOTHING — the
    // regime stays undecided, no prefix is retained (that arm belongs
    // to a stream human mode has already decided), and the run fails
    // at the capture limit, exit 125. Never a wire commitment whose
    // drift would fail the run at exit 1, never a silent truncation.
    const fold = new CodexPlainFold();
    // A blank line commits nothing: the regime is still undecided, and
    // the blank byte is undecided mode's.
    fold.push("\n");
    const hatched = fold as unknown as { raw: string; rawBytes: number };
    expect(hatched.rawBytes).toBe(1);
    // The oversized `{`-shaped line is the first non-empty output.
    fold.push(`{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"`);
    fold.push("x".repeat(MAX_CAPTURE_BYTES + 1));
    fold.push(`"}}\n`);
    // Undecided: no commitment was made, for the line was never read —
    // and no prefix joins raw on an undecided regime, so the partial
    // output is the blank byte alone. The latch answers every poll, and
    // the reduction never saw the line (no drift).
    expect((fold as unknown as { state: { mode: string | null } }).state.mode).toBeNull();
    expect(hatched.rawBytes).toBe(1);
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    expect(fold.finish()).toBe("\n");
    expect(captureLimitResult("\n")).toEqual({
      stdout: "\n",
      stderr: `Error: stdout exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit\n`,
      exitCode: 125,
      success: false,
    });
    expect(
      (fold as unknown as { state: { reducer: { drift: string | null } } }).state.reducer.drift
    ).toBeNull();

    // The al21 rule survives on the read side: the announcement read
    // WHOLE is the wire commitment that frees human mode's bytes at that
    // moment, exactly as decideMode frees them.
    const read = new CodexPlainFold();
    read.push("\n");
    read.push(THREAD + "\n");
    expect((read as unknown as { state: { mode: string | null } }).state.mode).toBe("wire");
    const readHatched = read as unknown as { raw: string; rawBytes: number };
    expect(readHatched.raw).toBe("");
    expect(readHatched.rawBytes).toBe(0);
    expect(read.keptBytes()).toBeLessThan(1024);

    // The mirror: once a non-empty plain line has decided human mode, an
    // oversized `{`-shaped line is human stdout the fold could not hold —
    // the capture limit's answer with al31's bounded prefix as the
    // partial output, never a flip and never a silent truncation (rule
    // 3: nothing later flips the regime).
    const human = new CodexPlainFold();
    human.push("plain stdout line one\nplain stdout line two\n");
    human.push(`{"type":"item.completed","item":{`);
    human.push("x".repeat(MAX_CAPTURE_BYTES + 1));
    expect((human as unknown as { state: { mode: string | null } }).state.mode).toBe("human");
    expect(human.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    const humanPartial = human.finish();
    expect(humanPartial.startsWith("plain stdout line one\nplain stdout line two\n")).toBe(true);
    expect(Buffer.byteLength(humanPartial)).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
    expect(captureLimitResult(humanPartial).exitCode).toBe(125);
  });

  test("an oversized startup warning before the first turn fails the run at the capture limit; its small spelling keeps the warning arm (al35, al37)", () => {
    // The reducer's carve-out (result-envelope.ts) still accepts a
    // completed error item between thread.started and turn.started as a
    // startup warning — its SMALL spelling below succeeds with the
    // warning on stderr. The oversized spelling is not the reducer's to
    // judge: the line was never read, so no carve-out applies — al37's
    // one rule answers it with the capture-limit failure, exit 125.
    // Size decides the failure's kind, never the run's success, and it
    // decides that one thing for every event type alike.
    const oversizedWarningLine = (): string =>
      `{"type":"item.completed","item":{"id":"item_2","type":"error","message":"` +
      `ignored config key 'model_reasoning_effort' ` +
      "x".repeat(MAX_CAPTURE_BYTES) +
      `"}}`;
    // The small spelling succeeds with the warning on stderr (the
    // reducer's carve-out, pinned at the fold level).
    const small = new CodexPlainFold();
    small.push(
      [THREAD, warningItem(), turnStarted(), agentMessage("the reply"), turnCompleted(USAGE_FULL)]
        .join("\n") + "\n"
    );
    const smallOut = small.verdict(finished(""));
    expect(smallOut.success).toBe(true);
    expect(smallOut.stdout).toBe("the reply\n");
    expect(smallOut.stderr).toContain("codex warning");
    // The oversized spelling is the capture limit's own failure: the
    // warning's text is gone — the line is past the bound, so its
    // message was never read — and with it the warning note the small
    // spelling carries.
    const fold = new CodexPlainFold();
    fold.push(THREAD + "\n");
    fold.push(oversizedWarningLine() + "\n");
    fold.push(
      [turnStarted(), agentMessage("the reply"), turnCompleted(USAGE_FULL)].join("\n") + "\n"
    );
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    expect(fold.finish()).toBe("");
    const out = captureLimitResult("");
    expect(out.exitCode).toBe(125);
    expect(out.stderr).not.toContain("codex warning");
  });

  test("an oversized reroute notice before the first turn fails at the capture limit; its small spelling keeps the drift (al34, al35, al37)", () => {
    // The al34 rule survives on the READ side — a reroute notice before
    // any turn is drift, for it attributes a model onto a turn that was
    // never served — and the oversized spelling never reaches it: the
    // line is dropped unread, al37's latch answers, and the run fails
    // at the capture limit. Size decides the failure's kind.
    const fold = new CodexPlainFold();
    fold.push(THREAD + "\n");
    fold.push(
      `{"type":"item.completed","item":{"id":"item_1","type":"error","message":"model rerouted: gpt-5.1 -> gpt-5.2 (` +
        "x".repeat(MAX_CAPTURE_BYTES) +
        `)"}}` +
        "\n"
    );
    fold.push(
      [turnStarted(), agentMessage("the reply"), turnCompleted(USAGE_FULL)].join("\n") + "\n"
    );
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    expect(captureLimitResult(fold.finish()).exitCode).toBe(125);
    // The small spelling of the same notice still drifts — the reducer's
    // own rule, unchanged by the bound (pinned in full in
    // tests/result-envelope.test.ts).
    const small = new CodexPlainFold();
    small.push(THREAD + "\n");
    small.push(
      `{"type":"item.completed","item":{"id":"item_1","type":"error","message":"model rerouted: gpt-5.1 -> gpt-5.2 (region)"}}` +
        "\n"
    );
    small.push(
      [turnStarted(), agentMessage("the reply"), turnCompleted(USAGE_FULL)].join("\n") + "\n"
    );
    const smallOut = small.verdict(finished(""));
    expect(smallOut.success).toBe(false);
    expect(smallOut.stderr).toContain("outside a turn");
    expect(smallOut.servedModel).toBeNull();
  });

  test("an oversized warning inside an open turn fails the run at the capture limit (al22, al35, al37)", () => {
    // al22's rule — a completed error item inside a turn is a warning
    // the run survives — is the reducer's, and the reducer only ever
    // sees lines read whole. The oversized spelling is dropped unread:
    // al37's latch, exit 125, no head classified, no message read.
    const fold = new CodexPlainFold();
    fold.push(THREAD + "\n" + turnStarted() + "\n");
    fold.push(
      `{"type":"item.completed","item":{"id":"item_2","type":"error","message":"` +
        "x".repeat(MAX_CAPTURE_BYTES + 1) +
        `"}}` +
        "\n"
    );
    fold.push(agentMessage("the reply") + "\n");
    fold.push(turnCompleted(USAGE_FULL) + "\n");
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    expect(fold.finish()).toBe("");
    expect(captureLimitResult("").exitCode).toBe(125);
  });

  test("an oversized warning past the last turn.completed fails at the capture limit, the reply its partial (al35, al37)", () => {
    // The carve-out's far boundary is unread too: the completed turn's
    // reply was read whole before the drop, so the modeled 125 carries
    // it as the partial output — the same partial the whole-stream
    // capture would have returned.
    const fold = new CodexPlainFold();
    fold.push(
      [THREAD, turnStarted(), agentMessage("the reply"), turnCompleted(USAGE_FULL)].join("\n") + "\n"
    );
    fold.push(
      `{"type":"item.completed","item":{"id":"item_3","type":"error","message":"` +
        "x".repeat(MAX_CAPTURE_BYTES + 1) +
        `"}}` +
        "\n"
    );
    expect(fold.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    expect(fold.finish()).toBe("the reply\n");
    expect(captureLimitResult("the reply\n")).toEqual({
      stdout: "the reply\n",
      stderr: `Error: stdout exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit\n`,
      exitCode: 125,
      success: false,
    });
  });

});

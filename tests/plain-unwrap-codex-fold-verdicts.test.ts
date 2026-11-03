import { describe, expect, test } from "bun:test";
import {
  codexPlainStreamResult,
  type CodexPlanFallbackRead,
} from "../src/plain-unwrap.js";
import {
  CODEX_FINAL_MESSAGE_FALLBACK_NOTE,
  emptyUsage,
} from "../src/result-envelope.js";
import type { RunResult } from "../src/types.js";
import {
  agentMessage,
  codexFoldStream,
  completeStream,
  finished,
  FULL_BLOCK,
  THREAD,
  toolItem,
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

  test("a failed turn prints nothing, exactly what human mode printed, and reports no usage", () => {
    // Upstream discards a failed turn's final message, so neither the
    // fold nor human mode prints one.
    const stream = [
      THREAD,
      turnStarted(),
      agentMessage("partial"),
      turnFailed("Usage limit reached"),
    ].join("\n") + "\n";
    const out = foldStream(stream).verdict(finished(""));
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("Usage limit reached");
    expect(out.usage).toEqual(emptyUsage());
  });

  test("codex's own non-zero exit fails the run while the message it printed stays on stdout", () => {
    // The decided contract (round al5): the stream completed the turn —
    // a turn.completed closed it and a final message exists — so the
    // reply stays on stdout even though codex then exited nonzero; human
    // mode printed that message before exiting.
    const result: RunResult = { stdout: "", stderr: "boom", exitCode: 3, success: false };
    const out = foldStream(completeStream("the reply")).verdict(result);
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(3);
    expect(out.stdout).toBe("the reply\n");
    expect(out.stderr).toBe("boom");
    // A figure from a run whose end the harness itself called failed is
    // at best incomplete: the receipt records none.
    expect(out.usage).toEqual(emptyUsage());
  });

  test("a truncated stream — a complete message whose turn never completed — fails the run and prints nothing (al5)", () => {
    // The decided contract: no turn.completed, no reply on stdout — the
    // message the reducer holds is an intermediate one.
    const stream = [THREAD, turnStarted(), agentMessage("partial")].join("\n") + "\n";
    const out = foldStream(stream).verdict(finished(""));
    expect(out.success).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("turn.completed");
  });
  test("a completed turn with no message anywhere succeeds with empty stdout, human mode's verdict (al10)", () => {
    // The ninth review's finding, settled against 0.160.1's own human
    // output processor (event_processor_with_human_output.rs): a
    // TurnStatus::Completed turn shuts codex down normally — exit 0 —
    // whatever it holds, and print_final_output prints a final message
    // only when one exists, so a messageless completed turn printed
    // nothing and exited 0. The Plan-only turn under an untrusted sandbox
    // is this exact wire shape: the JSONL stream has no Plan variant, so
    // without the --output-last-message file that launch cannot have, the
    // text human mode printed never reaches codemux — empty stdout is the
    // faithful spelling, the usage stays, and the run succeeds. The
    // envelope path keeps failing the same stream (its promise is a
    // result envelope, and an empty result is a failed run;
    // result-envelope.test.ts).
    const reasoningItem = JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "reasoning", text: "thinking" },
    });
    const stream = [THREAD, turnStarted(), reasoningItem, turnCompleted(USAGE_FULL)].join("\n") + "\n";
    const out = foldStream(stream).verdict(finished(""));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("");
    expect(out.stderr).not.toContain("no result to report");
    expect(out.usage).toEqual(FULL_BLOCK);
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));
    // The same turn under a nonzero codex exit still fails, with nothing
    // to print: human mode printed nothing and exited nonzero.
    const crashed = foldStream(stream).verdict(
      { stdout: "", stderr: "boom", exitCode: 3, success: false }
    );
    expect(crashed.success).toBe(false);
    expect(crashed.exitCode).toBe(3);
    expect(crashed.stdout).toBe("");
    expect(crashed.usage).toEqual(emptyUsage());
    // An empty agent_message is the same rule one step further: human
    // mode's final_message_from_turn_items returned the empty text, so
    // println! printed a lone newline and exited 0; the plain path spells
    // exactly that since al11 (al10 had emptied it — the review's parity
    // finding) and succeeds the same.
    const empty = [THREAD, turnStarted(), agentMessage(""), turnCompleted(USAGE_FULL)].join("\n") + "\n";
    const emptyOut = foldStream(empty).verdict(finished(""));
    expect(emptyOut.success).toBe(true);
    expect(emptyOut.exitCode).toBe(0);
    expect(emptyOut.stdout).toBe("\n");
    expect(emptyOut.usage).toEqual(FULL_BLOCK);
    expect(emptyOut).toEqual(codexPlainStreamResult(finished(empty)));
  });

  test("a messageless turn with no fallback thunk succeeds empty — the default every replay keeps (al10, al29)", () => {
    // Round al29 restores the plain run's --output-last-message file, but
    // scoped: the verdict consults it only through a thunk the launch
    // passes after its own read, and only for a completed messageless
    // turn (the tests below). No thunk — the whole-capture replay, any
    // caller without a context, and the launch that named no file (the
    // untrusted sandbox) — keeps exactly the answer al10 settled and
    // al28 made universal: the messageless completed turn succeeds empty,
    // with the usage, and nothing on stderr names a fallback.
    const stream = [THREAD, turnStarted(), toolItem("thinking"), turnCompleted(USAGE_FULL)].join("\n") + "\n";
    const out = foldStream(stream).verdict(finished(""));
    expect(out.success).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("");
    expect(out.stderr).not.toContain("no result to report");
    expect(out.stderr).not.toContain("--output-last-message");
    expect(out.usage).toEqual(FULL_BLOCK);
    expect(out).toEqual(codexPlainStreamResult(finished(stream)));
  });

  test("the bounded fallback: a messageless completed turn answers from the file the launch named (al29)", () => {
    // The round al29 major's one case, spelled per outcome. A plain run
    // names a --output-last-message file again — a Plan-only turn's
    // recorded final message is the reply's only carrier, the one item
    // the JSONL wire does not carry — and the launch reads (and removes)
    // it before the verdict runs, handing the outcome over as the thunk
    // these tests stand in for. Text answers with the recorded message
    // and the fallback note; an empty file (upstream's own
    // messageless-turn record) confirms the empty reply with no note; a
    // missing file fails the run naming the unwritten file (round al34,
    // edges major 2 — the file was the reply's only carrier, so its
    // absence is an upstream write failure, never the no-fallback
    // shape); and a read that refused fails the run with its error.
    const planOnly =
      [THREAD, turnStarted(), toolItem("thinking"), turnCompleted(USAGE_FULL)].join("\n") + "\n";
    const recorded = "the plan\nsteps one and two";

    const text = foldStream(planOnly).verdict(finished(""), () => ({
      outcome: "text",
      text: recorded,
    }));
    expect(text.success).toBe(true);
    expect(text.exitCode).toBe(0);
    // The recorded message verbatim plus the one trailing newline the
    // pinned printer appends (al11's spelling, the file's bytes included).
    expect(text.stdout).toBe(`${recorded}\n`);
    expect(text.stderr).toContain(CODEX_FINAL_MESSAGE_FALLBACK_NOTE);
    expect(text.usage).toEqual(FULL_BLOCK);
    // The streaming fold and the whole-capture replay share the arm.
    expect(text).toEqual(
      codexPlainStreamResult(finished(planOnly), () => ({ outcome: "text", text: recorded }))
    );

    const empty = foldStream(planOnly).verdict(finished(""), () => ({
      outcome: "text",
      text: "",
    }));
    expect(empty.success).toBe(true);
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toBe("");
    expect(empty.stderr).not.toContain("codemux:");
    expect(empty.usage).toEqual(FULL_BLOCK);

    const missing = foldStream(planOnly).verdict(finished(""), () => ({
      outcome: "missing",
      path: "/run/.codemux-scratch/last-message",
    }));
    // Round al34 (edges major 2): a NAMED file that is not there is a
    // write codex only logged — the completed messageless turn's only
    // carrier never landed, so the run fails naming it, with no usage
    // from a run whose end is a failure. (The no-fallback shape — a
    // launch that named no file — passes no thunk at all and keeps the
    // al10 empty success, the test above.)
    expect(missing.success).toBe(false);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain(
      "codex completed the turn but did not write the " +
        "--output-last-message file the launch named"
    );
    expect(missing.stderr).toContain("/run/.codemux-scratch/last-message");
    expect(missing.usage).toEqual(emptyUsage());

    const unreadable = foldStream(planOnly).verdict(finished(""), () => ({
      outcome: "unreadable",
      error: "EACCES: permission denied, open 'last-message'",
    }));
    expect(unreadable.success).toBe(false);
    expect(unreadable.exitCode).toBe(1);
    expect(unreadable.stdout).toBe("");
    expect(unreadable.stderr).toContain(
      "could not read codex's --output-last-message file"
    );
    expect(unreadable.stderr).toContain("permission denied");
    expect(unreadable.usage).toEqual(emptyUsage());
  });

  test("no other path touches the file: every verdict that is not a completed messageless turn ignores the thunk (al29)", () => {
    // The bounded case's other half, and the al28 lesson held: the file
    // may never contradict the stream. A thunk that THROWS if consulted
    // stands in for the read, and every other verdict shape — a stream
    // that carried its reply, failed its own way, never completed the
    // turn, exited nonzero after completing, or never proved itself the
    // wire at all — answers without it.
    const boom = (): CodexPlanFallbackRead => {
      throw new Error("the fallback thunk must not be consulted");
    };
    const normal = foldStream(completeStream("the reply")).verdict(finished(""), boom);
    expect(normal.success).toBe(true);
    expect(normal.stdout).toBe("the reply\n");
    expect(normal.stderr).not.toContain(CODEX_FINAL_MESSAGE_FALLBACK_NOTE);

    const failed = foldStream(
      [THREAD, turnStarted(), turnFailed("Usage limit reached")].join("\n") + "\n"
    ).verdict(finished(""), boom);
    expect(failed.success).toBe(false);
    expect(failed.stderr).toContain("Usage limit reached");

    const truncated = foldStream(
      [THREAD, turnStarted(), agentMessage("partial")].join("\n") + "\n"
    ).verdict(finished(""), boom);
    expect(truncated.success).toBe(false);
    expect(truncated.stdout).toBe("");

    // Codex exited nonzero after completing: the message stays on stdout
    // (human mode printed it before exiting) and the file is beside the
    // point — the run already failed.
    const crashed = foldStream(completeStream("the reply")).verdict(
      { stdout: "", stderr: "boom", exitCode: 3, success: false },
      boom
    );
    expect(crashed.success).toBe(false);
    expect(crashed.exitCode).toBe(3);
    expect(crashed.stdout).toBe("the reply\n");

    const hatch = foldStream("a plain reply\n").verdict(finished("a plain reply\n"), boom);
    expect(hatch.success).toBe(true);
    expect(hatch.stdout).toBe("a plain reply\n");
  });
});

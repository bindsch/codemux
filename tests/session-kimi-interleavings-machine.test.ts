/**
 * The kimi session machine probed purely (no driver): the turn's reply
 * rule, the tool loop's id grammar, the spawn-abandonment hold contract,
 * and the ended phase's absorb-and-count rule. Split from
 * tests/session-kimi-interleavings.test.ts; the wire spellings and the
 * scripted child are tests/helpers/session-kimi-interleavings.ts.
 */

import { describe, expect, test } from "bun:test";
import {
  initialKimiState,
  step,
  type KimiEffect,
  type KimiEvent,
  type TurnChild,
} from "../src/session/kimi-machine.js";
import { emptyUsage } from "../src/result-envelope.js";
import type { ResultUsageBlock } from "../src/types.js";
import {
  assistantCall,
  assistantText,
  FakeTurnProcess,
  hintLine,
  ID,
  toolResult,
} from "./helpers/session-kimi-interleavings.js";

describe("kimi machine - the turn's reply rule (al34)", () => {
  const config = { authorPrefix: true, registryEnabled: false };

  /** One turn through the pure machine: open it, attach a child, feed
   * `lines`, then exit 0 — the verdict the exit's turn_completed emit
   * carries. Pure state-machine probes were how the review found the
   * two false-success shapes, so they are how the fix is pinned. */
  const runTurn = (
    lines: string[],
    usage: ResultUsageBlock = emptyUsage()
  ): { finish: "end" | "failed" | "interrupted"; reason?: string; usage: ResultUsageBlock } => {
    const state = initialKimiState(null);
    step(state, { kind: "run_started" }, config);
    step(
      state,
      { kind: "user_input", line: JSON.stringify({ type: "user", text: "probe" }) },
      config
    );
    const child = new FakeTurnProcess();
    step(state, { kind: "spawn_settled", child }, config);
    for (const line of lines) step(state, { kind: "child_line", line }, config);
    const effects = step(
      state,
      { kind: "child_exit", child, outcome: { code: 0, signal: null }, usage },
      config
    );
    const completed = effects.find(
      (effect): effect is Extract<
        KimiEffect,
        { kind: "emit"; event: "turn_completed" }
      > => effect.kind === "emit" && effect.event === "turn_completed"
    );
    if (completed === undefined) {
      throw new Error("the exit carried no turn_completed emit");
    }
    return { finish: completed.finish, reason: completed.reason, usage: completed.usage };
  };

  test("a final assistant text after every tool result answers the turn", () => {
    const { finish } = runTurn([
      assistantText("let me look"),
      assistantCall("call-1"),
      toolResult("call-1"),
      assistantText("here is the answer"),
      hintLine(ID),
    ]);
    expect(finish).toBe("end");
  });

  test("a resolved tool loop with no final assistant reply fails the turn", () => {
    // Edges major 1, first shape: every call's result arrived, but no
    // final assistant text stands behind them — the old condition gated
    // on unresolved calls, so this turn read success at exit 0.
    const { finish, reason } = runTurn([
      assistantText("let me look"),
      assistantCall("call-1"),
      toolResult("call-1"),
      hintLine(ID),
    ]);
    expect(finish).toBe("failed");
    expect(reason).toBe(
      "the kimi process exited 0 with no final assistant reply after its tool results"
    );
  });

  test("an assistant reply while a tool call is still pending fails the turn", () => {
    // Edges major 1, second shape: text arrived while the call was
    // unanswered — mid-loop prose, not the answer. The old setter took
    // any text frame as the final reply, so the unresolved-calls clause
    // never fired and the turn read success at exit 0.
    const { finish, reason } = runTurn([
      assistantCall("call-1"),
      assistantText("still working"),
      hintLine(ID),
    ]);
    expect(finish).toBe("failed");
    expect(reason).toBe(
      "the kimi process exited 0 with 1 tool call that never received a result " +
        "and no final assistant reply"
    );
  });

  test("the exit's usage read rides the turn_completed emit and the cumulative fold", () => {
    // The print wire names no counts, so the executor reads them from
    // the session's wire log after the child settles (the child_exit
    // event's usage field, kimi-driver-events.ts); the machine threads
    // that block onto the caller's turn_completed unchanged and folds
    // it into the cumulative the session's end carries — a failed
    // verdict folds it too (the model calls happened whatever the
    // verdict says).
    const read: ResultUsageBlock = {
      input_tokens: 10, output_tokens: 2, cached_input_tokens: 3, total_tokens: 15, cost_usd: null,
    };
    const ok = runTurn([assistantText("answer"), hintLine(ID)], read);
    expect(ok.usage).toEqual(read);
    const failed = runTurn([assistantText("cut"), assistantCall("call-1"), hintLine(ID)], read);
    expect(failed.finish).toBe("failed");
    expect(failed.usage).toEqual(read);
    // No read (the executor's all-null block when the log could not be
    // attributed): the event says nulls, never zeros.
    expect(runTurn([assistantText("answer"), hintLine(ID)]).usage).toEqual(emptyUsage());
  });
});

describe("kimi machine - the tool loop's id grammar (al35)", () => {
  const config = { authorPrefix: true, registryEnabled: false };

  /** One turn fed `lines` whose malformed shape raises the fatal itself:
   * the turn's completion comes from the end path's synthesis at
   * children_settled (the executor's delivery once every child of the end
   * settled), so the probe returns the fatal's own effects beside the
   * synthesized verdict. */
  const runMalformed = (
    lines: string[]
  ): {
    lineEffects: KimiEffect[];
    finish: "end" | "failed" | "interrupted";
    reason?: string;
  } => {
    const state = initialKimiState(null);
    step(state, { kind: "run_started" }, config);
    step(
      state,
      { kind: "user_input", line: JSON.stringify({ type: "user", text: "probe" }) },
      config
    );
    const child = new FakeTurnProcess();
    step(state, { kind: "spawn_settled", child }, config);
    const lineEffects: KimiEffect[] = [];
    for (const line of lines) {
      lineEffects.push(...step(state, { kind: "child_line", line }, config));
    }
    const settled = step(state, { kind: "children_settled" }, config);
    const completed = [...lineEffects, ...settled].find(
      (effect): effect is Extract<
        KimiEffect,
        { kind: "emit"; event: "turn_completed" }
      > => effect.kind === "emit" && effect.event === "turn_completed"
    );
    if (completed === undefined) {
      throw new Error("the end path carried no turn_completed emit");
    }
    return { lineEffects, finish: completed.finish, reason: completed.reason };
  };

  /** The fatal error effect the malformed loop raised, if any. */
  const fatalError = (
    effects: KimiEffect[]
  ): Extract<KimiEffect, { kind: "error" }> | undefined =>
    effects.find(
      (effect): effect is Extract<KimiEffect, { kind: "error" }> =>
        effect.kind === "error" && effect.fatal
    );

  test("a repeated tool call id is a grammar error, never a stacked call", () => {
    // Correctness major 3, first shape: the loop keys calls by id, so one
    // id names exactly one open call — a harness repeating it cannot say
    // which result answers which call. The old set-difference bookkeeping
    // let the duplicate stack silently; the session now fails on the
    // grammar error, the raw line still goes out, and the turn's
    // completion is the end path's failed synthesis.
    const { lineEffects, finish, reason } = runMalformed([
      assistantCall("call-1"),
      assistantCall("call-1"),
    ]);
    const error = fatalError(lineEffects);
    expect(error).toBeDefined();
    expect(error!.source).toBe("harness");
    expect(error!.message).toContain("repeated the tool call id call-1");
    expect(finish).toBe("failed");
    expect(reason).toContain("repeated the tool call id call-1");
  });

  test("a tool call id cannot be reused after its result in the same turn (al39)", () => {
    const { lineEffects, finish, reason } = runMalformed([
      assistantCall("call-1"),
      toolResult("call-1"),
      assistantCall("call-1"),
    ]);
    expect(fatalError(lineEffects)?.message).toContain("repeated the tool call id call-1");
    expect(lineEffects.filter((effect) => effect.kind === "emit" && effect.event === "tool_call"))
      .toHaveLength(1);
    expect(finish).toBe("failed");
    expect(reason).toContain("repeated the tool call id call-1");
  });

  test("a tool result for an id the loop never opened is a grammar error", () => {
    // Correctness major 3, second shape: a result for an unknown id has
    // no call to answer — the old bookkeeping dropped it into the set
    // difference and the loop read resolved when it was not.
    const { lineEffects, finish } = runMalformed([toolResult("call-9")]);
    const error = fatalError(lineEffects);
    expect(error).toBeDefined();
    expect(error!.message).toContain(
      "the call id call-9 the loop never opened, or one it already answered"
    );
    expect(finish).toBe("failed");
  });

  test("a second result for one call is a grammar error, never a resolved loop", () => {
    // Correctness major 3, third shape: the result arriving twice is the
    // mirror of the unknown id — one call, two answers — and the map's
    // keying fails it the same way instead of letting the loop close
    // early behind a duplicate the harness may replay.
    const { lineEffects, finish } = runMalformed([
      assistantCall("call-1"),
      toolResult("call-1"),
      toolResult("call-1"),
    ]);
    const error = fatalError(lineEffects);
    expect(error).toBeDefined();
    expect(error!.message).toContain(
      "the call id call-1 the loop never opened, or one it already answered"
    );
    expect(finish).toBe("failed");
  });
});

describe("kimi machine - every spawn abandonment declares hold_release (al35)", () => {
  const config = { authorPrefix: true, registryEnabled: false };

  test("the ending-phase spawn_settled arm stops the child and declares the hold", () => {
    // Contracts-2 minor: the arm that abandons an in-flight spawn when
    // the end path had already passed its waits was the only abandonment
    // without a hold_release effect — the effect union's own contract
    // says an abandoned spawn comes with one, and a consumer tracking
    // holds from the effect stream would have missed this one. The arm
    // is defensive (the grace arm awaits the spawn, the killing arm
    // abandons it earlier), so the state is forced to the shape it
    // guards: phase `ending`, spawn still in flight, not yet abandoned.
    const state = initialKimiState(null);
    step(state, { kind: "run_started" }, config);
    step(
      state,
      { kind: "user_input", line: JSON.stringify({ type: "user", text: "probe" }) },
      config
    );
    state.phase = "ending"; // the forced defensive shape
    const child = new FakeTurnProcess();
    const effects = step(state, { kind: "spawn_settled", child }, config);
    expect(effects).toEqual([
      { kind: "stop_child", child },
      { kind: "hold_release" },
    ]);
    expect(state.spawnAbandoned).toBe(true);
    expect(state.spawnInFlight).toBe(false);
  });
});

describe("kimi machine - ended absorbs and counts", () => {
  test("every event in ended is ignored and counted, and nothing is emitted", () => {
    const config = { authorPrefix: true, registryEnabled: false };
    const state = initialKimiState(null);
    const fatal: KimiEvent = {
      kind: "fatal",
      source: "codemux",
      message: "the outbound queue failed",
    };
    step(state, fatal, config); // the first cause
    step(state, { kind: "children_settled" }, config); // the executor's tail
    expect(state.phase).toBe("ended");
    const stray: TurnChild = new FakeTurnProcess();
    const after: KimiEvent[] = [
      { kind: "run_started" },
      { kind: "user_input", line: JSON.stringify({ type: "user", text: "late" }) },
      { kind: "spawn_settled", child: stray },
      { kind: "spawn_failed", error: new Error("late") },
      { kind: "child_line", line: "not json" },
      { kind: "child_exit", child: stray, outcome: { code: 0, signal: null }, usage: emptyUsage() },
      { kind: "stdin_eof" },
      { kind: "signal" },
      { kind: "session_timeout" },
      fatal,
      { kind: "registry_error", message: "late" },
      { kind: "record_outcome", ok: true },
      { kind: "children_settled" }, // the once-only transition, again
    ];
    const ignoredBefore = state.end.ignored;
    for (const event of after) {
      expect(step(state, event, config)).toEqual([]);
    }
    expect(state.end.ignored).toBe(ignoredBefore + after.length);
  });
});

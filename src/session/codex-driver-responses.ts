/**
 * The codex driver's JSON-RPC response side: handshake and thread
 * continuation, the session announcement both start paths share, and the
 * response-error verdicts. src/session/codex-driver.ts owns the
 * lifecycle.
 */

import {
  buildInitializedNotification,
  buildThreadResumeRequest,
  buildThreadStartRequest,
  CODEX_THREAD_ID_PATTERN,
} from "./codex-session.js";
import { buildSessionStarted, buildUnknownEvent } from "./protocol.js";
import { isCallerHarnessHome, recordedHarnessHome } from "./harness-home.js";
import { CodexDriverSteer } from "./codex-steer.js";
import { inputSeqList } from "./codex-turns.js";
import type { PendingCall } from "./codex-driver-io.js";

export abstract class CodexDriverResponses extends CodexDriverSteer {
  /** Run the session-start machinery both start paths share: the FSM
   * transition, the registry record, the announcement, and the buffered
   * input replay. The announcement follows the record's verdict: a
   * required record that failed must not announce — §4.8's fail-closed
   * rule, nothing is vouchable — while a record that succeeded announces
   * even while an end path drains, so the registry and the caller agree
   * the session existed. A null registryPath records nothing and always
   * announces. `rawLine` is the notification the announcement mirrors on
   * the thread/started path, null on the response-adoption path
   * (codemux-originated). */
  protected announceSession(rawLine: string | null): void {
    const error = this.fsm.transition({ kind: "session_started" });
    if (error !== null) {
      this.emitGrammarViolation(rawLine, error.message);
      void this.finish("crash", 1);
      return;
    }
    this.recordStart();
    if (
      this.settled ||
      (this.options.registryPath !== null && !this.registryRecorded)
    ) {
      return;
    }
    this.emit(
      buildSessionStarted(++this.seq, this.sessionIdOrEmpty(), rawLine, {
        agent: "codex",
        model: this.options.model ?? null,
        autonomy: this.options.autonomy,
        cwd: this.options.cwd,
        sandboxed: this.options.sandboxed,
        sandbox_trust: this.options.sandboxTrust,
        capabilities: this.capabilities,
        protocol: "codemux-live-session/1",
        // The hermetic session's private home, named as the resume guard
        // finds it (the settled path keyed by this thread id); a plain
        // session reports null. The key is always present (the protocol
        // doc promises no omission).
        private_home:
          this.options.privateHome != null
            ? recordedHarnessHome(this.options.privateHome, this.sessionIdOrEmpty())
            : null,
        // The thread response's model is the harness naming what it
        // configured (source `harness`, design P5); the provider's own
        // reroute naming lands on each turn's completion.
        model_served: this.harnessModel,
        model_served_source: this.harnessModel !== null ? "harness" : null,
        model_alias: this.options.modelAlias ?? null,
      })
    );
    while (this.preSessionLines.length > 0 && !this.finished) {
      this.handleCallerLine(this.preSessionLines.shift() as string);
    }
    this.preSessionBytes = 0;
    this.drainTurnQueue();
  }

  /** The model thread/start and thread/resume carry: `wireModel` when the
   * caller computed one (null sends none — the provider-override rule),
   * else `model`. */
  private threadWireModel(): string | undefined {
    const wire = this.options.wireModel;
    if (wire === null) return undefined;
    return wire ?? this.options.model;
  }

  /** The thread builders' hermetic arm (round 413, item 1): either flag
   * says hermetic — the same predicate the call ledger records with — so
   * a launcher that hands only the private home still skips AGENTS.md
   * discovery, and a plain session loads project documents exactly as a
   * plain codex run does. */
  private threadHermetic(): boolean {
    return this.options.projectSettings !== true &&
      (this.options.hermetic === true || (this.options.privateHome != null && !isCallerHarnessHome(this.options.privateHome)));
  }

  protected applyResponse(id: number | string, result: unknown, rawLine: string): void {
    // Request ids are matched strictly: codemux numbers every request it
    // sends, so a string id — even a numeric-looking "1" — is not the
    // reply to any call this driver made. `Number(id)` accepted it
    // (review live15).
    if (typeof id !== "number") {
      this.emitGrammarViolation(rawLine, `a response references unknown request id ${String(id)}`);
      void this.finish("crash", 1);
      return;
    }
    const pending = this.pendingCalls.get(id);
    if (pending === undefined) {
      // Tier 2: a response nothing asked for breaks the request/response
      // grammar the whole driver is built on.
      this.emitGrammarViolation(rawLine, `a response references unknown request id ${String(id)}`);
      void this.finish("crash", 1);
      return;
    }
    this.pendingCalls.delete(id);
    if (pending === "initialize" || pending === "thread_start" || pending === "thread_resume") {
      if (this.finished) {
        // The handshake is codemux's own continuation chain — initialize
        // answers into thread/start or thread/resume, which answers into
        // the announcement — and it stops the moment an end path began:
        // the response is consumed, nothing further is sent, adopted, or
        // recorded, and the caller's already-acked shutdown stays the
        // verdict. This is deliberately unlike the claude family's init
        // frame and agy's first result, which are harness-initiated
        // identity frames carrying the first real content and keep the
        // live5 announce-during-drain rule (review live15).
        return;
      }
    }
    if (pending === "initialize") {
      // Wire order, as the fixture recorded it: the initialized
      // notification, then the thread request.
      // A refused write started the crash end; the thread request would
      // follow it into a harness that stopped reading (review live23).
      if (!this.writeToHarness(buildInitializedNotification())) return;
      this.call(
        this.options.resumeThreadId === null ? "thread_start" : "thread_resume",
        (nextId) =>
          this.options.resumeThreadId === null
            ? buildThreadStartRequest(
                nextId,
                this.policy,
                this.options.cwd,
                this.threadWireModel(),
                this.threadHermetic(),
                this.options.tools,
                this.options.noToolsCatalog
              )
            : buildThreadResumeRequest(
                nextId,
                this.options.resumeThreadId,
                this.policy,
                this.options.cwd,
                this.threadWireModel(),
                this.threadHermetic(),
                this.options.tools,
                this.options.noToolsCatalog
              )
      );
      return;
    }
    if (pending === "thread_start" || pending === "thread_resume") {
      const thread = (result as { thread?: unknown } | null)?.thread;
      const threadId = (thread as { id?: unknown } | null)?.id;
      // The harness's own model naming (design P5), read before any
      // announce this branch can trigger: the fresh path announces at the
      // thread/started notification (which the recorded wire sends after
      // the response), the resume path right here.
      const responseModel = (result as { model?: unknown } | null)?.model;
      if (typeof responseModel === "string" && responseModel.length > 0) {
        this.harnessModel = responseModel;
      }
      if (typeof threadId !== "string" || threadId.length === 0) {
        this.emitGrammarViolation(rawLine, "the thread response carries no thread id");
        void this.finish("crash", 1);
        return;
      }
      // The registry key and the `--resume` argument: an id `--resume`
      // would refuse is refused here too (review live16).
      if (!CODEX_THREAD_ID_PATTERN.test(threadId)) {
        this.emitGrammarViolation(rawLine, "the thread response carries an invalid thread id");
        void this.finish("crash", 1);
        return;
      }
      if (pending === "thread_resume" && threadId !== this.options.resumeThreadId) {
        // The response's thread.id is the subscription proof — the echo
        // the reference clients of the same app-server validate — and it
        // was never checked: `threadId` is preset to the requested id at
        // construction, so the adopt-if-null below never ran for a
        // resume, and a server that resumed into a DIFFERENT thread left
        // codemux recording and announcing the requested id while the
        // harness ran another thread — later turn/start and steer
        // requests would go to an id the server may not hold (review
        // live12). Fail closed: name both ids and end.
        this.emitGrammarViolation(
          rawLine,
          `the app-server resumed thread ${threadId}, not the requested ${this.options.resumeThreadId}`
        );
        void this.finish("crash", 1);
        return;
      }
      if (this.threadId !== null && threadId !== this.threadId) {
        // The fresh-thread sibling of the resume echo check: a
        // thread/started notification may adopt the id BEFORE the
        // thread/start response answers (the starting-state path below),
        // and the response was then never compared with what was adopted
        // (review live15) — two ids for one session, with turn/start
        // aimed at whichever one this branch happened to keep. Fail
        // closed naming both, like the resume mismatch.
        this.emitGrammarViolation(
          rawLine,
          `the app-server started thread ${threadId}, not the announced ${this.threadId}`
        );
        void this.finish("crash", 1);
        return;
      }
      if (this.threadId === null) this.threadId = threadId;
      if (pending === "thread_resume" && this.fsm.state === "starting") {
        // The resume response is itself the subscription proof — its
        // thread.id echoes the requested id (checked above), which is
        // exactly what the reference clients of the same app-server
        // validate; none of them waits for a thread/started on resume,
        // and the real server does not send one there (re-proven live,
        // review live11). Start the session from the response; a late
        // thread/started (a server that announces anyway) passes through
        // as tier-1 unknown in the notification case above. A fresh
        // thread/start keeps waiting for the notification, which the
        // recorded fixture proves follows.
        this.announceSession(null);
      }
      return;
    }
    if (typeof pending === "object" && pending.kind === "turn_start") {
      const turn = (result as { turn?: unknown } | null)?.turn;
      const turnId = (turn as { id?: unknown } | null)?.id;
      if (typeof turnId !== "string" || turnId.length === 0) {
        // A success the server answered without naming its turn: the
        // turn may well be running, and without its id codemux can
        // neither interrupt nor steer it. Failing only the codemux turn
        // sent the next queued turn/start to a busy thread (review
        // live22), so the session ends instead; the end path stops the
        // child and synthesizes the failed completion.
        this.emitGrammarViolation(rawLine, "the turn/start response carries no turn id");
        void this.finish("crash", 1);
        return;
      }
      if (pending.turnId !== this.fsm.activeTurn) {
        // The response's turn completed before the response arrived (a
        // fast server emits turn/completed first, review round 232): the
        // codemux turn is closed, its harness id was adopted and closed
        // at completion, and adopting the id here would scope the next
        // turn's window to a dead id. The response must still name the
        // turn that completion adopted for this very request (recorded on
        // the pending call, so neither the bounded closed-turn set nor a
        // second request's turn can stand in for it: review rounds 235
        // and 244). This branch runs before the pending-id comparison
        // below, because by now a later turn may own the pending id — its
        // first notification arrived while this response was still in
        // flight — and that id is no contradiction of this one (review
        // round 238). A turn that closed with no harness id at all (ended
        // before any notification named it) keeps the older rule: the
        // response is consumed. The buffered interrupt and steers were
        // cleared at completion, each with the notice naming its seq
        // (review round 341); nothing else is owed here.
        if (pending.completedHarnessTurnId !== undefined && pending.completedHarnessTurnId !== turnId) {
          this.emitGrammarViolation(
            rawLine,
            `the turn/start response names turn ${turnId}, which this session never saw complete`
          );
          void this.finish("crash", 1);
        }
        return;
      }
      if (this.pendingTurnId !== null && this.pendingTurnId !== turnId) {
        // The window's notifications were charged to the starting turn on
        // the strength of their id; a response naming another turn means
        // they belonged to a turn this session never started (round 67).
        this.emitGrammarViolation(
          rawLine,
          `the turn/start response names turn ${turnId} but the notifications that arrived while it was in flight named ${this.pendingTurnId}`
        );
        void this.finish("crash", 1);
        return;
      }
      this.pendingTurnId = null;
      this.harnessTurnId = turnId;
      // An interrupt buffered while the harness turn id was unknown.
      if (this.interruptQueued) {
        this.interruptQueued = false;
        const queuedSeq = this.interruptQueuedSeq;
        this.interruptQueuedSeq = null;
        const delivered = this.deliverInterrupt();
        if (!delivered) {
          // The refused write just started the crash end, whose own
          // interrupt (already sent, inside finish's synchronous prefix)
          // is what will answer the turn. The queued interrupt never
          // reached the harness, so the timeout label it carried cannot
          // ride that completion: the label names only an interrupt the
          // timeout produced (completeTurn's rule, review live23).
          this.interruptFromTimeout = false;
          if (queuedSeq !== null) {
            this.emitError(
              false,
              "codemux",
              `the interrupt accepted while the turn was starting (input_seq ${queuedSeq}) could not be delivered`
            );
          }
        }
      }
      this.flushSteer();
      return;
    }
    // steer and interrupt responses carry nothing codemux needs.
  }

  protected applyResponseError(id: number | string, message: string, rawLine: string): void {
    // Strict ids, as in applyResponse: codemux numbers its requests
    // (review live15).
    if (typeof id !== "number") {
      this.emitGrammarViolation(rawLine, `an error response references unknown request id ${String(id)}`);
      void this.finish("crash", 1);
      return;
    }
    const pending = this.pendingCalls.get(id);
    if (pending === undefined) {
      this.emitGrammarViolation(rawLine, `an error response references unknown request id ${String(id)}`);
      void this.finish("crash", 1);
      return;
    }
    this.pendingCalls.delete(id);
    if (pending === "initialize" || pending === "thread_start" || pending === "thread_resume") {
      if (this.finished) {
        // The success branch stops once an end path began (review
        // live15); its failure sibling does too — the session the caller
        // already ended does not become a crash because a handshake
        // response nobody waits for was an error.
        return;
      }
      // Tier 2: without the handshake the session never existed.
      this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
      this.emitError(true, "harness", `the app-server rejected the ${callLabel(pending)} request: ${message}`);
      void this.finish("crash", 1);
      return;
    }
    if (typeof pending === "object" && pending.kind === "turn_start") {
      if (pending.turnId !== this.fsm.activeTurn) {
        // The turn this request started already completed through its
        // notifications (the early-completion ordering of review round
        // 232) and may have drained the next turn into the active slot:
        // failing the open turn would fail that later turn while the
        // harness still runs it (review round 241). The completed turn
        // reported its own finish; the late refusal is recorded and
        // changes nothing.
        this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
        return;
      }
      this.failOpenTurn(message, rawLine);
      return;
    }
    // A steer or interrupt that failed: the turn keeps running; the
    // caller hears about it without losing the session. A rejected
    // interrupt never happened, so its pending flags must not color the
    // turn's completion — the real finish stands. But only when the
    // rejection is this interrupt's own call: a stale rejection (its
    // turn completed first, a later turn's interrupt is already pending)
    // must not clear the next turn's state (review live11).
    if (pending === "interrupt" && id === this.interruptCallId) {
      this.interruptFromTimeout = false;
      this.interruptCallId = null;
    }
    // A rejected steer names the lines it carried and their turn: the
    // caller saw them acked and echoed, and the harness never got them
    // (review live23).
    const steered =
      typeof pending === "object" && pending.kind === "steer"
        ? ` (${inputSeqList(pending.inputSeqs)}${pending.turnId !== null ? `, turn ${pending.turnId}` : ""}; the text did not reach the turn)`
        : "";
    this.emitError(
      false,
      "harness",
      `the app-server rejected the ${callLabel(pending)} request${steered}: ${message}`
    );
  }

}

function callLabel(call: PendingCall): string {
  if (typeof call === "string") return call.replaceAll("_", "/");
  return call.kind;
}

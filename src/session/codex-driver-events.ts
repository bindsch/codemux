/**
 * The codex driver's harness-side event handling: one stdout line fed
 * through the parser, each parse applied to the session as an emitted
 * event, an approval, or an end path. src/session/codex-driver.ts owns
 * the lifecycle.
 */

import {
  buildJsonRpcErrorResponse,
  offersRefusal,
  type CodexParse,
} from "./codex-session.js";
import { accumulateUsage, addTurnUsage } from "./usage.js";
import { buildEvent, buildUnknownEvent } from "./protocol.js";
import { approvalMethod } from "./codex-driver-approvals.js";
import { CodexDriverResponses } from "./codex-driver-responses.js";

export abstract class CodexDriverEvents extends CodexDriverResponses {
  /** One line from the harness stdout. Never throws. Lines are parsed and
   * emitted until the end path settles (`settled`): the shutdown grace
   * window is exactly the interval in which the harness's last output —
   * the end-interrupt's response, the interrupted turn's completion, its
   * usage — is still arriving, and dropping it there would report a
   * session that ended mid-sentence. */
  override handleHarnessLine(line: string): void {
    if (this.proc === null) {
      this.earlyLines.push(line);
      return;
    }
    if (this.settled) return;
    const wasEnding = this.finished;
    const parses = this.parser.feed(line, {
      threadId: this.threadId,
      activeTurnId: this.harnessTurnId,
      closedTurnIds: this.closedHarnessTurnIds,
      // The window between sending turn/start and its response naming
      // the harness turn: scoped events there belong to that turn and
      // cannot be checked against an id (review round 64).
      turnPending: this.harnessTurnId === null && this.turnStartInFlight(),
      pendingTurnId: this.pendingTurnId,
    });
    for (const parse of parses) {
      this.noteProvisionalTurn(parse);
      this.applyParse(parse, line);
      // A parse that started the end path ends this line's application;
      // parses that arrive while an already-running end path drains still
      // apply, all the way to settlement.
      if (this.settled || (!wasEnding && this.finished)) return;
    }
  }

  /** The first turn id a scoped notification names while the turn/start
   * response is in flight is the starting turn's provisional id (round
   * 67); the parser holds the window to it and the response must confirm
   * it. Stragglers of closed turns name nothing new. */
  private noteProvisionalTurn(parse: CodexParse): void {
    if (this.harnessTurnId !== null || this.pendingTurnId !== null) return;
    if (!("turnId" in parse) || typeof parse.turnId !== "string") return;
    if (this.closedHarnessTurnIds.has(parse.turnId)) return;
    if (this.turnStartInFlight()) this.pendingTurnId = parse.turnId;
  }

  // --- harness side -----------------------------------------------------

  private applyParse(parse: CodexParse, rawLine: string): void {
    switch (parse.kind) {
      case "unusable":
        // Tier 3 (§4.2): the fatal report carries the excerpt; the line
        // itself is not mirrored (there is no event to preserve).
        this.emitError(
          true,
          "harness",
          `unusable harness output (not JSON, ${parse.bytes} bytes): ${parse.excerpt}`
        );
        void this.finish("crash", 1);
        return;
      case "grammar_error":
        // Tier 2: the raw event still goes out, then the fatal end.
        this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
        this.emitError(true, "harness", parse.message);
        void this.finish("crash", 1);
        return;
      case "response":
        this.applyResponse(parse.id, parse.result, rawLine);
        return;
      case "response_error":
        this.applyResponseError(parse.id, parse.message, rawLine);
        return;
      case "thread_started": {
        if (this.fsm.state !== "starting" || this.finished) {
          // The session already started — the resume path adopted it from
          // the thread/resume response (review live11) — or an end path
          // began mid-handshake and the codemux-initiated chain stopped
          // (review live15). A thread/started landing now is a benign
          // duplicate on the first path and a dead echo on the second:
          // tier-1 passthrough either way, never a fatal (the parser's
          // seen-once flag cannot know the driver adopted ahead of the
          // notification), and never an adoption or announcement.
          this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
          return;
        }
        if (this.threadId !== null && parse.threadId !== this.threadId) {
          // The mirror of the response-side cross-check: the thread
          // response may have adopted an id before this notification
          // arrived (the fresh path adopts from whichever comes first),
          // and one session cannot run under two ids (review live15).
          this.emitGrammarViolation(
            rawLine,
            `the app-server announced thread ${parse.threadId}, not the adopted ${this.threadId}`
          );
          void this.finish("crash", 1);
          return;
        }
        if (this.threadId === null) this.threadId = parse.threadId;
        this.announceSession(rawLine);
        return;
      }
      case "turn_started":
        // The caller's turn_started went out at submit; the harness's
        // notification is an echo of that announcement and mirrors as
        // tier-1 unknown, never silently dropped — the same rule as the
        // claude family's replay echo of codemux's own user line
        // (review live15).
        this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
        return;
      case "assistant_delta":
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "assistant_delta", rawLine, {
            delta: parse.text,
            turn_id: this.turnIdFor(parse.turnId),
          })
        );
        return;
      case "assistant_text":
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "assistant_message", rawLine, {
            text: parse.text,
            turn_id: this.turnIdFor(parse.turnId),
          })
        );
        return;
      case "tool_call":
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "tool_call", rawLine, {
            call_id: parse.callId,
            name: "commandExecution",
            input: parse.input,
          })
        );
        return;
      case "tool_result":
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "tool_result", rawLine, {
            call_id: parse.callId,
            output: parse.output,
            is_error: parse.isError,
          })
        );
        return;
      case "file_change":
        // Native on codex (§4.3): no `derived` marker.
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "file_change", rawLine, {
            path: parse.path,
            action: parse.action,
          })
        );
        return;
      case "usage": {
        // Per-turn accumulation for the open turn: the session cumulative
        // folds at turn completion (§4.2), so a notification is never
        // counted twice. A notification that belongs to no open turn — it
        // landed after its turn's `turn/completed`, with no turn open or
        // before the next turn's id is known — was being charged to the
        // NEXT turn (review live18). It is real usage, so it folds into
        // the session cumulative directly and its event carries a null
        // `turn_id`. While the open turn's harness id is known, the
        // parser has already checked the notification names it.
        // A notification naming the closed turn is late even after the
        // next turn's id is known: the parser accepts it as a straggler
        // then (review live20 — it was a grammar error that ended the
        // session when queued input opened the next turn at once).
        const forOpenTurn =
          this.fsm.state === "turn_active" &&
          !(typeof parse.turnId === "string" && this.closedHarnessTurnIds.has(parse.turnId)) &&
          (this.harnessTurnId !== null || typeof parse.turnId === "string");
        if (forOpenTurn) {
          this.turnUsage = accumulateUsage(this.turnUsage, parse.usage);
        } else {
          this.cumulative = addTurnUsage(this.cumulative, parse.usage);
        }
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "usage", rawLine, {
            turn_id: forOpenTurn ? this.fsm.activeTurn : null,
            usage: parse.usage,
          })
        );
        return;
      }
      case "model_rerouted": {
        // The provider rerouted the open turn's model (design P5): no
        // event of its own — the turn's completion reports the model as
        // `model_served` — but the notification is still mirrored raw,
        // never silently dropped. No open turn (the notification raced a
        // completion, or the session is idle) can attribute a turn, so
        // the model is dropped and the raw mirror stands alone.
        if (this.fsm.state === "turn_active") {
          this.turnReroutedModel = parse.model;
        }
        this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
        return;
      }
      case "turn_completed":
        this.completeTurn(parse, rawLine);
        return;
      case "permission_request": {
        if (
          parse.kindOfApproval === "commandExecution" &&
          !offersRefusal(parse.input["availableDecisions"])
        ) {
          // An approval whose availableDecisions carry neither "decline"
          // nor "cancel" has no refusal codemux may send, and a decision
          // the server did not offer could be rejected, leaving the
          // approval open and the turn hung after the caller had been
          // told deny (review live17). Such a request never reaches the
          // caller: it is answered with a JSON-RPC error (a protocol
          // answer, not a decision), passed through raw, and the turn is
          // interrupted so it cannot wait on it.
          // The raw line goes out before the answer: a refused write
          // ends the session, and its fatal must follow the line, with no
          // "answered" notice after it (review live23).
          this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
          const answered = this.writeToHarness(
            buildJsonRpcErrorResponse(
              parse.id,
              -32602,
              "codemux: the approval offered no refusal decision; refused"
            )
          );
          if (!answered) return;
          const interrupting = this.fsm.state === "turn_active" && !this.finished;
          this.emitError(
            false,
            "harness",
            `an approval request offered no refusal decision; it was answered with an error${interrupting ? " and the turn interrupted" : ""}`
          );
          if (interrupting) {
            this.supersedeApprovals();
            if (!this.finished) this.sendInterrupt();
          }
          return;
        }
        const requestPayload = {
          request_id: parse.requestId,
          tool: parse.kindOfApproval,
          input: parse.input,
          options: this.allowDeliverable(parse.kindOfApproval, parse.input)
            ? ["allow", "deny"]
            : ["deny"],
        };
        if (this.options.permissionPolicy === "deny") {
          this.emit(buildEvent(
            ++this.seq, this.sessionIdOrEmpty(), "permission_request", rawLine, requestPayload
          ));
          if (!this.writeToHarness(this.approvalDecline(
            parse.id, approvalMethod(parse.kindOfApproval), parse.input["availableDecisions"]
          ))) return;
          // Codex declines carry no message. Like the Claude deny policy,
          // this answers before creating pending state or an expiry timer.
          this.emit(buildEvent(++this.seq, this.sessionIdOrEmpty(), "permission_denied", null, {
            request_id: parse.requestId,
            tool: parse.kindOfApproval,
          }));
          return;
        }
        const error = this.fsm.addPending(parse.requestId);
        if (error !== null) {
          this.emitGrammarViolation(rawLine, error.message);
          void this.finish("crash", 1);
          return;
        }
        this.pendingApprovals.set(parse.requestId, {
          id: parse.id,
          kind: parse.kindOfApproval,
          input: parse.input,
        });
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "permission_request", rawLine, requestPayload)
        );
        if (this.finished) {
          // The drain window: caller decisions are already refused and
          // the expiry timers are cleared with every other on the end
          // path, so a request landing now could never be decided — yet
          // the app-server waits on its answer inside the very grace
          // window that exists so it can persist. Decline it at once
          // with the same supersede treatment `finish` gave the
          // approvals it found pending (review live8).
          this.supersedeApprovals();
          return;
        }
        const timer = setTimeout(
          () => this.expireApproval(parse.requestId),
          this.options.permissionTimeoutMs
        );
        timer.unref?.();
        this.pendingTimers.set(parse.requestId, timer);
        return;
      }
      case "unparseable_approval": {
        // The request could not be judged, so it is declined — never
        // silently ignored — and the raw event reaches the caller with a
        // non-fatal error (§4.2: permission shapes never kill a session).
        // Raw line first, then the answer (review live23, as above).
        this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
        if (!this.writeToHarness(this.approvalDecline(parse.id, parse.method, null))) return;
        this.emitError(
          false,
          "harness",
          `an approval request could not be parsed and was declined (${parse.method})`
        );
        return;
      }
      case "server_request": {
        // A server request codemux does not implement: answered with a
        // JSON-RPC error and passed through raw — never silently
        // dropped (§4.7).
        // Raw line first, then the answer (review live23, as above).
        this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
        const answered = this.writeToHarness(
          buildJsonRpcErrorResponse(
            parse.id,
            -32601,
            `codemux does not implement ${parse.method}`
          )
        );
        if (!answered) return;
        this.emitError(
          false,
          "harness",
          `the app-server sent a request codemux does not implement (${parse.method}); it was answered with an error`
        );
        return;
      }
      case "unknown":
        this.emit(buildUnknownEvent(++this.seq, this.sessionIdOrEmpty(), rawLine));
        return;
    }
  }
}

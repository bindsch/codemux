/**
 * The claude-family driver's harness-side dispatch: applyParse, the one
 * switch over every stream parse kind, and the derived file-change
 * candidates it stashes and confirms. src/session/driver.ts owns the
 * lifecycle.
 */

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  buildControlErrorResponse,
  buildControlResponse,
  DEFAULT_DENIAL_MESSAGE,
  type ClaudeParse,
} from "./claude-session.js";
import { buildEvent, buildPermissionDenied, buildUnknownEvent } from "./protocol.js";
import { ClaudeDriverTurns } from "./driver-turns.js";

export abstract class ClaudeDriverEvents extends ClaudeDriverTurns {

  /** Derived file-change candidates waiting on their tool's result
   * (§4.3): stashed when the tool_use frame arrives — before the
   * permission round-trip — and emitted as `file_change` only when the
   * matching tool_result reports success. A denied or failed call
   * changed nothing, so its candidate is dropped silently; a candidate
   * whose turn completed without its result is dropped with the turn,
   * so no later turn's reused or delayed call id can confirm it (review
   * round 259); and entries left behind at session end (a tool that
   * never reported) stay unreported the same way — an unknown outcome is
   * not a change (review live10). */
  private readonly pendingFileChanges = new Map<
    string,
    { path: string; action: "add" | "edit"; rawLine: string }
  >();

  /** Turn completion's half of the candidate rule (completeTurn calls
   * this beside the permission supersede): the map belongs to the open
   * turn, so it empties when the turn ends. */
  protected dropPendingFileChanges(): void {
    this.pendingFileChanges.clear();
  }

  protected applyParse(parse: ClaudeParse, rawLine: string): void {
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
        this.emit(buildUnknownEvent(++this.seq, this.options.sessionId, rawLine));
        this.emitError(true, "harness", parse.message);
        void this.finish("crash", 1);
        return;
      case "init": {
        const error = this.fsm.transition({ kind: "session_started" });
        if (error !== null) {
          this.emitGrammarViolation(rawLine, error.message);
          void this.finish("crash", 1);
          return;
        }
        this.recordStart();
        // The announcement follows the record's verdict: a required
        // record that failed must not announce — §4.8's fail-closed rule,
        // nothing is vouchable (and `settled` alone would let the drained
        // init of a registry-failed start announce) — while a record that
        // succeeded announces even while an end path drains, so the
        // registry and the caller agree the session existed. A null
        // registryPath records nothing and always announces.
        if (
          this.settled ||
          (this.options.registryPath !== null && !this.registryRecorded)
        ) {
          return;
        }
        this.emit(
          buildEvent(++this.seq, this.options.sessionId, "session_started", null, {
            agent: this.options.agent,
            model: this.options.model ?? null,
            autonomy: this.options.autonomy,
            cwd: this.options.cwd,
            sandboxed: this.options.sandboxed,
            sandbox_trust: this.options.sandboxTrust,
            capabilities: this.capabilities,
            protocol: "codemux-live-session/1",
          })
        );
        // Input accepted before the init frame arrived was forwarded but
        // only counted; opening the session must also open that turn, or
        // the first result meets an idle FSM and ends the session
        // fatally. This is the pre-init-arrival path (the CLI spawns the
        // harness and immediately relays caller stdin).
        if (this.openerPending && !this.finished) {
          this.openerPending = false;
          const opened = this.startTurn();
          if (opened !== null && this.interruptBeforeInit) {
            this.interruptBeforeInit = false;
            if (!this.sendInterrupt()) {
              this.emitError(
                false,
                "codemux",
                `the interrupt accepted before the session started (input_seq ${this.interruptBeforeInitSeq}) could not be delivered`
              );
            }
          }
        }
        return;
      }
      case "assistant_delta":
        this.emit(
          buildEvent(++this.seq, this.options.sessionId, "assistant_delta", rawLine, {
            delta: parse.text,
            turn_id: this.fsm.activeTurn,
          })
        );
        return;
      case "assistant_text":
        this.emit(
          buildEvent(++this.seq, this.options.sessionId, "assistant_message", rawLine, {
            text: parse.text,
            turn_id: this.fsm.activeTurn,
          })
        );
        return;
      case "tool_call":
        this.emit(
          buildEvent(++this.seq, this.options.sessionId, "tool_call", rawLine, {
            call_id: parse.callId,
            name: parse.name,
            input: parse.input,
          })
        );
        return;
      case "tool_result": {
        this.emit(
          buildEvent(++this.seq, this.options.sessionId, "tool_result", rawLine, {
            call_id: parse.callId,
            output: parse.output,
            is_error: parse.isError,
          })
        );
        // The derived change confirms here, not at the tool_use frame:
        // only a successful result proves the write happened (review
        // live10 — the frame arrives before the permission round-trip,
        // so emitting there reported changes that were then denied).
        const candidate = this.pendingFileChanges.get(parse.callId);
        if (candidate !== undefined) {
          this.pendingFileChanges.delete(parse.callId);
          if (!parse.isError) {
            this.emit(
              buildEvent(
                ++this.seq,
                this.options.sessionId,
                "file_change",
                candidate.rawLine,
                {
                  path: candidate.path,
                  action: candidate.action,
                  derived: true,
                }
              )
            );
          }
        }
        return;
      }
      case "file_change":
        // Stash, not emit: the tool_use frame only names a candidate.
        // The Write add/edit split reads the workspace now — before the
        // tool runs — because after a successful write the file always
        // exists; the frame order preserves correctness, each call
        // arriving after the previous tool's result. The existsSync
        // resolves a relative target against the SESSION cwd — the same
        // literal join the ceiling uses — not codemux's own working
        // directory, which the harness never runs in (review live15).
        this.pendingFileChanges.set(parse.callId, {
          path: parse.path,
          action: this.writeAction(parse),
          rawLine,
        });
        return;
      case "permission_request": {
        // The deny policy answers before the request can become pending
        // (the option's doc): no caller decision exists for it, no timer
        // is armed against it, and its one record is the
        // `permission_denied` event — the request itself is still emitted
        // first, so a headless caller sees every ask it denied. The answer
        // carries the default denial text: the agent reads its own
        // harness's rejection, never a wrapper's veto.
        if (this.options.permissionPolicy === "deny") {
          this.emit(
            buildEvent(++this.seq, this.options.sessionId, "permission_request", rawLine, {
              request_id: parse.requestId,
              tool: parse.tool,
              input: parse.input,
              options: ["allow", "deny"],
            })
          );
          const answered = this.writeToHarness(
            buildControlResponse(parse.requestId, "deny")
          );
          if (!answered) return;
          this.emit(
            buildPermissionDenied(
              ++this.seq,
              this.options.sessionId,
              parse.requestId,
              parse.tool,
              DEFAULT_DENIAL_MESSAGE
            )
          );
          return;
        }
        const error = this.fsm.addPending(parse.requestId);
        if (error !== null) {
          this.emitGrammarViolation(rawLine, error.message);
          void this.finish("crash", 1);
          return;
        }
        this.pendingRequests.set(parse.requestId, {
          tool: parse.tool,
          input: parse.input,
        });
        this.emit(
          buildEvent(
            ++this.seq,
            this.options.sessionId,
            "permission_request",
            rawLine,
            {
              request_id: parse.requestId,
              tool: parse.tool,
              input: parse.input,
              options: ["allow", "deny"],
            }
          )
        );
        if (this.finished) {
          // A request landing inside the shutdown drain can never be
          // decided: caller input is already refused once an end request
          // began, and the expiry timer is cleared with every other on
          // the end path — it could only fire at a session that is gone.
          // Deny it at once with the same supersede treatment `finish`
          // gave the requests it found pending (review live8), so the
          // harness never waits on a permission the ending session
          // cannot grant.
          this.supersedePendingDeny();
          return;
        }
        const timer = setTimeout(
          () => this.expirePermission(parse.requestId),
          this.options.permissionTimeoutMs
        );
        timer.unref?.();
        this.pendingTimers.set(parse.requestId, timer);
        return;
      }
      case "unparseable_permission": {
        // A can_use_tool whose payload cannot be read (§4.1's opaque
        // rule): answered deny keyed by request_id so the harness never
        // hangs, the raw frame passes through, and a non-fatal error
        // tells the caller what was denied. Never fatal on shape alone.
        // The raw line goes out before the answer: a refused write ends
        // the session, and its fatal must follow the line, with no
        // "answered" notice after it (review live23).
        this.emit(buildUnknownEvent(++this.seq, this.options.sessionId, rawLine));
        const denied = this.writeToHarness(
          buildControlResponse(parse.requestId, "deny")
        );
        if (!denied) return;
        this.emitError(
          false,
          "harness",
          "a can_use_tool request could not be parsed; answered deny"
        );
        return;
      }
      case "unsupported_control_request": {
        // A control request codemux does not implement: answered with the
        // control protocol's error response when its id can be echoed, so
        // the harness never waits on it, then passed through raw with a
        // non-fatal error (review live18; codex answers its unknown server
        // requests with -32601 the same way). Never fatal on shape alone.
        // Raw line first, then the answer (review live23, as above).
        this.emit(buildUnknownEvent(++this.seq, this.options.sessionId, rawLine));
        if (
          parse.requestId !== null &&
          !this.writeToHarness(
            buildControlErrorResponse(
              parse.requestId,
              `codemux does not implement the ${parse.subtype} control request`
            )
          )
        ) {
          return;
        }
        this.emitError(
          false,
          "harness",
          parse.requestId !== null
            ? `the harness sent a control request codemux does not implement (${parse.subtype}); it was answered with an error`
            : `the harness sent a control request with no usable request id (${parse.subtype}); it could not be answered`
        );
        return;
      }
      case "turn_completed":
        this.completeTurn(parse, rawLine);
        return;
      case "control_error":
        this.emit(buildUnknownEvent(++this.seq, this.options.sessionId, rawLine));
        if (
          this.interruptPending &&
          parse.requestId === this.interruptId
        ) {
          // The harness refused the interrupt: it never happened, so it
          // must not label the turn's own error result interrupted (or
          // turn-timeout), excuse a drain exit, or hold the end path's
          // grace window open (review live22; the codex driver's
          // rejected-interrupt rule).
          this.interruptPending = false;
          this.interruptFromTimeout = false;
          this.emitError(false, "harness", `the harness rejected the interrupt: ${parse.error}`);
        }
        return;
      case "unknown":
        this.emit(buildUnknownEvent(++this.seq, this.options.sessionId, rawLine));
        return;
    }
  }

  /** The add/edit split for a derived file-change candidate (§4.3): a
   * Write over an existing target is an edit, over a missing one an add
   * — read at stash time, before the tool runs. The target resolves
   * against the session cwd the harness runs in (the ceiling's literal
   * join: absolute kept, relative prefixed), because a relative
   * `file_path` is relative to THAT directory, never to codemux's own
   * process cwd (review live15). Edit and NotebookEdit only ever
   * modify, so they are edits regardless. */
  private writeAction(parse: Extract<ClaudeParse, { kind: "file_change" }>): "add" | "edit" {
    if (!parse.write) return "edit";
    const target = isAbsolute(parse.path)
      ? parse.path
      : `${this.options.cwd}/${parse.path}`;
    return existsSync(target) ? "edit" : "add";
  }
}

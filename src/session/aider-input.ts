/**
 * The caller-side input grammar for the aider session driver: one framed
 * stdin line at a time (user/shutdown) plus the stdin close.
 * src/session/aider-driver.ts owns the lifecycle.
 */

import { aiderPromptIsCommand } from "../adapters/aider.js";
import { MAX_ARGV_PROMPT_BYTES } from "../process-runner.js";
import { callerStdinFailure } from "./process.js";
import {
  applyAuthorPrefix,
  buildUserMessage,
  parseInputLine,
} from "./protocol.js";
import { AiderTurns } from "./aider-turns.js";

export abstract class AiderCallerInput extends AiderTurns {
  private stdinClosed = false;

  /** One framed line from the caller's stdin. Never throws. The honest
   * capability matrix has already narrowed the reachable cases to
   * `user` and `shutdown`. */
  handleCallerLine(line: string): void {
    if (line.trim() === "") return;
    if (this.finished) {
      // The input contract (§4.1): during the drain window every line is
      // answered `shutting_down`; once settled, nothing may follow
      // session_ended (review live9).
      if (!this.settled) this.ack(this.fsm.nextInputSeq(), false, "shutting_down");
      return;
    }
    const inputSeq = this.fsm.nextInputSeq();
    const parsed = parseInputLine(line, {
      capabilities: this.capabilities,
      hasActiveTurn: this.fsm.state === "turn_active",
      pendingRequestIds: new Set<string>(),
      shuttingDown:
        this.stdinClosed ||
        this.fsm.state === "shutting_down" ||
        this.fsm.state === "ended",
    });
    if (!parsed.ok) {
      this.ack(inputSeq, false, parsed.reason);
      return;
    }
    const message = parsed.message;
    switch (message.type) {
      case "interrupt": {
        this.ack(inputSeq, true);
        if (!this.finished) this.interruptTurn();
        return;
      }
      case "user": {
        const harnessText = applyAuthorPrefix(
          message.text,
          message.author,
          this.options.authorPrefix
        );
        // The prompt rides argv (`--message=`), so the run path's argv
        // bound is the per-turn cap — checked BEFORE the ack, the same
        // deliverability rule every driver applies to what it is about to
        // send (an accepted line that cannot reach the harness would hang
        // its turn open).
        if (Buffer.byteLength(harnessText, "utf8") > MAX_ARGV_PROMPT_BYTES) {
          this.ack(inputSeq, false, "text_too_long");
          return;
        }
        // Aider would run a text whose first non-whitespace character is
        // `/` or `!` as one of its own commands — /run (the `!` alias)
        // executes the shell immediately, ungated by --dry-run — so the
        // line is refused `unsupported` before the ack rather than
        // delivered: the recorded autonomy must bound what caller text
        // can do (review D10, security; the run path's twin is
        // AiderAdapter.validateRunRequest). Judged on harnessText: the
        // text about to ride argv is what aider dispatches, and an author
        // prefix (`[author] …`) sits ahead of it and neutralizes the
        // dispatch — the line is model prompt text then, never a command.
        if (aiderPromptIsCommand(harnessText)) {
          this.ack(inputSeq, false, "unsupported");
          return;
        }
        this.ack(inputSeq, true);
        // The acknowledgement itself can be the event that breaches the
        // outbound bound and ends the session. The end path then recorded
        // that no turn was open, so no turn may open after it (review
        // round 155).
        if (this.finished) return;
        if (this.fsm.state === "starting") {
          // An input that arrived before run() warmed the FSM up (run()
          // announces; this branch only transitions).
          const error = this.fsm.transition({ kind: "session_started" });
          if (error !== null) {
            this.emitError(true, "codemux", error.message);
            void this.finish("crash", 1);
            return;
          }
        }
        const turnId = this.submitTurn();
        if (turnId === null) return; // transition failure already ended us
        this.emit(
          buildUserMessage(
            ++this.seq,
            this.options.sessionId,
            inputSeq,
            message.text,
            message.author,
            turnId
          )
        );
        // A turn must not spawn after the driver finished (review round
        // 153): an outbound bound breached inside the emits above ends the
        // session synchronously — the queue's failure callback runs
        // finish, which sets `finished` before its first await — so the
        // turn ends with the session instead of spawning a child the end
        // path no longer owns.
        if (this.finished) return;
        void this.startTurn(harnessText);
        return;
      }
      case "shutdown": {
        this.ack(inputSeq, true);
        void this.finish("shutdown", 0);
        return;
      }
    }
  }

  /** The caller closed stdin: the graceful end, exit 0. A read error is
   * not a close (review live17). */
  handleCallerEnd(error?: unknown): void {
    this.stdinClosed = true;
    if (this.settled) {
      if (error !== undefined) console.error(`codemux: ${callerStdinFailure(error)}`);
      return;
    }
    if (this.finished) {
      if (error !== undefined) this.emitError(false, "codemux", callerStdinFailure(error));
      return;
    }
    if (error !== undefined) {
      this.emitError(true, "codemux", callerStdinFailure(error));
      void this.finish("stdin-close", 1);
      return;
    }
    void this.finish("stdin-close", 0);
  }
}

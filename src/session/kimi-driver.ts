/**
 * The kimi session driver (design §4.7): turn-per-process over kimi's
 * own session store. Each caller input spawns one headless kimi process
 * (`--prompt`, `--output-format stream-json`; src/session/kimi-
 * session.ts pins the wire), and its exit is the turn's verdict. State
 * carries across turns through the native session id: a fresh session
 * learns its id from the first turn's `session.resume_hint` meta line
 * — the only line that names one — and every later turn resumes it
 * with `--session <id>`, kimi's own store replaying the transcript.
 *
 * Round al28 makes the driver an EXECUTOR only: every decision lives in
 * the state machine (kimi-machine.ts; the table is documented once, in
 * turn-per-process.ts), and the machinery is split across the chain
 * this file extends: kimi-driver-io.ts holds the options record, the
 * shared state, and the emit/ledger plumbing; kimi-driver-events.ts
 * performs the machine's effects and renders the emitted wire events;
 * kimi-driver-finalize.ts owns the two asynchronous procedures the
 * effects start — the end path (runEndPath: wait for or stop what the
 * state owes, then deliver children_settled, the machine's one
 * transition into `ended`) and the hold (an abandoned spawn's
 * late-landing child stopped and settled before the registry record is
 * released). This file's driver translates process callbacks into
 * events (deliver) and performs the effects the transition returns, in
 * order. An effect list
 * produced by one transition is executed to completion in order (round
 * al29's effect-completion rule): a delivery raised while the list
 * runs — the outbound queue's overflow fires inside an emit — is
 * queued and dispatched after the list finishes, never allowed to
 * abort the remaining effects. The abort it replaces once skipped
 * ledger_session and resolve_done when the session_ended emit itself
 * tripped the queue, leaving run() pending on a session the machine
 * had already ended.
 *
 * The prompt rides argv (kimi 0.31.1 has no stdin transport), so the
 * run path's 32 KiB argv bound is the per-turn cap, checked before the
 * ack, and a turn process is spawned with its whole input already in
 * hand: nothing is ever written to the child's stdin — a piped stdin
 * kimi never reads, closed by endInput() once the spawn lands. No
 * usage appears on the wire: every turn reports all-null usage, the
 * honest null rather than a guessed zero, and the ledger mirrors it.
 */

import { codemuxFatalMessage, type SessionFatal } from "./process.js";
import { KimiDriverEvents } from "./kimi-driver-events.js";

export type { KimiDriverOptions } from "./kimi-driver-io.js";

export class KimiSessionDriver extends KimiDriverEvents {

  /** The CLI's resume claim succeeded: this process owns the record from
   * now on, whether or not the session start is ever reached. */
  adoptResumeClaim(): void {
    this.state.resumeClaimed = true;
  }

  /** The main wait: resolves with codemux's exit code when the session
   * has fully ended. There is no child to watch while idle — a turn
   * process's death is that turn's business, not the session's, until
   * the machine says otherwise. */
  async run(): Promise<number> {
    if (this.runDelivered || this.state.phase === "ended") return this.done;
    this.runDelivered = true;
    this.deliver({ kind: "run_started" });
    return this.done;
  }

  /** One line from the open turn process's stdout. Never throws; the
   * machine decides whether the line is parsed at all. */
  handleHarnessLine(line: string): void {
    this.deliver({ kind: "child_line", line });
  }

  /** A tier-3 fatal from the process layer (non-UTF-8, line overflow, a
   * stdout read failure), classified here — a codemux-side framing or
   * I/O failure is reported with its own words on stderr as well. */
  handleFatal(fatal: SessionFatal): void {
    if (fatal.kind === "handler" || fatal.kind === "read-error") {
      console.error(`codemux: ${codemuxFatalMessage(fatal)}`, fatal.error);
      this.deliver({
        kind: "fatal",
        source: "codemux",
        message: codemuxFatalMessage(fatal),
      });
      return;
    }
    this.deliver({
      kind: "fatal",
      source: "harness",
      message: `unusable harness output (${fatal.kind}, ${fatal.bytes} bytes): ${fatal.excerpt}`,
    });
  }

  /** One framed line from the caller's stdin. Never throws. Blank lines
   * are framing whitespace, not input. */
  handleCallerLine(line: string): void {
    if (line.trim() === "") return;
    this.deliver({ kind: "user_input", line });
  }

  /** The caller closed stdin; a read error is carried as the event's
   * error, for the machine to fail the input channel with. */
  handleCallerEnd(error?: unknown): void {
    this.deliver({ kind: "stdin_eof", error });
  }

  dispose(): void {
    // The signal handlers outlive this call when a hold is pending
    // (round al30, edges major 3): an abandoned spawn still settling past
    // `session_ended` keeps them installed, and a second SIGINT/SIGTERM
    // in that window escalates (escalateStop) instead of meeting the
    // default disposition, which would kill codemux mid-hold. finishDone
    // disposes them once the hold has settled.
    if (!this.state.spawnAbandoned || this.holdDone) this.disposeSignals();
    this.clearSessionTimer();
  }
}

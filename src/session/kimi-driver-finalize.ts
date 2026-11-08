/**
 * The kimi driver's end path and finalization: the end-path
 * procedure, the abandoned-spawn hold, the stop escalation, the
 * registry release, and the closing flush that hands the caller the
 * exit code. src/session/kimi-driver.ts owns the lifecycle.
 */

import { appendSessionCallRecord } from "../call-log.js";
import { awaitFinalFlush } from "./process.js";
import type { TurnChild } from "./kimi-machine.js";
import { releaseSessionRecord } from "./registry.js";
import { KimiDriverIo } from "./kimi-driver-io.js";

export abstract class KimiDriverFinalize extends KimiDriverIo {

  // --- the two procedures ----------------------------------------------------

  /** The end path (the end_path effect starts it exactly once): wait for
   * or stop what the state owes — a graceful end awaits an in-flight
   * spawn and then the turn's own completion; a killing end stops the
   * child at once — and deliver children_settled once every child of
   * the end path has settled. Every wait is cut by a later cause
   * (cut_waits resolves the race; the drain's predicate reads the
   * machine's cause log). */
  protected async runEndPath(): Promise<void> {
    if (this.endPathBegun) return;
    this.endPathBegun = true;
    const spawn = this.spawnPromise;
    if (
      this.state.child === null &&
      spawn !== null &&
      this.state.spawnInFlight &&
      !this.state.spawnAbandoned
    ) {
      // A graceful end owes the in-flight spawn its wait: the probes the
      // spawn closure runs may still land a child whose argv already
      // carries the prompt. The wait ends when the spawn settles (the
      // continuation delivers its event first — it registered before
      // this wait) or when a later cause's cut abandons the spawn.
      await new Promise<void>((resolve) => {
        this.cutResolve = resolve;
        void spawn.then(
          () => resolve(),
          () => resolve()
        );
      });
      this.cutResolve = null;
    }
    const child = this.state.child;
    if (child !== null) {
      if (this.state.graceOpen && !this.state.end.cut) {
        // The graceful drain: the turn's own completion (its closing
        // hint and exit), a later cause's cut, or the child's
        // exit/grace deadline answers the wait — then the stop signal
        // and the settle.
        await child.awaitEndAnswer(
          () =>
            this.state.turn === null ||
            this.state.end.cut ||
            this.state.phase === "ended"
        );
      }
      child.requestStop();
      // The exit delivery (attach_child's wiring) resolves this only
      // after the exit has been classified, so children_settled always
      // sees it.
      await this.childDelivery;
    }
    this.deliver({ kind: "children_settled" });
  }

  /** A spawn that settled: delivered as the event while the session can
   * still adopt it, or — when the end path abandoned it, or the session
   * ended — routed to the hold: the late child stopped and settled (or
   * the rejection resolved outright) before the registry record is
   * released. */
  protected async spawnContinuation(child: TurnChild | null, error: unknown): Promise<void> {
    this.spawnPromise = null;
    if (this.state.spawnAbandoned || this.state.phase === "ended") {
      if (child !== null) await this.settleChild(child);
      else this.completeHold();
      return;
    }
    if (child === null) this.deliver({ kind: "spawn_failed", error });
    else this.deliver({ kind: "spawn_settled", child: child! });
  }

  /** Stop one child nobody will drain and settle it before the hold
   * resolves — the guarantee the registry release rests on. A latched
   * escalation (the escalateRequested field's note) skips the graceful
   * stop: the late child gets the tree SIGKILL the operator already
   * asked for, on arrival. */
  protected async settleChild(child: TurnChild): Promise<void> {
    this.stoppedChild = child;
    if (this.escalateRequested && child.escalateStop !== undefined) {
      child.escalateStop();
    } else {
      child.requestStop();
    }
    try {
      await child.settled;
    } catch {
      // A settle failure changes nothing: the child is gone, which is
      // all the hold asserts.
    }
    this.stoppedChild = null;
    this.completeHold();
  }

  /** Resolve the hold: the abandoned spawn can no longer create a child,
   * so the registry record may be released and the signal handlers taken
   * down (they stayed installed through the hold — round al30, edges
   * major 3). */
  protected completeHold(): void {
    this.holdDone = true;
    this.resolveHold?.();
  }

  /** A second SIGINT/SIGTERM while the first signal's shutdown still
   * runs (round al30, edges major 3): SIGKILL every child group this
   * driver still owns, at once. No diagnostic event — the session may
   * already have ended, and `ended` absorbs — and no state change: this
   * is the operator's hand on the same tree the end path is stopping. */
  protected override escalateStop(): void {
    // Latch before any kill: a spawn still in flight has no child to
    // signal yet, and the continuation's settleChild reads the latch the
    // moment the late child arrives (round al31, correctness major 3).
    this.escalateRequested = true;
    // One child under several aliases — an attached turn child is both
    // activeChild and state.child — is escalated once, not once per
    // alias (round al33, edges major 3: the duplicate sends raced each
    // other and the second attempt's evidence overwrote the first's).
    const targets = new Set<TurnChild>();
    if (this.activeChild !== null) targets.add(this.activeChild);
    if (this.stoppedChild !== null) targets.add(this.stoppedChild);
    if (this.state.child !== null) targets.add(this.state.child);
    for (const child of targets) child.escalateStop?.();
  }

  /** Take the signal handlers down, once (the finishDone tail and the
   * CLI's dispose share this; whichever runs first wins). */
  protected disposeSignals(): void {
    if (this.signalsDisposed) return;
    this.signalsDisposed = true;
    this.signals.dispose();
  }

  /** Whether a registry record for this session exists to release: the
   * recorded start of a session that named its id, or a resume's claim. */
  private hasRegistryRecord(): boolean {
    return this.options.registryPath !== null && this.state.sessionId !== null &&
      (this.state.registryRecorded || this.state.resumeClaimed);
  }

  /** The registry release, once no child of this session can exist
   * anymore (children_settled, or the hold's tail). */
  protected releaseRegistryRecord(): void {
    if (!this.hasRegistryRecord()) return;
    releaseSessionRecord(this.options.registryPath!, this.state.sessionId!);
  }

  /** The final step: flush what remains of the event stream, then hand
   * the caller the end path's code — raised once more only when the
   * final events could not be delivered. The held release resolves past
   * done by design: the caller's code and session_ended land first;
   * only the registry record waits, behind the abandoned spawn's
   * settling. The signal handlers come down only after that wait
   * (round al30, edges major 3): a second SIGINT/SIGTERM while the hold
   * runs escalates instead of being absorbed. A recordless session —
   * its start record never landed, and no resume was claimed — never
   * awaits: the release it would guard cannot happen, so the wait
   * protected nothing and the end disposes at once (round 391, item 15). */
  protected async finishDone(code: number): Promise<void> {
    const delivered = await awaitFinalFlush(this.out);
    const exitCode = delivered ? code : Math.max(code, 1);
    if (this.closingLedger !== null) {
      appendSessionCallRecord(
        this.callLedger,
        this.ledgerSessionId(),
        this.sessionStartedAt,
        this.closingLedger.reason,
        exitCode,
        this.closingLedger.usage
      );
    }
    this.resolveDone(exitCode);
    if (this.state.spawnAbandoned && this.hasRegistryRecord()) {
      await this.holdReleased;
      this.releaseRegistryRecord();
    }
    this.disposeSignals();
  }
}

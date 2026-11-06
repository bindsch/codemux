/**
 * The second-signal escalation every session driver shares (review round
 * 162, finding 2). Kimi carried it alone (rounds al30/al31/al33); the
 * other drivers installed no later-signal callback, so a second
 * SIGINT/SIGTERM/SIGHUP was absorbed by the gate while the first
 * signal's end path ran, and the operator could not invoke the immediate
 * tree kill SessionProcess.escalateStop exists for.
 *
 * The rule, one latch and one snapshot per driver: the first signal
 * starts the graceful end (each driver's onFirst); a later one SIGKILLs
 * every child the driver still owns at that moment — no diagnostic event
 * and no driver state change beyond the latch, because the session may
 * already have ended and `ended` absorbs. A child that did not exist
 * yet (a spawn still in flight, a CLI preflight between the driver's
 * construction and attach) is taken by the latch: the path that adopts
 * it reads `escalateIfRequested` on arrival and kills it there instead
 * of draining it, which is what the operator already asked for. The
 * same call registers the child, so a request that comes while the end
 * path is still stopping it reaches it too.
 */

import {
  installSessionSignalHandlers,
  type SessionProcess,
  type SessionSignalGate,
} from "./process.js";

export class SessionStopEscalation {
  private requested = false;
  /** Children an end path adopted through `escalateIfRequested` and is
   * still stopping (review round 164). Several of them are held only in
   * a local of the end path or of the abandoned-spawn hold, never in a
   * driver field, so the driver's own snapshot cannot name them: a
   * second signal that arrives after such a child landed would find
   * nothing to kill and the child would keep the whole stop grace. A
   * child leaves the set once its tree has settled. */
  private readonly adopted = new Set<SessionProcess>();

  /** Latch the request and SIGKILL every child in `children`, and every
   * child an end path adopted and has not settled, once each
   * (SessionProcess.escalateStop is idempotent per child, so aliases and
   * repeated signals cannot double-kill). Nulls and absent fields are
   * allowed: several windows own no child, and a request with nothing to
   * kill still latches for the child that may land later. */
  request(children: Iterable<SessionProcess | null | undefined>): void {
    this.requested = true;
    for (const child of children) {
      child?.escalateStop();
    }
    for (const child of this.adopted) {
      child.escalateStop();
    }
  }

  /** A child an end path adopts: escalate it on arrival when the request
   * already latched, and remember it until it settles so a request that
   * comes later still reaches it. Returns whether it was escalated now,
   * so the caller skips the graceful stop it would otherwise run —
   * requestStop after a tree SIGKILL only arms timers against a dying
   * group. */
  escalateIfRequested(child: SessionProcess): boolean {
    if (this.requested) {
      child.escalateStop();
      return true;
    }
    if (!this.adopted.has(child)) {
      this.adopted.add(child);
      const forget = (): void => {
        this.adopted.delete(child);
      };
      child.settled.then(forget, forget);
    }
    return false;
  }

  /** The signal wiring every non-kimi driver installs: the first signal
   * runs `onFirst` (the driver's graceful end), a later one escalates
   * onto every child `owned` names at that moment. Kimi keeps its own
   * richer aliasing (kimi-driver-finalize.ts); the drivers with one or
   * two child fields name them directly. */
  install(
    onFirst: () => void,
    owned: () => Iterable<SessionProcess | null | undefined>
  ): SessionSignalGate {
    return installSessionSignalHandlers(onFirst, () => this.request(owned()));
  }
}

/**
 * The kimi driver's effect execution and event rendering: performs
 * each machine effect and renders the emitted wire events. The
 * lifecycle procedures live in kimi-driver-finalize.ts; src/session/
 * kimi-driver.ts owns the lifecycle.
 */

import { appendSessionTurnCallRecord } from "../call-log.js";
import { emptyUsage } from "../result-envelope.js";
import { findKimiWireLog, kimiWireUsage } from "../kimi-wire-log.js";
import type { ResultUsageBlock } from "../types.js";
import { kimiSessionCapabilities } from "./kimi-session.js";
import {
  type KimiEffect,
  type TurnChild,
} from "./kimi-machine.js";
import { buildSessionEnded, shutdownRequested } from "./process.js";
import {
  buildEvent,
  buildInputAck,
  buildSessionStarted,
  buildUnknownEvent,
  buildUserMessage,
} from "./protocol.js";
import { recordSessionStartOffStream, touchSession } from "./registry.js";
import { isCallerHarnessHome, recordedHarnessHome } from "./harness-home.js";
import { kimiPrivateBrandHome } from "../kimi-hermetic.js";
import { KimiDriverFinalize } from "./kimi-driver-finalize.js";
import { identifyKimiInterruptedSession } from "./kimi-session-index.js";

/** A usage block whose every token count is known (kimiWireUsage's
 * output when the log's records carried complete counts). */
type CompleteUsage = ResultUsageBlock & {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  total_tokens: number;
};

export abstract class KimiDriverEvents extends KimiDriverFinalize {

  /** The wire log's token totals as of the previous read (zeros before
   * the first): one log accumulates every turn of the native session,
   * so a turn's own counts are the delta against these. */
  private wireUsageBaseline = { input: 0, output: 0, cached: 0, total: 0 };
  /** False once totals are unknowable — a resumed session whose prior
   * log could not be read at construction, or a partial read midway
   * (the log is append-only, so a record that lacks a count makes every
   * later read partial too): no later turn can be attributed counts of
   * its own, so every report is the honest all-null block. */
  private wireBaselineKnown: boolean = this.seedWireBaseline();

  protected override performOne(effect: KimiEffect): void {
    switch (effect.kind) {
      case "ack":
        this.emit(
          buildInputAck(
            ++this.seq,
            this.sessionIdOrEmpty(),
            effect.inputSeq,
            effect.accepted,
            effect.reason
          )
        );
        return;
      case "emit":
        if (effect.event === "turn_started") this.armTurnTimer();
        if (effect.event === "turn_completed" || effect.event === "session_ended") this.clearTurnTimer();
        // Final turn emissions share the fatal reservation, leaving the
        // lane's last slot for session_ended. Live turn events still use
        // ordinary capacity. A refused final emission raises the exit
        // directly: the ended machine no longer accepts fatal events.
        this.emit(this.renderEvent(effect), {
          terminal: effect.event === "session_ended"
            ? true
            : this.state.phase === "ended" ||
              (effect.event === "turn_completed" && this.state.end.cause !== null) ? "fatal" : undefined,
        });
        return;
      case "error":
        this.emit(
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "error", null, {
            fatal: effect.fatal,
            source: effect.source,
            message: effect.message,
          }),
          { terminal: effect.fatal ? "fatal" : undefined }
        );
        return;
      case "announce":
        this.emit(
          buildSessionStarted(++this.seq, this.sessionIdOrEmpty(), null, {
            agent: "kimi",
            model: this.options.model ?? null,
            autonomy: this.options.autonomy,
            cwd: this.options.cwd,
            sandboxed: this.options.sandboxed,
            sandbox_trust: this.options.sandboxTrust,
            capabilities: kimiSessionCapabilities(),
            protocol: "codemux-live-session/1",
            // The hermetic session's private home, named as the resume
            // guard finds it (the settled path keyed by this session id);
            // a plain session reports null. The key is always present
            // (the protocol doc promises no omission).
            private_home:
              this.options.privateHome != null
                ? recordedHarnessHome(this.options.privateHome, this.state.sessionId ?? "")
                : null,
            // kimi 2.5.2's print wire names no model on any line (the
            // PromptJsonWriter writes role and meta lines only, design
            // P5's bundle read), so no served model exists to report —
            // a declared limitation, not a missing field.
            model_served: null,
            model_served_source: null,
            model_alias: this.options.modelAlias ?? null,
          })
        );
        return;
      case "spawn": {
        let promise: Promise<TurnChild>;
        try {
          promise = this.options.spawnTurn(this.prepareTurn(effect.prompt), undefined, this.playwrightChecks);
        } catch (error) {
          // A synchronous throw from the spawn closure (the CLI's
          // per-turn validateRunRequest) is the spawn's own failure. No
          // promise exists, so no continuation will ever land a child or
          // resolve the hold — the hold completes here instead (round
          // al37, edges major 1), or a fatal end that had abandoned the
          // in-flight spawn waits in finishDone forever.
          this.deliver({ kind: "spawn_failed", error });
          this.completeHold();
          return;
        }
        this.spawnPromise = promise;
        // The continuation registers before anything can race it (the
        // end path's wait attaches to the same promise afterwards), so
        // the event is delivered — and the child attached — before any
        // waiter of the spawn resumes.
        void promise.then(
          (child) => this.spawnContinuation(child, null),
          (error: unknown) => this.spawnContinuation(null, error)
        );
        return;
      }
      case "attach_child": {
        const child = effect.child;
        this.activeChild = child;
        this.childDelivery = child.exited.then(async (outcome) => {
          // The exit is classified only once the tree has settled: the
          // drained output the caller is owed arrived first.
          await child.settled;
          if (this.activeChild === child) this.activeChild = null;
          this.cleanupNoToolsProfile();
          if (this.options.privateHome != null && this.state.sessionId === null && this.state.turn?.interruption !== undefined) {
            try {
              const id = identifyKimiInterruptedSession(this.currentBrandHome(), this.options.cwd, this.sessionIdsBeforeTurn);
              if (id !== null) this.deliver({ kind: "session_identified", sessionId: id });
            } catch (error) {
              this.deliver({ kind: "fatal", source: "codemux", message: String(error) });
            }
          }
          // The child is gone, so nothing writes the private home
          // anymore: this is the one settle point between turns.
          this.settlePrivateHome();
          this.deliver({ kind: "child_exit", child, outcome, usage: this.readTurnWireUsage() });
        });
        child.endInput();
        return;
      }
      case "stop_child":
        void this.settleChild(effect.child);
        return;
      case "stop_turn":
        this.activeChild?.requestStop();
        return;
      case "arm_session_timer":
        if (this.options.sessionTimeoutMs !== null && this.sessionTimer === null) {
          this.sessionTimer = setTimeout(() => {
            this.deliver({ kind: "session_timeout" });
          }, this.options.sessionTimeoutMs);
          this.sessionTimer.unref?.();
        }
        return;
      case "disarm_session_timer":
        this.clearSessionTimer();
        return;
      case "record_start": {
        const registryPath = this.options.registryPath;
        const sessionId = this.state.sessionId;
        // Unreachable otherwise: the machine issues record_start only
        // with a registry and a named session.
        if (registryPath === null || sessionId === null) return;
        // The record runs off the stream's lock budget (review round
        // 341): one attempt here, and a busy lock retries on a timer
        // while the turn's output keeps flowing, instead of the
        // synchronous full-budget wait that froze the event loop
        // mid-turn. The machine keeps waiting for the one outcome.
        recordSessionStartOffStream(
          registryPath,
          {
            id: sessionId,
            agent: "kimi",
            cwd: this.options.cwd,
            // The real value: either flag says hermetic.
            hermetic: this.options.hermetic || (this.options.privateHome != null && !isCallerHarnessHome(this.options.privateHome) && !this.options.preserveCustomization),
            // A hermetic session's home is the private brand home, named
            // as the resume guard finds it: the settled path keyed by
            // this session id (settle lands before the record's release,
            // so a resume never sees the keyed name missing).
            harness_home:
              isCallerHarnessHome(this.options.privateHome) ? this.options.privateHome.dir : this.options.privateHome != null
                ? kimiPrivateBrandHome(recordedHarnessHome(this.options.privateHome, sessionId))
                : this.options.harnessHome,
            ...(isCallerHarnessHome(this.options.privateHome) ? { caller_owned_home: true } : {}),
            model: this.options.model ?? null,
            model_alias: this.options.modelAlias ?? null,
            autonomy: this.options.autonomy,
            sandboxed: this.options.sandboxed,
            sandbox_trust: this.options.sandboxTrust,
            sandbox_no_net: this.options.sandboxNoNet,
            sandbox_scrub_env: this.options.sandboxScrubEnv,
            sandbox_block: [...(this.options.sandboxBlock ?? [])],
            pass_env: [...this.options.passEnv],
            playwright_mcp: this.options.playwrightMcp === true,
            provider_base_url: this.options.providerBaseUrl,
            project_settings: this.options.experimentProjectSettings === true,
          },
          () => this.state.phase === "ended",
          (outcome) =>
            this.deliver({
              kind: "record_outcome",
              ok: outcome.ok,
              ...(outcome.ok ? {} : { error: outcome.error, failure: outcome.kind }),
            }),
          (error) =>
            console.error(
              `codemux: the registry lock is busy recording session ${sessionId} ` +
                `(${error}); retrying in the background`
            ),
          this.options.registryStartBudget
        );
        return;
      }
      case "end_path":
        void this.runEndPath();
        return;
      case "cut_waits":
        this.cutResolve?.();
        return;
      case "hold_release":
        // The hold's tracker exists from construction; the machine's
        // effect records the decision to defer the release behind the
        // abandoned spawn's settling.
        return;
      case "release_registry":
        this.releaseRegistryRecord();
        return;
      case "notice":
        // A diagnostic line only: no event, no verdict — the resumed
        // session's busy-exhaustion notice while it keeps running
        // (round 361, item 16).
        console.error(effect.message);
        return;
      case "stamp_activity": {
        if (!this.state.registryRecorded || this.options.registryPath === null) return;
        const outcome = touchSession(this.options.registryPath, this.state.sessionId ?? "", {
          attempts: 1,
        });
        if (!outcome.ok && !this.touchWarned) {
          this.touchWarned = true;
          console.error(
            `codemux: cannot stamp the session registry for ${this.state.sessionId} ` +
              `(${outcome.error}); activity tracking may lag`
          );
        }
        return;
      }
      case "ledger_turn":
        appendSessionTurnCallRecord(
          this.callLedger,
          this.ledgerSessionId(),
          effect.turnId,
          effect.startedAt,
          this.out.completeTurn(effect.turnId, effect.finish).finish,
          effect.usage,
          // The print wire names no model: no served model to record.
          null
        );
        return;
      case "ledger_session":
        this.closingLedger = effect;
        return;
      case "resolve_done":
        void this.finishDone(Math.max(effect.code, this.finalEmissionFailed ? 1 : 0));
        return;
    }
  }

  private renderEvent(effect: KimiEffect & { kind: "emit" }): string {
    const sid = this.sessionIdOrEmpty();
    switch (effect.event) {
      case "user_message":
        return buildUserMessage(
          ++this.seq,
          sid,
          effect.inputSeq,
          effect.text,
          effect.author,
          effect.turnId
        );
      case "turn_started":
        return buildEvent(++this.seq, sid, "turn_started", null, { turn_id: effect.turnId });
      case "turn_completed":
        return buildEvent(++this.seq, sid, "turn_completed", null, {
          turn_id: effect.turnId,
          finish: effect.finish,
          ...(effect.reason !== undefined ? { reason: effect.reason } : {}),
          // The turn's wire-log delta (the child_exit read); all-null
          // when none could be attributed.
          usage: effect.usage,
          // The print wire names no model (see the announce case): no
          // served model exists to report (design P5's declared
          // limitation).
          model_served: null,
          model_served_source: null,
          model_alias: this.options.modelAlias ?? null,
        });
      case "assistant_message":
        return buildEvent(++this.seq, sid, "assistant_message", effect.raw, {
          text: effect.text,
          turn_id: effect.turnId,
        });
      case "tool_call":
        return buildEvent(++this.seq, sid, "tool_call", effect.raw, {
          call_id: effect.callId,
          name: effect.name,
          input: effect.input,
        });
      case "tool_result":
        return buildEvent(++this.seq, sid, "tool_result", effect.raw, {
          call_id: effect.callId,
          output: effect.output,
          is_error: false,
        });
      case "unknown_event":
        return buildUnknownEvent(++this.seq, sid, effect.raw);
      case "session_ended":
        return buildSessionEnded(++this.seq, sid, effect.harnessExit, {
          reason: effect.reason,
          shutdown_requested: this.state.end.cause !== null &&
            [this.state.end.cause, ...this.state.end.later].some((cause) => shutdownRequested(cause.reason)),
          exit_code: Math.max(effect.exitCode ?? 0, this.finalEmissionFailed ? 1 : 0),
          usage: effect.usage,
          // A hermetic session whose private home never reached its
          // session-keyed name is not resumable: the registry's
          // harness_home names that path, so an honest report refuses
          // the caller now instead of letting a resume fail on it.
          resumable:
            effect.resumable &&
            !this.finalEmissionFailed &&
            (this.options.privateHome == null || this.options.privateHome.settled),
        });
    }
  }

  /** The brand home the session's wire log lives under: the hermetic
   * session's settled private brand home (the settle just ran at every
   * read point, and the naming rule is idempotent on a settled dir),
   * else the operator brand home the plain session runs on. */
  private wireBrandHome(sessionId: string): string {
    return this.options.privateHome != null
      ? kimiPrivateBrandHome(recordedHarnessHome(this.options.privateHome, sessionId))
      : this.options.harnessHome;
  }

  /** Seed the baseline with the prior turns' totals so a resumed
   * session's first turn reports only its own counts. A fresh session
   * needs no seed (its log starts empty). Any seed failure — the prior
   * log missing, unreadable, or partial — leaves the prior totals
   * unknown, and no later turn can be attributed counts of its own. */
  private seedWireBaseline(): boolean {
    const resume = this.options.resumeSessionId;
    if (resume === null) return true;
    const totals = this.readWireTotals(resume);
    if (totals === null) return false;
    this.absorbWireTotals(totals);
    return true;
  }

  /** Read the log's cumulative totals; null when the log cannot be read
   * or a count is unreportable (kimiWireUsage's partial shape). */
  private readWireTotals(sessionId: string): CompleteUsage | null {
    try {
      const totals = kimiWireUsage(findKimiWireLog(this.wireBrandHome(sessionId), sessionId));
      return totals.input_tokens === null || totals.output_tokens === null ||
        totals.cached_input_tokens === null || totals.total_tokens === null
        ? null
        : totals as CompleteUsage;
    } catch {
      return null;
    }
  }

  /** Adopt complete totals as the baseline. */
  private absorbWireTotals(totals: CompleteUsage): void {
    this.wireUsageBaseline = {
      input: totals.input_tokens,
      output: totals.output_tokens,
      cached: totals.cached_input_tokens,
      total: totals.total_tokens,
    };
  }

  /** The finished turn's token counts: the wire log's new totals minus
   * the previous read's (the log carries the whole native session, so
   * only the delta is this turn's). Any failure reports no counts and
   * leaves the baseline standing — usage is reporting, never a verdict,
   * and a later read then attributes everything since the last
   * successful one, keeping the session's cumulative exact. */
  private readTurnWireUsage(): ResultUsageBlock {
    const sessionId = this.state.sessionId;
    if (sessionId === null || !this.wireBaselineKnown) return emptyUsage();
    const totals = this.readWireTotals(sessionId);
    if (totals === null) return emptyUsage();
    const base = this.wireUsageBaseline;
    this.absorbWireTotals(totals);
    return {
      ...emptyUsage(),
      input_tokens: totals.input_tokens - base.input,
      output_tokens: totals.output_tokens - base.output,
      cached_input_tokens: totals.cached_input_tokens - base.cached,
      total_tokens: totals.total_tokens - base.total,
    };
  }
}

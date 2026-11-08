/**
 * The kimi driver's effect execution and event rendering: performs
 * each machine effect and renders the emitted wire events. The
 * lifecycle procedures live in kimi-driver-finalize.ts; src/session/
 * kimi-driver.ts owns the lifecycle.
 */

import { appendSessionTurnCallRecord } from "../call-log.js";
import { emptyUsage } from "../result-envelope.js";
import {
  buildKimiSessionCommand,
  kimiSessionCapabilities,
} from "./kimi-session.js";
import {
  type KimiEffect,
  type TurnChild,
} from "./kimi-machine.js";
import { buildSessionEnded, shutdownRequested } from "./process.js";
import {
  buildEvent,
  buildInputAck,
  buildUnknownEvent,
  buildUserMessage,
} from "./protocol.js";
import { recordSessionStartOffStream, touchSession } from "./registry.js";
import { KimiDriverFinalize } from "./kimi-driver-finalize.js";

export abstract class KimiDriverEvents extends KimiDriverFinalize {

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
          buildEvent(++this.seq, this.sessionIdOrEmpty(), "session_started", null, {
            agent: "kimi",
            model: this.options.model ?? null,
            autonomy: this.options.autonomy,
            cwd: this.options.cwd,
            sandboxed: this.options.sandboxed,
            sandbox_trust: this.options.sandboxTrust,
            capabilities: kimiSessionCapabilities(),
            protocol: "codemux-live-session/1",
          })
        );
        return;
      case "spawn": {
        const argv = buildKimiSessionCommand({
          model: this.options.wireModel,
          resumeSessionId: this.state.sessionId ?? undefined,
          prompt: effect.prompt,
        });
        let promise: Promise<TurnChild>;
        try {
          promise = this.options.spawnTurn(argv);
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
          this.deliver({ kind: "child_exit", child, outcome });
        });
        child.endInput();
        return;
      }
      case "stop_child":
        void this.settleChild(effect.child);
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
            hermetic: this.options.hermetic,
            harness_home: this.options.harnessHome,
            model: this.options.model ?? null,
            autonomy: this.options.autonomy,
            sandboxed: this.options.sandboxed,
            sandbox_trust: this.options.sandboxTrust,
            sandbox_no_net: this.options.sandboxNoNet,
            sandbox_scrub_env: this.options.sandboxScrubEnv,
            sandbox_block: [...(this.options.sandboxBlock ?? [])],
            pass_env: [...this.options.passEnv],
            playwright_mcp: false,
            provider_base_url: this.options.providerBaseUrl,
            project_settings: false,
          },
          () => this.state.phase === "ended",
          (outcome) =>
            this.deliver({
              kind: "record_outcome",
              ok: outcome.ok,
              ...(outcome.ok ? {} : { error: outcome.error }),
            }),
          (error) =>
            console.error(
              `codemux: the registry lock is busy recording session ${sessionId} ` +
                `(${error}); retrying in the background`
            )
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
          effect.finish,
          emptyUsage()
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
          usage: emptyUsage(),
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
          resumable: effect.resumable && !this.finalEmissionFailed,
        });
    }
  }
}

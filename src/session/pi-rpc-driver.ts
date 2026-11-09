/** Pi 0.85.1 RPC transport over the existing turn/session lifecycle.
 * dist/modes/rpc/rpc-mode.js (read 2026-11-09) accepts prompt, get_state,
 * and abort commands. stdin EOF shuts the RPC child down cleanly. Each
 * turn retains the native --session-id store and exits after agent_settled. */
import { appendSessionTurnCallRecord } from "../call-log.js";
import { buildEvent, buildInputAck, parseInputLine } from "./protocol.js";
import type { SessionChildOutcome, SessionProcess } from "./process.js";
import { parsePiSessionTurn } from "./pi-session.js";
import { PI_DRIVER_PROFILE } from "./pi-driver.js";
import { TurnAgentSessionDriver } from "./turn-driver.js";
import type { TurnAgentDriverOptions } from "./turn-driver-types.js";
import { addUsage } from "./usage.js";

/** No prompt reaches RPC as bare text, and the inherited stdin half-close
 * waits until agent_settled. All other process methods retain their receiver. */
function rpcProcess(child: SessionProcess): SessionProcess {
  return new Proxy(child, {
    get(target, key) {
      if (key === "writeRaw") {
        return (text: string) => target.writeRaw(
          `${JSON.stringify({ id: "state", type: "get_state" })}\n` +
          `${JSON.stringify({ id: "prompt", type: "prompt", message: text })}\n`
        );
      }
      if (key === "endInput") return () => {};
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export class PiRpcSessionDriver extends TurnAgentSessionDriver {
  private rpcChild: SessionProcess | null = null;
  private promptAccepted = false;
  private interruptRequested = false;
  private abortSent = false;
  private inputEnded = false;
  private interruptReason = "the caller interrupted the pi turn";
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly turnTimeoutMs: number | null;

  constructor(options: TurnAgentDriverOptions & { turnTimeoutMs?: number | null }) {
    let rememberChild: (child: SessionProcess) => void = () => {};
    super({
      ...options,
      profile: {
        ...PI_DRIVER_PROFILE,
        capabilities: { ...PI_DRIVER_PROFILE.capabilities, interrupt: true },
        buildTurnCommand: (input) => {
          const argv = options.profile.buildTurnCommand(input);
          const mode = argv.indexOf("--mode");
          if (mode < 0 || argv[mode + 1] !== "json") {
            throw new Error("pi RPC requires the pi JSON session command");
          }
          argv[mode + 1] = "rpc";
          const print = argv.indexOf("--print");
          if (print >= 0) argv.splice(print, 1);
          return argv;
        },
      },
      spawnTurn: async (build, abandoned) => {
        const child = await options.spawnTurn(build, abandoned);
        rememberChild(child);
        return rpcProcess(child);
      },
    });
    this.turnTimeoutMs = options.turnTimeoutMs ?? null;
    rememberChild = (child) => { this.rpcChild = child; };
  }

  protected override async startTurn(text: string): Promise<void> {
    this.rpcChild = null;
    this.promptAccepted = false;
    this.interruptRequested = false;
    this.abortSent = false;
    this.interruptReason = "the caller interrupted the pi turn";
    this.clearTurnTimer();
    if (this.turnTimeoutMs !== null) {
      const turnId = this.fsm.activeTurn;
      this.turnTimer = setTimeout(() => {
        if (this.finished || this.fsm.activeTurn !== turnId) return;
        this.interruptRequested = true;
        this.interruptReason = "the pi turn timeout expired";
        this.sendAbort();
        this.turnTimer = setTimeout(() => {
          if (!this.finished && this.fsm.activeTurn === turnId) void this.finish("timeout", 1);
        }, this.turnTimeoutMs!);
        this.turnTimer.unref?.();
      }, this.turnTimeoutMs);
      this.turnTimer.unref?.();
    }
    await super.startTurn(text);
  }

  private clearTurnTimer(): void {
    if (this.turnTimer !== null) clearTimeout(this.turnTimer);
    this.turnTimer = null;
  }

  protected override clearTimers(): void {
    this.clearTurnTimer();
    super.clearTimers();
  }

  override handleCallerEnd(error?: unknown): void {
    this.inputEnded = true;
    super.handleCallerEnd(error);
  }

  override handleCallerLine(line: string): void {
    let decoded: unknown;
    try { decoded = JSON.parse(line); }
    catch { super.handleCallerLine(line); return; }
    if (typeof decoded !== "object" || decoded === null ||
        (decoded as { type?: unknown }).type !== "interrupt" || this.finished) {
      super.handleCallerLine(line);
      return;
    }
    const inputSeq = this.fsm.nextInputSeq();
    const parsed = parseInputLine(line, {
      capabilities: this.capabilities,
      hasActiveTurn: this.fsm.state === "turn_active",
      pendingRequestIds: new Set<string>(),
      shuttingDown: this.inputEnded,
    });
    this.emit(buildInputAck(++this.seq, this.sessionIdOrEmpty(), inputSeq,
      parsed.ok, parsed.ok ? undefined : parsed.reason));
    if (!parsed.ok || this.finished) return;
    this.interruptRequested = true;
    this.sendAbort();
  }

  private sendAbort(): void {
    if (!this.interruptRequested || !this.promptAccepted || this.abortSent ||
        this.rpcChild === null || this.finished) return;
    this.abortSent = true;
    const written = this.rpcChild.writeRaw(`${JSON.stringify({ id: "abort", type: "abort" })}\n`);
    if (!written.ok) {
      this.emitError(true, "codemux", "could not deliver the pi abort command");
      void this.finish("crash", 1);
    }
  }

  override handleHarnessLine(line: string): void {
    if (this.settled) return;
    let event: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null) {
        super.handleHarnessLine(line);
        return;
      }
      event = value as Record<string, unknown>;
    } catch { super.handleHarnessLine(line); return; }
    if (event.type === "response") {
      if (event.success === false) {
        this.emitError(true, "harness", `pi RPC ${String(event.command)} failed: ${String(event.error)}`);
        void this.finish("crash", 1);
        return;
      }
      if (event.command === "get_state" && event.id === "state") {
        const data = event.data as { sessionId?: unknown } | null | undefined;
        super.handleHarnessLine(JSON.stringify({ type: "session", id: data?.sessionId }));
      }
      if (event.command === "prompt" && event.id === "prompt") {
        this.promptAccepted = true;
        this.sendAbort();
      }
      return;
    }
    super.handleHarnessLine(line);
    // Pi 0.85.1 dist/core/agent-session.js:386 emits agent_end with
    // willRetry before retry/compaction/queued continuation; :772-810
    // emits agent_settled only after that work (read 2026-11-09).
    // RPC stdin EOF disposes the session, so agent_end is too early.
    if (event.type === "agent_settled") this.rpcChild?.endInput();
  }

  protected override completeTurn(outcome: SessionChildOutcome): void {
    this.clearTurnTimer();
    const parsed = parsePiSessionTurn(this.turnStdout.join("\n"), { knownSessionId: this.sessionId });
    if (!this.abortSent || parsed.stopReason !== "aborted" ||
        parsed.noSessionId || parsed.wrongSession || parsed.noWire ||
        outcome.code !== 0 || outcome.signal !== null || this.fsm.activeTurn === null) {
      super.completeTurn(outcome);
      return;
    }
    const turnId = this.fsm.activeTurn;
    this.lastChildOutcome = outcome;
    this.turnProc = null;
    this.rpcChild = null;
    this.adoptSessionId(parsed.sessionId!);
    this.settlePrivateHome();
    const error = this.fsm.transition({ kind: "turn_completed", turnId });
    if (error !== null) {
      this.emitError(true, "codemux", error.message);
      void this.finish("crash", 1);
      return;
    }
    this.turnUsage = parsed.usage;
    this.turnModelEffective = parsed.servedModel;
    this.cumulative = addUsage(this.cumulative, parsed.usage);
    this.emit(buildEvent(++this.seq, this.sessionIdOrEmpty(), "turn_completed", null, {
      turn_id: turnId,
      finish: "interrupted",
      reason: this.interruptReason,
      usage: parsed.usage,
    }));
    appendSessionTurnCallRecord(this.callLedger, this.ledgerSessionId(), turnId,
      this.turnStartedAt.get(turnId) ?? Date.now(), "interrupted", parsed.usage, parsed.servedModel);
    this.turnStartedAt.delete(turnId);
    this.stampActivity();
  }
}

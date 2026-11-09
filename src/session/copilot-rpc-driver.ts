import { appendSessionTurnCallRecord } from "../call-log.js";
import type { BaseAdapter, RunContext } from "../adapters/base.js";
import { emptyUsage } from "../result-envelope/common.js";
import type { ResultUsageBlock, RunRequest } from "../types.js";
import { buildEvent, buildInputAck, parseInputLine } from "./protocol.js";
import type { SessionChildOutcome, SessionProcess } from "./process.js";
import { TurnAgentSessionDriver } from "./turn-driver.js";
import type { TurnAgentDriverOptions, TurnCommandInput } from "./turn-driver-types.js";
import { COPILOT_DRIVER_PROFILE } from "./copilot-driver.js";
import { buildCopilotRpcLaunch } from "./copilot-rpc-config.js";
import { CopilotRpcControl, type CopilotRpcSessionConfig } from "./copilot-rpc-control.js";
import { copilotUsageDelta } from "./copilot-profile.js";
import { addUsage } from "./usage.js";

export interface CopilotRpcDriverOptions extends TurnAgentDriverOptions {
  adapter: BaseAdapter;
  request: RunRequest;
  context(): RunContext | undefined;
  permissionPolicy?: "default" | "deny";
  turnTimeoutMs?: number | null;
  rpcTimeoutMs?: number;
}

/** Each turn uses native --headless --stdio RPC and the existing S1
 * identity, registry, final-home and process-tree lifecycle. Shared spawn
 * must deliver raw stdout to handleHarnessBytes/end, not the line parser.
 * Native session.idle plus completed metrics/detach becomes the base
 * profile's result verdict. Abort is credited only with a native abort
 * event, never merely because codemux sent an abort request. */
export class CopilotRpcSessionDriver extends TurnAgentSessionDriver {
  private control: CopilotRpcControl | null = null;
  private child: SessionProcess | null = null;
  private input: TurnCommandInput | null = null;
  private config: CopilotRpcSessionConfig | null = null;
  private baseline: ResultUsageBlock | null = null;
  private rpcUsage: ResultUsageBlock | null = null;
  private promptAccepted = false;
  private promptStarted = false;
  private idleSeen = false;
  private abortSent = false;
  private aborted = false;
  private interruptRequested = false;
  private inputEnded = false;
  private nativeFailed = false;
  private interruptReason = "the caller interrupted the copilot turn";
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly rpcOptions: CopilotRpcDriverOptions;

  constructor(options: CopilotRpcDriverOptions) {
    let owner: CopilotRpcSessionDriver;
    super({
      ...options,
      profile: {
        ...COPILOT_DRIVER_PROFILE,
        capabilities: { ...COPILOT_DRIVER_PROFILE.capabilities, interrupt: true },
        buildTurnCommand(input) {
          const built = buildCopilotRpcLaunch({ adapter: options.adapter, request: options.request,
            context: options.context(), turn: input, harnessHome: options.harnessHome });
          owner.input = input;
          owner.config = built.config;
          return built.argv;
        },
        parseTurnOutput(stdout, id) {
          const verdict = COPILOT_DRIVER_PROFILE.parseTurnOutput!(stdout, id);
          return { ...verdict, usage: owner.rpcUsage ?? emptyUsage(),
            failed: verdict.failed || !owner.idleSeen };
        },
      },
      spawnTurn: async (build, abandoned) => {
        const child = await options.spawnTurn(build, abandoned);
        owner.child = child;
        owner.openControl(child);
        return new Proxy(child, {
          get(target, key) {
            if (key === "writeRaw") return (text: string) => {
              void owner.beginPrompt(text).catch((error: unknown) => owner.rpcFailure(error));
              return { ok: true };
            };
            if (key === "endInput") return () => {};
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    });
    owner = this;
    this.rpcOptions = options;
  }

  private openControl(child: SessionProcess): void {
    if (this.sessionId === null) throw new Error("Copilot RPC session identity is missing");
    this.control = new CopilotRpcControl({
      sessionId: this.sessionId, denyPermissions: this.rpcOptions.permissionPolicy === "deny",
      timeoutMs: this.rpcOptions.rpcTimeoutMs,
      write: (bytes) => {
        const result = child.writeRaw(Buffer.from(bytes).toString("utf8"));
        if (!result.ok) throw new Error("could not write Copilot RPC input");
      },
      onEvent: (event) => this.nativeEvent(event),
      onFailure: (error) => this.rpcFailure(error),
    });
  }

  private async beginPrompt(text: string): Promise<void> {
    const control = this.control!;
    await control.open(!this.input!.firstTurn, this.config!);
    await control.configureAutonomy(this.options.autonomy);
    if (!this.input!.firstTurn) this.baseline = await control.usage();
    if (this.finished) return;
    this.promptStarted = true;
    await control.send(text);
    this.promptAccepted = true;
    this.sendAbort();
  }

  protected override async startTurn(text: string): Promise<void> {
    this.control?.close();
    this.control = null;
    this.child = null;
    this.baseline = null;
    this.rpcUsage = null;
    this.promptAccepted = false;
    this.promptStarted = false;
    this.idleSeen = false;
    this.abortSent = false;
    this.aborted = false;
    this.interruptRequested = false;
    this.nativeFailed = false;
    this.interruptReason = "the caller interrupted the copilot turn";
    this.clearTurnTimer();
    const timeout = this.rpcOptions.turnTimeoutMs;
    if (timeout !== undefined && timeout !== null) {
      const turnId = this.fsm.activeTurn;
      this.turnTimer = setTimeout(() => {
        if (this.finished || this.fsm.activeTurn !== turnId) return;
        this.interruptRequested = true;
        this.interruptReason = "the copilot turn timeout expired";
        this.sendAbort();
        this.turnTimer = setTimeout(() => {
          if (!this.finished && this.fsm.activeTurn === turnId) void this.finish("timeout", 1);
        }, timeout);
        this.turnTimer.unref?.();
      }, timeout);
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

  override dispose(): void {
    this.control?.close();
    super.dispose();
  }

  handleHarnessBytes(bytes: Uint8Array): void {
    if (!this.settled) this.control?.receive(bytes);
  }

  handleHarnessEnd(): void { this.control?.end(); }

  override handleHarnessLine(_line: string): void {
    this.rpcFailure(new Error("Copilot RPC requires raw-byte stdout framing"));
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
    const parsed = parseInputLine(line, { capabilities: this.capabilities,
      hasActiveTurn: this.fsm.state === "turn_active", pendingRequestIds: new Set<string>(),
      shuttingDown: this.inputEnded });
    this.emit(buildInputAck(++this.seq, this.sessionIdOrEmpty(), inputSeq, parsed.ok,
      parsed.ok ? undefined : parsed.reason));
    if (!parsed.ok || this.finished) return;
    this.interruptRequested = true;
    this.sendAbort();
  }

  private sendAbort(): void {
    if (!this.interruptRequested || !this.promptAccepted || this.abortSent || this.idleSeen || this.finished) return;
    this.abortSent = true;
    void this.control!.abort().then((value) => {
      if (typeof value !== "object" || value === null || (value as { success?: unknown }).success !== true) {
        this.rpcFailure(new Error("Copilot RPC did not confirm the abort"));
      }
    }, (error: unknown) => this.rpcFailure(error));
  }

  private nativeEvent(event: Record<string, unknown>): void {
    if (this.finished || !this.promptStarted || event.agentId !== undefined) return;
    if (event.type === "abort") {
      const reason = (event.data as { reason?: unknown } | undefined)?.reason;
      this.aborted = this.abortSent && reason === "user_initiated";
      if (!this.aborted) this.nativeFailed = true;
    }
    if (event.type === "session.error") this.nativeFailed = true;
    if (event.type === "assistant.message" || event.type === "session.error") {
      super.handleHarnessLine(JSON.stringify(event));
    }
    if (event.type === "session.idle" && !this.idleSeen) {
      this.idleSeen = true;
      this.clearTurnTimer();
      void this.finishNativeTurn().catch((error: unknown) => this.rpcFailure(error));
    }
  }

  private async finishNativeTurn(): Promise<void> {
    this.rpcUsage = copilotUsageDelta(await this.control!.usage(), this.baseline);
    await this.control!.detach();
    if (this.finished) return;
    super.handleHarnessLine(JSON.stringify({ type: "result", sessionId: this.sessionId,
      exitCode: this.nativeFailed ? 1 : 0 }));
    this.child!.endInput();
  }

  private rpcFailure(error: unknown): void {
    if (this.finished) return;
    this.emitError(true, "harness", error instanceof Error ? error.message : String(error));
    void this.finish("crash", 1);
  }

  protected override completeTurn(outcome: SessionChildOutcome): void {
    this.clearTurnTimer();
    if (!this.aborted || !this.idleSeen || this.nativeFailed || this.rpcUsage === null ||
        outcome.code !== 0 || outcome.signal !== null || this.fsm.activeTurn === null) {
      super.completeTurn(outcome);
      return;
    }
    const turnId = this.fsm.activeTurn;
    this.lastChildOutcome = outcome;
    this.turnProc = null;
    this.child = null;
    this.adoptSessionId(this.sessionId!);
    this.settlePrivateHome();
    const error = this.fsm.transition({ kind: "turn_completed", turnId });
    if (error !== null) { this.rpcFailure(error.message); return; }
    this.turnUsage = this.rpcUsage;
    this.cumulative = addUsage(this.cumulative, this.rpcUsage);
    this.emit(buildEvent(++this.seq, this.sessionIdOrEmpty(), "turn_completed", null, {
      turn_id: turnId, finish: "interrupted", reason: this.interruptReason, usage: this.rpcUsage,
    }));
    appendSessionTurnCallRecord(this.callLedger, this.ledgerSessionId(), turnId,
      this.turnStartedAt.get(turnId) ?? Date.now(), "interrupted", this.rpcUsage, this.turnModelEffective);
    this.turnStartedAt.delete(turnId);
    this.stampActivity();
  }
}

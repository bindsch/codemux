import { appendSessionTurnCallRecord } from "../call-log.js";
import { emptyUsage } from "../result-envelope.js";
import { applyAuthorPrefix, buildEvent, buildInputAck, MAX_ID_CHARS, parseInputLine } from "./protocol.js";
import type { SessionChildOutcome, SessionProcess } from "./process.js";
import { TurnAgentSessionDriver } from "./turn-driver.js";
import type { TurnAgentDriverOptions } from "./turn-driver-types.js";
import { addUsage } from "./usage.js";
import { ClineAcpTransport } from "./cline-acp.js";
import { MAX_GEMINI_ACP_LINE_BYTES } from "./gemini-acp.js";
import { buildClineSessionCommand, CLINE_ACP_DRIVER_PROFILE, CLINE_SESSION_ID_PATTERN } from "./cline-session.js";
import { clineTurnUsage, freshClineUsage, type ClineHistoryRead } from "./cline-usage.js";

export interface ClineDriverOptions extends TurnAgentDriverOptions {
  readUsage: ClineHistoryRead;
  configHome?: () => string | null;
  permissionPolicy?: "default" | "deny";
}

/** One ACP connection per turn, with native session/load between turns.
 * The shared driver owns registry claims, process settlement and private-home
 * cleanup. --id is deliberately absent: Cline headless --id does not resume.
 * https://github.com/cline/cline/blob/cli-v3.0.74/apps/cli/src/main.ts#L1172-L1242 */
export class ClineSessionDriver extends TurnAgentSessionDriver {
  private acp: ClineAcpTransport | null = null;
  private promptStarted = false;
  private chunks: string[] = [];
  private stopReason: string | null = null;
  private interrupted = false;
  private inputEnded = false;
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly readUsage: ClineHistoryRead;

  constructor(options: ClineDriverOptions) {
    let deliver: (child: SessionProcess, text: string) => void = () => {};
    super({ ...options, profile: { ...CLINE_ACP_DRIVER_PROFILE,
      buildTurnCommand: () => buildClineSessionCommand({ home: options.configHome?.() ?? options.privateHome?.dir,
        effort: options.effort, autonomy: options.autonomy, permissionPolicy: options.permissionPolicy }),
    }, spawnTurn: async (build, abandoned) => {
      const child = await options.spawnTurn(build, abandoned);
      // The shared stdin carrier delivers one prompt. ACP retains its stdin
      // until the response, then closes after the history snapshot is read.
      return new Proxy(child, { get(target, key) {
        if (key === "writeRaw") return (text: string) => { deliver(target, text); return { ok: true }; };
        if (key === "endInput") return () => {};
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    } });
    this.readUsage = options.readUsage;
    deliver = (child, text) => { void this.deliver(child, text); };
  }

  private active(): boolean {
    return !this.settled && (!this.finished || this.endReason === "stdin-close" || this.endReason === "shutdown");
  }

  protected override emit(line: string, options?: { terminal?: boolean | "fatal" }): void {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type === "session_started" || event.type === "turn_completed") {
      // Cline's configured model is not evidence of the model the server used.
      Object.assign(event, { model_served: null, model_served_source: null, model_alias: this.options.modelAlias ?? null });
      line = JSON.stringify(event);
    }
    super.emit(line, options);
  }

  protected override async startTurn(text: string): Promise<void> {
    this.acp = null;
    this.promptStarted = false;
    this.chunks = [];
    this.stopReason = null;
    this.interrupted = false;
    this.clearTurnTimer();
    const timeout = this.options.turnTimeoutMs;
    if (timeout !== undefined && timeout !== null) {
      const turn = this.fsm.activeTurn;
      this.turnTimer = setTimeout(() => {
        if (!this.active() || this.fsm.activeTurn !== turn) return;
        this.interrupted = true;
        this.cancelPrompt();
        this.turnTimer = setTimeout(() => {
          if (this.active() && this.fsm.activeTurn === turn) void this.finish("timeout", 1);
        }, timeout);
        this.turnTimer.unref?.();
      }, timeout);
      this.turnTimer.unref?.();
    }
    await super.startTurn(text);
  }

  private async snapshot(sessionId: string) {
    try { return await this.readUsage(sessionId); } catch { return null; }
  }

  private async deliver(child: SessionProcess, text: string): Promise<void> {
    const transport = new ClineAcpTransport({
      write: (line) => child.writeRaw(line).ok,
      onUpdate: (update) => { if (this.promptStarted && this.active()) this.applyUpdate(update); },
      onFailure: (error) => { if (this.acp === transport) this.transportFailure(error); },
      permissionPolicy: "deny",
    });
    this.acp = transport;
    try {
      await transport.initialize();
      if (!this.active()) return;
      const resumed = this.sessionId !== null;
      const id = await transport.open({ cwd: this.options.cwd, resumeId: this.sessionId ?? undefined });
      if (!CLINE_SESSION_ID_PATTERN.test(id)) throw new Error("Cline ACP returned an invalid native session identity");
      this.adoptSessionId(id);
      if (!this.active()) return;
      await transport.configure(this.options.model, this.options.autonomy === "read-only" ? "plan" : "act");
      const before = resumed ? await this.snapshot(id) : freshClineUsage();
      if (!this.active()) return;
      this.promptStarted = true;
      const pending = transport.prompt(text);
      this.cancelPrompt();
      const result = await pending;
      if (!this.active()) return;
      this.stopReason = result.stopReason as string;
      this.turnUsage = clineTurnUsage(before, await this.snapshot(id));
      if (!this.active()) return;
      if (this.turnUsage.total_tokens === null) {
        this.emitError(false, "harness", "Cline history did not provide usable cumulative usage; this turn's usage is unknown");
      }
      if (!["end_turn", "max_tokens", "max_turn_requests"].includes(this.stopReason) &&
          !(this.stopReason === "cancelled" && this.interrupted)) { // allow-british: native ACP enum
        this.turnError = `Cline ACP stopped with ${this.stopReason}`;
      }
      if (this.turnError === null && this.stopReason !== "cancelled" && this.chunks.length > 0) { // allow-british: native ACP enum
        this.emit(buildEvent(++this.seq, this.sessionIdOrEmpty(), "assistant_message", null,
          { text: this.chunks.join(""), turn_id: this.fsm.activeTurn }));
      }
      child.endInput();
    } catch (error) {
      if (this.acp === transport) this.transportFailure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private transportFailure(error: Error): void {
    if (!this.active()) return;
    this.turnError ??= error.message;
    this.emitError(true, "harness", error.message.replaceAll("Gemini ACP", "Cline ACP"));
    void this.finish("crash", 1);
    // The ACP proxy retains stdin between messages. A failed transport must
    // stop its child explicitly instead of waiting for a prompt response.
    this.turnProc?.requestStop();
  }

  private applyUpdate(update: Record<string, unknown>): void {
    const raw = JSON.stringify(update);
    const content = update.content as { type?: string; text?: unknown } | undefined;
    if (update.sessionUpdate === "agent_message_chunk" && content?.type === "text" && typeof content.text === "string") {
      this.chunks.push(content.text);
      this.emit(buildEvent(++this.seq, this.sessionIdOrEmpty(), "assistant_delta", raw,
        { delta: content.text, turn_id: this.fsm.activeTurn }));
    } else if (update.sessionUpdate === "tool_call" && typeof update.toolCallId === "string") {
      if (this.options.tools === "none") {
        this.transportFailure(new Error("Cline emitted a tool call despite --tools none"));
        return;
      }
      this.emit(buildEvent(++this.seq, this.sessionIdOrEmpty(), "tool_call", raw,
        { call_id: update.toolCallId, name: String(update.title ?? update.kind ?? "tool"), input: update.rawInput ?? null }));
    } else if (update.sessionUpdate === "tool_call_update" && typeof update.toolCallId === "string" &&
        (update.status === "completed" || update.status === "failed")) {
      this.emit(buildEvent(++this.seq, this.sessionIdOrEmpty(), "tool_result", raw,
        // cli-v3.0.74 ACP emits rawOutput, including native error strings.
        // https://github.com/cline/cline/blob/cli-v3.0.74/apps/cli/src/acp/session-updates.ts#L146-L156
        { call_id: update.toolCallId, output: update.rawOutput ?? update.content ?? null, is_error: update.status === "failed" }));
    }
  }

  override handleHarnessLine(line: string): void { if (this.active()) this.acp?.handleLine(line); }
  override handleCallerEnd(error?: unknown): void { this.inputEnded = true; super.handleCallerEnd(error); }

  override handleCallerLine(line: string): void {
    let value: unknown;
    try { value = JSON.parse(line); } catch { super.handleCallerLine(line); return; }
    if (!this.finished && value && typeof value === "object" && (value as { type?: unknown }).type === "user") {
      const parsed = parseInputLine(line, { capabilities: this.capabilities,
        hasActiveTurn: this.fsm.state === "turn_active", pendingRequestIds: new Set(), shuttingDown: this.inputEnded });
      if (parsed.ok && parsed.message.type === "user") {
        const text = applyAuthorPrefix(parsed.message.text, parsed.message.author, this.options.authorPrefix);
        // Account for JSON escaping before accepting input. The transport's
        // frame limit is smaller than the caller protocol's raw-text limit.
        const wire = JSON.stringify({ jsonrpc: "2.0", id: Number.MAX_SAFE_INTEGER, method: "session/prompt",
          params: { sessionId: this.sessionId ?? "x".repeat(MAX_ID_CHARS), prompt: [{ type: "text", text }] } }) + "\n";
        if (Buffer.byteLength(wire) > MAX_GEMINI_ACP_LINE_BYTES) {
          this.emit(buildInputAck(++this.seq, this.sessionIdOrEmpty(), this.fsm.nextInputSeq(), false, "text_too_long"));
          return;
        }
      }
    }
    if (!value || typeof value !== "object" || (value as { type?: unknown }).type !== "interrupt" || this.finished) {
      super.handleCallerLine(line); return;
    }
    const input = this.fsm.nextInputSeq();
    const parsed = parseInputLine(line, { capabilities: this.capabilities,
      hasActiveTurn: this.fsm.state === "turn_active", pendingRequestIds: new Set(), shuttingDown: this.inputEnded });
    this.emit(buildInputAck(++this.seq, this.sessionIdOrEmpty(), input, parsed.ok, parsed.ok ? undefined : parsed.reason));
    if (!parsed.ok) return;
    this.interrupted = true;
    this.cancelPrompt();
  }

  private cancelPrompt(): void {
    if (!this.interrupted || !this.promptStarted || !this.active()) return;
    try { this.acp?.cancel(); } catch (error) { this.transportFailure(error as Error); }
  }

  private clearTurnTimer(): void {
    if (this.turnTimer !== null) clearTimeout(this.turnTimer);
    this.turnTimer = null;
  }

  protected override clearTimers(): void { this.clearTurnTimer(); super.clearTimers(); }

  protected override completeTurn(outcome: SessionChildOutcome): void {
    this.clearTurnTimer();
    const transport = this.acp;
    this.acp = null;
    transport?.close();
    if (this.stopReason === null) this.turnError ??= "Cline ACP exited without a prompt response";
    if (this.stopReason !== "cancelled" || !this.interrupted || outcome.code !== 0 || outcome.signal !== null || this.fsm.activeTurn === null) { // allow-british: native ACP enum
      super.completeTurn(outcome); return;
    }
    const turnId = this.fsm.activeTurn;
    this.lastChildOutcome = outcome;
    this.turnProc = null;
    this.settlePrivateHome();
    const failure = this.fsm.transition({ kind: "turn_completed", turnId });
    if (failure !== null) { this.transportFailure(new Error(failure.message)); return; }
    const usage = this.turnUsage ?? emptyUsage();
    const completion = this.out.completeTurn(turnId, "interrupted", "the Cline turn was interrupted");
    this.cumulative = addUsage(this.cumulative, usage);
    this.emit(buildEvent(++this.seq, this.sessionIdOrEmpty(), "turn_completed", null, { turn_id: turnId, ...completion, usage }));
    appendSessionTurnCallRecord(this.callLedger, this.ledgerSessionId(), turnId,
      this.turnStartedAt.get(turnId) ?? Date.now(), completion.finish, usage, null);
    this.turnStartedAt.delete(turnId);
    this.stampActivity();
  }
}

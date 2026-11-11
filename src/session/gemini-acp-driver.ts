/** Gemini ACP turns reuse the shared process, registry, home, and end path.
 * Native newSession mints the identity; later turns load it. EOF after the
 * prompt response closes ACP (gemini-LUNNHKPJ.js:16415, 0.60.0, 2026-11-09). */
import { AnswerCollector, assembleAnswer } from "../answer-complete.js";
import { appendSessionTurnCallRecord } from "../call-log.js";
import { emptyUsage } from "../result-envelope.js";
import { reportedTokenCount, safeTokenSum } from "../result-envelope/common.js";
import { buildEvent, buildInputAck, parseInputLine } from "./protocol.js";
import type { SessionChildOutcome, SessionProcess } from "./process.js";
import { TurnAgentSessionDriver } from "./turn-driver.js";
import type { TurnAgentDriverOptions, TurnAgentProfile } from "./turn-driver-types.js";
import { GEMINI_DRIVER_PROFILE } from "./gemini-driver.js";
import type { GeminiTurnSettings } from "./gemini-settings.js";
import { buildGeminiAcpCommand, GeminiAcpTransport } from "./gemini-acp.js";
import { addUsage } from "./usage.js";
import { join } from "node:path";
import { readGeminiAcpTranscript, geminiAcpTranscriptUsage } from "./gemini-acp-usage.js";
import { GEMINI_SESSION_ID_PATTERN } from "./gemini-session.js";
import { rpcPromptDeliverable } from "./rpc-prompt-bounds.js";

export const GEMINI_ACP_DRIVER_PROFILE: TurnAgentProfile = {
  ...GEMINI_DRIVER_PROFILE,
  identity: "deferred",
  capabilities: { ...GEMINI_DRIVER_PROFILE.capabilities, interrupt: true },
  buildTurnCommand(input) {
    const settings = input as typeof input & GeminiTurnSettings;
    return buildGeminiAcpCommand({ autonomy: input.autonomy, model: input.model,
      home: settings.geminiHome ?? input.hermeticHome ?? undefined, policyPath: settings.geminiPolicyPath });
  },
};

/** Native ACP quota input includes cached tokens but omits their split.
 * Preserve the reported total and output; do not invent uncached input. */
export function geminiAcpUsage(result: Record<string, unknown>) {
  const usage = emptyUsage();
  const meta = result._meta as { quota?: { token_count?: Record<string, unknown> } } | undefined;
  const counts = meta?.quota?.token_count;
  if (!counts) return usage;
  const input = reportedTokenCount(counts.input_tokens);
  usage.output_tokens = reportedTokenCount(counts.output_tokens);
  if (input !== null && usage.output_tokens !== null) usage.total_tokens = safeTokenSum(input, usage.output_tokens);
  return usage;
}

export class GeminiAcpSessionDriver extends TurnAgentSessionDriver {
  private acp: GeminiAcpTransport | null = null;
  private transcriptHome: string | null = null;
  private promptStarted = false;
  /** The turn's assistant text: chunks join into one message until a tool
   * call closes it (lane AN1: every message of the turn, a blank line
   * between two). */
  private turnAnswer = new AnswerCollector();
  private stopReason: string | null = null;
  private interruptRequested = false;
  private inputEnded = false;
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly turnTimeoutMs: number | null;
  private readonly permissionPolicy: "default" | "deny";

  constructor(options: TurnAgentDriverOptions & {
    permissionPolicy?: "default" | "deny"; turnTimeoutMs?: number | null;
  }) {
    let start: (child: SessionProcess, text: string) => void = () => {};
    let rememberHome: (home: string) => void = () => {};
    super({ ...options, profile: GEMINI_ACP_DRIVER_PROFILE,
      spawnTurn: async (build, abandoned) => {
        const child = await options.spawnTurn((extras) => {
          const argv = build(extras);
          const redirected = argv.find((arg) => arg.startsWith("GEMINI_CLI_HOME="));
          rememberHome(redirected === undefined ? options.harnessHome : join(redirected.slice("GEMINI_CLI_HOME=".length), ".gemini"));
          return argv;
        }, abandoned);
        return new Proxy(child, { get(target, key) {
          if (key === "writeRaw") return (text: string) => { start(target, text); return { ok: true }; };
          if (key === "endInput") return () => {};
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        } });
      },
    });
    this.permissionPolicy = options.permissionPolicy ?? "default";
    this.turnTimeoutMs = options.turnTimeoutMs ?? null;
    start = (child, text) => { void this.deliver(child, text); };
    rememberHome = (home) => { this.transcriptHome = home; };
  }

  protected override async startTurn(text: string): Promise<void> {
    this.acp = null;
    this.promptStarted = false;
    this.turnAnswer = new AnswerCollector();
    this.stopReason = null;
    this.interruptRequested = false;
    this.clearTurnTimer();
    if (this.turnTimeoutMs !== null) {
      const turn = this.fsm.activeTurn;
      this.turnTimer = setTimeout(() => {
        if (this.finished || this.fsm.activeTurn !== turn) return;
        this.interruptRequested = true;
        this.cancelPrompt();
        this.turnTimer = setTimeout(() => {
          if (!this.finished && this.fsm.activeTurn === turn) void this.finish("timeout", 1);
        }, this.turnTimeoutMs!);
        this.turnTimer.unref?.();
      }, this.turnTimeoutMs);
      this.turnTimer.unref?.();
    }
    await super.startTurn(text);
  }

  private async deliver(child: SessionProcess, text: string): Promise<void> {
    const turn = this.fsm.activeTurn;
    const current = () => this.receivesTurnOutput && this.fsm.activeTurn === turn && this.acp === transport;
    const transport = new GeminiAcpTransport({
      write: (line) => child.writeRaw(line).ok,
      onUpdate: (update, raw) => { if (this.promptStarted && current()) this.applyUpdate(update, raw); },
      onFailure: (error) => { if (current()) this.transportFailure(error); },
      // No caller permission round trip is advertised. Every native request
      // is refused; --policy separately prevents native automatic approvals.
      permissionPolicy: this.permissionPolicy,
    });
    this.acp = transport;
    try {
      await transport.initialize();
      if (!current()) return;
      const id = await transport.open({ cwd: this.options.cwd, resumeId: this.sessionId ?? undefined });
      if (!current()) return;
      if (!GEMINI_SESSION_ID_PATTERN.test(id)) throw new Error("Gemini ACP returned a non-UUID session identity");
      this.adoptSessionId(id);
      const brandHome = this.transcriptHome ?? this.options.harnessHome;
      const before = readGeminiAcpTranscript(brandHome, this.options.cwd, id);
      this.promptStarted = true;
      const pending = transport.prompt(text);
      this.cancelPrompt();
      const result = await pending;
      if (!current()) return;
      this.stopReason = result.stopReason as string;
      const nativeUsage = geminiAcpUsage(result);
      const transcriptUsage = geminiAcpTranscriptUsage(before, readGeminiAcpTranscript(brandHome, this.options.cwd, id));
      this.turnUsage = transcriptUsage !== null &&
        (nativeUsage.total_tokens === null || transcriptUsage.total_tokens === nativeUsage.total_tokens)
        ? transcriptUsage : nativeUsage;
      if (this.turnUsage.input_tokens === null) {
        this.emitError(false, "harness", "Gemini ACP did not provide a usable transcript token split; input and cached usage are unknown");
      }
      if (!["end_turn", "max_tokens", "max_turn_requests"].includes(this.stopReason) &&
          !(this.stopReason === "cancelled" && this.interruptRequested)) { // allow-british: native ACP enum
        this.turnError = `Gemini ACP stopped with ${this.stopReason}`;
      }
      if (this.turnError === null && this.stopReason !== "cancelled" && this.turnAnswer.size > 0) { // allow-british: native ACP enum
        // Native ACP reports assistant text only as chunks; the terminal
        // assistant_message is codemux's assembly of this turn's own
        // chunks, raw null like the whole-stdout drivers' verdict answer.
        this.emit(buildEvent(++this.seq, this.sessionIdOrEmpty(), "assistant_message", null,
          { text: assembleAnswer(this.turnAnswer.transcript().messages), turn_id: this.fsm.activeTurn }));
      }
      child.endInput();
    } catch (error) {
      if (current()) this.transportFailure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private transportFailure(error: Error): void {
    if (!this.receivesTurnOutput) return;
    this.emitError(true, "harness", error.message);
    void this.finish("crash", 1);
  }

  private applyUpdate(update: Record<string, unknown>, raw: string): void {
    const content = update.content as { type?: string; text?: unknown } | undefined;
    if (update.sessionUpdate === "agent_message_chunk" && content?.type === "text" && typeof content.text === "string") {
      this.turnAnswer.text(content.text);
      this.emit(buildEvent(++this.seq, this.sessionIdOrEmpty(), "assistant_delta", raw,
        { delta: content.text, turn_id: this.fsm.activeTurn }));
    } else if (update.sessionUpdate === "tool_call" && typeof update.toolCallId === "string") {
      this.turnAnswer.close();
      this.emit(buildEvent(++this.seq, this.sessionIdOrEmpty(), "tool_call", raw,
        { call_id: update.toolCallId, name: String(update.title ?? update.kind ?? "tool"), input: update.rawInput ?? null }));
    } else if (update.sessionUpdate === "tool_call_update" && typeof update.toolCallId === "string" &&
        (update.status === "completed" || update.status === "failed")) {
      this.emit(buildEvent(++this.seq, this.sessionIdOrEmpty(), "tool_result", raw,
        { call_id: update.toolCallId, output: update.content ?? null, is_error: update.status === "failed" }));
    }
  }

  override handleHarnessLine(line: string): void {
    if (this.receivesTurnOutput) this.acp?.handleLine(line);
  }

  override handleCallerEnd(error?: unknown): void { this.inputEnded = true; super.handleCallerEnd(error); }

  override handleCallerLine(line: string): void {
    let value: unknown;
    try { value = JSON.parse(line); } catch { super.handleCallerLine(line); return; }
    if (!value || typeof value !== "object" || (value as { type?: unknown }).type !== "interrupt" || this.finished) {
      super.handleCallerLine(line); return;
    }
    const input = this.fsm.nextInputSeq();
    const parsed = parseInputLine(line, { capabilities: this.capabilities,
      hasActiveTurn: this.fsm.state === "turn_active", pendingRequestIds: new Set(), shuttingDown: this.inputEnded });
    this.emit(buildInputAck(++this.seq, this.sessionIdOrEmpty(), input, parsed.ok, parsed.ok ? undefined : parsed.reason));
    if (!parsed.ok || this.finished) return;
    this.interruptRequested = true;
    this.cancelPrompt();
  }

  private cancelPrompt(): void {
    if (!this.interruptRequested || !this.promptStarted || !this.receivesTurnOutput) return;
    try { this.acp?.cancel(); } catch (error) { this.transportFailure(error as Error); }
  }

  private clearTurnTimer(): void {
    if (this.turnTimer !== null) clearTimeout(this.turnTimer);
    this.turnTimer = null;
  }

  protected override promptDeliverable(text: string): boolean {
    return rpcPromptDeliverable("gemini", text, this.sessionId);
  }

  protected override clearTimers(): void { this.clearTurnTimer(); super.clearTimers(); }

  protected override completeTurn(outcome: SessionChildOutcome): void {
    this.clearTurnTimer();
    const transport = this.acp;
    this.acp = null;
    transport?.close();
    if (this.stopReason === null) this.turnError ??= "Gemini ACP exited without a prompt response";
    if (this.stopReason !== "cancelled" || !this.interruptRequested || outcome.code !== 0 || outcome.signal !== null || this.fsm.activeTurn === null) { // allow-british: native ACP enum
      super.completeTurn(outcome); return;
    }
    const turnId = this.fsm.activeTurn;
    this.lastChildOutcome = outcome;
    this.turnProc = null;
    if (!this.settlePrivateHome()) { void this.finish("crash", 1); return; }
    const failure = this.fsm.transition({ kind: "turn_completed", turnId });
    if (failure !== null) { this.transportFailure(new Error(failure.message)); return; }
    const usage = this.turnUsage ?? emptyUsage();
    this.cumulative = addUsage(this.cumulative, usage);
    this.emit(buildEvent(++this.seq, this.sessionIdOrEmpty(), "turn_completed", null,
      { turn_id: turnId, finish: "interrupted", reason: "the Gemini turn was interrupted", usage, ...this.modelFields() }));
    appendSessionTurnCallRecord(this.callLedger, this.ledgerSessionId(), turnId,
      this.turnStartedAt.get(turnId) ?? Date.now(), "interrupted", usage, null);
    this.turnStartedAt.delete(turnId);
    this.stampActivity();
  }
}

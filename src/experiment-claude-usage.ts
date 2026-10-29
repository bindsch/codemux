import { ExperimentFailure, ExperimentFailureCode as Code, turnRecord, turnUsageRecord,
  type ExperimentRecord, type ExperimentRecordFields, type ExperimentUsage } from "./experiment-records.js";
import type { JsonObject } from "./experiment-server.js";

const FIELDS = { input_tokens: "input", output_tokens: "output", cache_read_input_tokens: "cache_read",
  cache_creation_input_tokens: "cache_write" } as const;
const empty = (): ExperimentUsage => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });

/** Assistant snapshots can contain placeholders. Stream events finalize per-message counters. */
export class ClaudeExperimentUsage {
  turn?: ExperimentRecordFields["turn"];
  private usage = empty();
  private usageTime = 0;
  private hasUsage = false;
  private seen = new Set<string>();
  private completed = new Set<string>();
  private streamId?: string;
  private streamUsage = empty();
  private streamUsageTime = 0;
  private streamHasUsage = false;

  constructor(private record: ExperimentRecord) {}

  begin(message: JsonObject, t: number): boolean {
    // Legacy control peers without IDs retain raw evidence only.
    if (message.id === undefined) { this.complete(); this.turn = undefined; return false; }
    if (typeof message.id !== "string" || !message.id) throw new ExperimentFailure(Code.MessageIdMissing,
      "Claude assistant message.id must be a nonempty string");
    if (this.completed.has(message.id)) throw new ExperimentFailure(Code.HarnessLogMissing,
      "Claude repeated a completed assistant message.id");
    const first = this.turn?.message_id !== message.id;
    if (first) {
      if (!message.usage || typeof message.usage !== "object" || Array.isArray(message.usage) ||
          message.usage.input_tokens === undefined || message.usage.output_tokens === undefined) {
        throw new ExperimentFailure(Code.HarnessLogMissing, "Claude first assistant frame lacks input or output usage");
      }
      this.complete();
      this.seen.add(message.id);
      this.usage = this.streamId === message.id ? { ...this.streamUsage } : empty();
      this.usageTime = this.streamId === message.id ? this.streamUsageTime : t;
      this.hasUsage = this.streamId === message.id && this.streamHasUsage;
      this.turn = turnRecord(message.id, t, null, []);
    }
    if (this.merge(this.usage, message.usage)) {
      this.hasUsage = true;
      this.usageTime = t;
    }
    return first;
  }

  stream(event: JsonObject | undefined, t: number): void {
    if (event?.type === "message_start" && typeof event.message?.id === "string") {
      if (this.completed.has(event.message.id)) throw new ExperimentFailure(Code.HarnessLogMissing,
        "Claude repeated a completed stream message.id");
      if (this.turn?.message_id !== event.message.id) this.complete();
      this.streamId = event.message.id;
      this.streamUsage = empty();
      this.streamHasUsage = this.merge(this.streamUsage, event.message.usage);
      this.streamUsageTime = t;
      if (this.turn?.message_id === this.streamId && this.merge(this.usage, event.message.usage)) {
        this.hasUsage = true;
        this.usageTime = t;
      }
    } else if (event?.type === "message_delta" && event.usage) {
      if (this.merge(this.streamUsage, event.usage)) {
        this.streamHasUsage = true;
        this.streamUsageTime = t;
      }
      if (this.turn && (!this.streamId || this.streamId === this.turn.message_id) &&
          this.merge(this.usage, event.usage)) {
        this.hasUsage = true;
        this.usageTime = t;
      }
    } else if (event?.type === "message_stop") {
      this.complete();
    }
  }

  complete(): void {
    if (!this.turn || this.completed.has(this.turn.message_id)) return;
    if (!this.hasUsage) throw new ExperimentFailure(Code.HarnessLogMissing,
      "Claude turn ended without real per-message usage counters");
    this.record("turn_usage", turnUsageRecord(this.turn.message_id, { ...this.usage }, this.usageTime));
    this.completed.add(this.turn.message_id);
  }

  verify(): void {
    if ([...this.seen].some((id) => !this.completed.has(id))) {
      throw new ExperimentFailure(Code.HarnessLogMissing, "Claude turn lacks exactly one usage record");
    }
  }

  private merge(target: ExperimentUsage, reported: JsonObject | undefined): boolean {
    let real = false;
    for (const [source, key] of Object.entries(FIELDS)) {
      const value = reported?.[source];
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Claude assistant usage must contain nonnegative integers");
      // Per-message counters are cumulative. A placeholder cannot lower a known count.
      target[key] = Math.max(target[key], value);
      if (value > 0) real = true;
    }
    return real;
  }
}

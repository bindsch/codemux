/** Capture billing evidence before interpreting success or failure. */
import type { Settlement } from "./governor.js";
import type { UpstreamConfig } from "./provider.js";
import { hasNativeToolCharge, usageFromAnthropic, usageFromOpenAI, type CompletionUsage } from "./usage.js";

type Json = Record<string, unknown>;

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function tierPriced(tier: unknown): boolean {
  return tier === undefined || tier === null || tier === "default" || tier === "flex";
}

export class ResponseAccounting {
  usage: CompletionUsage | null = null;
  servedModel: string | null = null;
  private priceKnown = true;
  private countsComplete = false;

  constructor(private readonly upstream: UpstreamConfig) {}

  observe(value: Json): void {
    if (this.upstream.wire === "anthropic" && Array.isArray(value["content"]) && value["content"].some(hasNativeToolCharge)) {
      this.priceKnown = false;
    }
    if (value["model"] !== undefined && value["model"] !== null) {
      const model = typeof value["model"] === "string" ? value["model"] : "";
      if (this.servedModel !== null && this.servedModel !== model) this.priceKnown = false;
      this.servedModel = model;
    }
    // An earlier premium tier cannot be erased by a later usage-only event.
    if (this.upstream.provider === "openai" && !tierPriced(value["service_tier"])) this.priceKnown = false;
    if (!isObject(value["usage"])) {
      // Null/absent usage is normal on content chunks. Supplied malformed
      // evidence makes earlier counts unsafe to price, even after recovery.
      if (value["usage"] !== undefined && value["usage"] !== null) this.priceKnown = false;
      return;
    }
    const next = this.upstream.wire === "anthropic"
      ? usageFromAnthropic(value["usage"]) : usageFromOpenAI(value["usage"]);
    if (next?.priceKnown === false) this.priceKnown = false;
    this.countsComplete = next !== null && next.inputKnown !== false && next.outputKnown !== false;
    if (next !== null) {
      // Counts are cumulative. A charge-only event must retain earlier counts,
      // and a count-only event must not discard an already reported charge.
      const previous = this.usage;
      this.usage = {
        ...next,
        ...(next.inputKnown === false && previous !== null ? {
          input: previous.input, cacheRead: previous.cacheRead, cacheWrite: previous.cacheWrite, inputKnown: previous.inputKnown,
        } : {}),
        ...(next.outputKnown === false && previous !== null ? { output: previous.output, outputKnown: previous.outputKnown } : {}),
        reportedCostUsd: next.reportedCostUsd ?? previous?.reportedCostUsd ?? null,
      };
      if (previous?.reportedCostUsd !== null && previous?.reportedCostUsd !== undefined && next.reportedCostUsd === null) {
        this.countsComplete = false;
      }
    }
  }

  settlement(finish: string, completed = true, billable = true): Settlement {
    return {
      usage: this.usage, servedModel: this.servedModel, finish, billable,
      priceKnown: this.priceKnown,
      costKnown: completed && this.countsComplete && this.priceKnown,
    };
  }
}

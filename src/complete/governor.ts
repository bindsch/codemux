/**
 * The spend governor every `codemux complete` request passes: a request
 * cap counted at admission, a dollar cap counted from each answer's
 * reported usage, a price for every model before it is served, and one
 * ledger row per authenticated request (kind `complete`, never the prompt
 * text or the key). Once a cap is reached every later request is refused
 * with HTTP 429 and the server stops (docs/complete.md).
 *
 * The dollar cap is checked before a request is forwarded, against the
 * spend already settled, so requests already in flight when the cap is
 * crossed still complete and are counted: the overshoot is bounded by what
 * those requests cost. A request whose cost cannot be determined also stops
 * the server, because the cap cannot be kept without a number: an answer
 * with no price and no provider-reported charge, and any request the
 * upstream accepted (so the provider may bill it) whose full usage never
 * arrived: a 2xx answer without a usage object, a stream cut before its
 * usage, or a request aborted after it was sent; and an OpenAI-provider answer
 * served at a service tier the table does not price (`priority`, …).
 */

import { appendCallRecord } from "../call-log.js";
import { CompleteError } from "./errors.js";
import { estimateCost, isSnapshotOf, priceFor, type ModelPrice } from "./prices.js";
import { ledgerUsage, type CompletionUsage } from "./usage.js";

export interface GovernorOptions {
  budgetUsd: number;
  maxRequests: number;
  priceOverride: ModelPrice | null;
  /** True when the provider reports its own charge (OpenRouter), so a
   * model the table does not list may still be served. */
  providerReportsCost: boolean;
  host: string;
  labels: Record<string, string> | null;
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface Ticket {
  startedAt: number;
  model: string;
}

export interface Settlement {
  usage: CompletionUsage | null;
  servedModel: string | null;
  finish: string;
  /** The upstream may bill this request: it was sent and not refused with
   * an HTTP error before any answer (a connection that never opened, a
   * redirect, or a fully read HTTP error without usage is not billed). */
  billable: boolean;
  /** `usage` is the answer's final count and prices at the table's
   * standard tier: not partial, not missing, not a premium service tier. */
  costKnown: boolean;
  /** False when the served tier has no applicable table price. */
  priceKnown?: boolean;
}

export type StopReason = "budget_exhausted" | "request_cap_reached" | "cost_unknown";

export class CompleteGovernor {
  requests = 0;
  spentUsd = 0;
  stopReason: StopReason | null = null;
  private readonly now: () => number;

  constructor(private readonly options: GovernorOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Why the next request would be refused, or null when it may go. */
  capReached(): StopReason | null {
    if (this.stopReason !== null) return this.stopReason;
    if (this.spentUsd >= this.options.budgetUsd) return "budget_exhausted";
    if (this.requests >= this.options.maxRequests) return "request_cap_reached";
    return null;
  }

  get exhausted(): boolean {
    return this.capReached() !== null;
  }

  /** Admits one request or throws the refusal (a ledger row is written
   * for the refusal too). The request counts against the cap from here. */
  admit(model: string): Ticket {
    const startedAt = this.now();
    const reached = this.capReached();
    if (reached !== null) {
      const error = reached === "request_cap_reached"
        ? new CompleteError(429, "request_cap_reached", `the request cap of ${this.options.maxRequests} is reached`)
        : reached === "cost_unknown"
          ? new CompleteError(429, "cost_unknown", "a previous answer's cost could not be determined, so the budget can no longer be kept")
          : new CompleteError(429, "budget_exhausted",
            `the budget of $${this.options.budgetUsd} is spent ($${this.spentUsd.toFixed(4)} estimated)`);
      this.refuse(model, startedAt, error);
      throw error;
    }
    if (!this.options.providerReportsCost && priceFor(model, this.options.priceOverride) === null) {
      const error = new CompleteError(400, "model_not_priced",
        `no price for model ${JSON.stringify(model)}; pass --input-usd-per-mtok and --output-usd-per-mtok`);
      this.refuse(model, startedAt, error);
      throw error;
    }
    this.requests++;
    return { startedAt, model };
  }

  /** Writes the ledger row for a request refused before it was forwarded. */
  refuse(model: string | null, startedAt: number, error: CompleteError): void {
    this.append(model, null, `refused:${error.code}`, startedAt, null, null);
  }

  /** Writes the ledger row for a request a stop signal cut before it was
   * forwarded (its body was still arriving): `interrupted`, as for the
   * forwarded requests the signal aborts. */
  interrupted(startedAt: number): void {
    this.append(null, null, "interrupted", startedAt, null, null);
  }

  /** Settles a forwarded request: prices its usage, adds the cost to the
   * spend, and writes its ledger row. Returns the cost (null when no usage
   * was reported). A billable request without its final usage records what
   * was seen and stops the server (`cost_unknown`). */
  settle(ticket: Ticket, settlement: Settlement): number | null {
    const { usage } = settlement;
    let cost: number | null = null;
    let billed = false;
    if (usage !== null) {
      if (usage.reportedCostUsd !== null) {
        cost = usage.reportedCostUsd;
        billed = true;
      } else if (settlement.priceKnown !== false && usage.priceKnown !== false && usage.inputKnown !== false && usage.outputKnown !== false) {
        // The served model's price; the requested model's only when the
        // provider named none or resolved the alias to its own snapshot.
        // Other reroutes need their own table entry or an explicit override.
        const served = settlement.servedModel;
        const price = (served !== null ? priceFor(served, this.options.priceOverride) : null) ??
          (served === null || isSnapshotOf(served, ticket.model) ? priceFor(ticket.model, this.options.priceOverride) : null);
        const estimate = price !== null ? estimateCost(usage, price) : Number.NaN;
        if (Number.isFinite(estimate)) cost = estimate;
        else this.stopReason = "cost_unknown";
      }
    }
    // A provider charge read from an incomplete answer is a partial charge:
    // it is counted, and the stop still applies.
    if (settlement.billable && !settlement.costKnown) this.stopReason = "cost_unknown";
    if (cost !== null) this.spentUsd += cost;
    this.append(ticket.model, settlement.servedModel, settlement.finish, ticket.startedAt, usage, cost, billed);
    return cost;
  }

  private append(
    model: string | null,
    servedModel: string | null,
    finish: string,
    startedAt: number,
    usage: CompletionUsage | null,
    cost: number | null,
    billed = false
  ): void {
    appendCallRecord({
      ts: new Date(startedAt).toISOString(),
      kind: "complete",
      agent: null,
      model,
      model_effective: servedModel,
      model_alias: null,
      provider: this.options.host,
      session_id: null,
      turn_id: null,
      autonomy: null,
      hermetic: false,
      sandboxed: false,
      exit_code: null,
      finish,
      duration_ms: Math.max(0, this.now() - startedAt),
      cwd: this.options.cwd,
      labels: this.options.labels,
      usage: ledgerUsage(usage, cost),
      cost_source: billed ? "billed" : null,
    }, this.options.environment);
  }
}

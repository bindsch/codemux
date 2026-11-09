/** Read 2026-11-09, Pi 0.85.1: extensions/types.d.ts:238,559,604; agent-session.js:384,
 * 1825-1840. Hooks are awaited; ctx.abort stops the active request.
 * session_compact reports separate summary usage, not message_end again. */
export interface PiBudgetUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/** A zero price cannot distinguish a free request from missing pricing. */
export function piBudgetUsage(value: unknown): PiBudgetUsage {
  const usage = value as PiBudgetUsage | undefined;
  const names = ["input", "output", "cacheRead", "cacheWrite"] as const;
  if (!usage || names.some((key) => !Number.isSafeInteger(usage[key]) || usage[key] < 0) ||
      !Number.isSafeInteger(usage.totalTokens) || usage.totalTokens < 0 || !usage.cost ||
      names.some((key) => !Number.isFinite(usage.cost[key]) || usage.cost[key] < 0) ||
      !Number.isFinite(usage.cost.total) || usage.cost.total <= 0) {
    throw new Error("Pi budget requires complete usage and a positive reported USD cost");
  }
  const cost = names.reduce((total, key) => total + usage.cost[key], 0);
  if (Math.abs(cost - usage.cost.total) > 1e-9 * Math.max(1, cost)) {
    throw new Error("Pi budget cost components disagree with the reported total");
  }
  return { input: usage.input, output: usage.output, cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite, totalTokens: usage.totalTokens,
    cost: { input: usage.cost.input, output: usage.cost.output, cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite, total: usage.cost.total } };
}

interface Model { id?: string; provider?: string; cost?: Record<string, unknown> }
export function piBudgetModel(model: Model | undefined): Model {
  const cost = model?.cost;
  if (!model || typeof model.id !== "string" || !model.id || typeof model.provider !== "string" || !model.provider ||
      !cost || ["input", "output", "cacheRead", "cacheWrite"].some((key) =>
        typeof cost[key] !== "number" || !Number.isFinite(cost[key]) || (cost[key] as number) < 0) ||
      !((cost.input as number) > 0 || (cost.output as number) > 0)) {
    throw new Error("Pi budget cannot verify native model pricing");
  }
  return { id: model.id, provider: model.provider,
    cost: { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite } };
}

interface Context {
  model?: Model;
  abort(): void;
}
export interface PiBudgetApi {
  on(name: string, handler: (event: any, context: Context) => unknown): void;
}

/** Serialized with piBudgetUsage into the launch's explicit extension. */
export function installPiBudgetExtension(pi: PiBudgetApi, options: {
  limit: number; record(kind: string, fields: Record<string, unknown>): void;
}): void {
  if (!Number.isFinite(options.limit) || options.limit <= 0) throw new Error("Invalid Pi USD budget");
  let total = 0;
  let charges = 0;
  let status = "active";
  const seenMessages = new WeakSet<object>();
  const seenCompactions = new Set<string>();
  const fail = (error: unknown, context: Context) => {
    status = "failed";
    try { options.record("failure", { message: error instanceof Error ? error.message : String(error) }); }
    catch { /* Missing evidence fails host verification. Native cancellation must still return. */ }
    try { context.abort(); }
    catch { /* A faulty abort must not discard the compaction or tool refusal. */ }
  };
  const guard = (name: string, fn: (event: any, context: Context) => unknown) => {
    pi.on(name, (event, context) => {
      try { return fn(event, context); }
      catch (error) {
        fail(error, context);
        if (name === "session_before_compact" || name === "session_before_tree") return { cancel: true };
        if (name === "tool_call") return { block: true, reason: "Pi budget accounting failed" };
      }
    });
  };
  const allow = (name: string, context: Context): boolean => {
    if (status !== "active") {
      try { options.record("blocked", { event: name }); }
      finally { context.abort(); }
      return false;
    }
    const model = piBudgetModel(context.model);
    if (name === "before_provider_request") options.record("request", { model });
    return true;
  };
  const charge = (source: string, usageValue: unknown, context: Context) => {
    const usage = piBudgetUsage(usageValue);
    if (status !== "active") throw new Error("Pi reported another charge after the budget stopped the run");
    total += usage.cost.total;
    if (!Number.isFinite(total)) throw new Error("Pi budget total overflowed");
    charges += 1;
    if (total >= options.limit) status = "exhausted";
    // Persist the threshold before abort: native runner.js catches hook errors.
    options.record("charge", { source, usage, total, status });
    if (status === "exhausted") context.abort();
  };
  options.record("installed", { limit: options.limit });
  for (const event of ["before_agent_start", "turn_start", "before_provider_request"]) {
    guard(event, (_event, context) => { allow(event, context); });
  }
  guard("tool_call", (_event, context) => {
    if (!allow("tool_call", context)) return { block: true, reason: "Pi USD budget stopped the run" };
  });
  guard("message_end", (event, context) => {
    const message = event.message;
    if (message?.role !== "assistant" || seenMessages.has(message)) return;
    seenMessages.add(message);
    charge("assistant", message.usage, context);
  });
  guard("session_before_compact", (_event, context) => {
    if (!allow("session_before_compact", context)) return { cancel: true };
    // Read 2026-11-09: compaction.js:454-466 and pi-ai utils/retry.js:114-156
    // discard failed summary attempts' usage. Refuse before those requests.
    throw new Error("Pi USD budget refuses native compaction because summary retries hide per-request costs");
  });
  guard("session_before_tree", (event, context) => {
    if (!allow("session_before_tree", context)) return { cancel: true };
    if (event.preparation?.userWantsSummary) throw new Error("Pi USD budget refuses unaccounted branch summaries");
  });
  guard("session_compact", (event, context) => {
    const entry = event.compactionEntry;
    if (typeof entry?.id !== "string" || !entry.id) throw new Error("Pi compaction lacks an accounting identity");
    if (seenCompactions.has(entry.id)) return;
    seenCompactions.add(entry.id);
    charge("compaction", entry.usage, context);
    throw new Error("Pi compaction bypassed the USD budget cancellation guard");
  });
  guard("agent_settled", (_event, _context) => {
    options.record("settled", { total, charges, status });
  });
}

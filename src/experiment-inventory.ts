import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ExperimentFailure, ExperimentFailureCode, experimentFailure, type ExperimentRecord } from "./experiment-records.js";
import type { JsonObject } from "./experiment-server.js";
import { kimiToolName } from "./experiment-kimi-content.js";
import { sanitizeCodexToolName } from "./experiment-tool-names.js";

const EXPERIMENT_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
// Claude's SDK bridge bounds injected names at 64 characters. Applying the
// same bound to the namespaced name satisfies both raw and prefixed checks.
const MAX_NAMESPACED_TOOL_NAME = 64;
/** The most tools/list pages one collection follows. MCP puts no bound on
 * pagination, and every cursor must be unique, so a server that keeps
 * answering with empty pages and fresh cursors would otherwise keep
 * collection — and its mcp_request records — running without end (review
 * round 286). A hundred pages sits an order above any real inventory
 * (docs/experiment-mcp.md calls a hundred tools large). */
const MAX_TOOLS_LIST_PAGES = 100;

/** A complete, immutable tool inventory, shared by both MCP transports. */
export class ExperimentInventory {
  definitions?: JsonObject[];
  readonly names = new Set<string>();
  rechecking?: Promise<void>;
  private changes = 0;

  constructor(private serverName: string,
    private request: (message: JsonObject) => Promise<JsonObject | undefined>,
    private record: ExperimentRecord, private fail: (error: Error) => void,
    private active: () => boolean, private settled: () => void = () => {}) {}

  namespaced(name: string): string { return `mcp__${this.serverName}__${name}`; }

  async accept(reply: JsonObject, controlId: string | null): Promise<void> {
    const tools = await this.collect(reply, controlId);
    if (!this.active()) return;
    if (this.definitions && !isDeepStrictEqual(this.definitions, tools)) {
      throw new ExperimentFailure(ExperimentFailureCode.InventoryMismatch, "experiment tool definitions changed during the run");
    }
    this.definitions = tools;
    for (const tool of tools) this.names.add(this.namespaced(tool.name));
    reply.result = { ...reply.result, tools };
    delete reply.result.nextCursor;
    this.recheck();
  }

  changed(): void { this.changes++; this.recheck(); }

  private async page(controlId: string | null, cursor?: string): Promise<JsonObject | undefined> {
    const message = { jsonrpc: "2.0", id: randomUUID(), method: "tools/list",
      ...(cursor === undefined ? {} : { params: { cursor } }) };
    this.record("mcp_request", { control_id: controlId, rpc_id: message.id, tool_use_id: null, message });
    const reply = await this.request(message);
    if (!this.active()) return;
    if (!reply || reply.id !== message.id) throw new Error("experiment MCP response id mismatch");
    if (reply.error !== undefined) throw new ExperimentFailure(ExperimentFailureCode.ServerError, "experiment MCP tools/list returned a JSON-RPC error");
    return reply;
  }

  private async collect(page: JsonObject | undefined, controlId: string | null): Promise<JsonObject[]> {
    if (!this.active()) return [];
    if (!page) throw new Error("experiment MCP response id mismatch");
    const tools: JsonObject[] = [];
    const names = new Set<string>();
    const sanitizedNames = new Set<string>();
    const kimiNames = new Set<string>();
    const cursors = new Set<string>();
    for (;;) {
      if (!Array.isArray(page.result?.tools)) throw new ExperimentFailure(ExperimentFailureCode.InventoryMismatch, "experiment server requires one complete nonempty tools/list");
      for (const tool of page.result.tools) {
        if (!tool || typeof tool.name !== "string" || !EXPERIMENT_TOOL_NAME.test(tool.name) || names.has(tool.name) ||
            this.namespaced(tool.name).length > MAX_NAMESPACED_TOOL_NAME) {
          throw new ExperimentFailure(ExperimentFailureCode.InventoryMismatch, "experiment server exposes an unsupported or duplicate tool name");
        }
        const sanitized = sanitizeCodexToolName(this.namespaced(tool.name));
        const kimi = kimiToolName(this.serverName, tool.name);
        if (sanitizedNames.has(sanitized) || kimiNames.has(kimi)) {
          throw new ExperimentFailure(ExperimentFailureCode.InventoryMismatch,
            `experiment server tool name sanitizer collision for ${tool.name}`);
        }
        names.add(tool.name);
        sanitizedNames.add(sanitized);
        kimiNames.add(kimi);
        tools.push(tool);
      }
      const cursor = page.result.nextCursor;
      if (cursor === undefined) break;
      if (typeof cursor !== "string" || cursors.has(cursor)) throw new ExperimentFailure(ExperimentFailureCode.InventoryMismatch, "invalid or repeated experiment tools/list cursor");
      cursors.add(cursor);
      if (cursors.size >= MAX_TOOLS_LIST_PAGES) {
        throw new ExperimentFailure(ExperimentFailureCode.InventoryMismatch,
          `experiment server exceeds ${MAX_TOOLS_LIST_PAGES} tools/list pages`);
      }
      page = await this.page(controlId, cursor);
      if (!this.active()) return [];
      if (!page) throw new Error("experiment MCP response id mismatch");
    }
    if (tools.length === 0) throw new ExperimentFailure(ExperimentFailureCode.InventoryMismatch, "experiment server requires one complete nonempty tools/list");
    return tools;
  }

  private recheck(): void {
    if (!this.definitions || !this.changes || this.rechecking || !this.active()) return;
    this.rechecking = (async () => {
      while (this.changes && this.active()) {
        this.changes--;
        const page = await this.page(null);
        if (!this.active()) return;
        const tools = await this.collect(page, null);
        if (!this.active()) return;
        const equal = isDeepStrictEqual(this.definitions, tools);
        this.record("tool_inventory_recheck", { equal, previous: this.definitions, current: tools });
        if (!equal) throw new ExperimentFailure(ExperimentFailureCode.InventoryMismatch, "experiment tool definitions changed during the run");
      }
    })().catch((error) => this.fail(experimentFailure(error))).finally(() => {
      this.rechecking = undefined;
      this.recheck();
      this.settled();
    });
  }
}

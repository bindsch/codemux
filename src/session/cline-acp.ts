import { GeminiAcpTransport, MAX_GEMINI_ACP_LINE_BYTES, type GeminiAcpHost } from "./gemini-acp.js";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Cline and Gemini use the same ACP v1 framing, permission outcomes and
 * new/load/prompt/cancel messages. Reuse that bounded transport; Cline adds
 * explicit model and mode restoration because load does not persist either.
 * cli-v3.0.74 acpAgent.ts setSessionConfigOption accepts arbitrary model ids:
 * https://github.com/cline/cline/blob/cli-v3.0.74/apps/cli/src/acp/acpAgent.ts#L520-L529
 * Unlike CLINE_MODEL's catalog fallback, this path preserves the request. */
export class ClineAcpTransport extends GeminiAcpTransport {
  private serial = 0;
  private pending: { id: string; resolve(): void; reject(error: Error): void } | null = null;
  private closed: Error | null = null;

  constructor(private readonly clineHost: GeminiAcpHost) {
    super({ ...clineHost, onFailure: (error) => {
      const mapped = new Error(error.message.replaceAll("Gemini ACP", "Cline ACP"));
      this.closed = mapped;
      this.pending?.reject(mapped);
      this.pending = null;
      clineHost.onFailure?.(mapped);
    } });
  }

  async configure(model: string | undefined, mode: "plan" | "act"): Promise<void> {
    if (model !== undefined) await this.setting("session/set_config_option", { configId: "model", value: model });
    await this.setting("session/set_mode", { modeId: mode });
  }

  private setting(method: string, params: ObjectValue): Promise<void> {
    if (this.closed) return Promise.reject(this.closed);
    if (this.sessionId === null) return Promise.reject(new Error("Cline ACP session is not ready"));
    if (this.pending) return Promise.reject(new Error("Cline ACP configuration is already pending"));
    const id = `cline-config-${++this.serial}`;
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject };
      const wire = JSON.stringify({ jsonrpc: "2.0", id, method, params: { sessionId: this.sessionId, ...params } }) + "\n";
      if (Buffer.byteLength(wire) > MAX_GEMINI_ACP_LINE_BYTES || !this.clineHost.write(wire)) {
        this.close(new Error("Cline ACP configuration could not be written"));
      }
    });
  }

  override handleLine(line: string): void {
    if (this.closed) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { super.handleLine(line); return; }
    if (object(value) && this.pending && value.id === this.pending.id && value.method === undefined) {
      const pending = this.pending;
      this.pending = null;
      if (Buffer.byteLength(line) > MAX_GEMINI_ACP_LINE_BYTES || value.jsonrpc !== "2.0" || !object(value.result)) {
        const detail = object(value.error) && typeof value.error.message === "string" ? value.error.message : "invalid response";
        const error = new Error(`Cline ACP configuration failed: ${detail}`);
        pending.reject(error);
        this.close(error);
      } else pending.resolve();
      return;
    }
    super.handleLine(line);
  }
}

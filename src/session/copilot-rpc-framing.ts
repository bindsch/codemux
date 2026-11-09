/** Installed Copilot 1.0.85 copilot-sdk/client.d.ts and index.js use
 * vscode-jsonrpc Content-Length framing over --headless --stdio
 * (read 2026-11-09). Shared SessionProcess currently exposes text lines;
 * this byte decoder must receive raw stdout before that line splitter. */
const copilotRpcHeaderLimit = 8 * 1024;
export const copilotRpcBodyLimit = 16 * 1024 * 1024;

export function encodeCopilotRpc(value: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > copilotRpcBodyLimit) throw new Error("Copilot RPC message exceeds the byte limit");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

export class CopilotRpcFramer {
  private buffer: Buffer = Buffer.alloc(0);
  private bodyLength: number | null = null;

  push(chunk: Uint8Array): unknown[] {
    if (this.buffer.length + chunk.length > copilotRpcBodyLimit + copilotRpcHeaderLimit) {
      throw new Error("Copilot RPC buffered data exceeds the byte limit");
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    for (;;) {
      if (this.bodyLength === null) {
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end < 0) {
          if (this.buffer.length > copilotRpcHeaderLimit) throw new Error("Copilot RPC header exceeds the byte limit");
          break;
        }
        if (end > copilotRpcHeaderLimit) throw new Error("Copilot RPC header exceeds the byte limit");
        const lines = this.buffer.subarray(0, end).toString("latin1").split("\r\n");
        const lengths = lines.filter((line) => /^Content-Length:/i.test(line));
        if (lengths.length !== 1 || !/^Content-Length: [0-9]+$/i.test(lengths[0]!)) {
          throw new Error("Copilot RPC requires one valid Content-Length header");
        }
        const length = Number(lengths[0]!.split(": ")[1]);
        if (!Number.isSafeInteger(length) || length <= 0 || length > copilotRpcBodyLimit) {
          throw new Error("Copilot RPC body length is outside the byte limit");
        }
        this.bodyLength = length;
        this.buffer = this.buffer.subarray(end + 4);
      }
      if (this.buffer.length < this.bodyLength) break;
      const body = this.buffer.subarray(0, this.bodyLength);
      this.buffer = this.buffer.subarray(this.bodyLength);
      this.bodyLength = null;
      messages.push(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
    }
    return messages;
  }

  end(): void {
    if (this.bodyLength !== null || this.buffer.length !== 0) throw new Error("Copilot RPC ended with a truncated frame");
  }
}

const MAX_HEADER_BYTES = 64 * 1024;

/** Recognize the end of responses produced by our own Bun HTTP server.
 * Bodies are counted, never buffered. Unknown framing waits for TCP EOF. */
export class ResponseFraming {
  private mode: "headers" | "length" | "size" | "data" | "crlf" | "trailers" | "eof" | "done" = "headers";
  private remaining = 0;
  private line = "";

  constructor(private readonly headResponse = false) {}

  push(bytes: Uint8Array): boolean {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.mode === "done") return true;
      if (this.mode === "eof") return false;
      if (this.mode === "length" || this.mode === "data" || this.mode === "crlf") {
        const count = Math.min(this.remaining, bytes.length - offset);
        this.remaining -= count;
        offset += count;
        if (this.remaining !== 0) continue;
        if (this.mode === "length") this.mode = "done";
        else if (this.mode === "data") { this.mode = "crlf"; this.remaining = 2; }
        else this.mode = "size";
        continue;
      }
      this.line += String.fromCharCode(bytes[offset++]!);
      if (this.line.length > MAX_HEADER_BYTES) { this.mode = "eof"; return false; }
      if (this.mode === "headers") {
        if (!this.line.endsWith("\r\n\r\n")) continue;
        const status = Number(/^HTTP\/1\.[01] (\d+)/.exec(this.line)?.[1]);
        if (status >= 100 && status < 200) { this.line = ""; continue; }
        if (this.headResponse) { this.mode = "done"; return true; }
        const length = /\r\ncontent-length:\s*(\d+)\r\n/i.exec(this.line);
        if (/\r\ntransfer-encoding:\s*chunked\r\n/i.test(this.line)) this.mode = "size";
        else if (length !== null) {
          this.remaining = Number(length[1]);
          this.mode = this.remaining === 0 ? "done" : "length";
        } else this.mode = status === 204 || status === 304 ? "done" : "eof";
        this.line = "";
      } else if (this.line.endsWith("\r\n")) {
        if (this.mode === "trailers") {
          if (this.line === "\r\n") this.mode = "done";
        } else {
          const size = /^([0-9a-f]+)(?:;[^\r\n]*)?\r\n$/i.exec(this.line);
          if (size === null) { this.mode = "eof"; return false; }
          this.remaining = parseInt(size[1]!, 16);
          this.mode = this.remaining === 0 ? "trailers" : "data";
        }
        this.line = "";
      }
    }
    return this.mode === "done";
  }
}

/** Keep TCP sockets alive until Bun's complete HTTP response has drained.
 * Pinned Bun can finish a chunked response before its socket buffer drains. */
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { ResponseFraming } from "./response-framing.js";

export class CompleteTransport {
  private readonly connections = new Set<Socket>();
  private readonly awaitingHeaders = new Map<Socket, Socket>();
  private readonly busyClients = new Set<Socket>();
  private listener: Server | null = null;
  private stopped: Promise<void> | null = null;
  private resolveStopped: (() => void) | null = null;

  async start(port: number, httpPort: number): Promise<number> {
    const listener = this.listener = createServer((client) => {
      const upstream = connect(httpPort, "127.0.0.1");
      let framing: ResponseFraming | null = null;
      let method = "";
      this.awaitingHeaders.set(client, upstream);
      let tail = "";
      const headers = (chunk: Buffer) => {
        if (framing === null) {
          method += chunk.toString("latin1", 0, 5 - method.length);
          if (method.length === 5) framing = new ResponseFraming(method === "HEAD ");
        }
        const text = tail + chunk.toString("latin1");
        if (text.includes("\r\n\r\n")) {
          this.awaitingHeaders.delete(client);
          this.busyClients.add(client);
          client.off("data", headers);
        } else tail = text.slice(-3);
      };
      client.on("data", headers);
      for (const socket of [client, upstream]) {
        this.connections.add(socket);
        socket.on("error", () => { client.destroy(); upstream.destroy(); });
        socket.once("close", () => {
          this.connections.delete(socket);
          this.finishIfIdle();
        });
      }
      client.pipe(upstream);
      upstream.on("data", (chunk: Buffer) => {
        this.busyClients.add(client);
        if (!client.write(chunk)) upstream.pause();
        if (framing?.push(chunk)) {
          // The complete response is queued. end/finish waits for the TCP
          // writer; closing Bun's now-idle socket cannot discard any bytes.
          client.end();
          upstream.destroy();
        }
      });
      client.on("drain", () => upstream.resume());
      upstream.once("end", () => client.end());
      client.once("finish", () => client.destroy());
      client.once("close", () => upstream.destroy());
      client.once("close", () => {
        this.awaitingHeaders.delete(client);
        this.busyClients.delete(client);
        this.finishIfIdle();
      });
      upstream.once("close", () => {
        if (!client.writableEnded) client.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(port, "127.0.0.1", resolve);
    });
    return (listener.address() as AddressInfo).port;
  }

  stop(force: boolean): Promise<void> {
    if (force) for (const socket of this.connections) socket.destroy();
    if (this.stopped === null) {
      this.stopped = new Promise<void>((resolve) => { this.resolveStopped = resolve; });
    }
    if (force) this.listener?.close();
    this.finishIfIdle();
    return this.stopped;
  }

  private finishIfIdle(): void {
    if (this.resolveStopped === null) return;
    if (this.busyClients.size === 0) {
      // Keep serving 429s until response writes drain. Only then close the
      // listener and sockets that never supplied complete request headers.
      if (this.listener?.listening) this.listener.close();
      for (const [client, upstream] of this.awaitingHeaders) {
        client.destroy();
        upstream.destroy();
      }
    }
    if (this.connections.size === 0) this.resolveStopped?.();
  }
}

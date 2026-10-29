import type { ClientRequest, IncomingMessage } from "node:http";

export type RelayHttpResponse = {
  status: number; body: string; type?: string; etag?: string; allow?: string; connection?: string;
};

/** An early 413 can finish while the rejected upload still has queued writes. */
export function readRelayHttpResponse(request: ClientRequest): Promise<RelayHttpResponse> {
  return new Promise((resolveResponse, reject) => {
    let incoming: IncomingMessage | undefined;
    let reply: RelayHttpResponse | undefined;
    let closed = false;
    const complete = () => { if (reply && closed) resolveResponse(reply); };
    request.once("response", (response) => {
      incoming = response;
      const chunks: Buffer[] = [];
      let ended = false;
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("end", () => {
        ended = true;
        if (!response.complete) { reject(new Error("experiment relay returned an incomplete HTTP response")); return; }
        reply = { status: response.statusCode!, body: Buffer.concat(chunks).toString(),
          type: response.headers["content-type"], etag: response.headers.etag, allow: response.headers.allow,
          connection: response.headers.connection };
        complete();
      });
      response.once("aborted", () => reject(new Error("experiment relay HTTP response was aborted")));
      response.once("error", reject);
      response.once("close", () => {
        if (!ended) reject(new Error("experiment relay closed an incomplete HTTP response"));
      });
    });
    request.on("error", (error: NodeJS.ErrnoException) => {
      if (incoming?.statusCode === 413 && (error.code === "EPIPE" || error.code === "ECONNRESET")) return;
      reject(error);
    });
    request.once("close", () => {
      closed = true;
      if (!incoming) reject(new Error("experiment relay closed without an HTTP response"));
      else complete();
    });
  });
}

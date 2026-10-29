import type { ClientRequest, IncomingMessage } from "node:http";

export type RelayHttpResponse = {
  status: number; body: string; type?: string; etag?: string; allow?: string; connection?: string;
  rawBody?: string; events?: { event: string; data: string }[]; keepalives?: number;
};

function streamResponse(body: string): Pick<RelayHttpResponse, "body" | "rawBody" | "events" | "keepalives"> {
  const events: { event: string; data: string }[] = [];
  let keepalives = 0;
  for (const block of body.replace(/\r\n/g, "\n").split("\n\n")) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line === ": keepalive") keepalives++;
      else if (line.startsWith("event:")) event = line.slice(6).trimStart();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length) events.push({ event, data: data.join("\n") });
  }
  const messages = events.filter((event) => event.event === "message");
  if (messages.length !== 1) throw new Error("experiment relay SSE response must contain one message event");
  return { body: messages[0]!.data, rawBody: body, events, keepalives };
}

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
        const body = Buffer.concat(chunks).toString();
        let content: Pick<RelayHttpResponse, "body" | "rawBody" | "events" | "keepalives"> = { body };
        try {
          if (response.headers["content-type"]?.split(";", 1)[0]?.trim() === "text/event-stream") content = streamResponse(body);
        } catch (error) { reject(error); return; }
        reply = { status: response.statusCode!, ...content,
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

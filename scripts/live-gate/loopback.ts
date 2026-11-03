// The gate's loopback pieces (audits D7 and D9): probe J's reachability
// listener and no-net script, probe H's envelope verification, and probe
// H2's fake provider. Everything here talks to 127.0.0.1 only, and the
// fake provider never writes or prints a credential value — the request
// log records whether each request carried the override key, categorically.
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentId } from "../../src/types.js";
import { verifyResultEnvelope } from "./probes.js";

/** Probe H's verification: probe C's envelope checks, plus the proof the
 * override served the run — the envelope's `codemux.served_model` is the
 * model the PROVIDER reported serving the run, and it must be the model the
 * override selected. `codemux.model` alone proves nothing: it is codemux's
 * own selection (the request's, else the override's), so an override the
 * harness ignored left it unchanged (review round 14, edges 2). A null
 * served_model on a harness that can report one (claude, zai, codex — the
 * SERVED_MODEL_EVIDENCE set gates the probe) means the provider named no
 * single model, and fails. The override model is required (review round 4,
 * edges finding H): an undefined one made the model comparison a no-op. */
/** Closes a loopback server for good: open connections are destroyed so a
 * stalled client cannot hold the close, and the promise settles on the
 * server's own callback or after a bound (review round 43). */
function closeWithSockets(server: Server, sockets: Set<Socket>): Promise<void> {
  return new Promise<void>((done) => {
    let settled = false;
    const finish = (): void => { if (!settled) { settled = true; done(); } };
    const bound = setTimeout(finish, 5_000);
    server.close(() => { clearTimeout(bound); finish(); });
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  });
}

export function verifyProviderOverrideEnvelope(
  stdout: string,
  overrideModel: string,
  agent: AgentId
): string | null {
  const base = verifyResultEnvelope(stdout, agent);
  if (base !== null) return base;
  const envelope = JSON.parse(stdout) as { codemux?: { served_model?: unknown } };
  const served = envelope.codemux?.served_model;
  if (typeof served !== "string" || served === "") {
    return "result JSON reports no codemux.served_model; the provider did not report the override's model serving the run";
  }
  if (served !== overrideModel) {
    return `codemux.served_model is ${JSON.stringify(served)}, not the override's ${JSON.stringify(overrideModel)}`;
  }
  return null;
}

export function providerOverrideEnv(agent: AgentId): string {
  return `CODEMUX_${agent.toUpperCase()}_PROVIDER_BASE_URL,CODEMUX_${agent.toUpperCase()}_PROVIDER_API_KEY,CODEMUX_${agent.toUpperCase()}_PROVIDER_MODEL`;
}

export interface LoopbackServer {
  port: number;
  close(): Promise<void>;
}

/** Probe J's listener: any request answers 200, so the address is provably
 * reachable OUTSIDE the sandbox and a curl that fails inside
 * --sandbox-no-net proves the block (audit D7) — not a port that happened
 * to be closed. */
export function startReachableListener(): Promise<LoopbackServer> {
  return new Promise((ready, refuse) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("reachable\n");
    });
    // A client that opened a request and never finished would hold
    // server.close() open forever (review round 43): every connection is
    // destroyed at close, and the close resolves on its callback or a bound.
    const sockets = new Set<Socket>();
    server.on("connection", (socket: Socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.once("error", refuse);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        refuse(new Error("the loopback listener reported no port"));
        return;
      }
      ready({
        port: address.port,
        close: () => closeWithSockets(server, sockets),
      });
    });
  });
}

export interface NoNetProbe {
  expected: "BLOCKED";
  prompt: string;
}

/** Writes probe J's script: run by the harness under
 * `--sandbox-no-net --sandbox-scrub-env --sandbox-trust standard`, it must
 * reply BLOCKED. NO-CURL is a distinct output on purpose — it mismatches
 * the expected BLOCKED and fails the probe instead of passing it on a
 * sandbox that merely lacks curl. */
export function prepareNoNetProbe(directory: string, port: number): NoNetProbe {
  writeFileSync(join(directory, "nonet.sh"), [
    "if ! command -v curl >/dev/null 2>&1; then",
    "  printf 'NO-CURL'",
    "  exit 0",
    "fi",
    `if curl -fsS --max-time 5 http://127.0.0.1:${port}/ >/dev/null 2>&1; then`,
    "  printf 'OPEN'",
    "else",
    "  printf 'BLOCKED'",
    "fi\n",
  ].join("\n"), { mode: 0o700 });
  return {
    expected: "BLOCKED",
    prompt: "Run the shell command: sh nonet.sh and reply with exactly its output, nothing else.",
  };
}

/** One request the fake provider saw. `auth` is categorical on purpose:
 * the log never carries a credential value, only whether the request bore
 * the override key, a different one, or none. */
export interface OverrideRequestRecord {
  path: string;
  auth: "override" | "other" | "none";
  model: string | null;
}

export interface FakeProvider extends LoopbackServer {
  /** Every request the harness sent, in order. */
  requests(): OverrideRequestRecord[];
}

/** Probe H2's fake provider (audit D9): the loopback twin of probe H. The
 * gate points the run's provider override at this server, so the run spends
 * no provider quota and no real credential is reachable. Requests carrying
 * the override key answer 200 with a minimal body; every other request is
 * refused with 401. The proof is the request log (verifyOverrideLog), not
 * the run's envelope or exit code. */
/** The fake provider reads at most this much body per request (review round 44). */
export const FAKE_PROVIDER_BODY_LIMIT = 1_048_576;

export function startFakeProvider(options: { apiKey: string }): Promise<FakeProvider> {
  return new Promise((ready, refuse) => {
    const seen: OverrideRequestRecord[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      let received = 0;
      let oversized = false;
      // Authorization: Bearer <key> (OpenAI-style) and x-api-key (the
      // Anthropic spelling) are both read. The request is the override's
      // only when EVERY credential it carries is the override key: a real
      // key beside the override key is a credential leak, recorded as
      // "other" (review round 44).
      const headers = request.headers;
      const bearer = headers.authorization?.replace(/^Bearer\s+/i, "");
      const headerKey = headers["x-api-key"];
      const carried = [bearer, headerKey].filter((value): value is string => value !== undefined && value !== "");
      const auth: OverrideRequestRecord["auth"] =
        carried.length === 0 ? "none" : carried.every((value) => value === options.apiKey) ? "override" : "other";
      request.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > FAKE_PROVIDER_BODY_LIMIT) {
          // A candidate streaming without end must not grow this process:
          // the record is kept (no model read), the request refused.
          if (!oversized) {
            oversized = true;
            seen.push({ path: request.url ?? "", auth, model: null });
            response.writeHead(413, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "body too large for the fake provider" }));
            request.destroy();
          }
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        if (oversized) return;
        let model: string | null = null;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: unknown };
          if (typeof body.model === "string") model = body.model;
        } catch {
          // A body that is not JSON carries no model field to check.
        }
        seen.push({ path: request.url ?? "/", auth, model });
        if (auth !== "override") {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({
            error: { type: "authentication_error", message: "the loopback probe provider refuses requests without the override key" },
          }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: "loopback-probe", object: "completion",
          model: model ?? "unknown",
          choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
          content: [{ type: "text", text: "OK" }],
        }));
      });
    });
    // A client that opened a request and never finished would hold
    // server.close() open forever (review round 43): every connection is
    // destroyed at close, and the close resolves on its callback or a bound.
    const sockets = new Set<Socket>();
    server.on("connection", (socket: Socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.once("error", refuse);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        refuse(new Error("the loopback fake provider reported no port"));
        return;
      }
      ready({
        port: address.port,
        requests: () => [...seen],
        close: () => closeWithSockets(server, sockets),
      });
    });
  });
}

/** Probe H2's verification over the fake provider's request log (audit
 * D9): the harness must have talked to the fake at all (zero requests
 * means the override did not route the run — it went to the real provider
 * or nowhere), every request must have carried the override key and no
 * other credential, and at least one request must have named the override
 * model. Returns the failure reason, or null when the log passes. */
export function verifyOverrideLog(
  records: readonly OverrideRequestRecord[],
  overrideModel: string
): string | null {
  if (records.length === 0) {
    return "the harness sent no request to the loopback provider; the override did not route the run";
  }
  const other = records.filter((record) => record.auth === "other").length;
  if (other > 0) {
    return `${other} of ${records.length} request(s) carried a credential other than the override key; the override did not isolate the run`;
  }
  const none = records.filter((record) => record.auth === "none").length;
  if (none > 0) {
    return `${none} of ${records.length} request(s) carried no credential header; the override key never reached the provider`;
  }
  if (!records.some((record) => record.model === overrideModel)) {
    const models = [...new Set(records.map((record) => record.model))]
      .map((model) => JSON.stringify(model)).join(", ");
    return `no request named the override model ${JSON.stringify(overrideModel)}; the requests carried: ${models}`;
  }
  return null;
}

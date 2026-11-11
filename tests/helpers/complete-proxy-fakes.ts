/** Local TLS origin and CONNECT proxy. Synthetic credentials only. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { join } from "node:path";
import { OPENAI_ANSWER, json, ledgerScratch } from "./complete-fakes.js";

export function proxyCertificate() {
  const scratch = ledgerScratch();
  const ca = join(scratch.dir, "cert.pem");
  const key = join(scratch.dir, "key.pem");
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-keyout", key, "-out", ca, "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"],
    { stdio: "pipe" });
    return { ca, tls: { key: readFileSync(key), cert: readFileSync(ca) }, cleanup: scratch.cleanup };
  } catch (error) {
    scratch.cleanup();
    throw error;
  }
}

export async function proxyFakes(tls?: ReturnType<typeof proxyCertificate>["tls"]) {
  const credentials: (string | null)[] = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, tls, async fetch(request) {
    credentials.push(request.headers.get("authorization"));
    await request.text();
    return json(OPENAI_ANSWER);
  } });
  const sockets = new Set<Socket>();
  const targets: string[] = [];
  let requests = 0;
  const proxy = createServer((_request, response) => {
    requests++;
    response.writeHead(502).end();
  });
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  proxy.on("connect", (request, client, head) => {
    requests++;
    targets.push(request.url ?? "");
    // The fake can only connect to its own origin, never an outside host.
    if (request.url !== `127.0.0.1:${upstream.port}`) { client.destroy(); return; }
    const origin = connect(upstream.port!, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) origin.write(head);
      client.pipe(origin);
      origin.pipe(client);
    });
    sockets.add(origin);
    origin.on("close", () => sockets.delete(origin));
    origin.on("error", () => client.destroy());
    client.on("error", () => origin.destroy());
    client.on("close", () => origin.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  return {
    baseUrl: `${tls ? "https" : "http"}://127.0.0.1:${upstream.port}/v1`,
    proxyUrl: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    credentials, targets, requests: () => requests,
    stop() {
      for (const socket of sockets) socket.destroy();
      proxy.close();
      upstream.stop(true);
    },
  };
}

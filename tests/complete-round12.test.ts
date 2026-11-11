/** Cap shutdown must drain HTTP bodies, including on pinned Bun 1.3.14. */
import { afterEach, describe, expect, test } from "bun:test";
import { CompleteServer } from "../src/complete/server.js";
import { governorFor, ledgerScratch, OPENAI_ANSWER, startFake, upstreamFor } from "./helpers/complete-fakes.js";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const request = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };
const MIB = 1024 * 1024;

function slowPost(url: string, token: string, stream: boolean) {
  let headers!: () => void;
  const started = new Promise<void>((resolve) => { headers = resolve; });
  let resume!: () => void;
  const body = new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    void Bun.connect({
      hostname: "127.0.0.1", port: Number(new URL(url).port),
      socket: {
        open(client) {
          const payload = JSON.stringify({ ...request, stream, stream_options: { include_usage: true } });
          resume = () => client.resume();
          cleanups.push(() => client.terminate());
          client.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
        },
        data(client, chunk) {
          chunks.push(Buffer.from(chunk));
          client.pause();
          if (chunks.length === 1) headers();
          else setTimeout(() => client.resume(), 1);
        },
        end(client) {
          try { resolve(httpBody(Buffer.concat(chunks))); } catch (error) { reject(error); }
          client.end();
        },
        error(_client, error) { reject(error); },
      },
    }).catch(reject);
  });
  // Keep an early socket error handled until the test awaits the body.
  void body.catch(() => {});
  return { started, body, resume: () => resume() };
}

function httpBody(wire: Buffer): string {
  const boundary = wire.indexOf("\r\n\r\n");
  const headers = wire.subarray(0, boundary).toString();
  expect(headers).toMatch(/^HTTP\/1\.1 200 /);
  let body = wire.subarray(boundary + 4);
  const length = /content-length: (\d+)/i.exec(headers);
  if (length) {
    expect(body.length).toBe(Number(length[1]));
    return body.toString();
  }
  expect(headers).toMatch(/transfer-encoding: chunked/i);
  const chunks: Buffer[] = [];
  while (body.length > 0) {
    const end = body.indexOf("\r\n");
    const size = parseInt(body.subarray(0, end).toString(), 16);
    if (end < 0 || !Number.isFinite(size)) throw new Error("invalid HTTP chunk header");
    body = body.subarray(end + 2);
    if (size === 0) {
      expect(body.toString()).toBe("\r\n");
      return Buffer.concat(chunks).toString();
    }
    if (body.length < size + 2) throw new Error("truncated HTTP chunk");
    chunks.push(body.subarray(0, size));
    expect(body.subarray(size, size + 2).toString()).toBe("\r\n");
    body = body.subarray(size + 2);
  }
  throw new Error("missing final HTTP chunk");
}

describe("cap response draining", () => {
  test("new requests get a complete 429 while a settled 48 MiB answer drains", async () => {
    const answer = JSON.stringify({ ...OPENAI_ANSWER,
      choices: [{ index: 0, message: { role: "assistant", content: "x".repeat(48 * MIB) }, finish_reason: "stop" }] });
    const fake = startFake(() => new Response(answer, { headers: { "content-type": "application/json" } }));
    const scratch = ledgerScratch();
    const server = new CompleteServer({ upstream: upstreamFor(fake, "openai"),
      governor: governorFor(scratch.environment, { maxRequests: 1 }), port: 0, timeoutMs: 5000 });
    const url = await server.start();
    cleanups.push(() => { server.stop("signal"); fake.stop(); scratch.cleanup(); });
    const client = slowPost(url, server.token, false);
    await client.started;
    expect(scratch.records()).toHaveLength(1);
    const refused = await fetch(url + "/v1/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${server.token}` }, body: JSON.stringify(request),
    });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: { code: "request_cap_reached" } });
    client.resume();
    expect(await client.body).toBe(answer);
    expect(await server.done).toMatchObject({ reason: "cap", requests: 1 });
    expect(fake.received).toHaveLength(1);
  });
  for (const stream of [false, true]) {
    for (const size of [MIB, 12 * MIB]) {
      test(`${stream ? "SSE" : "JSON"}: ${size / MIB} MiB slow readers receive both in-flight answers`, async () => {
        const content = "x".repeat(size);
        const choice = { index: 0, message: { role: "assistant", content }, finish_reason: "stop" };
        const answer = stream
          ? `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }], usage: OPENAI_ANSWER.usage })}\n\ndata: [DONE]\n\n`
          : JSON.stringify({ ...OPENAI_ANSWER, choices: [choice] });
        let release!: () => void;
        const ready = new Promise<void>((resolve) => { release = resolve; });
        let admitted!: () => void;
        const bothAdmitted = new Promise<void>((resolve) => { admitted = resolve; });
        let received = 0;
        const fake = startFake(async () => {
          if (++received === 2) admitted();
          await ready;
          return new Response(answer, { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
        });
        const scratch = ledgerScratch();
        const governor = governorFor(scratch.environment, { maxRequests: 2 });
        const server = new CompleteServer({ upstream: upstreamFor(fake, "openai"), governor, port: 0, timeoutMs: 5000 });
        const url = await server.start();
        cleanups.push(() => { release(); server.stop("signal"); fake.stop(); scratch.cleanup(); });
        const clients = [slowPost(url, server.token, stream), slowPost(url, server.token, stream)];
        await bothAdmitted;
        const refused = await fetch(url + "/v1/chat/completions", {
          method: "POST", headers: { authorization: `Bearer ${server.token}` }, body: JSON.stringify(request),
        });
        expect(refused.status).toBe(429);
        expect(await refused.json()).toMatchObject({ error: { code: "request_cap_reached" } });
        release();
        await Promise.all(clients.map((client) => client.started));
        await Bun.sleep(100);
        for (const client of clients) client.resume();
        for (const body of await Promise.all(clients.map((client) => client.body))) expect(body).toBe(answer);
        expect(await server.done).toMatchObject({ reason: "cap", requests: 2, capReason: "request_cap_reached" });
        expect(fake.received).toHaveLength(2);
        expect(scratch.records().map((row) => row.finish).sort()).toEqual(["refused:request_cap_reached", "stop", "stop"]);
      });
    }
  }
});

describe("CLI process drains its last response before exiting", () => {
  for (const stream of [false, true]) {
    for (const cap of ["request_cap_reached", "budget_exhausted", "cost_unknown"]) {
      test(`${stream ? "SSE" : "JSON"}: ${cap} preserves a 12 MiB answer through process exit`, async () => {
        const content = "x".repeat(12 * MIB);
        const usage = cap === "cost_unknown" ? undefined : OPENAI_ANSWER.usage;
        const answer = stream
          ? `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`
          : JSON.stringify({ ...OPENAI_ANSWER, usage, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
        const fake = startFake(() => new Response(answer, {
          headers: { "content-type": stream ? "text/event-stream" : "application/json" },
        }));
        const scratch = ledgerScratch();
        const child = Bun.spawn([process.execPath, "--no-env-file", "-e",
          'import { runServe, defaultDeps } from "./src/complete/command.ts"; process.exitCode = await runServe(JSON.parse(process.argv[1]), defaultDeps());',
          JSON.stringify({ provider: "openai", baseUrl: fake.baseUrl, keyEnv: "TEST_KEY", label: [],
            timeout: "5", port: "0", maxRequests: cap === "request_cap_reached" ? "1" : "10",
            budgetUsd: cap === "budget_exhausted" ? "0.001" : "100" }),
        ], {
          cwd: new URL("..", import.meta.url).pathname,
          env: { ...process.env, ...scratch.environment, TEST_KEY: "sk-test-not-a-real-key" },
          stdout: "pipe", stderr: "pipe",
        });
        cleanups.push(() => { child.kill(); fake.stop(); scratch.cleanup(); });
        const output = child.stdout.getReader();
        let line = "";
        while (!line.includes("\n")) {
          const next = await output.read();
          if (next.done) throw new Error(await new Response(child.stderr).text());
          line += new TextDecoder().decode(next.value);
        }
        const ready = JSON.parse(line) as { base_url: string; token: string };
        const client = slowPost(ready.base_url.replace(/\/v1$/, ""), ready.token, stream);
        await client.started;
        await Bun.sleep(100);
        client.resume();
        expect(await client.body).toBe(answer);
        expect(await child.exited).toBe(0);
        expect(await new Response(child.stderr).text()).toContain(`stopped at a cap (${cap})`);
        expect(scratch.records()).toHaveLength(1);
        expect(fake.received).toHaveLength(1);
        output.releaseLock();
      });
    }
  }
});

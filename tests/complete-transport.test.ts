import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { ResponseFraming } from "../src/complete/response-framing.js";
import { CompleteServer } from "../src/complete/server.js";
import { governorFor, json, ledgerScratch, OPENAI_ANSWER, startFake, upstreamFor } from "./helpers/complete-fakes.js";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

describe("native HTTP response boundaries", () => {
  test("HEAD has no body even with a nonzero content length", () => {
    const framing = new ResponseFraming(true);
    expect(framing.push(Buffer.from("HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 200\r\n\r\n"))).toBe(true);
  });
  const responses = [
    "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello",
    "HTTP/1.1 429 Too Many Requests\r\ncontent-length: 2\r\n\r\n{}",
    "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
    "HTTP/1.1 204 No Content\r\n\r\n",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2;ext=x\r\nhi\r\n3\r\nbye\r\n0\r\nTrailer: value\r\n\r\n",
  ];
  for (const [index, response] of responses.entries()) {
    test(`response ${index + 1} remains incomplete at every byte boundary`, () => {
      const bytes = Buffer.from(response);
      for (let split = 0; split < bytes.length; split++) {
        const framing = new ResponseFraming();
        expect(framing.push(bytes.subarray(0, split))).toBe(false);
        expect(framing.push(bytes.subarray(split))).toBe(true);
      }
      const framing = new ResponseFraming();
      for (let i = 0; i < bytes.length; i++) {
        expect(framing.push(bytes.subarray(i, i + 1))).toBe(i === bytes.length - 1);
      }
    });
  }
  for (const response of [
    "HTTP/1.1 200 OK\r\n\r\nbody delimited by EOF",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\ngarbage\r\n",
    "HTTP/1.1 200 OK\r\nX: " + "a".repeat(64 * 1024),
  ]) {
    test(`unknown framing waits for EOF: ${response.slice(0, 60)}`, () => {
      const framing = new ResponseFraming();
      expect(framing.push(Buffer.from(response))).toBe(false);
      expect(framing.push(Buffer.from("more"))).toBe(false);
    });
  }
});

describe("TCP lifetime at shutdown", () => {
  for (const partial of ["", "POST /v1/chat/completions HTTP/1.1\r\n"]) {
    test(`${partial === "" ? "idle" : "partial-header"} connection cannot hold cap shutdown open`, async () => {
      const scratch = ledgerScratch();
      const fake = startFake(() => json(OPENAI_ANSWER));
      const server = new CompleteServer({ upstream: upstreamFor(fake, "openai"),
        governor: governorFor(scratch.environment, { maxRequests: 1 }), timeoutMs: 1000, port: 0 });
      const url = await server.start();
      const socket = connect(Number(new URL(url).port), "127.0.0.1");
      socket.on("error", () => {});
      cleanups.push(() => { socket.destroy(); server.stop("signal"); fake.stop(); scratch.cleanup(); });
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      if (partial) socket.write(partial);
      const head = await fetch(url + "/v1/chat/completions", {
        method: "HEAD", headers: { authorization: `Bearer ${server.token}` },
      });
      expect(head.status).toBe(405);
      expect(await head.text()).toBe("");
      const response = await fetch(url + "/v1/chat/completions", {
        method: "POST", headers: { authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(await response.json()).toEqual(OPENAI_ANSWER);
      expect(await server.done).toMatchObject({ reason: "cap", requests: 1 });
      expect(scratch.records()).toHaveLength(1);
    });
  }
});

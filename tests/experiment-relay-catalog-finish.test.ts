/**
 * When the served model catalog counts as delivered (review rounds 115
 * and 116). The relay used to mark it served right after
 * `response.end()`. It now counts a fetch only when the response
 * finished, uncounts it when the client resets the connection with the
 * body unread, and keeps it once the client used the connection again or
 * closed it in order. src/experiment-relay-catalog.ts states the rule.
 *
 * Over loopback a client that abandons the body still lets the server's
 * `finish` fire: the kernel accepted the bytes. What the server sees
 * next is the reset, as an error on the connection. The real-socket
 * tests below drive exactly that.
 */

import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import type { ExperimentHttpRelay } from "../src/experiment-relay.js";
import { cleanupRelays, http, records, setup } from "./helpers/experiment-relay-fixture.js";

afterEach(cleanupRelays);

/** Just under the 1 MiB catalog cap (experiment-codex-model.ts). */
const BIG_BODY = `{"pad":"${"x".repeat(1023 * 1024)}"}`;

const kinds = (relay: ExperimentHttpRelay): string[] =>
  records(relay).map((record) => record.kind).filter((kind) => kind.startsWith("catalog_"));

async function until(holds: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

/** A raw client: the tests decide when it reads and how it closes. */
async function rawClient(relay: ExperimentHttpRelay): Promise<{ socket: Socket; get: (path?: string) => void; received: () => number }> {
  const catalog = new URL(relay.catalogUrl!);
  const socket = connect(Number(catalog.port), catalog.hostname);
  socket.on("error", () => {});
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  let received = 0;
  socket.on("data", (chunk) => { received += chunk.length; });
  return {
    socket,
    get: (path = catalog.pathname) => { socket.write(`GET ${path} HTTP/1.1\r\nHost: relay\r\n\r\n`); },
    received: () => received,
  };
}

function fakeResponse(socket: EventEmitter | null = new EventEmitter()): ServerResponse {
  const emitter = new EventEmitter() as unknown as
    { shouldKeepAlive: boolean; socket: EventEmitter | null; writeHead: () => void; end: () => void } & EventEmitter;
  emitter.shouldKeepAlive = true;
  emitter.socket = socket;
  emitter.writeHead = () => {};
  emitter.end = () => {};
  return emitter as unknown as ServerResponse;
}

function serve(relay: ExperimentHttpRelay, response: ServerResponse): void {
  const nonce = (relay as unknown as { catalog: { nonce: string } }).catalog.nonce;
  const request = { method: "GET", resume: (): void => {}, headers: {} } as unknown as IncomingMessage;
  (relay as unknown as { serveCatalog(request: IncomingMessage, response: ServerResponse, path: string, query: URLSearchParams): void })
    .serveCatalog(request, response, `/catalog/${nonce}`, new URLSearchParams());
}

test("a response that closes without finishing never records catalog_served; one that finishes records it once", async () => {
  const relay = await setup(undefined, { catalog: { body: '{"models":[]}' } });
  const closed = fakeResponse();
  serve(relay, closed);
  closed.emit("close");
  expect(relay.catalogServed).toBe(false);
  expect(kinds(relay)).toEqual([]);
  const finished = fakeResponse();
  serve(relay, finished);
  finished.emit("finish");
  finished.emit("finish");
  expect(relay.catalogServed).toBe(true);
  const served = records(relay).filter((record) => record.kind === "catalog_served");
  expect(served).toHaveLength(1);
  expect((served[0] as { bytes?: number }).bytes).toBe('{"models":[]}'.length);
});

test("a request pipelined behind the catalog response does not settle the fetch (review round 117)", async () => {
  const relay = await setup(undefined, { catalog: { body: '{"models":[]}' } });
  const delivery = (relay as unknown as { catalogDelivery: { requestArrived(connection: unknown): void } }).catalogDelivery;
  const socket = new EventEmitter();
  const response = fakeResponse(socket);
  serve(relay, response);
  // The second request is already here before the catalog response finished.
  delivery.requestArrived(socket);
  response.emit("finish");
  expect(relay.catalogServed).toBe(true);
  // The client never read anything and resets: the fetch is uncounted.
  socket.emit("error", new Error("reset"));
  expect(relay.catalogServed).toBe(false);
  expect(kinds(relay)).toEqual(["catalog_served", "catalog_fetch_reset"]);
  // A request after the finish settles a fetch; a later reset keeps it.
  const second = new EventEmitter();
  second.on("error", () => {}); // The settled fetch removed its listener; an unheard error event would throw.
  const read = fakeResponse(second);
  serve(relay, read);
  read.emit("finish");
  delivery.requestArrived(second);
  second.emit("error", new Error("reset"));
  expect(relay.catalogServed).toBe(true);
  expect(kinds(relay)).toEqual(["catalog_served", "catalog_fetch_reset", "catalog_served"]);
});

test("two catalog fetches open on one connection both settle on the request that follows them (review round 120)", async () => {
  const relay = await setup(undefined, { catalog: { body: '{"models":[]}' } });
  const delivery = (relay as unknown as { catalogDelivery: { requestArrived(connection: unknown): void } }).catalogDelivery;
  const socket = new EventEmitter();
  socket.on("error", () => {});
  const first = fakeResponse(socket);
  const second = fakeResponse(socket);
  serve(relay, first);
  serve(relay, second);
  first.emit("finish");
  second.emit("finish");
  // The request after both: the client read both. A reset from later
  // traffic uncounts neither and records nothing.
  delivery.requestArrived(socket);
  socket.emit("error", new Error("reset"));
  expect(relay.catalogServed).toBe(true);
  expect(kinds(relay)).toEqual(["catalog_served", "catalog_served"]);
  expect(socket.listenerCount("error")).toBe(1);
  expect(socket.listenerCount("close")).toBe(0);
});

test("a catalog response with no connection to watch is never counted", async () => {
  const relay = await setup(undefined, { catalog: { body: '{"models":[]}' } });
  const response = fakeResponse(null);
  serve(relay, response);
  response.emit("finish");
  expect(relay.catalogServed).toBe(false);
  expect(kinds(relay)).toEqual([]);
});

test("two requests pipelined over a real socket and never read: the reset is recorded and nothing fails", async () => {
  // What the relay concludes about the FIRST fetch depends on when it
  // sees the second request, which the client does not control: before
  // the first response finished (pipelined, settles nothing, so the reset
  // uncounts the fetch) or after it (indistinguishable from a client that
  // read the response, so the fetch stays counted; the stated limit).
  // Both orders happen for two requests written together, so this test
  // asserts only what holds in both. The two orders themselves are
  // pinned with fake responses above, where the order is under control.
  const relay = await setup(undefined, { catalog: { body: BIG_BODY } });
  const catalog = new URL(relay.catalogUrl!);
  const client = await rawClient(relay);
  client.socket.pause();
  const get = (path: string): string => `GET ${path} HTTP/1.1\r\nHost: relay\r\n\r\n`;
  client.socket.write(get(catalog.pathname) + get(catalog.pathname));
  await until(() => kinds(relay).includes("catalog_served"), "catalog_served");
  client.socket.resetAndDestroy();
  await until(() => kinds(relay).includes("catalog_fetch_reset"), "catalog_fetch_reset");
  await Bun.sleep(100);
  const seen = kinds(relay);
  const served = seen.filter((kind) => kind === "catalog_served").length;
  const reset = seen.filter((kind) => kind === "catalog_fetch_reset").length;
  // The abandoned connection uncounted at least its last fetch, and never
  // more fetches than it counted.
  expect(reset).toBeGreaterThanOrEqual(1);
  expect(reset).toBeLessThanOrEqual(served);
  expect(relay.catalogServed).toBe(served > reset);
  expect(relay.failureCode).toBeNull();
});

test("a complete fetch of a large catalog over a real socket marks it served once", async () => {
  const relay = await setup(undefined, { catalog: { body: BIG_BODY } });
  const catalog = new URL(relay.catalogUrl!);
  expect(relay.catalogServed).toBe(false);
  const response = await http(relay, "", { method: "GET", path: catalog.pathname, token: null });
  expect(response.status).toBe(200);
  expect(response.body).toBe(BIG_BODY);
  expect(relay.catalogServed).toBe(true);
  expect(kinds(relay)).toEqual(["catalog_served"]);
});

test("a client that resets the connection with the catalog unread leaves it unserved (review round 116)", async () => {
  const relay = await setup(undefined, { catalog: { body: BIG_BODY } });
  const client = await rawClient(relay);
  client.socket.pause();
  client.get();
  // The server finished the response into the kernel's buffers.
  await until(() => kinds(relay).includes("catalog_served"), "catalog_served");
  expect(relay.catalogServed).toBe(true);
  // The client goes away without reading the body.
  client.socket.resetAndDestroy();
  await until(() => kinds(relay).includes("catalog_fetch_reset"), "catalog_fetch_reset");
  expect(relay.catalogServed).toBe(false);
  expect(kinds(relay)).toEqual(["catalog_served", "catalog_fetch_reset"]);
  expect(relay.failureCode).toBeNull();
  // A later complete fetch still counts.
  const catalog = new URL(relay.catalogUrl!);
  await http(relay, "", { method: "GET", path: catalog.pathname, token: null });
  expect(relay.catalogServed).toBe(true);
  expect(kinds(relay)).toEqual(["catalog_served", "catalog_fetch_reset", "catalog_served"]);
});

test("a reset after the client used the connection again does not uncount the catalog", async () => {
  const relay = await setup(undefined, { catalog: { body: BIG_BODY } });
  const client = await rawClient(relay);
  client.get();
  await until(() => client.received() > BIG_BODY.length, "the whole catalog response");
  // The next request on the same connection: the client read the catalog.
  const before = client.received();
  client.get("/catalog/not-the-nonce");
  await until(() => client.received() > before, "the second response");
  // A later response the client abandons belongs to later traffic.
  client.socket.pause();
  client.get();
  await until(() => kinds(relay).filter((kind) => kind === "catalog_served").length === 2, "the second catalog_served");
  client.socket.resetAndDestroy();
  await until(() => kinds(relay).includes("catalog_fetch_reset"), "catalog_fetch_reset");
  // The first, confirmed fetch still stands; only the abandoned one went.
  expect(relay.catalogServed).toBe(true);
  expect(kinds(relay)).toEqual(["catalog_served", "catalog_served", "catalog_fetch_reset"]);
});

test("an orderly close after reading keeps the catalog served", async () => {
  const relay = await setup(undefined, { catalog: { body: BIG_BODY } });
  const client = await rawClient(relay);
  client.get();
  await until(() => client.received() > BIG_BODY.length, "the whole catalog response");
  const closed = new Promise<void>((resolve) => client.socket.once("close", () => resolve()));
  client.socket.end();
  await closed;
  await Bun.sleep(100);
  expect(relay.catalogServed).toBe(true);
  expect(kinds(relay)).toEqual(["catalog_served"]);
});

test("an abortive close right after the fetch uncounts it even when the client had read the body: fail closed", async () => {
  // The stated cost of the rule (review round 119). The server sees the
  // same reset whether the body was read or not, so it cannot keep the
  // fetch for one and drop it for the other. It drops both: an abortive
  // close is not how an HTTP client ends a connection it read from, and a
  // client that does it fetches the catalog again.
  const relay = await setup(undefined, { catalog: { body: BIG_BODY } });
  const client = await rawClient(relay);
  client.get();
  await until(() => client.received() > BIG_BODY.length, "the whole catalog response");
  client.socket.resetAndDestroy();
  await until(() => kinds(relay).includes("catalog_fetch_reset"), "catalog_fetch_reset");
  expect(relay.catalogServed).toBe(false);
  expect(relay.failureCode).toBeNull();
  const catalog = new URL(relay.catalogUrl!);
  await http(relay, "", { method: "GET", path: catalog.pathname, token: null });
  expect(relay.catalogServed).toBe(true);
});

test("a recording failure inside the finish handler fails the relay instead of throwing (review round 116)", async () => {
  const relay = await setup(undefined, { catalog: { body: '{"models":[]}' } });
  const recording = (relay as unknown as { recording: { record: (kind: string, fields: object) => void } }).recording;
  const original = recording.record.bind(recording);
  recording.record = (kind, fields) => {
    if (kind === "catalog_served") throw new Error("no space left on device");
    original(kind, fields);
  };
  const response = fakeResponse();
  serve(relay, response);
  expect(() => response.emit("finish")).not.toThrow();
  expect(relay.catalogServed).toBe(false);
  expect(relay.failureCode).not.toBeNull();
});

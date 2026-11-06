/**
 * The experiment MCP server's stdin write is settled before a notification is
 * acknowledged, and a rejected write (EPIPE under backpressure) ends the
 * server instead of going unhandled (review round 59); a sink that answers
 * a closed result instead of a promise is the same failure (round 211).
 */

import { expect, test } from "bun:test";
import { ExperimentServer } from "../src/experiment-server.js";

test("a notification whose stdin write rejects is rejected to the caller and fails the server", async () => {
  const failures: Error[] = [];
  const server = new ExperimentServer(
    { name: "experiment", command: "/bin/true", args: [], env: [], accept_harness_prefix: [] } as never,
    process.cwd(), {}, () => {}, (error) => { failures.push(error); }
  );
  // A fake process whose sink is under backpressure and then broken.
  (server as unknown as { proc: unknown }).proc = {
    stdin: { write: () => Promise.reject(new Error("EPIPE: broken pipe")) },
  };
  await expect(server.request({ jsonrpc: "2.0", method: "notifications/initialized" })).rejects.toThrow("EPIPE");
  await Bun.sleep(5);
  expect(failures.map((error) => error.message).join("\n")).toContain("stdin write failed");
});

test("a synchronous write acknowledges a notification at once", async () => {
  const server = new ExperimentServer(
    { name: "experiment", command: "/bin/true", args: [], env: [], accept_harness_prefix: [] } as never,
    process.cwd(), {}, () => {}, () => {}
  );
  (server as unknown as { proc: unknown }).proc = { stdin: { write: () => 42 } };
  await expect(server.request({ jsonrpc: "2.0", method: "notifications/initialized" })).resolves.toBeUndefined();
});

test("an asynchronous write that resolves acknowledges the notification once it settled", async () => {
  const server = new ExperimentServer(
    { name: "experiment", command: "/bin/true", args: [], env: [], accept_harness_prefix: [] } as never,
    process.cwd(), {}, () => {}, () => {}
  );
  let settled = false;
  (server as unknown as { proc: unknown }).proc = {
    stdin: { write: () => new Promise((resolve) => setTimeout(() => { settled = true; resolve(7); }, 20)) },
  };
  await expect(server.request({ jsonrpc: "2.0", method: "notifications/initialized" })).resolves.toBeUndefined();
  expect(settled).toBe(true);
});

test("an id-bearing request whose write rejects is rejected and releases its pending slot (review round 60)", async () => {
  const failures: Error[] = [];
  const server = new ExperimentServer(
    { name: "experiment", command: "/bin/true", args: [], env: [], accept_harness_prefix: [] } as never,
    process.cwd(), {}, () => {}, (error) => { failures.push(error); }
  );
  (server as unknown as { proc: unknown }).proc = {
    stdin: { write: () => Promise.reject(new Error("EPIPE: broken pipe")) },
  };
  await expect(server.request({ jsonrpc: "2.0", id: 7, method: "tools/list" })).rejects.toThrow("stdin write failed");
  expect((server as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
  expect(failures).toHaveLength(1);
});

test("a sink that answers a closed result instead of a promise is a failed delivery (round 211)", async () => {
  // Bun answers a closed sink with a boolean, or its own Error, instead of
  // throwing or rejecting: the message never left, so the write is the
  // failure a rejection is -- acknowledged nowhere, the failure handler
  // reached at once.
  const failures: Error[] = [];
  const errorSink = new ExperimentServer(
    { name: "experiment", command: "/bin/true", args: [], env: [], accept_harness_prefix: [] } as never,
    process.cwd(), {}, () => {}, (error) => { failures.push(error); }
  );
  (errorSink as unknown as { proc: unknown }).proc = {
    stdin: { write: () => new Error("EPIPE: broken pipe") },
  };
  await expect(errorSink.request({ jsonrpc: "2.0", method: "notifications/initialized" }))
    .rejects.toThrow("stdin write failed");
  expect(failures.map((error) => error.message).join("\n")).toContain("the stdin sink was closed");

  const booleanSink = new ExperimentServer(
    { name: "experiment", command: "/bin/true", args: [], env: [], accept_harness_prefix: [] } as never,
    process.cwd(), {}, () => {}, (error) => { failures.push(error); }
  );
  (booleanSink as unknown as { proc: unknown }).proc = { stdin: { write: () => true } };
  await expect(booleanSink.request({ jsonrpc: "2.0", method: "notifications/initialized" }))
    .rejects.toThrow("stdin write failed");
  expect(failures).toHaveLength(2);
});

test("an id-bearing request whose sink answered closed rejects and registers no pending slot (round 211)", async () => {
  const failures: Error[] = [];
  const server = new ExperimentServer(
    { name: "experiment", command: "/bin/true", args: [], env: [], accept_harness_prefix: [] } as never,
    process.cwd(), {}, () => {}, (error) => { failures.push(error); }
  );
  (server as unknown as { proc: unknown }).proc = {
    stdin: { write: () => new Error("EPIPE: broken pipe") },
  };
  await expect(server.request({ jsonrpc: "2.0", id: 9, method: "tools/list" })).rejects.toThrow("stdin write failed");
  expect((server as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
  expect(failures).toHaveLength(1);
});

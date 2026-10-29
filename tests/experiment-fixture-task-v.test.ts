import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MARKER } from "./fixtures/experiment-mcp.js";

const fixture = resolve(import.meta.dir, "fixtures/experiment-mcp.ts");
const message = (command: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call",
  params: { name: "bash", arguments: { command } } });
const markerReply = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: MARKER }] } };

async function readRemaining(reader: { read(): Promise<{ value?: Uint8Array; done?: boolean }> }): Promise<string> {
  let text = "";
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

async function runFixture(command: string, inspectDelay = false, followingMessages: object[] = []) {
  const parent = resolve(import.meta.dir, "../scratch");
  mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(join(parent, "fixture-task-v-"));
  const preload = join(scratch, "timer.ts");
  if (inspectDelay) writeFileSync(preload, `const nativeTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, milliseconds, ...args) => {
  process.stderr.write(JSON.stringify({ milliseconds }) + "\\n");
  return nativeTimeout(callback, 0, ...args);
};\n`);
  const proc = Bun.spawn([process.execPath, "--no-env-file", "--no-install",
    `--config=${resolve("bunfig.runtime.toml")}`, ...(inspectDelay ? ["--preload", preload] : []), fixture],
  { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    const reader = proc.stdout.getReader();
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize" }) + "\n");
    const initialized = await reader.read();
    if (initialized.done) throw new Error(`experiment fixture exited before initialization (${await proc.exited}): ${await new Response(proc.stderr).text()}`);
    expect(JSON.parse(new TextDecoder().decode(initialized.value))).toHaveProperty("result.protocolVersion");
    const started = performance.now();
    proc.stdin.write(JSON.stringify(message(command)) + "\n");
    for (const following of followingMessages) proc.stdin.write(JSON.stringify(following) + "\n");
    proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      readRemaining(reader), new Response(proc.stderr).text(), proc.exited,
    ]);
    reader.releaseLock();
    return { stdout, stderr, code, elapsed: performance.now() - started };
  } finally {
    if (proc.exitCode === null) proc.kill();
    await proc.exited;
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("hold delays the fixture response before returning the normal marker", async () => {
  const result = await runFixture("hold:80");
  expect(result.elapsed).toBeGreaterThanOrEqual(75);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual(markerReply);
});

test("the fixture answers a ping before an outstanding hold completes", async () => {
  const result = await runFixture("hold:100", false, [{ jsonrpc: "2.0", id: "ping", method: "ping" }]);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.elapsed).toBeGreaterThanOrEqual(95);
  expect(result.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
    { jsonrpc: "2.0", id: "ping", result: {} }, markerReply,
  ]);
});

test.each(["3600000", "3600001", "9999999999999999999999999999999999999999"])(
  "hold:%s schedules at most one hour without waiting in the synthetic test", async (milliseconds) => {
    const result = await runFixture(`hold:${milliseconds}`, true);
    expect(result.code).toBe(0);
    expect(result.stderr.trim()).not.toBe("");
    expect(JSON.parse(result.stderr)).toEqual({ milliseconds: 3_600_000 });
    expect(JSON.parse(result.stdout)).toEqual(markerReply);
  });

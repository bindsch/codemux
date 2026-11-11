import { describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createPiMcpStdioTransport } from "../src/pi-mcp-stdio.js";
import { piMcpExtensionSource, preparePiPlaywright } from "../src/pi-mcp-launch.js";
import { PiAdapter } from "../src/adapters/pi.js";
import * as mcp from "../src/mcp.js";

function processRig() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & { write(text: string, done: (error?: Error) => void): void; end(): void; destroy(): void } | null;
    stdout: (EventEmitter & { destroy(): void }) | null;
    kill(signal: string): void;
  };
  const wrote: Record<string, unknown>[] = [];
  const signals: string[] = [];
  let writeError: Error | undefined;
  child.stdin = Object.assign(new EventEmitter(), {
    write: (text: string, done: (error?: Error) => void) => { wrote.push(JSON.parse(text)); done(writeError); },
    end: () => { child.emit("close"); },
    destroy: () => {},
  });
  child.stdout = Object.assign(new EventEmitter(), { destroy: () => {} });
  child.kill = (signal) => { signals.push(signal); };
  const calls: unknown[][] = [];
  const spawnFake = ((...args: unknown[]) => { calls.push(args); return child; }) as unknown as typeof spawn;
  const reply = (value: unknown) => child.stdout!.emit("data", Buffer.from(`${JSON.stringify(value)}\n`));
  return { child, wrote, signals, calls, spawnFake, reply, failWrites: () => { writeError = new Error("synthetic write failure"); } };
}

describe("Pi MCP stdio bridge", () => {
  test.each(["protocol", "write", "process"])("%s failure still waits for forced termination and close", async (failure) => {
    const p = processRig();
    let ended = false;
    p.child.stdin!.end = () => { ended = true; };
    const client = createPiMcpStdioTransport("/server", [], p.spawnFake);
    if (failure === "write") p.failWrites();
    const pending = client.request("test");
    if (failure === "protocol") p.child.stdout!.emit("data", Buffer.from("bad json\n"));
    if (failure === "process") p.child.emit("error", new Error("synthetic process error"));
    await expect(pending).rejects.toThrow();
    let resolved = false;
    const closing = client.close().then(() => { resolved = true; });
    await Promise.resolve();
    try {
      expect(ended).toBe(true);
      expect(resolved).toBe(false);
      await Bun.sleep(1050);
      expect(p.signals).toContain("SIGKILL");
      expect(resolved).toBe(false);
    } finally { p.child.emit("close"); await closing; }
    expect(resolved).toBe(true);
    await client.close();
  });
  test("correlates requests, notifications, server errors, and cleanup", async () => {
    const p = processRig();
    const client = createPiMcpStdioTransport("/trusted/server", ["literal;arg"], p.spawnFake);
    expect(p.calls[0]).toEqual(["/trusted/server", ["literal;arg"], { stdio: ["pipe", "pipe", "inherit"], shell: false }]);
    const first = client.request("tools/list");
    p.reply({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    expect(await first).toEqual({ tools: [] });
    await client.notify("notifications/initialized");
    expect(p.wrote.at(-1)).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" });
    const failed = client.request("tools/call", { name: "tool" });
    p.reply({ jsonrpc: "2.0", id: 2, error: { message: "denied" } });
    await expect(failed).rejects.toThrow("denied");
    await client.close(); await client.close();
    expect(p.signals).toEqual(["SIGTERM"]);
    await expect(client.request("tools/list")).rejects.toThrow("closed");
  });

  test("partial multibyte frames and blank lines are decoded correctly", async () => {
    const p = processRig(); const client = createPiMcpStdioTransport("/server", [], p.spawnFake);
    const value = client.request("test");
    const bytes = Buffer.from('\n{"jsonrpc":"2.0","id":1,"result":"é"}\n');
    const split = bytes.indexOf(0xc3) + 1;
    p.child.stdout!.emit("data", bytes.subarray(0, split));
    p.child.stdout!.emit("data", bytes.subarray(split));
    expect(await value).toBe("é"); await client.close();
  });

  for (const data of ["not json\n", '{"jsonrpc":"2.0","id":999,"result":{}}\n', "null\n", "x".repeat(1024 * 1024 + 1), "x".repeat(1024 * 1024 + 1) + "\n"]) {
    test(`malformed or oversized server output rejects outstanding requests (${data.length})`, async () => {
      const p = processRig(); const client = createPiMcpStdioTransport("/server", [], p.spawnFake);
      const value = client.request("test");
      p.child.stdout!.emit("data", Buffer.from(data));
      await expect(value).rejects.toThrow();
      p.child.stdout!.emit("data", Buffer.from("ignored\n"));
      expect(p.signals).toContain("SIGTERM"); await client.close();
    });
  }

  test("request limits, write errors, process errors, and exits fail closed", async () => {
    const large = processRig(); const bounded = createPiMcpStdioTransport("/server", [], large.spawnFake);
    await expect(bounded.request("test", { text: "x".repeat(1024 * 1024) })).rejects.toThrow("request exceeds");
    const pending = Array.from({ length: 256 }, () => bounded.request("pending").catch(() => undefined));
    await expect(bounded.request("overflow")).rejects.toThrow("too many");
    large.child.emit("exit", 1); await Promise.all(pending); await bounded.close();
    const broken = processRig(); const client = createPiMcpStdioTransport("/server", [], broken.spawnFake);
    broken.failWrites(); await expect(client.request("test")).rejects.toThrow("write failure"); await client.close();
    const errored = processRig(); const errors = createPiMcpStdioTransport("/server", [], errored.spawnFake);
    const value = errors.request("test"); errored.child.emit("error", new Error("spawn failure"));
    await expect(value).rejects.toThrow("spawn failure"); await errors.close();
    const missing = processRig(); missing.child.stdin = null;
    expect(() => createPiMcpStdioTransport("/server", [], missing.spawnFake)).toThrow("no stdio pipes");
  });

  test("closing rejects in-flight calls", async () => {
    const p = processRig(); const client = createPiMcpStdioTransport("/server", [], p.spawnFake);
    const value = client.request("pending"); await client.close();
    await expect(value).rejects.toThrow("transport closed");
  });
  test("native cancellation sends MCP cancellation and tolerates its late reply", async () => {
    const p = processRig(); const client = createPiMcpStdioTransport("/server", [], p.spawnFake);
    const controller = new AbortController();
    const removed = spyOn(controller.signal, "removeEventListener");
    const pending = client.request("tools/call", { name: "wait" }, controller.signal);
    controller.abort(new Error("native cancellation"));
    await expect(pending).rejects.toThrow("native cancellation");
    expect(p.wrote.at(-1)).toEqual({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }); // allow-british: native MCP method
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    await expect(client.request("tools/call", {}, controller.signal)).rejects.toThrow("native cancellation");
    expect(p.wrote).toHaveLength(2);
    const next = client.request("tools/list");
    p.reply({ jsonrpc: "2.0", id: 1, result: { content: [] } });
    p.reply({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
    expect(await next).toEqual({ tools: [] });
    expect(p.signals).toEqual([]);
    removed.mockRestore(); await client.close();
  });

  test("canceled calls do not exhaust request capacity when the server never replies", async () => {
    const p = processRig(); const client = createPiMcpStdioTransport("/server", [], p.spawnFake);
    for (let i = 0; i < 512; i++) {
      const controller = new AbortController();
      const pending = client.request("tools/call", {}, controller.signal);
      controller.abort();
      await expect(pending).rejects.toThrow();
    }
    const next = client.request("tools/list");
    p.reply({ jsonrpc: "2.0", id: 512, result: {} });
    p.reply({ jsonrpc: "2.0", id: 513, result: {} });
    expect(await next).toEqual({});
    // The oldest cancellation has expired; it is no longer recognized.
    const expired = client.request("tools/list");
    p.reply({ jsonrpc: "2.0", id: 1, result: {} });
    await expect(expired).rejects.toThrow("invalid server response");
    await client.close();
  });
});

describe("Pi Playwright extension artifacts", () => {
  test("generated source is standalone JavaScript with literal command arguments", () => {
    const source = piMcpExtensionSource("/path/with'quote", ["$literal", "\narg"], "playwright");
    expect(() => new Bun.Transpiler({ loader: "js" }).transformSync(source)).not.toThrow();
    expect(source).toContain(JSON.stringify("/path/with'quote"));
    expect(source).toContain('exclusive:false');
    expect(source).not.toContain(".ts\"");
  });

  test("adapter prepares, injects, preserves native autonomy, and removes an extension", () => {
    const parent = join(process.cwd(), "scratch", "fix", "pi-synthetic"); mkdirSync(parent, { recursive: true });
    const home = mkdtempSync(join(parent, "playwright-"));
    const trusted = spyOn(mcp, "buildPlaywrightSandboxMcp").mockReturnValue({
      args: ["--mcp-config", JSON.stringify({ mcpServers: { playwright: { command: "/trusted/playwright", args: [] } } })],
      check: { path: "/trusted/playwright" } as never,
    });
    try {
      const adapter = new PiAdapter({ HOME: home }, home);
      for (const autonomy of ["read-only", "low", "medium", "high"] as const) {
        const request = { agent: "pi" as const, prompt: "p", autonomy, sandboxed: true, enablePlaywrightMcp: true };
        const context = adapter.prepareRun(request);
        const extension = context.piMcpExtension!.path;
        expect(existsSync(extension)).toBe(true);
        expect(readFileSync(extension, "utf8")).toContain("/trusted/playwright");
        const command = adapter.buildRunCommand(request, context);
        expect(command).toContain(extension);
        expect(command).not.toContain("--tools");
        expect(command).not.toContain("--no-tools");
        if (autonomy === "low") expect(command).toContain("bash,powershell");
        if (autonomy === "read-only") expect(command).toContain("bash,powershell,edit,write");
        expect(adapter.getRunEnv(request, context)).toEqual({});
        expect(context.playwrightMcpCheck?.path).toBe("/trusted/playwright");
        adapter.cleanupRunSync(context);
        expect(existsSync(extension)).toBe(false);
      }
      expect(preparePiPlaywright({ agent: "pi", prompt: "p" }, {}, home, "")).toEqual({});
      expect(() => adapter.buildRunCommand({ agent: "pi", prompt: "p", enablePlaywrightMcp: true })).toThrow("was not prepared");
      trusted.mockReturnValue({ args: [], check: null });
      expect(() => adapter.prepareRun({ agent: "pi", prompt: "p", enablePlaywrightMcp: true })).toThrow("sandboxed trusted server");
    } finally { trusted.mockRestore(); rmSync(home, { recursive: true, force: true }); }
  });
});

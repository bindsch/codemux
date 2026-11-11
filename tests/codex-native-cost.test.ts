import { describe, expect, spyOn, test } from "bun:test";
import { hasActiveSignalOwner, signalShutdownPending } from "../src/process-runner-signals.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTrustedCommand, trustCheckedCommandChecks } from "../src/executable-security.js";
import {
  CodexCostFold, codexCostCommand, codexCostThreadId, codexNativeCostUsd,
  collectCodexNativeCost, readCodexNativeCost, withCodexNativeCost,
  type CodexCostBinding,
} from "../src/codex-native-cost.js";
import type { RunContext } from "../src/adapters/base.js";
import type { RunRequest, RunResult } from "../src/types.js";

const THREAD = "01234567-89ab-cdef-0123-456789abcdef";
const header = JSON.stringify({ type: "thread.started", thread_id: THREAD });
const raw: RunResult = { stdout: header + "\n", stderr: "", success: true, exitCode: 0 };
const request: RunRequest = { agent: "codex", prompt: "synthetic", resultJson: false };
const binding: CodexCostBinding = {
  command: ["/synthetic/codex", "exec", "--json", "-"], checks: [], env: { PATH: "/synthetic" },
  options: { cwd: process.cwd(), sandboxed: false, autonomy: "read-only" },
};
const native = (micros: unknown = 123456) => ({ threadUsage: { threadId: THREAD, nativeUsageUsdMicros: micros, estimatedUsageUsdMicros: 999999 } });
type Spawn = NonNullable<Parameters<typeof readCodexNativeCost>[2]>;

function fake(reply: unknown = native(), mode = "normal") {
  const sent: any[] = [];
  let stopped = 0;
  let options: Parameters<Spawn>[2] | undefined;
  const spawn: Spawn = async (_command, _env, opts, hooks) => {
    options = opts;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    return {
      settled,
      requestStop() { stopped++; settle(); },
      writeLine(line) {
        const value = JSON.parse(line); sent.push(value);
        queueMicrotask(() => {
          if (mode === "silent") return;
          if (value.id === 1) {
            if (mode === "exit") { settle(); return; }
            if (mode === "fatal") { hooks.onFatal({ kind: "oversize", bytes: 1 } as any); return; }
            if (mode === "bad-json") { hooks.onLine("{"); return; }
            if (mode === "array") { hooks.onLine("[]"); return; }
            if (mode === "oversize") { hooks.onLine(" ".repeat(1024 * 1024 + 1)); return; }
            if (mode === "server-call") { hooks.onLine(JSON.stringify({ id: 8, method: "item/tool/call" })); return; }
            hooks.onLine(JSON.stringify(mode === "init-error" ? { id: 1, error: {} } : { id: 1, result: {} }));
          }
          if (value.id === 2) {
            hooks.onLine(JSON.stringify(mode === "rpc-error" ? { id: 2, error: { code: -32600 } } : { id: 2, result: reply }));
            hooks.onLine(JSON.stringify({ id: 2, result: native(9999999) }));
          }
        });
        return { ok: mode !== "closed" };
      },
    };
  };
  return { spawn, sent, stopped: () => stopped, options: () => options };
}

describe("native Codex thread cost", () => {
  test("a pinned synthetic executable serves the native read and replacement fails closed", async () => {
    const parent = join(process.cwd(), "scratch", "fix", "codex-native-cost");
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, "case-"));
    const binary = join(root, "fake-codex");
    const cwd = join(root, "work"); mkdirSync(cwd);
    const source = `#!${process.execPath}
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === "initialize") console.log(JSON.stringify({ id: request.id, result: {} }));
  else if (request.method === "account/usage/read") console.log(JSON.stringify({ id: request.id, result: { threadUsage: { threadId: request.params.threadId, nativeUsageUsdMicros: 123456 } } }));
  else if (request.method !== "initialized") process.exit(8);
}
`;
    try {
      writeFileSync(binary, source, { mode: 0o700 });
      const command = resolveTrustedCommand([binary, "exec", "--json", "-"], "synthetic Codex", cwd, "");
      const selected: CodexCostBinding = { ...binding, command, checks: trustCheckedCommandChecks(command), options: { ...binding.options, cwd } };
      expect(await readCodexNativeCost(selected, THREAD)).toBe(0.123456);
      writeFileSync(binary, source + "\n// replaced\n", { mode: 0o700 });
      expect(await readCodexNativeCost(selected, THREAD)).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("maps only native nonnegative integer micros for the requested thread", () => {
    expect(codexNativeCostUsd(native(), THREAD)).toBe(0.123456);
    expect(codexNativeCostUsd(native(0), THREAD)).toBe(0);
    for (const value of [null, {}, { threadUsage: null }, { threadUsage: { estimatedUsageUsdMicros: 9 } },
      native(-1), native(1.2), native(Number.MAX_SAFE_INTEGER + 1), native("12"), native(null)]) {
      expect(codexNativeCostUsd(value, THREAD)).toBeNull();
    }
    expect(codexNativeCostUsd(native(), "other")).toBeNull();
  });

  test("the fold captures only its first bounded thread header across chunking", () => {
    for (const size of [1, 10, 1024]) {
      const fold = new CodexCostFold();
      const stream = raw.stdout + 'quoted example\n';
      for (let i = 0; i < stream.length; i += size) fold.push(stream.slice(i, i + size));
      expect(fold.threadId).toBe(THREAD);
    }
    for (const prefix of ["plain\n", "x".repeat(1025), "[]\n", "\n"]) {
      const fold = new CodexCostFold(); fold.push(prefix); fold.push(raw.stdout);
      expect(fold.threadId).toBeNull();
    }
    expect(codexCostThreadId("{")).toBeNull();
    expect(codexCostThreadId(JSON.stringify({ type: "thread.started", thread_id: "bad" }))).toBeNull();
  });

  test("metadata command preserves exact binary, private HOME, and credential store", () => {
    const argv = codexCostCommand(["/usr/bin/env", "HOME=/synthetic/private", "CODEX_HOME=/synthetic/state", "/synthetic/codex", "-c", 'model="alias"', "exec", "-"]);
    expect(argv.slice(0, 5)).toEqual(["/usr/bin/env", "HOME=/synthetic/private", "CODEX_HOME=/synthetic/state", "/synthetic/codex", "app-server"]);
    expect(argv).toContain("mcp_servers={}");
    expect(argv.some((arg) => arg.startsWith("cli_auth_credentials_store="))).toBe(false);
    expect(argv).not.toContain('model="alias"');
    expect(codexCostCommand(binding.command)[0]).toBe(binding.command[0]!);
    expect(() => codexCostCommand([])).toThrow("resolved exec command");
  });

  test("reads exactly one thread; carries sandbox policy and pins through shutdown", async () => {
    const f = fake();
    const check = { path: "/synthetic/codex" } as any;
    const selected: CodexCostBinding = { ...binding, checks: [check], options: {
      ...binding.options, sandboxed: true,
      sandboxOptions: { trust: "standard", scrubEnv: true, blockPaths: ["/synthetic/blocked"] },
      extraExecutableChecks: [{ path: "/synthetic/nested" } as any],
    } };
    expect(await readCodexNativeCost(selected, THREAD, f.spawn)).toBe(0.123456);
    expect(f.sent.map((item) => item.method)).toEqual(["initialize", "initialized", "account/usage/read"]);
    expect(f.sent[2].params).toEqual({ threadId: THREAD });
    expect(f.options()?.sandboxOptions).toEqual(selected.options.sandboxOptions);
    expect(f.options()?.extraExecutableChecks).toEqual([...selected.options.extraExecutableChecks!, check]);
    expect(f.options()?.abandoned?.()).toBe(true);
    expect(f.stopped()).toBe(1);
  });

  for (const mode of ["silent", "exit", "fatal", "bad-json", "array", "oversize", "server-call", "init-error", "rpc-error", "closed"]) {
    test(`${mode} leaves native cost unknown and stops the metadata child`, async () => {
      const f = fake(native(), mode);
      expect(await readCodexNativeCost(binding, THREAD, f.spawn, 10)).toBeNull();
      expect(f.stopped()).toBe(1);
    });
  }

  test("spawn rejection and late preflight are bounded and cannot start a late child", async () => {
    expect(await readCodexNativeCost(binding, "invalid", async () => { throw new Error("must not spawn"); })).toBeNull();
    expect(await readCodexNativeCost(binding, THREAD, async () => { throw new Error("pin changed"); }, 10)).toBeNull();
    let checked = false;
    const spawn: Spawn = async (_argv, _env, options) => {
      await Bun.sleep(25);
      checked = options.abandoned?.() === true;
      throw new Error("abandoned");
    };
    expect(await readCodexNativeCost(binding, THREAD, spawn, 5)).toBeNull();
    await Bun.sleep(30);
    expect(checked).toBe(true);
  });

  test.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("%s during metadata read exits after stopping the child and recording interruption", async (signal) => {
    const listeners = process.listenerCount(signal);
    const f = fake(native(), "silent");
    let recorded = false;
    const exit = spyOn(process, "exit").mockImplementation((code) => { throw new Error(`exit ${code}`); });
    const diagnostic = spyOn(console, "error").mockImplementation(() => {});
    try {
      const reading = collectCodexNativeCost({ ...raw }, request, { harnessVersion: "0.166.0" }, {
        ...binding, onSignaled: async () => {
          expect(f.stopped()).toBe(1);
          expect(hasActiveSignalOwner()).toBe(true);
          recorded = true;
        },
      }, false, f.spawn);
      queueMicrotask(() => process.emit(signal));
      await expect(reading).rejects.toThrow("exit 143");
      expect(recorded).toBe(true);
      expect(exit).toHaveBeenCalledWith(143);
      expect(process.listenerCount(signal)).toBe(listeners);
      expect(hasActiveSignalOwner()).toBe(false);
      expect(signalShutdownPending()).toBe(false);
    } finally { exit.mockRestore(); diagnostic.mockRestore(); }
  });

  test("collection skips unsupported routes and enriches plain and JSON successes", async () => {
    const f = fake();
    const context: RunContext = { harnessVersion: "0.166.0" };
    await collectCodexNativeCost(raw, request, context, binding, false, f.spawn);
    const enriched = withCodexNativeCost({ ...raw, stdout: "answer\n" }, request, context);
    expect(enriched.usage?.cost_usd).toBe(0.123456);
    expect(enriched.stdout).toBe("answer\n");
    const envelope = withCodexNativeCost({ ...raw, stdout: JSON.stringify({ result: "answer", codemux: { usage: {} } }) }, { ...request, resultJson: true }, context);
    expect(JSON.parse(envelope.stdout).codemux.usage.cost_usd).toBe(0.123456);
    expect(withCodexNativeCost({ ...raw, success: false }, request, context).usage).toBeUndefined();
    expect(withCodexNativeCost(raw, request).usage).toBeUndefined();
    for (const stdout of ["{}", "{"]) expect(withCodexNativeCost({ ...raw, stdout }, { ...request, resultJson: true }, context).stdout).toBe(stdout);
    const fold = new CodexCostFold(); fold.push(raw.stdout);
    await collectCodexNativeCost(raw, request, { harnessVersion: "0.166.0", stdoutSink: fold }, binding, false, f.spawn);
    const skip: Array<[RunResult, RunRequest, RunContext, CodexCostBinding, boolean]> = [
      [raw, request, context, binding, true], [raw, { ...request, agent: "cline" }, context, binding, false],
      [raw, request, {}, binding, false], [raw, request, { harnessVersion: "0.165.0" }, binding, false],
      [{ ...raw, success: false }, request, context, binding, false],
      [{ ...raw, stdout: "plain" }, request, context, binding, false],
      [raw, request, context, { ...binding, options: { ...binding.options, sandboxOptions: { noNet: true } } }, false],
    ];
    for (const args of skip) await collectCodexNativeCost(...args, async () => { throw new Error("must not spawn"); });
  });
});

import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { isAbsolute, join } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import type { RunContext } from "../src/adapters/base.js";
import { plantHarnessHomeCanary } from "../src/hermetic-session-canary-home.js";
import * as callerHome from "../src/hermetic-session-canary-home.js";
import { plantClaudeSessionCanary, plantClineSessionCanary, runHermeticSessionCanary } from "../src/hermetic-session-canary.js";
import * as canaryDriver from "../src/hermetic-session-canary-driver.js";
import { sessionCanaryCredentialSource } from "../src/hermetic-session-canary-driver.js";
import { signalProcess } from "../src/process-signal.js";
import { guardedWait } from "../src/process-guarded-wait.js";
import * as processTree from "../src/process-tree.js";
import * as processTable from "../src/process-table.js";
import { cleanups, of, send, startSession, waitFor } from "./helpers/session-kimi-e2e.js";

const roots: string[] = [];
const root = () => {
  const parent = join(import.meta.dir, "../scratch/fix"); fs.mkdirSync(parent, { recursive: true });
  const path = fs.realpathSync(fs.mkdtempSync(join(parent, "r8-life-"))); roots.push(path); return path;
};
afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean();
  for (const path of roots.splice(0)) fs.rmSync(path, { recursive: true, force: true });
});

test.each(["sync", "async", "failed-verify"])("Codex %s experiment cleanup removes control scratch", async (mode) => {
  const home = root(), adapter = new CodexAdapter({}, home);
  fs.mkdirSync(join(home, ".codex"));
  const context = adapter.prepareRun({ agent: "codex", prompt: "p", sandboxed: true });
  expect(context.lastMessageDir).toBeDefined();
  fs.writeFileSync(join(context.lastMessageDir!, "partial.txt"), "model output");
  let closed = false;
  context.experimentCodex = {
    hasEvidence: mode === "failed-verify",
    verify: async () => { throw new Error("verification failed"); },
    interruptBeforeEvidence() {}, preserveHarnessLog() {},
    closeSync() { closed = true; }, close: async () => { closed = true; },
  } as unknown as NonNullable<RunContext["experimentCodex"]>;
  if (mode === "sync") adapter.cleanupRunSync(context);
  else if (mode === "failed-verify") await expect(adapter.cleanupRun(context)).rejects.toThrow("verification failed");
  else await adapter.cleanupRun(context);
  expect(closed).toBe(true);
  expect(fs.existsSync(context.lastMessageDir!)).toBe(false);
});

test("caller-home canary copies private credentials on EXDEV", () => {
  const base = root(), source = join(base, "authenticated");
  fs.mkdirSync(join(source, ".codex"), { recursive: true });
  fs.writeFileSync(join(source, ".codex/auth.json"), "synthetic-login", { mode: 0o644 });
  const link = spyOn(fs, "linkSync").mockImplementation(() => { throw Object.assign(new Error("different filesystem"), { code: "EXDEV" }); });
  try {
    const plant = plantHarnessHomeCanary("codex", source, {}, base);
    try {
      const destination = join(plant.operatorHome, ".codex/auth.json");
      expect(fs.readFileSync(destination, "utf8")).toBe("synthetic-login");
      expect(fs.lstatSync(destination).isSymbolicLink()).toBe(false);
      expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
      expect(fs.statSync(destination).ino).not.toBe(fs.statSync(join(source, ".codex/auth.json")).ino);
    } finally { plant.cleanup(); }
  } finally { link.mockRestore(); }
});

test("canary setup failure is detected before any session can spend quota", async () => {
  const plant = spyOn(callerHome, "plantHarnessHomeCanary").mockImplementation(() => { throw new Error("scratch unavailable"); });
  const launch = spyOn(canaryDriver, "runCanarySession").mockImplementation(() => { throw new Error("must not launch"); });
  try {
    await expect(runHermeticSessionCanary({ agent: "codex", autonomy: "read-only", passthroughEnv: [], timeoutMs: 1000 }))
      .resolves.toBe(1);
    expect(launch).not.toHaveBeenCalled();
  } finally { plant.mockRestore(); launch.mockRestore(); }
});

test.each(["claude", "cline", "caller"])("%s canary removes mkdtemp output when realpath fails", (kind) => {
  const parent = root(), before = process.listenerCount("exit");
  const realpath = spyOn(fs, "realpathSync").mockImplementation((() => { throw new Error("canonicalization failed"); }) as unknown as typeof fs.realpathSync);
  try {
    const plant = () => kind === "claude" ? plantClaudeSessionCanary("claude", parent, "/synthetic/credential")
      : kind === "cline" ? plantClineSessionCanary(parent) : plantHarnessHomeCanary("codex", undefined, {}, parent);
    expect(plant).toThrow("canonicalization failed");
    expect(fs.readdirSync(parent)).toEqual([]);
    expect(process.listenerCount("exit")).toBe(before);
  } finally { realpath.mockRestore(); }
});

test("empty HOME cannot make the canary credential source relative", () => {
  const home = process.env.HOME;
  const account = spyOn(os, "homedir").mockReturnValue("/synthetic/account-home");
  process.env.HOME = "";
  try {
    expect(sessionCanaryCredentialSource()).toBe("/synthetic/account-home/.claude/.credentials.json");
    expect(isAbsolute(sessionCanaryCredentialSource())).toBe(true);
  } finally { process.env.HOME = home; account.mockRestore(); }
});

test("a child outside its old group receives signals through its handle", () => {
  const pid = 999900, calls: string[] = [];
  const table = spyOn(processTable, "readProcessTable").mockReturnValue(new Map([[pid, { ppid: 1, pgid: pid + 1, start: "fixture" }]]));
  const kill = spyOn(process, "kill").mockReturnValue(true);
  try {
    const target = { proc: { pid, kill: (signal: string) => calls.push(signal) } as unknown as ReturnType<typeof Bun.spawn>,
      processGroup: true, childExited: false, descendants: new Map() };
    signalProcess(target, "SIGTERM", "tree"); signalProcess(target, "SIGKILL", "tree");
    expect(calls).toEqual(["SIGTERM", "SIGKILL"]);
    expect(kill).toHaveBeenCalledWith(-pid, "SIGTERM");
  } finally { table.mockRestore(); kill.mockRestore(); }
});

test("termination during post-exit grace still sends SIGTERM to descendants", async () => {
  let end!: (value: number) => void;
  const exited = new Promise<number>((resolve) => { end = resolve; });
  const pid = 999910, descendant = pid + 1;
  const table = spyOn(processTable, "readProcessTable").mockReturnValue(new Map([
    [pid, { ppid: 1, pgid: pid, start: "parent" }], [descendant, { ppid: pid, pgid: pid + 1, start: "child" }],
  ]));
  const kill = spyOn(process, "kill").mockReturnValue(true);
  const grace = spyOn(processTree, "waitForDescendantsGrace").mockImplementation(async () => { process.emit("SIGTERM"); });
  const proc = { pid, exited, kill() { end(0); } } as unknown as ReturnType<typeof Bun.spawn>;
  try {
    const pending = guardedWait(() => proc); process.emit("SIGTERM");
    expect(await pending).toBe(143);
    expect(grace).toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith(descendant, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(descendant, "SIGKILL");
  } finally { table.mockRestore(); kill.mockRestore(); grace.mockRestore(); }
});

async function endKimiAfterInterruptedSecondTurn() {
  const session = await startSession();
  send(session.driver, { type: "user", text: "scenario:basic first" });
  await waitFor(session.events, of("turn_completed"), "first turn");
  send(session.driver, { type: "user", text: "scenario:wait second" });
  await waitFor(session.events, (events) => events.filter((e) => e.type === "turn_started")[1], "second turn");
  send(session.driver, { type: "interrupt" });
  const turn = await waitFor(session.events, (events) => events.filter((e) => e.type === "turn_completed")[1], "interruption");
  expect(turn.finish).toBe("interrupted");
  session.driver.handleCallerEnd();
  expect(await session.code).toBe(0);
  return session.events.at(-1);
}

test("Kimi expected interruption keeps the session end successful and preserves raw exit", async () => {
  const ended = await endKimiAfterInterruptedSecondTurn();
  expect(ended).toMatchObject({ type: "session_ended", reason: "stdin-close", exit_code: 0 });
  expect(ended?.harness_exit).toMatchObject({ signal: "SIGTERM" });
});

test("Kimi unconfirmed interrupted turn cannot reuse the preceding turn's resume hint", async () => {
  expect(await endKimiAfterInterruptedSecondTurn()).toMatchObject({ type: "session_ended", resumable: false });
});

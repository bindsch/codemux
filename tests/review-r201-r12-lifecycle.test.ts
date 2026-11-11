import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { runCanarySession, sessionCanary, SESSION_DRAIN_GRACE_MS } from "../src/hermetic-session-canary-driver.js";
import { evaluateCanary, mintCanaryMarker } from "../src/hermetic-canary.js";
import { prepareRunDirParent } from "../src/hermetic-sweep.js";
import { runDirectoryOwnerCheck, runDirectoryPrefix } from "../src/run-directory-owner.js";
import * as processTable from "../src/process-table.js";
import { sweepStaleHomes } from "../src/opencode-hermetic.js";
import { recordTrustedParent } from "../src/safe-remove.js";
import { guardedWait, runCapturedCommand } from "../src/process-runner.js";

function fakeCommand(script: string) {
  return spyOn(sessionCanary, "command").mockReturnValue([process.execPath, "--no-env-file", "-e", script]);
}

test("canary scans markers split across chunks after the retained stdout cap", async () => {
  const marker = mintCanaryMarker();
  const command = fakeCommand(`
    await Bun.write(Bun.stdout, "x".repeat(600 * 1024) + "\\n");
    await Bun.write(Bun.stdout, ${JSON.stringify(marker.slice(0, 12))});
    await Bun.sleep(30);
    await Bun.write(Bun.stdout, ${JSON.stringify(marker.slice(12))} + "\\n");
    console.log(JSON.stringify({type:"assistant_message",text:"OK"}));
  `);
  try {
    const run = await runCanarySession([], process.env, "question", 2_000, 0);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.length).toBe(512 * 1024);
    expect(run.stdout).not.toContain(marker);
    expect(run.markerEvidence).toContain(marker);
    expect(run.markerEvidence!.length).toBeLessThan(200);
    expect(evaluateCanary(run.stdout + run.markerEvidence, marker, run.assistantText))
      .toMatchObject({ kind: "leak", what: "marker" });
  } finally { command.mockRestore(); }
});

test.each([false, true])("canary bounds pipes retained by an escaped descendant (deadline: %s)", async (deadline) => {
  const root = mkdtempSync(resolve("scratch/fix/r12-pipes-"));
  const pidFile = join(root, "pid");
  const command = fakeCommand(`
    const child = Bun.spawn(["/bin/sleep", "30"], { detached:true, stdin:"ignore", stdout:"inherit", stderr:"inherit" });
    await Bun.write(${JSON.stringify(pidFile)}, String(child.pid));
    console.log("retained prefix");
    console.error("retained error");
    ${deadline ? 'setInterval(() => {}, 1000);' : 'process.exit(0);'}
  `);
  try {
    const started = Date.now();
    const run = await runCanarySession([], process.env, "question", 500, 0);
    expect(Date.now() - started).toBeLessThan(500 + SESSION_DRAIN_GRACE_MS + 3_000);
    expect(run.stopped).toBe(deadline);
    expect(run.failure).not.toBeNull();
    expect(run.stdout).toContain("retained prefix");
    expect(run.stderr).toContain("retained error");
    if (!deadline) expect(run.failure).toContain("pipes remained open");
  } finally {
    command.mockRestore();
    if (existsSync(pidFile)) {
      try { process.kill(-Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* Already reaped. */ }
    }
  }
});

test.each(["shared", "opencode"])("%s sweep distinguishes a reused pid from the live directory owner", (kind) => {
  const root = mkdtempSync(resolve("scratch/fix/r12-owner-"));
  const parent = prepareRunDirParent(root, ".codemux-hermetic");
  const token = (start: string) => createHash("sha256").update(start).digest("hex");
  const current = `run-${process.pid}-s${token("current")}-fixture`;
  const previous = `run-${process.pid}-s${token("previous")}-fixture`;
  const legacy = `run-${process.pid}-legacy`;
  const fresh = `run-${process.pid}-s${token("previous")}-fresh`;
  for (const name of [current, previous, legacy, fresh]) {
    mkdirSync(join(parent, name));
    if (name !== fresh) utimesSync(join(parent, name), new Date(0), new Date(0));
  }
  const table = spyOn(processTable, "readProcessTable").mockReturnValue(new Map([
    [process.pid, { ppid: 1, pgid: process.pid, start: "current" }],
  ]));
  try {
    if (kind === "shared") prepareRunDirParent(root, ".codemux-hermetic");
    else sweepStaleHomes(parent, recordTrustedParent(parent));
    expect(existsSync(join(parent, previous))).toBe(false);
    for (const name of [current, legacy, fresh]) expect(existsSync(join(parent, name))).toBe(true);
    expect(table).toHaveBeenCalledTimes(1);
  } finally { table.mockRestore(); }
});

test("new run directory names record the current process start token", () => {
  const start = processTable.readProcessTable().get(process.pid)!.start;
  expect(runDirectoryPrefix()).toBe(`run-${process.pid}-s${createHash("sha256").update(start).digest("hex")}-`);
});

test("unreadable owner identities retain homes, while impossible pids do not", () => {
  const table = spyOn(processTable, "readProcessTable").mockReturnValue(new Map());
  try {
    const check = runDirectoryOwnerCheck();
    expect(check(`run-${process.pid}-s${"0".repeat(64)}-fixture`, process.pid)).toBe(true);
    expect(check(`run-${process.pid}-legacy`, process.pid)).toBe(true);
    expect(check("run-0-invalid", 0)).toBe(false);
  } finally { table.mockRestore(); }
});

test("run directory naming retries a transiently unreadable process identity", async () => {
  // A separate process starts with an empty prefix cache, regardless of test order.
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `
    import { spyOn } from "bun:test";
    import * as table from "./src/process-table.ts";
    import { runDirectoryPrefix } from "./src/run-directory-owner.ts";
    const unavailable = spyOn(table, "readProcessTable").mockReturnValue(new Map());
    const first = runDirectoryPrefix();
    unavailable.mockReturnValue(new Map([[process.pid, {ppid:1,pgid:process.pid,start:"recovered"}]]));
    const second = runDirectoryPrefix();
    unavailable.mockRestore();
    console.log(JSON.stringify({pid:process.pid,first,second}));
  `], { cwd: resolve("."), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const value = JSON.parse(stdout);
  expect(value.first).toBe(`run-${value.pid}-`);
  expect(value.second).toBe(`run-${value.pid}-s${createHash("sha256").update("recovered").digest("hex")}-`);
});

test.each([["TERM", 143], ["KILL", 137], ["HUP", 129]] as const)(
  "captured and interactive waits preserve external %s death as %s", async (signal, expected) => {
    const argv = ["/bin/sh", "-c", `kill -${signal} $$`];
    const captured = await runCapturedCommand(argv, { cwd: process.cwd(), env: {} });
    expect(captured.exitCode).toBe(expected);
    expect(captured.success).toBe(false);
    const interactive = await guardedWait(() => Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }));
    expect(interactive).toBe(expected);
  }
);

/**
 * A child that attaches after the session's end path began gets the
 * orderly shutdown every end gets, EOF first, then the grace, then the
 * stop request (review round 69): a harness with the default signal
 * dispositions that exits 0 on EOF ends the session cleanly instead of
 * dying to an immediate SIGTERM and being reported as a harness failure.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgySessionDriver } from "../src/session/agy-driver.js";
import { CodexSessionDriver } from "../src/session/codex-driver.js";
import { SessionProcess } from "../src/session/process.js";
import { readRegistry, recordSessionStart } from "../src/session/registry.js";
import { cleanupSessions, type Event, workRoot } from "./session-codex-e2e-helpers.js";

const EXIT_ON_EOF = fileURLToPath(new URL("./fixtures/live/fake-exit-on-eof.ts", import.meta.url));

afterAll(cleanupSessions);

const record = (registryPath: string, dir: string, agent: "codex" | "agy", id: string) =>
  recordSessionStart(registryPath, {
    id, agent, cwd: dir, hermetic: false, project_settings: false, harness_home: join(dir, "home"),
    provider_base_url: null, model: null, model_alias: null, autonomy: "high", sandboxed: true, sandbox_trust: "standard",
    sandbox_no_net: false, sandbox_scrub_env: false, sandbox_block: [], pass_env: [], playwright_mcp: false,
  }).ok;

const common = (dir: string, registryPath: string, events: Event[]) => ({
  autonomy: "high" as const, cwd: dir, sandboxed: true, sandboxTrust: "standard" as const,
  sandboxNoNet: false, sandboxScrubEnv: false, passEnv: [], authorPrefix: true, sessionTimeoutMs: null,
  registryPath, harnessHome: join(dir, "home"), providerBaseUrl: null,
  sink: (line: string) => { events.push(JSON.parse(line) as Event); },
});

for (const agent of ["codex", "agy"] as const) {
  test(`a ${agent} child attached after the end began exits cleanly on EOF (review round 69)`, async () => {
    const dir = mkdtempSync(join(workRoot(), "s-"));
    const registryDir = join(dir, "registry");
    mkdirSync(registryDir, { mode: 0o700 });
    const registryPath = join(registryDir, "live-sessions.json");
    const id = agent === "codex" ? "0123456789abcdef" : "conv-eof-1";
    const events: Event[] = [];
    const driver = agent === "codex"
      ? new CodexSessionDriver({ resumeThreadId: id, permissionTimeoutMs: 300_000, turnTimeoutMs: null, ...common(dir, registryPath, events) })
      : new AgySessionDriver({ resumeConversationId: id, ...common(dir, registryPath, events) });
    expect(record(registryPath, dir, agent, id)).toBe(true);
    driver.adoptResumeClaim();
    driver.spawnPending();
    driver.handleCallerEnd();
    let childReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => { childReady = resolve; });
    const proc = new SessionProcess({
      command: ["bun", EXIT_ON_EOF],
      cwd: dir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir },
      onLine: (line) => { if (line === "READY") childReady(); },
      onFatal: (fatal) => driver.handleFatal(fatal),
      // Long enough that a SIGTERM inside the grace would be the only way
      // a child that ignored EOF could die before the assertion.
      graceMs: 5_000,
    });
    await ready;
    driver.attach(proc);
    const code = await driver.run();
    const outcome = await proc.exited;
    // EOF ended it: exit 0, no signal, and the session reports the
    // caller's end, never a harness failure.
    expect(outcome).toEqual({ code: 0, signal: null });
    expect(code).toBe(0);
    const ended = events[events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.reason).toBe("stdin-close");
    expect(events.some((event) => event.type === "error" && event.fatal === true)).toBe(false);
    const released = readRegistry(registryPath);
    expect(released.outcome === "ok" && released.file.sessions[0]?.ended !== null).toBe(true);
    driver.dispose();
    await proc.settled;
  }, 20_000);
}

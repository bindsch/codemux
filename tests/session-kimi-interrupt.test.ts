import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { identifyKimiInterruptedSession, kimiSessionIds } from "../src/session/kimi-session-index.js";
import { kimiPrivateBrandHome, populateKimiHermeticSessionHome } from "../src/kimi-hermetic.js";
import { fakePrivateHome } from "./helpers/fake-private-home.js";
import { cleanups, ID, OTHER, of, send, startSession, waitFor } from "./helpers/session-kimi-e2e.js";

afterAll(async () => { for (const cleanup of cleanups) await cleanup(); });

describe("Kimi supervisor turn interruption", () => {
  test("an interrupted turn stops its child and the next input resumes the same session", async () => {
    const session = await startSession({ resumeSessionId: ID });
    send(session.driver, { type: "user", text: "scenario:wait hold" });
    await waitFor(session.events, of("turn_started"), "turn start");
    send(session.driver, { type: "interrupt", reason: "new direction" });
    const turn = await waitFor(session.events, of("turn_completed"), "interrupted turn");
    expect(turn.finish).toBe("interrupted");
    expect(turn.reason).toBe("new direction");
    send(session.driver, { type: "user", text: "scenario:basic next" });
    const next = await waitFor(session.events, (events) => events.filter((event) => event.type === "turn_completed")[1], "next turn");
    expect(next.finish).toBe("end");
    expect(session.argvs[1]).toContain(ID);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("interrupt during spawn stops the late child and still permits the next input", async () => {
    const session = await startSession({ resumeSessionId: ID }, {}, 100, 1);
    send(session.driver, { type: "user", text: "scenario:wait late" });
    send(session.driver, { type: "interrupt" });
    expect((await waitFor(session.events, of("turn_completed"), "late interrupt")).finish).toBe("interrupted");
    send(session.driver, { type: "user", text: "scenario:basic after" });
    await waitFor(session.events, (events) => events.filter((event) => event.type === "turn_completed")[1], "next turn");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("turn timeout interrupts one turn without ending the session", async () => {
    const session = await startSession({ resumeSessionId: ID, turnTimeoutMs: 50 });
    send(session.driver, { type: "user", text: "scenario:wait timeout" });
    const turn = await waitFor(session.events, of("turn_completed"), "timed out turn");
    expect(turn.finish).toBe("interrupted");
    expect(turn.reason).toBe("the turn exceeded its timeout");
    session.options.turnTimeoutMs = null;
    send(session.driver, { type: "user", text: "scenario:basic next" });
    await waitFor(session.events, (events) => events.filter((event) => event.type === "turn_completed")[1], "next turn");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test("the native index recovers the first interrupted turn before any resume hint", async () => {
    const home = fakePrivateHome();
    populateKimiHermeticSessionHome(home.dir, null);
    const session = await startSession({ privateHome: home });
    const spawn = session.options.spawnTurn;
    session.options.spawnTurn = async (argv) => {
      writeFileSync(join(kimiPrivateBrandHome(home.dir), "session_index.jsonl"), JSON.stringify({
        sessionId: ID, workDir: session.options.cwd,
      }) + "\n");
      return spawn(argv);
    };
    send(session.driver, { type: "user", text: "scenario:wait first" });
    send(session.driver, { type: "interrupt" });
    expect((await waitFor(session.events, of("turn_completed"), "first interrupt")).finish).toBe("interrupted");
    expect((await waitFor(session.events, of("session_started"), "indexed identity")).session_id).toBe(ID);
    send(session.driver, { type: "user", text: "scenario:basic resume" });
    await waitFor(session.events, (events) => events.filter((event) => event.type === "turn_completed")[1], "resumed turn");
    expect(session.argvs[1]).toContain(ID);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    home.remove();
  });

  test("an unnamed plain first turn cannot borrow another process's native session identity", async () => {
    const session = await startSession();
    const spawn = session.options.spawnTurn;
    session.options.spawnTurn = async (argv) => {
      mkdirSync(session.options.harnessHome, { recursive: true });
      writeFileSync(join(session.options.harnessHome, "session_index.jsonl"), JSON.stringify({ sessionId: OTHER, workDir: session.options.cwd }) + "\n");
      return spawn(argv);
    };
    send(session.driver, { type: "user", text: "scenario:wait first" });
    send(session.driver, { type: "interrupt" });
    expect(await session.code).toBe(1);
    expect(session.events.some((event) => event.type === "session_started")).toBe(false);
    expect(session.events.some((event) => event.type === "turn_completed" && event.finish === "interrupted")).toBe(true);
  });

  test("session index selection filters workdirs, rejects ambiguity and malformed or linked input", () => {
    const scratch = join(import.meta.dir, "../scratch");
    mkdirSync(scratch, { recursive: true });
    const brand = mkdtempSync(join(scratch, "kimi-index-"));
    const path = join(brand, "session_index.jsonl");
    try {
      expect(kimiSessionIds(brand, brand)).toEqual(new Set());
      expect(identifyKimiInterruptedSession(brand, brand, new Set())).toBeNull();
      writeFileSync(path, [{ sessionId: ID, workDir: brand }, { sessionId: OTHER, workDir: "/other" }].map((entry) => JSON.stringify(entry)).join("\n"));
      expect(identifyKimiInterruptedSession(brand, brand, new Set())).toBe(ID);
      expect(identifyKimiInterruptedSession(brand, brand, new Set([ID]))).toBeNull();
      writeFileSync(path, [{ sessionId: ID, workDir: brand }, { sessionId: OTHER, workDir: brand }].map((entry) => JSON.stringify(entry)).join("\n"));
      expect(() => identifyKimiInterruptedSession(brand, brand, new Set())).toThrow("concurrent sessions");
      for (const source of ["null", "[]", '{"sessionId":"bad","workDir":"/test"}', "broken"]) {
        writeFileSync(path, source);
        expect(() => kimiSessionIds(brand, brand)).toThrow();
      }
      const linked = join(brand, "linked");
      mkdirSync(linked);
      symlinkSync(path, join(linked, "session_index.jsonl"));
      expect(() => kimiSessionIds(linked, brand)).toThrow();
    } finally { rmSync(brand, { recursive: true, force: true }); }
  });
});

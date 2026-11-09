import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertKimiResumeTools } from "../src/session/kimi-tools.js";
import { cleanups, ID, of, send, startSession, waitFor } from "./helpers/session-kimi-e2e.js";

afterAll(async () => { for (const cleanup of cleanups) await cleanup(); });

function wire(brand: string, records: unknown[]): string {
  const path = join(brand, "sessions", "workspace", ID, "agents", "main", "wire.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return path;
}

describe("Kimi resumed native tools", () => {
  test("replays native allowlist changes and rejects changing policy on resume", () => {
    const scratch = join(import.meta.dir, "../scratch");
    mkdirSync(scratch, { recursive: true });
    const brand = mkdtempSync(join(scratch, "kimi-resume-tools-"));
    try {
      expect(() => assertKimiResumeTools(brand, ID)).not.toThrow();
      expect(() => assertKimiResumeTools(brand, ID, "none")).toThrow("cannot verify --tools none");
      const profile = { type: "profile.bind", activeToolNames: [] };
      const path = wire(brand, [profile, { type: "usage.record", usage: {} }]);
      expect(() => assertKimiResumeTools(brand, ID, "none")).not.toThrow();
      expect(() => assertKimiResumeTools(brand, ID)).toThrow("resume with --tools none");
      wire(brand, [profile, { type: "tools.set_active_tools", names: ["Read"] }]);
      expect(() => assertKimiResumeTools(brand, ID)).not.toThrow();
      expect(() => assertKimiResumeTools(brand, ID, "none")).toThrow("resume with --tools default");
      wire(brand, [profile, { type: "tools.reset_active_tools" }]);
      expect(() => assertKimiResumeTools(brand, ID)).not.toThrow();
      for (const source of ["broken", "null", "[]"]) {
        writeFileSync(path, source);
        expect(() => assertKimiResumeTools(brand, ID, "none")).toThrow("cannot verify the resumed tool policy");
      }
    } finally { rmSync(brand, { force: true, recursive: true }); }
  });

  test("a fresh driver supplies tools [] once, removes its file, and resumes without the creation flag", async () => {
    const session = await startSession({ tools: "none" });
    const spawn = session.options.spawnTurn;
    let profile = "";
    session.options.spawnTurn = async (argv) => {
      if (argv.includes("--agent-file")) {
        profile = argv[argv.indexOf("--agent-file") + 1]!;
        expect(readFileSync(profile, "utf8")).toContain("tools: []");
        wire(session.options.harnessHome, [{ type: "profile.bind", activeToolNames: [] }]);
      }
      return spawn(argv);
    };
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "first turn");
    expect(profile).not.toBe("");
    expect(existsSync(profile)).toBe(false);
    send(session.driver, { type: "user", text: "scenario:basic two" });
    await waitFor(session.events, (events) => events.filter((event) => event.type === "turn_completed")[1], "second turn");
    expect(session.argvs[1]).toContain("--session");
    expect(session.argvs[1]).not.toContain("--agent-file");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });

  test.each(["none", "default"] as const)("resume validates native policy before spawning: %s", async (tools) => {
    const session = await startSession({ tools, resumeSessionId: ID });
    wire(session.options.harnessHome, [{ type: "profile.bind", activeToolNames: [] }]);
    send(session.driver, { type: "user", text: "scenario:basic resume" });
    if (tools === "none") {
      await waitFor(session.events, of("turn_completed"), "resumed turn");
      expect(session.argvs).toHaveLength(1);
      expect(session.argvs[0]).not.toContain("--agent-file");
      send(session.driver, { type: "shutdown" });
      expect(await session.code).toBe(0);
    } else {
      expect(await session.code).toBe(1);
      expect(session.argvs).toHaveLength(0);
      expect(session.events.some((event) => String(event.message).includes("resume with --tools none"))).toBe(true);
    }
  });

  test("spawn failure removes the fresh tools profile", async () => {
    let profile = "";
    const session = await startSession({ tools: "none", spawnTurn: async (argv) => {
      profile = argv[argv.indexOf("--agent-file") + 1]!;
      throw new Error("synthetic spawn failure");
    } });
    send(session.driver, { type: "user", text: "hello" });
    expect(await session.code).toBe(1);
    expect(profile).not.toBe("");
    expect(existsSync(profile)).toBe(false);
  });
});

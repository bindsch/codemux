import { describe, expect, test, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GeminiAcpSessionDriver, GEMINI_ACP_DRIVER_PROFILE } from "../src/session/gemini-acp-driver.js";
import { spawnSessionChild } from "../src/session/spawn.js";
import * as processTable from "../src/process-table.js";

describe("Gemini ACP process fixture", () => {
  test("native stdin, transcript usage, cancel, permission denial, and resume run through the process layer", async () => {
    const root = mkdtempSync(join(tmpdir(), "gemini-acp-process-"));
    const processMock = spyOn(processTable, "readProcessTable").mockReturnValue(new Map());
    const home = join(root, "home"), state = join(root, "state"), cwd = join(root, "work");
    for (const dir of [home, state, cwd]) mkdirSync(dir);
    const events: Record<string, any>[] = [];
    let driver!: GeminiAcpSessionDriver;
    driver = new GeminiAcpSessionDriver({
      profile: GEMINI_ACP_DRIVER_PROFILE, resumeSessionId: null, autonomy: "high", cwd,
      hermetic: false, sandboxed: false, sandboxTrust: "standard", sandboxNoNet: false,
      sandboxScrubEnv: false, passEnv: [], authorPrefix: false, sessionTimeoutMs: 5000,
      registryPath: null, harnessHome: join(home, ".gemini"), providerBaseUrl: null,
      privateHome: null, final: false, permissionPolicy: "deny",
      spawnTurn: async (build) => {
        const argv = build({}); expect(argv[0]).toBe("gemini");
        return spawnSessionChild([process.execPath, join(import.meta.dir, "fixtures/live/fake-gemini-session.ts"), ...argv.slice(1)],
          { ...process.env, HOME: home, GEMINI_CLI_HOME: home, FAKE_STATE_DIR: state },
          { cwd, sandboxed: false, autonomy: "high", graceMs: 50 },
          { onLine: (line) => driver.handleHarnessLine(line), onFatal: (fatal) => driver.handleFatal(fatal) });
      },
      sink: (line) => { events.push(JSON.parse(line)); },
    });
    const code = driver.run();
    const wait = async (predicate: () => boolean) => {
      for (let i = 0; i < 400; i++) { if (predicate()) return; await Bun.sleep(5); }
      throw new Error("Gemini ACP fixture event timed out");
    };
    const send = (value: unknown) => driver.handleCallerLine(JSON.stringify(value));
    try {
      send({ type: "user", text: "scenario:basic" });
      await wait(() => events.some((event) => event.type === "turn_completed"));
      expect(events.find((event) => event.type === "turn_completed")?.usage)
        .toEqual({ input_tokens: 90, output_tokens: 20, cached_input_tokens: 10, total_tokens: 120, cost_usd: null });
      send({ type: "user", text: "scenario:interrupt" }); send({ type: "interrupt" });
      await wait(() => events.filter((event) => event.type === "turn_completed").length === 2);
      expect(events.filter((event) => event.type === "turn_completed")[1]?.finish).toBe("interrupted");
      expect(events.filter((event) => event.type === "turn_completed")[1]?.usage.total_tokens).toBeNull();
      send({ type: "user", text: "scenario:permission" });
      await wait(() => events.filter((event) => event.type === "turn_completed").length === 3);
      expect(JSON.parse(readFileSync(join(state, "permission.jsonl"), "utf8")).outcome.optionId).toBe("deny");
      const frames = readFileSync(join(state, "acp.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(frames.filter((frame) => frame.method === "session/new")).toHaveLength(1);
      expect(frames.filter((frame) => frame.method === "session/load")).toHaveLength(2);
      send({ type: "shutdown" }); expect(await code).toBe(0);
    } finally {
      driver.handleCallerEnd(); await code; driver.dispose(); processMock.mockRestore(); rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});

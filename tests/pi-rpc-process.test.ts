import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PiRpcSessionDriver } from "../src/session/pi-rpc-driver.js";
import { PI_DRIVER_PROFILE } from "../src/session/pi-driver.js";
import { SessionProcess } from "../src/session/process.js";
import * as processTable from "../src/process-table.js";

test.each(["complete", "retry", "interrupt", "timeout"])("Pi RPC fake process %s preserves turn lifecycle", async (mode) => {
  const parent = join(process.cwd(), "scratch", "fix", "pi-synthetic"); mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "rpc-"));
  const processRead = spyOn(processTable, "readProcessTable").mockReturnValue(new Map());
  const events: Record<string, unknown>[] = [];
  const id = "11111111-1111-4111-8111-111111111111";
  let turnComplete!: () => void;
  const completed = new Promise<void>((resolve) => { turnComplete = resolve; });
  const driver = new PiRpcSessionDriver({ profile: PI_DRIVER_PROFILE, mintedSessionId: id, resumeSessionId: null,
    autonomy: "read-only", model: "pi-test", cwd: home, hermetic: false, sandboxed: false, sandboxTrust: "standard",
    sandboxNoNet: false, sandboxScrubEnv: false, passEnv: [], authorPrefix: false,
    sessionTimeoutMs: 5000, turnTimeoutMs: mode === "timeout" ? 300 : null, registryPath: null,
    harnessHome: home, providerBaseUrl: null, privateHome: null, final: false,
    sink: (line) => { const event = JSON.parse(line); events.push(event); if (event.type === "turn_completed" || event.type === "session_ended") turnComplete(); },
    spawnTurn: async (build) => new SessionProcess({
      command: [process.execPath, join(import.meta.dir, "fixtures", "live", "fake-pi-session.ts"), ...build({}).slice(1)],
      cwd: home, env: { PATH: process.env.PATH!, FAKE_STATE_DIR: home }, graceMs: 100,
      onLine: (line) => {
        driver.handleHarnessLine(line);
        const event = JSON.parse(line);
        if (mode === "interrupt" && event.type === "response" && event.command === "prompt") {
          driver.handleCallerLine('{"type":"interrupt"}');
        }
      },
      onFatal: (fatal) => driver.handleFatal(fatal),
    }),
  });
  try {
    const ended = driver.run();
    driver.handleCallerLine(JSON.stringify({ type: "user", text: `scenario:${mode === "complete" ? "basic" : mode === "retry" ? "retry" : "hold"} synthetic` }));
    await completed;
    driver.handleCallerEnd(); expect(await ended).toBe(0);
    expect(events.find((event) => event.type === "turn_completed")).toMatchObject({
      finish: mode === "complete" || mode === "retry" ? "end" : "interrupted", usage: { input_tokens: 120, output_tokens: 30 },
    });
    const requests = readFileSync(join(home, "rpc.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(requests.map((r) => r.type)).toEqual(mode === "complete" || mode === "retry" ? ["get_state", "prompt"] : ["get_state", "prompt", "abort"]);
    expect(requests[1].message).toContain("synthetic");
    expect(JSON.parse(readFileSync(join(home, "stdin.jsonl"), "utf8")).eof).toBe(true);
  } finally { driver.dispose(); processRead.mockRestore(); rmSync(home, { recursive: true, force: true }); }
}, 10_000);

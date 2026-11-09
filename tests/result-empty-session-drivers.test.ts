import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { readCallLog } from "../src/call-log.js";
import { emptyUsage } from "../src/result-envelope.js";
import { ClaudeSessionDriver } from "../src/session/driver.js";
import { CodexSessionDriver } from "../src/session/codex-driver.js";
import { AgySessionDriver } from "../src/session/agy-driver.js";
import { OpenCodeSessionDriver } from "../src/session/opencode-driver.js";
import { AiderSessionDriver } from "../src/session/aider-driver.js";
import type { SessionOutputQueue } from "../src/session/completion.js";
import type { SessionFsm } from "../src/session/fsm.js";
import { engineSession, fakeTurnProcess, wireProfile } from "./helpers/session-turn-engine.js";

const ID = "11111111-2222-4333-8444-555555555555";
const USAGE = { ...emptyUsage(), output_tokens: 17 };
type Agent = "claude" | "zai" | "codex" | "agy" | "opencode" | "aider";

function fixture(agent: Agent) {
  const events: Record<string, unknown>[] = [];
  const options = {
    agent: agent === "zai" ? "zai" as const : "claude" as const,
    sessionId: ID, resume: false, resumeThreadId: ID,
    resumeConversationId: ID, resumeSessionId: ID,
    autonomy: "high" as const, cwd: process.cwd(), hermetic: false,
    sandboxed: false, sandboxTrust: "standard" as const, sandboxNoNet: false,
    sandboxScrubEnv: false, passEnv: [], playwrightMcp: false, authorPrefix: false,
    permissionTimeoutMs: 300_000, turnTimeoutMs: null, sessionTimeoutMs: null,
    registryPath: null, harnessHome: process.cwd(), historyPath: "unused-history",
    providerBaseUrl: null,
    spawnTurn: async (): Promise<never> => { throw new Error("completion fixture never spawns"); },
    sink: (line: string) => { events.push(JSON.parse(line)); },
  };
  const driver = agent === "claude" || agent === "zai" ? new ClaudeSessionDriver(options)
    : agent === "codex" ? new CodexSessionDriver(options)
    : agent === "agy" ? new AgySessionDriver(options)
    : agent === "opencode" ? new OpenCodeSessionDriver(options)
    : new AiderSessionDriver(options);
  // Seed one accepted turn to isolate each driver's native completion
  // and ledger pair from its unrelated startup transport.
  const rig = driver as unknown as {
    fsm: SessionFsm;
    out: SessionOutputQueue;
    turnUsage: typeof USAGE;
    completeTurn(parse: unknown, raw?: string): void;
    applyResult(parse: unknown, raw: string): void;
    finishTurn(turnId: string, finish: "end" | "failed", reason?: string): void;
  };
  expect(rig.fsm.transition({ kind: "session_started" })).toBeNull();
  const start = (turnId: string, text: string | undefined) => {
    expect(rig.fsm.transition({ kind: "turn_started", turnId })).toBeNull();
    rig.out.enqueue(JSON.stringify({ type: "turn_started", turn_id: turnId }));
    if (text !== undefined) rig.out.enqueue(JSON.stringify({ type: "assistant_message", turn_id: turnId, text }));
  };
  const complete = (turnId: string) => {
    if (agent === "claude" || agent === "zai") {
      rig.completeTurn({ kind: "turn_completed", isError: false, reason: null, usage: USAGE, models: [] }, "native result");
    } else if (agent === "codex") {
      rig.completeTurn({ kind: "turn_completed", threadId: ID, turnId, finish: "end", reason: null }, "native result");
    } else if (agent === "agy") {
      rig.applyResult({ kind: "result", conversationId: ID, isError: false,
        status: "SUCCESS", errorText: null, responseText: null, usage: USAGE }, "native result");
    } else if (agent === "opencode") {
      rig.turnUsage = USAGE;
      rig.completeTurn({ code: 0, signal: null });
    } else rig.finishTurn(turnId, "end");
  };
  return { driver, events, rig, start, complete };
}

describe("native driver completion and ledger agree on empty answers", () => {
  for (const agent of ["claude", "zai", "codex", "agy", "opencode", "aider"] as const) {
    test(`${agent}: missing, empty, and whitespace text fail; the next answer succeeds`, async () => {
      const dir = mkdtempSync(join(import.meta.dir, "../scratch/fix/empty-session-"));
      const previous = process.env.CODEMUX_CALL_LOG;
      const ledgerPath = join(dir, "calls.jsonl");
      process.env.CODEMUX_CALL_LOG = ledgerPath;
      const h = fixture(agent);
      try {
        for (const [index, text] of [undefined, "", " \n\t", "answer"].entries()) {
          const turnId = `t${index + 1}`;
          h.start(turnId, text);
          h.complete(turnId);
          await h.rig.out.flush();
          const completed = h.events.filter((event) => event.type === "turn_completed").at(-1)!;
          expect(completed.finish).toBe(index === 3 ? "end" : "failed");
          if (index !== 3) expect(completed.reason).toBe("empty answer");
          expect(readCallLog(ledgerPath).entries.at(-1)?.record?.finish).toBe(index === 3 ? "end" : "failed");
        }
      } finally {
        h.driver.dispose();
        if (previous === undefined) delete process.env.CODEMUX_CALL_LOG;
        else process.env.CODEMUX_CALL_LOG = previous;
      }
    });
  }
});

test("turn-per-process driver rejects empty success through the public input and child lifecycle", async () => {
  for (const answer of [null, "", " \n\t", "answer"]) {
    const child = fakeTurnProcess();
    const h = engineSession({ options: { cwd: process.cwd(), harnessHome: process.cwd(),
      profile: wireProfile({ answer }), spawnTurn: async () => child } });
    try {
      h.user();
      await h.wait("turn_started");
      child.exit(0);
      const completed = await h.wait("turn_completed");
      expect(completed.finish).toBe(answer === "answer" ? "end" : "failed");
      if (answer !== "answer") expect(completed.reason).toBe("empty answer");
      h.shutdown();
      expect(await h.code()).toBe(0);
    } finally { h.dispose(); }
  }
});

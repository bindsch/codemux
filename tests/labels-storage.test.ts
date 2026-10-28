import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BaseAdapter } from "../src/adapters/base.js";
import {
  appendSessionCallRecord,
  appendSessionTurnCallRecord,
  CALL_LOG_ENV,
  readCallLog,
  type CallRecord,
  type SessionCallContext,
} from "../src/call-log.js";
import { launchRunRequest } from "../src/launch.js";
import { agyResult, claudeFamilyResult, codexResult, emptyUsage } from "../src/result-envelope.js";
import type { AdapterCapabilities, RunRequest, RunResult } from "../src/types.js";

const scratch = join(import.meta.dir, "..", "scratch", "labels-storage-tests");
mkdirSync(scratch, { recursive: true });
const previousLog = process.env[CALL_LOG_ENV];

afterEach(() => {
  if (previousLog === undefined) delete process.env[CALL_LOG_ENV];
  else process.env[CALL_LOG_ENV] = previousLog;
});

function ledgerPath(): string {
  return join(mkdtempSync(join(scratch, "ledger-")), "calls.jsonl");
}

class FakeAdapter extends BaseAdapter {
  readonly id = "claude" as const;
  readonly binaryName = "claude";
  constructor(private readonly failProcessing = false) { super(); }
  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: false,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: false,
      effortLevels: [],
    };
  }
  buildRunCommand(): string[] {
    return [process.execPath, "-e", "process.stdout.write('OK\\n')"];
  }
  buildTuiCommand(): string[] { return ["claude"]; }
  override processRunResult(result: RunResult): RunResult {
    if (this.failProcessing) throw new Error("fixture processing failure");
    return result;
  }
}

const request: RunRequest = { agent: "claude", prompt: "fixture", autonomy: "high" };
const labels = { project: "test-project", phase: "measure" };

describe("call ledger labels", () => {
  test.each([false, true])("run receipt retains labels when post-processing fails=%s", async (fails) => {
    const path = ledgerPath();
    process.env[CALL_LOG_ENV] = path;
    const run = launchRunRequest(new FakeAdapter(fails), { ...request, labels }, {
      sandbox: false, requestedAutonomy: "high",
    });
    if (fails) await expect(run).rejects.toThrow("fixture processing failure");
    else expect((await run).exitCode).toBe(0);
    expect(readCallLog(path).entries[0]!.record!.labels).toEqual(labels);
    expect(JSON.parse(readFileSync(path, "utf8")).labels).toEqual(labels);
  });

  test("an unlabeled run writes null", async () => {
    const path = ledgerPath();
    process.env[CALL_LOG_ENV] = path;
    await launchRunRequest(new FakeAdapter(), request, { sandbox: false, requestedAutonomy: "high" });
    expect(JSON.parse(readFileSync(path, "utf8")).labels).toBeNull();
  });

  test("check receipts write null even when their internal request carries labels", async () => {
    const path = ledgerPath();
    process.env[CALL_LOG_ENV] = path;
    await launchRunRequest(new FakeAdapter(), { ...request, labels }, {
      sandbox: false, requestedAutonomy: "high", kind: "check",
    });
    expect(JSON.parse(readFileSync(path, "utf8")).labels).toBeNull();
  });

  test("session helpers normalize absent labels to null", () => {
    const path = ledgerPath();
    const context: SessionCallContext = {
      agent: "claude", model: null, provider: "default", autonomy: "high",
      hermetic: false, sandboxed: false, cwd: process.cwd(),
    };
    const environment = { [CALL_LOG_ENV]: path };
    appendSessionTurnCallRecord(context, "session", "turn", Date.now(), "end", emptyUsage(), environment);
    appendSessionCallRecord(context, "session", Date.now(), "shutdown", 0, emptyUsage(), environment);
    const records = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((record) => record.labels)).toEqual([null, null]);
  });

  test("old records remain readable and malformed label fields are rejected", async () => {
    const path = ledgerPath();
    process.env[CALL_LOG_ENV] = path;
    await launchRunRequest(new FakeAdapter(), request, { sandbox: false, requestedAutonomy: "high" });
    const record = JSON.parse(readFileSync(path, "utf8")) as CallRecord;
    const { labels: _ignored, ...oldRecord } = record;
    writeFileSync(path, [oldRecord, { ...record, labels }, ...[[], "wrong", { phase: 3 }].map(
      (invalid) => ({ ...record, labels: invalid })
    )].map((item) => JSON.stringify(item)).join("\n") + "\n");
    const log = readCallLog(path);
    expect(log.entries[0]!.record!.labels).toBeNull();
    expect(log.entries[1]!.record!.labels).toEqual(labels);
    expect(log.malformed).toBe(3);
  });
});

describe("result envelope labels", () => {
  const finished = (stdout: string): RunResult => ({ stdout, stderr: "", exitCode: 0, success: true });
  const cases: Array<[string, (labels?: Record<string, string> | null) => RunResult]> = [
    ["claude", (value) => claudeFamilyResult(finished('{"type":"result","result":"OK"}'),
      { ...request, resultJson: true, labels: value }, "claude")],
    ["agy", (value) => agyResult(finished('{"status":"SUCCESS","response":"OK"}'),
      { ...request, agent: "agy", resultJson: true, labels: value })],
    ["codex", (value) => codexResult(finished([
      { type: "thread.started", thread_id: "fixture-thread" },
      { type: "turn.started" },
      { type: "item.completed", item: { type: "agent_message", text: "OK" } },
      { type: "turn.completed" },
    ].map((event) => JSON.stringify(event)).join("\n")),
    { ...request, agent: "codex", resultJson: true, labels: value })],
  ];

  for (const [agent, run] of cases) {
    test(`${agent} carries labels in its codemux block`, () => {
      const result = run(labels);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).codemux.labels).toEqual(labels);
    });
    test(`${agent} writes null labels when none were supplied`, () => {
      expect(JSON.parse(run().stdout).codemux.labels).toBeNull();
      expect(JSON.parse(run(null).stdout).codemux.labels).toBeNull();
    });
  }
});

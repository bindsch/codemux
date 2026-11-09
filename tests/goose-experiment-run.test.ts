import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { GooseExperimentRun, gooseExperimentConfig, readGooseExperimentConfig, type GooseExperimentRelay } from "../src/goose-experiment-run.js";
import {
  findGooseSessionLedger,
  gooseLedgerBytes,
  readGooseSessionLedger,
  verifyGooseExperimentLedger,
} from "../src/goose-experiment-ledger.js";
import { experimentFailure, type ExperimentFailure } from "../src/experiment-records.js";
import type { ExperimentRelayCall } from "../src/experiment-relay.js";
import type { ExperimentRecord } from "../src/experiment-records.js";
import type { ExperimentSpec } from "../src/experiment-mcp.js";

const spec: ExperimentSpec = { name: "parity", command: "/synthetic/probe", args: [], env: [] };

function scratchHome(label: string): string {
  const parent = join(process.cwd(), "scratch", "fix", "goose-experiment-synthetic");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, `${label}-`));
}

/** A real sqlite ledger, the way goose creates it. */
function writeLedger(root: string, rows: Array<{ role: string; content: unknown }>): string {
  const dir = join(root, "data", "goose", "sessions");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "sessions.db");
  const database = new Database(path);
  database.exec("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, content_json TEXT)");
  for (const row of rows) {
    database.run("INSERT INTO messages (role, content_json) VALUES (?, ?)", [row.role, JSON.stringify(row.content)]);
  }
  database.close();
  return path;
}

function requestBlock(id: string, name: string, input: unknown): Record<string, unknown> {
  return { type: "toolRequest", id, toolCall: { id, name, arguments: input } };
}
function responseBlock(id: string, content: unknown, isError = false): Record<string, unknown> {
  return { type: "toolResponse", id, toolResult: { content, isError } };
}

function setup(label: string) {
  const home = { home: scratchHome(label), envAssignments: [], finalize: () => {} };
  let starts = 0, finishes = 0, closes = 0, syncCloses = 0, failures = 0;
  let failure: ExperimentFailure | null = null;
  const records: Array<{ kind: string; fields: Record<string, unknown> }> = [];
  const listeners = new Set<() => void>();
  const relay: GooseExperimentRelay = {
    spec, token: "synthetic-secret", url: "http://127.0.0.1:12345/mcp",
    recordingPath: join(home.home, "recording.jsonl"),
    calls: [],
    get failureError() { return failure; },
    record: ((kind: string, fields: Record<string, unknown>) => { records.push({ kind, fields }); }) as ExperimentRecord,
    start: async () => { starts++; },
    finish: () => { finishes++; },
    fail: (error: unknown) => { failures++; failure ??= experimentFailure(error); for (const listener of listeners) listener(); },
    onFailure: (listener: (error: Error) => void) => {
      const fn = () => listener(new Error("synthetic relay failure"));
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    terminateProtocol: () => {},
    close: async () => { closes++; },
    closeSync: () => { syncCloses++; },
  };
  const experiment = new GooseExperimentRun(spec, join(home.home, "work"), home, {}, "literal prompt", relay);
  return { home, relay, experiment, records, state: () => ({ starts, finishes, closes, syncCloses, failures }) };
}

async function rig(label: string, run: (h: ReturnType<typeof setup>) => void | Promise<void>): Promise<void> {
  const h = setup(label);
  try { await run(h); } finally { rmSync(h.home.home, { recursive: true, force: true }); }
}

describe("goose experiment configuration carrier", () => {
  test("the extension entry names the relay, the bearer token, and the spec's timeout", () => {
    expect(gooseExperimentConfig({ url: "http://127.0.0.1:9/mcp", token: "secret", spec }))
      .toEqual({ extensions: { parity: { type: "streamable_http", uri: "http://127.0.0.1:9/mcp",
        headers: { Authorization: "Bearer secret" }, timeout: 7200 } } });
    expect(gooseExperimentConfig({ url: "u", token: "t", spec: { ...spec, tool_timeout_seconds: 120 } }).extensions)
      .toMatchObject({ parity: { timeout: 120 } });
  });

  test("prepare writes the configuration once and readGooseExperimentConfig reads it back", async () => rig("config", async (h) => {
    await Promise.all([h.experiment.prepare(), h.experiment.prepare()]);
    expect(h.state().starts).toBe(1);
    const written = readFileSync(h.experiment.configPath, "utf8");
    expect(written).toContain("streamable_http");
    expect(written).toContain("synthetic-secret");
    expect(readGooseExperimentConfig(h.experiment.configPath)).toEqual(gooseExperimentConfig(h.relay));
    await expect(h.experiment.prepare()).resolves.toBeUndefined();
  }));

  test("a prepare failure fails the relay and rethrows", async () => rig("prepare-fail", async (h) => {
    h.relay.start = async () => { throw new Error("synthetic listen refusal"); };
    await expect(h.experiment.prepare()).rejects.toThrow("synthetic listen refusal");
    expect(h.state().failures).toBe(1);
  }));

  test("readGooseExperimentConfig returns null for unparsable content", () => {
    const path = join(scratchHome("bad-config"), "config.yaml");
    writeFileSync(path, "\tnot: valid: yaml: [");
    expect(readGooseExperimentConfig(path)).toBeNull();
    rmSync(join(path, ".."), { recursive: true, force: true });
  });
});

describe("goose session ledger reader", () => {
  test("finds sessions.db under the private root and skips symlinked directories", () => {
    const root = scratchHome("find");
    const path = writeLedger(root, []);
    expect(findGooseSessionLedger(root)).toBe(path);
    expect(findGooseSessionLedger(join(root, "absent"))).toBeNull();
    const deep = scratchHome("deep");
    mkdirSync(join(deep, "a", "b", "c", "d", "sessions"), { recursive: true });
    writeFileSync(join(deep, "a", "b", "c", "d", "sessions", "sessions.db"), "");
    expect(findGooseSessionLedger(deep)).toBeNull();
    const linked = scratchHome("linked");
    mkdirSync(join(linked, "data"), { recursive: true });
    symlinkSync(join(root, "data", "goose"), join(linked, "data", "goose"));
    expect(findGooseSessionLedger(linked)).toBeNull();
    rmSync(root, { recursive: true, force: true }); rmSync(deep, { recursive: true, force: true }); rmSync(linked, { recursive: true, force: true });
  });

  test("reads toolRequest and toolResponse blocks, nested and inline, skipping other rows", () => {
    const root = scratchHome("read");
    const path = writeLedger(root, [
      { role: "user", content: "plain string content" },
      { role: "assistant", content: [requestBlock("b1", "parity_echo", { x: 1 }), { type: "text", text: "hello" }] },
      { role: "user", content: [responseBlock("b1", [{ type: "text", text: "ok" }])] },
      { role: "assistant", content: [{ type: "toolRequest", toolCallId: "b2", name: "inline_tool", arguments: { y: 2 } }] },
      { role: "user", content: [{ type: "toolResponse", toolCallId: "b2", content: "plain", isError: true }] },
      { role: "assistant", content: [{ type: "toolRequest", toolCall: { name: "no-id" } }] },
      { role: "assistant", content: [{ type: "toolResponse", toolResult: {} }] },
    ]);
    const ledger = readGooseSessionLedger(path);
    expect(ledger.calls).toEqual([
      { id: "b1", name: "parity_echo", input: { x: 1 } },
      { id: "b2", name: "inline_tool", input: { y: 2 } },
    ]);
    expect(ledger.responses).toEqual([
      { id: "b1", content: [{ type: "text", text: "ok" }], isError: false },
      { id: "b2", content: "plain", isError: true },
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  test("an absent database or missing table reads as an empty ledger", () => {
    expect(readGooseSessionLedger(join(scratchHome("absent-db"), "sessions.db"))).toEqual({ calls: [], responses: [] });
    const root = scratchHome("no-table");
    const path = writeLedger(root, []);
    const database = new Database(path);
    database.exec("DROP TABLE messages");
    database.close();
    expect(readGooseSessionLedger(path)).toEqual({ calls: [], responses: [] });
    rmSync(root, { recursive: true, force: true }); rmSync(join(root, "..", "absent-db"), { recursive: true, force: true });
  });

  test("gooseLedgerBytes retains the file's bytes and nothing for an absent one", () => {
    const root = scratchHome("bytes");
    const path = writeLedger(root, [{ role: "user", content: "x" }]);
    expect(gooseLedgerBytes(path, 1024)).toBe(readFileSync(path).subarray(0, 1024).toString("base64"));
    expect(gooseLedgerBytes(null, 1024)).toBe("");
    expect(gooseLedgerBytes(join(root, "gone.db"), 1024)).toBe("");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("goose experiment verification", () => {
  const withCalls = (over: Partial<ExperimentRelayCall> = {}): ExperimentRelayCall[] => [{
    relay_index: 1, call_id: "b1", name: "parity_echo", input: { x: 1 },
    result: { content: [{ type: "text", text: "ok" }], isError: false }, ...over,
  }];

  test("a matching ledger verifies and records native evidence", () => {
    const records: Array<{ kind: string }> = [];
    verifyGooseExperimentLedger(
      { calls: [{ id: "b1", name: "parity_echo", input: { x: 1 } }], responses: [{ id: "b1", content: [{ type: "text", text: "ok" }], isError: false }] },
      { spec, calls: withCalls(), record: (kind) => { records.push({ kind }); } },
    );
    expect(records).toEqual([{ kind: "goose_ledger_evidence" }]);
  });

  test("an incomplete relay call, an identity mismatch, or an orphan native call fails closed", () => {
    const record = () => {};
    const ledger = { calls: [{ id: "b1", name: "parity_echo", input: { x: 1 } }], responses: [] };
    expect(() => verifyGooseExperimentLedger(ledger, { spec, calls: withCalls({ result: undefined }), record })).toThrow("incomplete relay call");
    expect(() => verifyGooseExperimentLedger({ calls: [{ id: "b1", name: "other", input: { x: 1 } }], responses: [] }, { spec, calls: withCalls(), record })).toThrow("does not match relay identity");
    expect(() => verifyGooseExperimentLedger({ calls: [{ id: "b1", name: "parity_echo", input: { x: 1 } }, { id: "b9", name: "parity_echo", input: {} }], responses: [] }, { spec, calls: withCalls(), record })).toThrow("relay never saw");
  });

  test("a missing or changed model-visible result fails the run", () => {
    const record = () => {};
    const ledgerCalls = [{ id: "b1", name: "parity_echo", input: { x: 1 } }];
    expect(() => verifyGooseExperimentLedger({ calls: ledgerCalls, responses: [] }, { spec, calls: withCalls(), record })).toThrow("differs from server bytes");
    expect(() => verifyGooseExperimentLedger({ calls: ledgerCalls, responses: [{ id: "b1", content: [{ type: "text", text: "changed" }], isError: false }] }, { spec, calls: withCalls(), record })).toThrow("differs from server bytes");
    expect(() => verifyGooseExperimentLedger({ calls: ledgerCalls, responses: [{ id: "b1", content: [{ type: "text", text: "ok" }], isError: true }] }, { spec, calls: withCalls(), record })).toThrow("differs from server bytes");
  });
});

describe("goose experiment host lifecycle", () => {
  test("forwards literal stdin, captures stdout, resolves identity from the ledger, verifies, and closes", async () => rig("lifecycle", async (h) => {
    await h.experiment.prepare();
    writeLedger(h.home.home, [
      { role: "assistant", content: [requestBlock("b1", "parity_echo", { x: 1 })] },
      { role: "user", content: [responseBlock("b1", [{ type: "text", text: "ok" }])] },
    ]);
    await expect(h.relay.resolveCallId!({ relay_index: 1, name: "parity_echo", input: { x: 1 } } as ExperimentRelayCall, {}))
      .resolves.toBe("b1");
    await expect(h.relay.resolveCallId!({ relay_index: 2, name: "parity_echo", input: { x: 1 } } as ExperimentRelayCall, {}))
      .rejects.toThrow("already claimed");
    let written = "", ended = false, aborted = false;
    h.experiment.start((text) => { written += text; }, () => { ended = true; }, () => { aborted = true; });
    expect([written, ended, aborted]).toEqual(["literal prompt", true, false]);
    h.experiment.push('progress line\n{"content":"done","session_id":"s1"}\n');
    expect(h.experiment.hasOutput).toBe(true);
    h.experiment.finish();
    h.relay.calls.push(...matchingCalls());
    await h.experiment.complete();
    expect(h.state().finishes).toBe(1);
    await h.experiment.close();
    expect(h.state()).toMatchObject({ closes: 1, syncCloses: 0 });
    expect(h.records.some((record) => record.kind === "goose_ledger_copy")).toBe(true);
    expect(h.records.some((record) => record.kind === "harness_stdout")).toBe(true);
  }));

  test("identity polls until the ledger appears", async () => rig("poll", async (h) => {
    await h.experiment.prepare();
    setTimeout(() => {
      writeLedger(h.home.home, [{ role: "assistant", content: [requestBlock("b7", "parity_echo", { x: 2 })] }]);
    }, 60);
    await expect(h.relay.resolveCallId!({ relay_index: 1, name: "parity_echo", input: { x: 2 } } as ExperimentRelayCall, {}))
      .resolves.toBe("b7");
  }));

  test("parallel identical native calls are ambiguous and a finished run resolves nothing", async () => rig("ambiguous", async (h) => {
    await h.experiment.prepare();
    writeLedger(h.home.home, [
      { role: "assistant", content: [requestBlock("b1", "parity_echo", { x: 1 }), requestBlock("b2", "parity_echo", { x: 1 })] },
    ]);
    await expect(h.relay.resolveCallId!({ relay_index: 1, name: "parity_echo", input: { x: 1 } } as ExperimentRelayCall, {}))
      .rejects.toThrow("ambiguous");
    h.experiment.finish();
    await expect(h.relay.resolveCallId!({ relay_index: 2, name: "parity_echo", input: { x: 9 } } as ExperimentRelayCall, {}))
      .rejects.toThrow("native ledger identity");
  }));

  test("stdout without a final output object fails complete", async () => rig("no-terminal", async (h) => {
    await h.experiment.prepare();
    h.experiment.push("progress only\n");
    h.experiment.finish();
    h.relay.calls.push(...matchingCalls());
    await expect(h.experiment.complete()).rejects.toThrow("no final output object");
    expect(h.state().failures).toBe(1);
  }));

  test("an interrupted capture fails complete before verification", async () => rig("interrupted", async (h) => {
    await h.experiment.prepare();
    h.experiment.push('{"content":"done"}');
    h.experiment.finish({ timedOut: true });
    h.relay.calls.push(...matchingCalls());
    await expect(h.experiment.complete()).rejects.toThrow("interrupted");
  }));

  test("a failed relay aborts the sink start and complete rethrows its failure", async () => rig("relay-failure", async (h) => {
    await h.experiment.prepare();
    let aborted = false;
    h.experiment.start(() => {}, () => {}, () => { aborted = true; });
    h.relay.fail(new Error("synthetic relay failure"));
    expect(aborted).toBe(true);
    await expect(h.experiment.complete()).rejects.toThrow("synthetic relay failure");
    h.experiment.closeSync();
    expect(h.state().syncCloses).toBe(1);
  }));
});

function matchingCalls(): ExperimentRelayCall[] {
  return [{ relay_index: 1, call_id: "b1", name: "parity_echo", input: { x: 1 },
    result: { content: [{ type: "text", text: "ok" }], isError: false } }];
}

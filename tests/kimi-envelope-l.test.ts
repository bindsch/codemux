import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { KimiAdapter } from "../src/adapters/kimi.js";
import { ExperimentKimiRun } from "../src/experiment-kimi-run.js";
import { ExperimentFailure, ExperimentFailureCode as Code } from "../src/experiment-records.js";
import { kimiResult } from "../src/result-envelope/kimi.js";
import type { RunContext } from "../src/run-context.js";
import type { RunRequest, RunResult } from "../src/types.js";
import { KIMI_STREAM_SESSION, kimiResumeHint } from "./fixtures/kimi-stream.js";

const stream = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const events = [
  { role: "assistant", content: "Recovered\r\nanswer\n\n" },
  kimiResumeHint(),
];
const usage = { input_tokens: 3, output_tokens: 5, cached_input_tokens: 6, total_tokens: 14, cost_usd: null };
const success: RunResult = { stdout: stream(events), stderr: "native diagnostic", success: true, exitCode: 0 };

function fixture() {
  const scratch = join(import.meta.dir, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "kimi-envelope-l-"));
  const brand = join(home, ".kimi-code");
  const wire = join(brand, "sessions", "workspace", KIMI_STREAM_SESSION, "agents", "main", "wire.jsonl");
  const adapter = new KimiAdapter({}, home);
  const request: RunRequest = { agent: "kimi", prompt: "synthetic", resultJson: true,
    model: "fixture-model", labels: { test: "failure-envelope" } };
  const writeWire = () => {
    mkdirSync(dirname(wire), { recursive: true });
    writeFileSync(wire, stream([{ type: "usage.record", usage: {
      inputOther: 3, output: 5, inputCacheRead: 4, inputCacheCreation: 2,
    } }]));
  };
  return { home, brand, wire, adapter, request, writeWire,
    cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe("Kimi failure-envelope recovery", () => {
  test.each(["{broken\n", '{"role":"meta"', '{"role":"assistant","content":[]}\n'])
    ("complete events survive malformed or truncated tails: %s", (tail) => {
      const f = fixture();
      try {
        f.writeWire();
        const result = f.adapter.processRunResult({ ...success, stdout: stream(events) + tail }, f.request);
        expect(result).toMatchObject({ success: false, exitCode: 1, usage });
        expect(result.stderr).toContain("native diagnostic\ncodemux: kimi stream-json line 3:");
        expect(JSON.parse(result.stdout)).toMatchObject({ reply: "Recovered\nanswer\n", events,
          session_id: KIMI_STREAM_SESSION, codemux: { model: "fixture-model", usage, failure_code: null } });
      } finally { f.cleanup(); }
    });

  test("a result-json envelope over the capture bound fails the run with the bound named (round 100)", () => {
    const f = fixture();
    try {
      f.writeWire();
      // 9 MiB of assistant content rides in `reply` and again inside
      // `events`; the serialized envelope exceeds the 16 MiB capture
      // bound even though the captured stream itself is within it.
      const large = stream([{ role: "assistant", content: "x".repeat(9 * 1024 * 1024) }, kimiResumeHint()]);
      const result = f.adapter.processRunResult({ ...success, stdout: large }, f.request);
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(125);
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(result.stderr).toContain("capture bound");
      expect(result.stderr).toContain("reply is dropped");
    } finally { f.cleanup(); }
  });

  test("an experiment envelope over the bound is truncated to fit, with the events copy dropped first", () => {
    const f = fixture();
    try {
      f.writeWire();
      const large = stream([{ role: "assistant", content: "x".repeat(9 * 1024 * 1024) }, kimiResumeHint()]);
      const result = f.adapter.processRunResult({ ...success, stdout: large },
        { ...f.request, experimentMcp: "synthetic.json" }, undefined,
        new ExperimentFailure(Code.ResultChanged, "synthetic experiment failure"));
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(JSON.parse(result.stdout).events).toBeUndefined();
      expect(result.stderr).toContain("result truncated to the 16 MiB capture limit");
    } finally { f.cleanup(); }
  });

  test("oversized metadata cannot defeat the experiment bound: the emergency envelope keeps every key (round 102)", () => {
    const f = fixture();
    try {
      f.writeWire();
      const reply = stream([{ role: "assistant", content: "short" }, kimiResumeHint()]);
      const result = f.adapter.processRunResult({ ...success, stdout: reply },
        { ...f.request, experimentMcp: "synthetic.json", labels: { big: "y".repeat(17 * 1024 * 1024) } }, undefined,
        new ExperimentFailure(Code.ResultChanged, "synthetic experiment failure"));
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(16 * 1024 * 1024);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.reply).toBeNull();
      expect(envelope.codemux).toMatchObject({ agent: "kimi", labels: null, model: null, served_model: null,
        session_id: null, recording: null, failure_code: Code.ResultChanged });
      expect(result.stderr).toContain("result truncated to the 16 MiB capture limit");
    } finally { f.cleanup(); }
  });

  test.each([false, true])("capture failures keep only the valid prefix; JSON=%s", (resultJson) => {
    const f = fixture();
    try {
      const failure = new ExperimentFailure(Code.ResultChanged, "earlier experiment failure");
      const result = f.adapter.processRunResult({ ...success, usage,
        stdout: stream(events) + "{broken\n" + stream([{ role: "assistant", content: "Untrusted suffix" }]),
        exitCode: 125, success: false }, { ...f.request, resultJson, experimentMcp: "synthetic.json" }, undefined, failure);
      expect(result).toMatchObject({ success: false, exitCode: 125, usage, reply: "Recovered\nanswer\n" });
      expect(result.stderr).toContain("stream-json line 3");
      if (resultJson) expect(JSON.parse(result.stdout)).toMatchObject({ reply: "Recovered\nanswer\n", events,
        session_id: KIMI_STREAM_SESSION, codemux: { usage, failure_code: "result_changed" } });
      else expect(result.stdout).toBe("Recovered\nanswer\n");
    } finally { f.cleanup(); }
  });

  test("a re-read envelope's parse error says its line numbers are reconstructed (round 381)", () => {
    const f = fixture();
    try {
      // The envelope's events array carries no original line positions, so
      // the re-parse counts the reconstructed join; the diagnostic used to
      // cite "line 1" as though the capture had that line.
      const envelope = `${JSON.stringify({ codemux: { agent: "kimi" }, events: [{ bogus: true }] })}\n`;
      const result = f.adapter.processRunResult({ ...success, stdout: envelope }, f.request);
      expect(result.success).toBe(false);
      expect(result.stderr).toContain("no recognized role or type");
      expect(result.stderr).toContain("reconstructed");
    } finally { f.cleanup(); }
  });

  for (const experiment of [false, true]) {
    test.each(["empty", "malformed", "missing hint", "missing wire", "unreadable wire"] as const)
      (`result-json errors always return an envelope; experiment=${experiment}: %s`, (mode) => {
        const f = fixture();
        try {
          const captured = mode === "empty" ? [] : mode === "missing hint" ? events.slice(0, -1) : events;
          if (mode === "malformed") f.writeWire();
          if (mode === "unreadable wire") {
            mkdirSync(dirname(f.wire), { recursive: true });
            const target = join(f.home, "linked-wire.jsonl");
            writeFileSync(target, "");
            symlinkSync(target, f.wire);
          }
          const stdout = mode === "empty" ? "" : stream(captured) + (mode === "malformed" ? "{broken\n" : "");
          const result = f.adapter.processRunResult({ ...success, stdout },
            { ...f.request, ...(experiment ? { experimentMcp: "synthetic.json" } : {}) });
          expect(result).toMatchObject({ success: false, exitCode: 1 });
          expect(result.stderr).toMatch(/native diagnostic\ncodemux: /);
          expect(JSON.parse(result.stdout)).toMatchObject({ reply: mode === "empty" ? "" : "Recovered\nanswer\n",
            events: captured, session_id: mode === "empty" || mode === "missing hint" ? null : KIMI_STREAM_SESSION,
            codemux: { agent: "kimi", model: "fixture-model", labels: f.request.labels,
              failure_code: experiment ? "protocol" : null } });
          if (mode === "malformed") expect(result.usage).toEqual(usage);
          if (mode === "missing hint" || mode === "empty") expect(result.stderr).toContain("no session.resume_hint");
          if (mode === "unreadable wire") expect(result.stderr).toContain("wire log cannot be opened");
          if (mode === "missing wire") expect(result.stderr).toContain("wire log is missing");
        } finally { f.cleanup(); }
      });
  }

  test.each([false, true])("normalization records the retained experiment failure before returning; prior=%s", (prior) => {
    const f = fixture();
    const run = new ExperimentKimiRun({ name: "experiment", command: "/synthetic/never-started",
      args: [], env: [], recording: join(f.home, "recordings") }, f.home, f.brand, join(f.home, "agent.md"), {});
    const context: RunContext = { experimentKimi: run, experimentRecording: run.recordingPath };
    try {
      if (prior) run.relay.fail(new ExperimentFailure(Code.ResultChanged, "original mismatch"));
      const result = f.adapter.processRunResult({ ...success, stdout: stream(events.slice(0, -1)) },
        { ...f.request, experimentMcp: "synthetic.json" }, context);
      const code = prior ? Code.ResultChanged : Code.Protocol;
      expect(result).toMatchObject({ success: false, exitCode: 1 });
      expect(JSON.parse(result.stdout).codemux).toMatchObject({ failure_code: code, recording: run.recordingPath });
      expect(run.relay.failureError).toMatchObject({ code,
        message: prior ? "original mismatch" : expect.stringContaining("no session.resume_hint") });
      const records = readFileSync(run.recordingPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(records.filter((record) => record.kind === "failure")).toHaveLength(1);
      expect(records.find((record) => record.kind === "failure").code).toBe(code);
    } finally { run.closeSync(); f.cleanup(); }
  });

  test("a retained experiment failure includes its diagnostic when the capture is valid", () => {
    const f = fixture();
    const run = new ExperimentKimiRun({ name: "experiment", command: "/synthetic/never-started",
      args: [], env: [], recording: join(f.home, "recordings") }, f.home, f.brand, join(f.home, "agent.md"), {});
    try {
      f.writeWire();
      run.relay.fail(new ExperimentFailure(Code.ResultChanged, "original mismatch"));
      const result = f.adapter.processRunResult(success, { ...f.request, experimentMcp: "synthetic.json" },
        { experimentKimi: run, experimentRecording: run.recordingPath });
      expect(result).toMatchObject({ success: false, exitCode: 1, usage });
      expect(JSON.parse(result.stdout).codemux.failure_code).toBe("result_changed");
      expect(result.stderr).toContain("native diagnostic\ncodemux: experiment failure [result_changed]: original mismatch\n");
    } finally { run.closeSync(); f.cleanup(); }
  });

  test("a marker split across the surface/wire boundary does not fuse into the experiment scan (round 361, item 4)", () => {
    // The envelope appends the wire log to the scan surface. The wire's
    // first bytes are JSON (`{"dir":"meta"` on the pinned wire), so the
    // planted marker's tail IS those bytes and unseparated
    // concatenation fused the two into a marker that existed in no
    // single channel. The boundary carries a newline, the adapter's
    // rule for stdout/stderr/fold evidence.
    const f = fixture();
    try {
      mkdirSync(dirname(f.wire), { recursive: true });
      const wireHead = `{"dir":"meta","type":"usage.record","usage":${JSON.stringify({
        inputOther: 3, output: 5, inputCacheRead: 4, inputCacheCreation: 2 })}}`;
      writeFileSync(f.wire, wireHead + "\n");
      const marker = `CODEMUX-CANAR${wireHead.slice(0, 12)}`;
      const context = { experimentKimi: { foldedUsage: () => undefined,
        relay: { failureError: null, failureCode: null, fail() {} },
        evidence: { wireLogPath: f.wire } } } as unknown as RunContext;
      const result = kimiResult({ ...success, scanSurface: "kept output ends with CODEMUX-CANAR" },
        { ...f.request, experimentMcp: "synthetic.json" }, f.brand, context);
      expect(result.scanSurface).toBe(`kept output ends with CODEMUX-CANAR\n${wireHead}\n`);
      expect(result.scanSurface).not.toContain(marker);
    } finally { f.cleanup(); }
  });
});

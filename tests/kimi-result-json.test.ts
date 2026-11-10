import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { KimiAdapter } from "../src/adapters/kimi.js";
import type { RunContext } from "../src/run-context.js";
import type { RunRequest, RunResult } from "../src/types.js";
import { MAX_KIMI_WIRE_BYTES } from "../src/kimi-wire-log.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import { ExperimentFailure, ExperimentFailureCode } from "../src/experiment-records.js";
import { KIMI_STREAM_SESSION, kimiResumeHint as resumeHint } from "./fixtures/kimi-stream.js";

const success: RunResult = { stdout: "", stderr: "", exitCode: 0, success: true };
const stream = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const events = [
  { role: "meta", type: "system.version", version: "2.3.2" },
  { role: "assistant", content: "Working", tool_calls: [{ type: "function", id: "call-1", function: { name: "Read", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "call-1", content: "file contents" },
  { role: "meta", type: "turn.step.retrying", failed_attempt: 1, next_attempt: 2 },
  { role: "assistant", content: "A\nB\n\n" },
  resumeHint(),
];

function fixture(hermetic = false, alternateHome = false) {
  const scratch = join(import.meta.dir, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "kimi-result-"));
  const brand = join(home, alternateHome ? "alternate-brand" : ".kimi-code");
  mkdirSync(brand);
  const adapter = new KimiAdapter({ HOME: home, ...(alternateHome ? { KIMI_CODE_HOME: brand } : {}) }, home);
  const request: RunRequest = { agent: "kimi", prompt: "hello", model: "test-model", resultJson: true,
    hermetic, labels: { wf: "synthetic" }, ...(alternateHome ? { passthroughEnv: ["KIMI_CODE_HOME"] } : {}) };
  const context = adapter.prepareRun(request);
  const usedBrand = context.kimiHermeticHome?.kimiHome ?? brand;
  const path = join(usedBrand, "sessions", "workspace", KIMI_STREAM_SESSION, "agents", "main", "wire.jsonl");
  const writeWire = (records: unknown[]) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, stream(records));
  };
  const processResult = (stdout = stream(events)) => adapter.processRunResult({ ...success, stdout }, request, context);
  return { home, brand, adapter, request, context, path, writeWire, processResult,
    cleanup: () => { adapter.cleanupRunSync(context); rmSync(home, { recursive: true, force: true }); } };
}

const records = [
  { type: "context.append_loop_event", event: { type: "step.end", usage: { inputOther: 999 } } },
  { type: "usage.record", usageScope: "turn", usage: { inputOther: 10, output: 4, inputCacheRead: 20, inputCacheCreation: 2 } },
  { type: "usage.record", usageScope: "turn", usage: { inputOther: 3, output: 6, inputCacheRead: 5, inputCacheCreation: 1 } },
];

describe("Kimi result-json", () => {
  test.each([true, false])("experiment failure preserves captured reply and native events; JSON=%s", (resultJson) => {
    const f = fixture(true);
    try {
      f.writeWire(records);
      const failure = new ExperimentFailure(ExperimentFailureCode.ResultChanged, "synthetic mismatch");
      const request = { ...f.request, resultJson, experimentMcp: "synthetic.json" };
      const result = f.adapter.processRunResult({ ...success, stdout: stream(events) }, request, f.context, failure);
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      if (resultJson) expect(JSON.parse(result.stdout)).toMatchObject({ reply: "Working\n\nA\nB\n", events,
        session_id: KIMI_STREAM_SESSION, codemux: { failure_code: "result_changed" } });
      else expect(result.stdout).toBe("Working\n\nA\nB\n");
    } finally { f.cleanup(); }
  });

  test.each([true, false])("experiment parser failure prints the captured reply instead of raw events; JSON=%s", (resultJson) => {
    const f = fixture(true);
    try {
      const failure = new ExperimentFailure(ExperimentFailureCode.Protocol, "missing session hint");
      const request = { ...f.request, resultJson, experimentMcp: "synthetic.json" };
      const captured = events.slice(0, -1);
      const result = f.adapter.processRunResult({ ...success, stdout: stream(captured) }, request, f.context, failure);
      expect(result.success).toBe(false);
      if (resultJson) expect(JSON.parse(result.stdout)).toMatchObject({ reply: "Working\n\nA\nB\n", events: captured,
        session_id: null, codemux: { failure_code: "protocol" } });
      else expect(result.stdout).toBe("Working\n\nA\nB\n");
    } finally { f.cleanup(); }
  });

  test.each([true, false])("malformed tails retain the complete Kimi prefix and readable usage; JSON=%s", (resultJson) => {
    const f = fixture(true);
    try {
      f.writeWire(records);
      for (const tail of ['{broken\n', '{"role":"meta"', '{"role":"assistant","content":[]}\n']) {
        const failure = new ExperimentFailure(ExperimentFailureCode.Protocol, "synthetic capture failure");
        const result = f.adapter.processRunResult({ ...success, stdout: stream(events) + tail },
          { ...f.request, resultJson, experimentMcp: "synthetic.json" }, f.context, failure);
        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/stream-json line 7/);
        expect(result.usage?.total_tokens).toBe(51);
        if (resultJson) expect(JSON.parse(result.stdout)).toMatchObject({ reply: "Working\n\nA\nB\n", events,
          session_id: KIMI_STREAM_SESSION, codemux: { model: "test-model", failure_code: "protocol", usage: { total_tokens: 51 } } });
        else expect(result.stdout).toBe("Working\n\nA\nB\n");
      }
    } finally { f.cleanup(); }
  });

  test.each(["malformed", "missing hint", "missing wire", "empty"])("ordinary Kimi result-json always emits its failure envelope: %s", (mode) => {
    const f = fixture();
    try {
      const captured = mode === "missing hint" ? events.slice(0, -1) : events;
      const stdout = mode === "malformed" ? stream(captured) + "{broken\n" : mode === "empty" ? "" : stream(captured);
      if (mode === "malformed") f.writeWire(records);
      const result = f.processResult(stdout);
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).not.toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ events: mode === "empty" ? [] : captured,
        codemux: { agent: "kimi", model: "test-model", failure_code: null } });
    } finally { f.cleanup(); }
  });

  test("early experiment failures report the provider-selected model with an empty Kimi envelope", () => {
    const adapter = new KimiAdapter({ CODEMUX_KIMI_PROVIDER_MODEL: "provider-selected-model",
      CODEMUX_KIMI_PROVIDER_BASE_URL: "https://example.invalid/v1", CODEMUX_KIMI_PROVIDER_API_KEY: "synthetic" });
    const failure = new ExperimentFailure(ExperimentFailureCode.Protocol, "synthetic version refusal");
    const request: RunRequest = { agent: "kimi", prompt: "fixture", hermetic: true, resultJson: true, experimentMcp: "synthetic.json" };
    const result = adapter.processRunResult(success, request, undefined, failure);
    expect(result.success).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({ reply: "", events: [], session_id: null,
      codemux: { model: "provider-selected-model", failure_code: "protocol" } });
  });

  test.each([
    { CODEMUX_KIMI_PROVIDER_BASE_URL: "invalid-provider-url" },
    { KIMI_CODE_HOME: "relative-brand-home" },
  ])("early experiment failure envelopes tolerate the invalid configuration that caused refusal: %j", (environment) => {
    const adapter = new KimiAdapter(environment);
    const failure = new ExperimentFailure(ExperimentFailureCode.Protocol, "synthetic configuration refusal");
    const request: RunRequest = { agent: "kimi", prompt: "fixture", resultJson: true,
      experimentMcp: "synthetic.json", passthroughEnv: ["KIMI_CODE_HOME"] };
    const result = adapter.processRunResult(success, request, undefined, failure);
    expect(JSON.parse(result.stdout)).toMatchObject({ reply: "", events: [], session_id: null,
      codemux: { failure_code: "protocol" } });
  });

  test("experiment failures preserve a normalized envelope after the private home was removed", () => {
    const f = fixture(true);
    try {
      f.writeWire(records);
      const normalized = f.processResult();
      f.adapter.cleanupRunSync(f.context);
      const failure = new ExperimentFailure(ExperimentFailureCode.Protocol, "synthetic cleanup failure");
      const result = f.adapter.processRunResult(normalized, { ...f.request, experimentMcp: "synthetic.json" }, f.context, failure);
      expect(JSON.parse(result.stdout)).toMatchObject({ reply: "Working\n\nA\nB\n", events,
        session_id: KIMI_STREAM_SESSION, codemux: { failure_code: "protocol", usage: { total_tokens: 51 } } });
    } finally { f.cleanup(); }
  });

  test.each([false, true])("envelope reads used brand home before cleanup; hermetic=%s", (hermetic) => {
    const f = fixture(hermetic);
    try {
      f.writeWire(records);
      const result = f.processResult();
      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
      const envelope = JSON.parse(result.stdout);
      expect(envelope).toEqual({ reply: "Working\n\nA\nB\n", events, session_id: KIMI_STREAM_SESSION, codemux: {
        agent: "kimi", model: "test-model", served_model: null, model_alias: null, labels: { wf: "synthetic" }, session_id: null, recording: null, failure_code: null,
        final_message: "A\nB\n\n", truncated: false,
        usage: { input_tokens: 13, cached_input_tokens: 28, output_tokens: 10, total_tokens: 51, cost_usd: null },
      } });
      expect(f.context.kimiWireLogPath).toBe(f.path);
      expect(result.usage).toEqual(envelope.codemux.usage);
      const plain = f.adapter.processRunResult({ ...success, stdout: "• Working\n\n• A\n  B\n\n" },
        { ...f.request, resultJson: false }, { ...f.context, harnessVersion: "2.3.2" });
      expect(envelope.reply).toBe(plain.stdout);
      expect(existsSync(f.path)).toBe(true);
      f.adapter.cleanupRunSync(f.context);
      expect(existsSync(f.path)).toBe(!hermetic);
    } finally { f.cleanup(); }
  });

  test("plain result-json honors an explicitly passed brand home", () => {
    const f = fixture(false, true);
    try { f.writeWire(records); expect(f.processResult().exitCode).toBe(0); expect(f.context.kimiWireLogPath).toBe(f.path); }
    finally { f.cleanup(); }
  });

  test("native session-prefixed resume IDs name the existing session directory directly", () => {
    const f = fixture(true);
    try {
      f.writeWire(records);
      const native = [...events.slice(0, -1), resumeHint()];
      const result = f.processResult(stream(native));
      expect(result.success).toBe(true);
      expect(JSON.parse(result.stdout).session_id).toBe(KIMI_STREAM_SESSION);
      expect(f.context.kimiWireLogPath).toBe(f.path);
    } finally { f.cleanup(); }
  });

  test("missing wire log fails and names the expected path", () => {
    const f = fixture(true);
    try {
      const result = f.processResult();
      expect(result.exitCode).toBe(1); expect(result.success).toBe(false);
      expect(result.stderr).toContain(join(f.context.kimiHermeticHome!.kimiHome, "sessions", "*", KIMI_STREAM_SESSION, "agents", "main", "wire.jsonl"));
    } finally { f.cleanup(); }
  });

  test("missing session id fails and names the unresolved wire path", () => {
    const f = fixture();
    try {
      const result = f.processResult(stream(events.slice(0, -1)));
      expect(result.success).toBe(false); expect(result.stderr).toContain("no session.resume_hint session id");
      expect(result.stderr).toContain(join(f.brand, "sessions", "*", "session_<id>", "agents", "main", "wire.jsonl"));
    } finally { f.cleanup(); }
  });

  test.each(["not json\n", "{}\n", "[]\n", '{"role":"assistant","content":[]}\n'])("malformed stream fails: %s", (stdout) => {
    const f = fixture();
    try { expect(f.processResult(stdout).success).toBe(false); }
    finally { f.cleanup(); }
  });

  test("error events and empty replies fail even after a zero exit", () => {
    const f = fixture();
    try {
      f.writeWire(records);
      const failure = f.processResult(stream([...events, { type: "error", message: "synthetic failure" }]));
      expect(failure.exitCode).toBe(1); expect(failure.stderr).toContain("synthetic failure");
      const empty = f.processResult(stream([events[0], events.at(-1)]));
      expect(empty.success).toBe(false); expect(empty.stderr).toContain("no assistant reply");
      const nonzero = f.adapter.processRunResult({ ...success, stdout: stream(events), exitCode: 7, success: false }, f.request, f.context);
      expect(nonzero.exitCode).toBe(7); expect(nonzero.success).toBe(false);
    } finally { f.cleanup(); }
  });

  test("an error-only stream reports the provider error, not the missing resume hint (round 259)", () => {
    // A provider failure (quota exhausted) prints one error event and
    // never reaches the resume hint. Before round 259 the hint requirement
    // was read first, so the run reported only the missing
    // session.resume_hint and hid the error that explains why no hint
    // exists. The error event is the diagnostic; the hint is a
    // consequence. The plain path keeps the same rule (no reply on
    // stdout, the error on stderr).
    const f = fixture();
    try {
      const result = f.processResult(stream([{ type: "error", message: "quota exhausted" }]));
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("kimi reported an error event");
      expect(result.stderr).toContain("quota exhausted");
      expect(result.stderr).not.toContain("session.resume_hint");
      const plain = f.adapter.processRunResult(
        { ...success, stdout: stream([{ type: "error", message: "quota exhausted" }]) },
        { ...f.request, resultJson: false }, f.context
      );
      expect(plain.success).toBe(false);
      expect(plain.stderr).toContain("quota exhausted");
      expect(plain.stderr).not.toContain("session.resume_hint");
      expect(plain.stdout).toBe("");
    } finally { f.cleanup(); }
  });

  test("usage preserves zero and missing components without double counting step events", () => {
    const f = fixture();
    try {
      f.writeWire([{ type: "usage.record", usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } }]);
      expect(f.processResult().usage).toEqual({ input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_tokens: 0, cost_usd: null });
      f.writeWire([{ type: "usage.record", usage: { inputOther: 2, output: 3, inputCacheRead: 0 } }]);
      expect(f.processResult().usage).toEqual({ input_tokens: 2, output_tokens: 3, cached_input_tokens: null, total_tokens: null, cost_usd: null });
      // Kimi Code 2.5.0 leaves inputCacheRead out when nothing was read
      // from cache (its own schema marks it optional and its own total
      // counts it as zero): absent is zero, while a present null, or any
      // other missing count, still leaves the sums null (live gate,
      // 2026-11-06).
      f.writeWire([
        { type: "usage.record", usage: { inputOther: 2027, output: 114, inputCacheCreation: 0 } },
        { type: "usage.record", usage: { inputOther: 5, output: 1, inputCacheRead: 7, inputCacheCreation: 2 } },
      ]);
      expect(f.processResult().usage).toEqual({ input_tokens: 2032, output_tokens: 115, cached_input_tokens: 9, total_tokens: 2156, cost_usd: null });
      f.writeWire([{ type: "usage.record", usage: { inputOther: 2, output: 3, inputCacheRead: null, inputCacheCreation: 0 } }]);
      expect(f.processResult().usage).toEqual({ input_tokens: 2, output_tokens: 3, cached_input_tokens: null, total_tokens: null, cost_usd: null });
      f.writeWire([]);
      expect(f.processResult().usage).toEqual({ input_tokens: null, output_tokens: null, cached_input_tokens: null, total_tokens: null, cost_usd: null });
    } finally { f.cleanup(); }
  });

  test("wire reads reject malformed, oversized, and linked logs", () => {
    const f = fixture();
    try {
      f.writeWire([]); writeFileSync(f.path, "invalid\n");
      expect(f.processResult().stderr).toContain("wire log contains invalid JSON");
      truncateSync(f.path, MAX_KIMI_WIRE_BYTES + 1);
      expect(f.processResult().stderr).toContain(`exceeds ${MAX_KIMI_WIRE_BYTES} bytes`);
      rmSync(f.path); symlinkSync(join(f.home, "absent"), f.path);
      expect(f.processResult().success).toBe(false);
    } finally { f.cleanup(); }
  });

  test("session path traversal is refused", () => {
    const f = fixture();
    try {
      const result = f.processResult(stream([...events.slice(0, -1), { role: "meta", type: "session.resume_hint", session_id: "../../elsewhere" }]));
      expect(result.success).toBe(false); expect(result.stderr).toContain("invalid session id");
    } finally { f.cleanup(); }
  });

  test.each([
    { inputOther: Number.MAX_SAFE_INTEGER, output: 1, inputCacheRead: 1, inputCacheCreation: 0 },
    { inputOther: 0, output: 0, inputCacheRead: Number.MAX_SAFE_INTEGER, inputCacheCreation: 1 },
  ])("unsafe combined usage totals fail: %j", (usage) => {
    const f = fixture();
    try {
      f.writeWire([{ type: "usage.record", usage }]);
      const result = f.processResult();
      expect(result.success).toBe(false);
      expect(result.stderr).toContain("safe integer range");
    } finally { f.cleanup(); }
  });

  test("result parser records the wire path on the caller's context", () => {
    const f = fixture();
    const context: RunContext = {};
    try {
      f.writeWire(records);
      f.adapter.processRunResult({ ...success, stdout: stream(events) }, f.request, context);
      expect(context.kimiWireLogPath).toBe(f.path);
    } finally { f.cleanup(); }
  });
});

test.each(["--no-sandbox", "--sandbox"])("CLI result-json reads private wire usage with %s and then removes the home", async (sandbox) => {
  const f = fixture();
  const cwd = join(f.home, "work"); mkdirSync(join(cwd, ".git"), { recursive: true });
  const script = join(f.home, "shim.ts"), usedHome = join(f.home, "used-home");
  writeFileSync(script, `import {mkdirSync,writeFileSync} from "node:fs";
import {dirname,join} from "node:path";
if (process.argv[2] === "--version") {console.log("2.3.2");process.exit(0);}
if (!process.argv.includes("stream-json")) process.exit(8);
writeFileSync(${JSON.stringify(usedHome)},process.env.HOME);
const path = join(process.env.KIMI_CODE_HOME,"sessions","workspace",${JSON.stringify(KIMI_STREAM_SESSION)},"agents","main","wire.jsonl");
mkdirSync(dirname(path),{recursive:true});writeFileSync(path,${JSON.stringify(stream(records))});
process.stdout.write(${JSON.stringify(stream(events))});`);
  const fake = createFakeBinaryEnv({ kimi: `exec bun '${script}' "$@"`,
    scode: `[ "$HOME" = '${f.home}' ] || exit 9
while [ "$1" != "--" ]; do shift; done; shift
case "$1" in */env|env) ;; *) exit 10 ;; esac
[ "$2" = -u ] || exit 11
exec "$@"` });
  try {
    const result = await runCli(["run", "-a", "kimi", "--hermetic", "--result-json", sandbox, "--auto", "high", "--cwd", cwd, "-p", "hello"], { ...fake.env, HOME: f.home });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).codemux.usage.total_tokens).toBe(51);
    expect(existsSync(readFileSync(usedHome, "utf8"))).toBe(false);
  } finally { fake.cleanup(); f.cleanup(); }
});

test.each([
  { resultJson: true, captureError: false }, { resultJson: false, captureError: false },
  { resultJson: true, captureError: true }, { resultJson: false, captureError: true },
])("CLI experiment failure preserves the captured Kimi reply; %j", async ({ resultJson, captureError }) => {
  const f = fixture();
  const captured = [events[0], { role: "assistant", content: "Working" }, ...events.slice(3),
    ...(captureError ? [{ type: "error", message: "synthetic capture failure" }] : [])];
  const cwd = join(f.home, "work"), script = join(f.home, "failing-experiment.ts"), spec = join(f.home, "spec.json");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  writeFileSync(spec, JSON.stringify({ name: "experiment", command: process.execPath,
    args: [join(import.meta.dir, "fixtures/experiment-mcp.ts")], env: [], recording: join(f.home, "recordings"),
    accept_harness_prefix: ["kimi-wall-time"] }));
  writeFileSync(script, `import {mkdirSync,writeFileSync} from "node:fs";
import {dirname,join} from "node:path";
if(process.argv.includes("--version")){console.log("2.3.2");process.exit(0);}
const path=join(process.env.KIMI_CODE_HOME,"sessions/workspace",${JSON.stringify(KIMI_STREAM_SESSION)},"agents/main/wire.jsonl");
mkdirSync(dirname(path),{recursive:true});writeFileSync(path,${JSON.stringify(stream(records))});
process.stdout.write(${JSON.stringify(stream(captured))});`);
  const fake = createFakeBinaryEnv({ kimi: `exec bun '${script}' "$@"`,
    scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"' });
  try {
    const result = await runCli(["run", "-a", "kimi", "--hermetic", "--tools", "none", "--experiment-mcp", spec,
      "--cwd", cwd, "-p", "fixture", ...(resultJson ? ["--result-json"] : [])], { ...fake.env, HOME: f.home,
      CODEMUX_KIMI_PROVIDER_MODEL: "provider-selected-model", CODEMUX_KIMI_PROVIDER_BASE_URL: "https://example.invalid/v1",
      CODEMUX_KIMI_PROVIDER_API_KEY: "synthetic" });
    expect(result.exitCode).toBe(1);
    if (resultJson) expect(JSON.parse(result.stdout)).toMatchObject({ reply: "Working\n\nA\nB\n", events: captured,
      session_id: KIMI_STREAM_SESSION, codemux: { model: "provider-selected-model", failure_code: captureError ? "protocol" : "inventory_mismatch",
        usage: { total_tokens: 51 } } });
    else expect(result.stdout).toBe("Working\n\nA\nB\n");
  } finally { fake.cleanup(); f.cleanup(); }
});

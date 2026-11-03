/**
 * The kimi plain-run streaming fold (review round 3, contracts-2 finding
 * on kimi.ts): a plain run's stream-json wire carries every tool's output,
 * so the launcher feeds it to KimiPlainFold instead of capturing whole —
 * a stream with more than the capture bound of tool payloads and then a
 * short reply succeeds, with the reply and the wire-log usage recorded.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { KimiAdapter } from "../src/adapters/kimi.js";
import { KimiPlainFold } from "../src/plain-unwrap/kimi-fold.js";
import { evaluateCanary } from "../src/hermetic-canary.js";
import { MAX_CAPTURE_BYTES } from "../src/process-runner.js";
import type { RunContext } from "../src/adapters/base.js";
import type { RunRequest, RunResult } from "../src/types.js";
import { KIMI_STREAM_SESSION, kimiAssistantCall, kimiResumeHint } from "./fixtures/kimi-stream.js";

const success: RunResult = { stdout: "", stderr: "", exitCode: 0, success: true };
const line = (event: unknown) => `${JSON.stringify(event)}\n`;
const records = [
  { type: "usage.record", usageScope: "turn", usage: { inputOther: 10, output: 4, inputCacheRead: 20, inputCacheCreation: 2 } },
];

function fixture() {
  const scratch = join(import.meta.dir, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "kimi-fold-"));
  const brand = join(home, ".kimi-code");
  mkdirSync(brand);
  const adapter = new KimiAdapter({ HOME: home }, home);
  const request: RunRequest = { agent: "kimi", prompt: "hello", model: "test-model" };
  const path = join(brand, "sessions", "workspace", KIMI_STREAM_SESSION, "agents", "main", "wire.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return {
    home, adapter, request,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** More than the capture bound of tool payloads, then a short reply and
 * the resume hint. */
function oversizedStream(): string {
  const chunk = "x".repeat(1024 * 1024); // 1 MiB per tool result
  let stream = "";
  for (let index = 0; index < MAX_CAPTURE_BYTES / (1024 * 1024) + 4; index++) {
    stream += line({ role: "tool", tool_call_id: `call_${index}`, content: chunk });
  }
  stream += line({ role: "assistant", content: "Working\nA\nB\n\n" });
  stream += line(kimiResumeHint());
  return stream;
}

/** Feeds a stream through the fold the way the process runner does: in
 * bounded chunks, polling keptBytes after each push. */
function streamThrough(sink: KimiPlainFold, text: string, chunkBytes = 64 * 1024): void {
  for (let start = 0; start < text.length; start += chunkBytes) {
    sink.push(text.slice(start, start + chunkBytes));
    // The runner kills the run the moment this answers over the bound.
    expect(sink.keptBytes()).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
  }
}

describe("Kimi plain runs stream through a bounded fold", () => {
  test("tool payloads past the capture bound never reach it; the reply and usage survive", () => {
    const f = fixture();
    try {
      const context: RunContext = f.adapter.prepareRun(f.request);
      const sink = context.stdoutSink;
      expect(sink).toBeInstanceOf(KimiPlainFold);
      streamThrough(sink as KimiPlainFold, oversizedStream());
      const folded = (sink as KimiPlainFold).finish();
      // The folded stdout is wire JSONL that no longer carries a tool
      // payload, and the plain unwrap answers off it exactly as off the
      // whole capture: reply out, wire-log usage recorded.
      expect(folded).not.toContain("xxxxxxxx");
      const result = f.adapter.processRunResult({ ...success, stdout: folded }, f.request, {
        ...context, harnessVersion: "2.3.2",
      });
      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
      expect(result.stdout).toBe("Working\nA\nB\n");
      expect(result.usage).toEqual({
        input_tokens: 10, cached_input_tokens: 22, output_tokens: 4,
        total_tokens: 36, cost_usd: null,
      });
    } finally { f.cleanup(); }
  });

  test("a tool-calls-only assistant line is dropped; its grammar errors are not", () => {
    const f = fixture();
    try {
      const sink = new KimiPlainFold();
      const payload = JSON.stringify({ file: "x".repeat(2048) });
      streamThrough(sink, [
        line(kimiAssistantCall("call_1", "write", { file: "x".repeat(2048) })),
        line({ role: "assistant", content: "Done" }),
        line(kimiResumeHint()),
      ].join(""));
      expect(sink.finish()).not.toContain(payload);
      const result = f.adapter.processRunResult(
        { ...success, stdout: sink.finish() }, f.request, { harnessVersion: "2.3.2" });
      expect(result.stdout).toBe("Done\n");
      // A malformed tool line is kept verbatim so the whole-capture parser
      // fails on it downstream, exactly as it would have.
      const broken = new KimiPlainFold();
      streamThrough(broken, line({ role: "tool", tool_call_id: "", content: "o" }));
      expect(broken.finish()).toContain("tool_call_id");
      const failed = f.adapter.processRunResult(
        { ...success, stdout: broken.finish() }, f.request, { harnessVersion: "2.3.2" });
      expect(failed.success).toBe(false);
    } finally { f.cleanup(); }
  });

  test("a mixed text-and-tool-calls line keeps only its text (round 11, edges 5)", () => {
    const f = fixture();
    try {
      const sink = new KimiPlainFold();
      const mixed = {
        role: "assistant",
        content: "Short reply",
        tool_calls: [{ type: "function", id: "call_1",
          function: { name: "write", arguments: JSON.stringify({ file: "x".repeat(1024 * 1024) }) } }],
      };
      streamThrough(sink, line(mixed));
      const folded = sink.finish();
      // The megabyte of arguments is gone; the line survives small, its
      // text intact, and the plain unwrap reads the reply off it.
      expect(folded).toContain("Short reply");
      expect(folded).not.toContain("xxxxxxxx");
      expect(folded.length).toBeLessThan(200);
      expect(JSON.parse(folded.trim())).not.toHaveProperty("tool_calls");
      const result = f.adapter.processRunResult(
        { ...success, stdout: folded }, f.request, { harnessVersion: "2.3.2" });
      expect(result.stdout).toBe("Short reply\n");
    } finally { f.cleanup(); }
  });

  test("a marker shed with a tool payload still reaches the canary verdict (round 17, contracts-2 1)", () => {
    // The fold drops tool results and tool_calls payloads to hold the
    // capture bound; the hermetic check's leak scan must still see a
    // planted marker those bytes carried. Without the evidence, a harness
    // printing the marker only in a tool result was certified clean.
    const marker = "CODEMUX-CANARY-DEADBEEF";
    const f = fixture();
    try {
      const sink = new KimiPlainFold();
      streamThrough(sink, [
        line({ role: "tool", tool_call_id: "call_1", content: `the code word is ${marker}` }),
        line({
          role: "assistant", content: "OK",
          tool_calls: [{ type: "function", id: "call_2",
            function: { name: "write", arguments: JSON.stringify({ note: marker }) } }],
        }),
        line(kimiResumeHint()),
      ].join(""));
      const folded = sink.finish();
      // The kept bytes carry neither marker: one rode a dropped tool
      // result, the other a kept line's shed tool_calls payload.
      expect(folded).not.toContain(marker);
      expect(sink.droppedMarkerEvidence()).toContain(marker);
      // Both sheds are recorded: the tool line's and the tool_calls
      // field's, bounded to the match and its context.
      expect(sink.droppedMarkerEvidence().split(marker)).toHaveLength(3);
      // The evidence is not charged to the capture bound.
      const plain = new KimiPlainFold();
      streamThrough(plain, line({ role: "assistant", content: "OK" }) + line(kimiResumeHint()));
      expect(sink.keptBytes()).toBe(plain.keptBytes());

      // The full chain the check runs: the adapter's scanSurface — kept
      // output plus shed evidence — makes evaluateCanary report the leak
      // the reply alone would have hidden.
      const context: RunContext = { stdoutSink: sink };
      const result = f.adapter.processRunResult(
        { ...success, stdout: folded }, f.request, context);
      expect(result.stdout).toBe("OK\n");
      expect(result.scanSurface).toContain(marker);
      expect(evaluateCanary(result.scanSurface!, marker, result.stdout))
        .toEqual({ kind: "leak", what: "marker", answer: marker });
      // The control direction: no marker anywhere, the verdict stays
      // clean — the evidence channel adds nothing on its own.
      const clean = new KimiPlainFold();
      streamThrough(clean, line({ role: "tool", tool_call_id: "call_1", content: "no marker" }) +
        line({ role: "assistant", content: "OK" }) + line(kimiResumeHint()));
      const cleanResult = f.adapter.processRunResult(
        { ...success, stdout: clean.finish() }, f.request, { stdoutSink: clean });
      expect(evaluateCanary(cleanResult.scanSurface!, marker, cleanResult.stdout))
        .toEqual({ kind: "clean" });
    } finally { f.cleanup(); }
  });

  test("one tool event past the capture bound is shed from its prefix; the reply survives (round 20, edges 1)", () => {
    // Before round 20 the fold refused any single line over 16 MiB before
    // classifying it, so ONE large tool result aborted the run and lost
    // the reply after it. The fold now classifies by the streamed opening
    // — the pinned writer opens every payload with its role — and sheds
    // the line without ever holding it whole.
    const f = fixture();
    try {
      const context: RunContext = f.adapter.prepareRun(f.request);
      const sink = context.stdoutSink as KimiPlainFold;
      const oversized = line({
        role: "tool", tool_call_id: "call_big", content: "x".repeat(MAX_CAPTURE_BYTES + 4 * 1024 * 1024),
      });
      streamThrough(sink, oversized + line({ role: "assistant", content: "Working" }) + line(kimiResumeHint()));
      const folded = sink.finish();
      expect(folded).not.toContain("xxxxxxxx");
      const result = f.adapter.processRunResult({ ...success, stdout: folded }, f.request, {
        ...context, harnessVersion: "2.3.2",
      });
      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
      expect(result.stdout).toBe("Working\n");
    } finally { f.cleanup(); }
  });

  test("a marker inside a shed oversized payload still reaches the canary verdict, across chunk boundaries", () => {
    const marker = "CODEMUX-CANARY-DEADBEEF";
    const f = fixture();
    try {
      const sink = new KimiPlainFold();
      // The marker is placed to straddle a 64 KiB chunk boundary of the
      // payload: the discard stream scans chunk by chunk with a carry, so
      // a marker split across chunks still matches. The bytes before it
      // are chosen so the marker starts a few characters ahead of the
      // boundary (the line's own opening rides in front of the content).
      const opening = '{"role":"tool","tool_call_id":"call_big","content":"';
      const before = 65525 - opening.length;
      const content = "x".repeat(before) + marker + "x".repeat(MAX_CAPTURE_BYTES);
      streamThrough(sink, line({ role: "tool", tool_call_id: "call_big", content }) +
        line({ role: "assistant", content: "OK" }) + line(kimiResumeHint()));
      const folded = sink.finish();
      expect(folded).not.toContain(marker);
      expect(folded).toContain("OK");
      expect(sink.droppedMarkerEvidence()).toContain(marker);
      const result = f.adapter.processRunResult(
        { ...success, stdout: folded }, f.request, { stdoutSink: sink });
      expect(result.scanSurface).toContain(marker);
      expect(evaluateCanary(result.scanSurface!, marker, result.stdout))
        .toEqual({ kind: "leak", what: "marker", answer: marker });
    } finally { f.cleanup(); }
  });

  test("an assistant text line past the bound still latches; a tool-only oversize still proves the wire", () => {
    const f = fixture();
    try {
      const text = new KimiPlainFold();
      text.push(line({ role: "assistant", content: "x".repeat(MAX_CAPTURE_BYTES + 1) }));
      expect(text.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);

      // A stream whose only content was the oversized tool payload keeps
      // the wire proof through a COMPLETE error event: the anchor must
      // parse as wire (lane C30, item 3 made a cut excerpt plain text),
      // and the downstream verdict fails the run naming the shed payload,
      // never the hatch's empty success.
      const only = new KimiPlainFold();
      streamThrough(only, line({ role: "tool", tool_call_id: "call_big", content: "x".repeat(MAX_CAPTURE_BYTES + 1) }));
      const folded = only.finish();
      expect(folded.length).toBeLessThanOrEqual(129);
      expect(() => JSON.parse(folded)).not.toThrow();
      expect(folded).toContain('"type":"error"');
      expect(folded).toContain("shed an oversized tool payload");
      const result = f.adapter.processRunResult(
        { ...success, stdout: folded }, f.request, { harnessVersion: "2.3.2" });
      expect(result.success).toBe(false);
      expect(result.stderr).not.toBe("");
    } finally { f.cleanup(); }
  });

  test("a wire of tool payloads only still proves the wire: no hatch passthrough", () => {
    const f = fixture();
    try {
      const sink = new KimiPlainFold();
      streamThrough(sink, line({ role: "tool", tool_call_id: "call_1", content: "output" }));
      const folded = sink.finish();
      // The committing line answers as the wire's anchor.
      expect(folded).toContain('"role":"tool"');
      expect(() => JSON.parse(folded)).not.toThrow();
      const result = f.adapter.processRunResult(
        { ...success, stdout: folded }, f.request, { harnessVersion: "2.3.2" });
      // The whole-capture verdict for a stream with no hint and no reply
      // is a failed run naming the wire — never the hatch's silent empty
      // success.
      expect(result.success).toBe(false);
      expect(result.stderr).toContain("session.resume_hint");
    } finally { f.cleanup(); }
  });

  test("plain text keeps the hatch verbatim; a line past the bound latches", () => {
    const f = fixture();
    try {
      const hatch = new KimiPlainFold();
      streamThrough(hatch, "• Working\n  continued\n\n");
      expect(hatch.finish()).toBe("• Working\n  continued\n\n");
      // A pretty-printed JSON object over several lines is the same hatch
      // (lane C30, item 3): no line parses alone, so the regime is text
      // and the object returns verbatim instead of failing as a cut wire.
      const pretty = '{\n  "reply": "hello"\n}\n';
      const indented = new KimiPlainFold();
      streamThrough(indented, pretty);
      expect(indented.finish()).toBe(pretty);
      const oversize = new KimiPlainFold();
      oversize.push(line({ role: "assistant", content: "x".repeat(MAX_CAPTURE_BYTES + 1) }));
      expect(oversize.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
    } finally { f.cleanup(); }
  });

  test("a fake kimi streaming past the capture limit of tool events still answers", async () => {
    const f = fixture();
    const cwd = join(f.home, "work");
    mkdirSync(join(cwd, ".git"), { recursive: true });
    const script = join(f.home, "fake-kimi-oversize.ts");
    const ledger = join(f.home, "calls.jsonl");
    const wireLog = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    writeFileSync(script, `import {mkdirSync,writeFileSync} from "node:fs";
import {dirname,join} from "node:path";
if (process.argv[2] === "--version") {console.log("2.3.2");process.exit(0);}
if (!process.argv.includes("stream-json")) process.exit(8);
const path = join(process.env.HOME,".kimi-code","sessions","workspace",${JSON.stringify(KIMI_STREAM_SESSION)},"agents","main","wire.jsonl");
mkdirSync(dirname(path),{recursive:true});writeFileSync(path,${JSON.stringify(wireLog)});
const payload = "x".repeat(1024 * 1024);
for (let index = 0; index < 20; index++) {
  process.stdout.write(JSON.stringify({ role: "tool", tool_call_id: "call_" + index, content: payload }) + "\\n");
}
process.stdout.write(JSON.stringify({ role: "assistant", content: "Working\\nA\\nB\\n\\n" }) + "\\n");
process.stdout.write(JSON.stringify(${JSON.stringify(kimiResumeHint())}) + "\\n");`);
    const { createFakeBinaryEnv, runCli } = await import("./helpers/cli.js");
    const { readFileSync, existsSync, rmSync } = await import("node:fs");
    const fake = createFakeBinaryEnv({ kimi: `exec bun '${script}' "$@"` });
    try {
      const result = await runCli(
        ["run", "-a", "kimi", "--no-sandbox", "--auto", "high", "--cwd", cwd, "-p", "hello"],
        { ...fake.env, HOME: f.home, CODEMUX_CALL_LOG: ledger }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Working\nA\nB\n");
      const lines = readFileSync(ledger, "utf8").split("\n").filter((l) => l.trim() !== "");
      const record = JSON.parse(lines.at(-1)!) as { usage: { total_tokens: number } };
      expect(record.usage.total_tokens).toBe(36);
    } finally {
      fake.cleanup();
      f.cleanup();
      if (existsSync(ledger)) rmSync(ledger);
    }
  });

  test("a fake kimi streaming one 17 MiB kept line fails 125 naming the line (lane C30, item 2)", async () => {
    // The 125 used to say only that stdout passed the capture limit; the
    // one runaway kept line was nameless. The failure now carries the
    // offending line's first 512 bytes (controls escaped) and its byte
    // count, from the fold that latched on it.
    const f = fixture();
    const cwd = join(f.home, "work");
    mkdirSync(join(cwd, ".git"), { recursive: true });
    const script = join(f.home, "fake-kimi-kept-oversize.ts");
    writeFileSync(script, `if (process.argv[2] === "--version") {console.log("2.3.2");process.exit(0);}
if (!process.argv.includes("stream-json")) process.exit(8);
process.stdout.write(JSON.stringify({ role: "assistant", content: "y".repeat(${MAX_CAPTURE_BYTES} + 1024 * 1024) }) + "\\n");`);
    const { createFakeBinaryEnv, runCli } = await import("./helpers/cli.js");
    const fake = createFakeBinaryEnv({ kimi: `exec bun '${script}' "$@"` });
    try {
      const result = await runCli(
        ["run", "-a", "kimi", "--no-sandbox", "--auto", "high", "--cwd", cwd, "-p", "hello"],
        { ...fake.env, HOME: f.home }
      );
      expect(result.exitCode).toBe(125);
      expect(result.stderr).toContain(`Error: stdout exceeded the ${MAX_CAPTURE_BYTES}-byte capture limit`);
      expect(result.stderr).toMatch(/kimi: the line that passed the capture limit is (at least )?\d+ (streamed )?bytes long/);
      // The head of the offending line, quoted the way the message embeds
      // it (JSON.stringify's escaping of the wire head).
      const head = `{"role":"assistant","content":"${"y".repeat(64)}`;
      expect(result.stderr).toContain(JSON.stringify(head).slice(0, -1));
    } finally {
      fake.cleanup();
      f.cleanup();
    }
  });
});

  test("the first wire line is released once another line is kept (round 8, edges)", () => {
    // A dropped first tool event used to stay retained after a reply
    // line was kept, holding up to the capture bound beyond the residue
    // keptBytes reports. The anchor survives only while nothing else was
    // kept — a tool-only wire stays anchored.
    const released = new KimiPlainFold();
    const tool = line({ role: "tool", tool_call_id: "call_1", content: "x".repeat(1024 * 1024) });
    const reply = line({ role: "assistant", content: "Working" });
    released.push(tool + reply);
    expect(released.keptBytes()).toBe(Buffer.byteLength(reply));
    expect((released as unknown as { firstWireLine: string | null }).firstWireLine).toBeNull();
    expect(released.finish()).toBe(reply);
    const anchored = new KimiPlainFold();
    anchored.push(tool);
    expect((anchored as unknown as { firstWireLine: string | null }).firstWireLine).toBe(tool.trimEnd());
    expect(anchored.finish()).toBe(tool);
  });

  test("a dropped tool event followed by a blank line fails as no-reply, never plain success (round 10, edges 3)", () => {
    // A blank line kept used to release the wire anchor, so finish()
    // answered "\n"; the plain hatch saw no wire shape and the run
    // reported exit 0 with success: true and no reply. A blank line
    // releases nothing now: the anchor answers, the wire stays proven,
    // and the envelope fails with the no-reply verdict.
    const f = fixture();
    try {
      const tool = line({ role: "tool", tool_call_id: "call_1", content: "output" });
      const dropped = new KimiPlainFold();
      dropped.push(tool + "\n");
      const folded = dropped.finish();
      expect(() => JSON.parse(folded)).not.toThrow();
      expect(folded).toContain('"role":"tool"');
      const failed = f.adapter.processRunResult(
        { ...success, stdout: folded }, f.request, { harnessVersion: "2.3.2" });
      expect(failed.success).toBe(false);
      expect(failed.stderr).toContain("session.resume_hint");

      // The same stream with a reply after the blank line: the reply is
      // kept and the anchor is released — a real answer, not the anchor.
      // (The resume hint rides along so the wire-log usage resolves.)
      const answered = new KimiPlainFold();
      const reply = line({ role: "assistant", content: "Working" });
      answered.push(tool + "\n" + reply + line(kimiResumeHint()));
      expect((answered as unknown as { firstWireLine: string | null }).firstWireLine).toBeNull();
      const result = f.adapter.processRunResult(
        { ...success, stdout: answered.finish() }, f.request, { harnessVersion: "2.3.2" });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Working\n");
    } finally { f.cleanup(); }
  });

test("an unterminated record exactly at the bound passes; one byte more fails (round 12, edges 4)", () => {
  // The wire regime charged its re-emitted newline to a final record the
  // stream never terminated, so exactly MAX_CAPTURE_BYTES bytes failed
  // with the capture-limit exit while the whole-capture path accepted the
  // same bytes. The tail is re-emitted and charged without that newline
  // now — on both finish paths, the kept record and the anchor that
  // answers a tool-only wire.
  const sizedRecord = (template: string, total: number): string =>
    JSON.stringify({ ...JSON.parse(template), content: "x".repeat(total - JSON.stringify({ ...JSON.parse(template), content: "" }).length) });
  const exact = sizedRecord(line({ role: "assistant", content: "" }).trimEnd(), MAX_CAPTURE_BYTES);
  expect(Buffer.byteLength(exact)).toBe(MAX_CAPTURE_BYTES);
  const sink = new KimiPlainFold();
  sink.push(exact); // one chunk, no trailing newline
  const folded = sink.finish();
  expect(Buffer.byteLength(folded)).toBe(MAX_CAPTURE_BYTES);
  expect(folded.endsWith("\n")).toBe(false);
  expect(JSON.parse(folded).role).toBe("assistant");
  expect(sink.keptBytes()).toBe(MAX_CAPTURE_BYTES);

  // The anchor's symmetric case: a dropped tool record at exactly the
  // bound, also unterminated.
  const anchor = sizedRecord(line({ role: "tool", tool_call_id: "call_1", content: "" }).trimEnd(), MAX_CAPTURE_BYTES);
  expect(Buffer.byteLength(anchor)).toBe(MAX_CAPTURE_BYTES);
  const anchored = new KimiPlainFold();
  anchored.push(anchor);
  const anchorFolded = anchored.finish();
  expect(Buffer.byteLength(anchorFolded)).toBe(MAX_CAPTURE_BYTES);
  expect(anchorFolded.endsWith("\n")).toBe(false);

  const over = sizedRecord(line({ role: "assistant", content: "" }).trimEnd(), MAX_CAPTURE_BYTES + 1);
  const oversink = new KimiPlainFold();
  oversink.push(over);
  expect(oversink.keptBytes()).toBe(MAX_CAPTURE_BYTES + 1);
});

describe("an empty kimi stdout", () => {
  test("a zero-exit run that printed nothing is a failure, never a success without a reply (review round 46)", () => {
    const f = fixture();
    try {
      const result = f.adapter.processRunResult({ ...success, stdout: "" }, f.request, {} as RunContext);
      expect(result.success).toBe(false);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("kimi produced no output");
    } finally {
      f.cleanup();
    }
  });
});

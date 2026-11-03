import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { KimiAdapter } from "../src/adapters/kimi.js";
import type { RunRequest, RunResult } from "../src/types.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import { KIMI_STREAM_SESSION, kimiResumeHint as resumeHint } from "./fixtures/kimi-stream.js";

const success: RunResult = { stdout: "", stderr: "", exitCode: 0, success: true };
const stream = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const events = [
  { role: "meta", type: "system.version", version: "2.3.2" },
  { role: "assistant", content: "Working" },
  { role: "assistant", content: "A\nB\n\n" },
  resumeHint(),
];
const records = [
  { type: "usage.record", usageScope: "turn", usage: { inputOther: 10, output: 4, inputCacheRead: 20, inputCacheCreation: 2 } },
];

function fixture() {
  const scratch = join(import.meta.dir, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "kimi-plain-"));
  const brand = join(home, ".kimi-code");
  mkdirSync(brand);
  const adapter = new KimiAdapter({ HOME: home }, home);
  const request: RunRequest = { agent: "kimi", prompt: "hello", model: "test-model" };
  const path = join(brand, "sessions", "workspace", KIMI_STREAM_SESSION, "agents", "main", "wire.jsonl");
  const writeWire = (wire: unknown[]) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, stream(wire));
  };
  const plainResult = (stdout: string) =>
    adapter.processRunResult({ ...success, stdout }, request, { harnessVersion: "2.3.2" });
  return {
    home, adapter, request, path, writeWire, plainResult,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

describe("Kimi plain runs use the structured wire", () => {
  test("a plain run unwraps the reply and records the wire-log usage", () => {
    const f = fixture();
    try {
      f.writeWire(records);
      const result = f.plainResult(stream(events));
      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
      expect(result.stdout).toBe("Working\n\nA\nB\n");
      expect(result.usage).toEqual({
        input_tokens: 10, cached_input_tokens: 22, output_tokens: 4,
        total_tokens: 36, cost_usd: null,
      });
    } finally { f.cleanup(); }
  });

  test("stdout that never used the wire passes through verbatim with no usage", () => {
    const f = fixture();
    try {
      f.writeWire(records);
      // An older binary or wrapper that ignored --output-format: plain text,
      // including the 2.3.2 bullet spelling, is the hatch's.
      const bulleted = f.plainResult("• Working\n\n• A\n  B\n\n");
      expect(bulleted.stdout).toBe("Working\n\nA\nB\n");
      expect(bulleted.usage).toBeUndefined();
      expect(bulleted.exitCode).toBe(0);
      const unbuilt = f.plainResult("just text\n");
      expect(unbuilt.stdout).toBe("just text\n");
      expect(unbuilt.usage).toBeUndefined();
    } finally { f.cleanup(); }
  });

  test("a valid JSON value the wire never spells is a plain answer, not a wire failure (round 20, edges 3)", () => {
    const f = fixture();
    try {
      f.writeWire(records);
      // A binary that ignored --output-format can print a plain JSON
      // answer: a bare string, number, boolean, null, an array, or an
      // object with no recognized role. None of these is the stream-json
      // wire's grammar (an object with a recognized role or the error
      // event's type), so the hatch returns each verbatim instead of
      // failing the run as a broken wire.
      for (const stdout of ['"done"\n', "42\n", "true\n", "null\n", "[1,2]\n", "{}\n"]) {
        const result = f.plainResult(stdout);
        expect(result.success).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(stdout);
        expect(result.usage).toBeUndefined();
        expect(result.stderr).toBe("");
      }
      // A real wire line still parses as wire: the structured path answers
      // with the unwrapped reply, not the hatch's verbatim bytes.
      const wire = f.plainResult(stream(events));
      expect(wire.success).toBe(true);
      expect(wire.stdout).toBe("Working\n\nA\nB\n");
      expect(wire.usage!.total_tokens).toBe(36);
    } finally { f.cleanup(); }
  });

  test("wire-shaped stdout that is not the stream fails instead of passing through", () => {
    const f = fixture();
    try {
      // A line that parses with a recognized role but breaks the stream's
      // grammar still fails as a broken wire. (A `{`-shaped line that does
      // NOT parse alone — `{"role":"meta"\n` below — is one line of an
      // indented object, not a cut wire, and moved to the hatch with lane
      // C30, item 3.)
      for (const stdout of ['{"role":"assistant","content":[]}\n']) {
        const result = f.plainResult(stdout);
        expect(result.success).toBe(false);
        expect(result.stderr).not.toBe("");
        expect(result.stdout).toBe("");
      }
    } finally { f.cleanup(); }
  });

  test("a roleless JSON object on the first line is wire, as the parser's unknown event (round 33, edges 2)", () => {
    // kimi's forward-compatible events may carry no role; the fold must
    // not fall to plain mode and return the raw stream as the reply.
    const f = fixture();
    try {
      f.writeWire(records);
      const result = f.plainResult(stream([{ type: "system.future", version: "9.9.9" }, ...events]));
      expect(result.stderr).toBe("");
      expect(result.success).toBe(true);
      expect(result.stdout).toBe("Working\n\nA\nB\n");
    } finally { f.cleanup(); }
  });

  test("a pretty-printed JSON object over several lines returns as the plain reply (lane C30, item 3)", () => {
    const f = fixture();
    try {
      f.writeWire(records);
      // A binary that ignored --output-format and printed an indented
      // JSON object: no single line parses, so the old rule — any
      // `{`-shaped line is wire — failed the run as a broken wire. Each
      // line is now plain text and the hatch returns the object verbatim.
      const pretty = '{\n  "reply": "hello",\n  "lines": 2\n}\n';
      const result = f.plainResult(pretty);
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(pretty);
      expect(result.usage).toBeUndefined();
      expect(result.stderr).toBe("");
      // A single truncated object line is the same shape: not the wire.
      const cut = '{"role":"meta"\n';
      const cutResult = f.plainResult(cut);
      expect(cutResult.success).toBe(true);
      expect(cutResult.stdout).toBe(cut);
      expect(cutResult.usage).toBeUndefined();
      // The real stream-json fixture still unwraps: the first line parses
      // with a recognized role, so the wire path answers, not the hatch.
      const wire = f.plainResult(stream(events));
      expect(wire.success).toBe(true);
      expect(wire.stdout).toBe("Working\n\nA\nB\n");
      expect(wire.usage!.total_tokens).toBe(36);
    } finally { f.cleanup(); }
  });

  test("a failed structured plain run keeps the reply text and never prints the wire", () => {
    const f = fixture();
    try {
      f.writeWire(records);
      const result = f.plainResult(stream([...events, { type: "error", message: "synthetic failure" }]));
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("Working\n\nA\nB\n");
      expect(result.stderr).toContain("synthetic failure");
    } finally { f.cleanup(); }
  });
});

test("CLI plain run records wire-log usage in the ledger and prints the plain reply", async () => {
  const f = fixture();
  const cwd = join(f.home, "work");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const script = join(f.home, "fake-kimi.ts");
  const ledger = join(f.home, "calls.jsonl");
  writeFileSync(script, `import {mkdirSync,writeFileSync} from "node:fs";
import {dirname,join} from "node:path";
if (process.argv[2] === "--version") {console.log("2.3.2");process.exit(0);}
if (!process.argv.includes("stream-json")) process.exit(8);
const path = join(process.env.HOME,".kimi-code","sessions","workspace",${JSON.stringify(KIMI_STREAM_SESSION)},"agents","main","wire.jsonl");
mkdirSync(dirname(path),{recursive:true});writeFileSync(path,${JSON.stringify(stream(records))});
process.stdout.write(${JSON.stringify(stream(events))});`);
  const fake = createFakeBinaryEnv({ kimi: `exec bun '${script}' "$@"` });
  try {
    const result = await runCli(
      ["run", "-a", "kimi", "--no-sandbox", "--auto", "high", "--cwd", cwd, "-p", "hello"],
      { ...fake.env, HOME: f.home, CODEMUX_CALL_LOG: ledger }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Working\n\nA\nB\n");
    const lines = readFileSync(ledger, "utf8").split("\n").filter((line) => line.trim() !== "");
    const record = JSON.parse(lines.at(-1)!) as { agent: string; usage: { total_tokens: number } };
    expect(record.agent).toBe("kimi");
    expect(record.usage.total_tokens).toBe(36);
  } finally {
    fake.cleanup();
    f.cleanup();
    if (existsSync(ledger)) rmSync(ledger);
  }
});

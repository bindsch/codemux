// Verifier-level tests for the live gate: the probe F session-turn
// verifier, the probe G marker parser, the probe C envelope schema, and the
// probe H served-model evidence rule, each against its pure verifier and
// against fake harnesses; scripts/live-gate/probes.ts owns them.
import { afterAll, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ProbeRunner,
  SERVED_MODEL_EVIDENCE,
  parseOptions,
  prepareSessionProbe,
  probeApplies,
  runProbes,
  verifyExperimentEcho,
  verifyProviderOverrideEnvelope,
  verifyResultEnvelope,
  verifySessionTurn,
} from "../scripts/live-gate.js";
import { AGENT_IDS } from "../src/adapters/index.js";
import { SERVED_MODEL_EVIDENCE_HARNESSES } from "../src/result-envelope/index.js";
import type { AgentId } from "../src/types.js";
import * as registry from "../src/session/registry.js";
import { cleanupLoggedInHomes, factsFor, fixtureDirectory, loggedInEnv } from "./helpers/live-gate.js";

// runProbes reads the login state before the matrix (audit D8); the
// fixture home keeps that read off the operator's own stores.
afterAll(cleanupLoggedInHomes);
import { MARKER } from "./fixtures/experiment-mcp.js";

const sessionEvent = (type: string, fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ seq: 1, ts: "2026-11-01T00:00:00.000Z", session_id: "s", type, raw: null, ...fields });

test("probe F verification requires a completed turn and the nonce reply", () => {
  const session = prepareSessionProbe();
  // The completed turn, the assistant reply that carries the nonce, and
  // the orderly end the probe's shutdown frame produces.
  const ended = sessionEvent("session_ended", { reason: "shutdown", exit_code: 0 });
  expect(verifySessionTurn([
    sessionEvent("input_accepted", { input_seq: 1 }),
    sessionEvent("user_message", { input_seq: 1, text: `Reply with exactly: ${session.nonce}` }),
    sessionEvent("assistant_message", { text: session.nonce }),
    sessionEvent("turn_completed", { finish: "end" }),
    ended,
  ].join("\n"), session.nonce)).toBeNull();
  // Exit 0 with the user_message echo but no completed turn and no reply:
  // the old probe passed this shape.
  expect(verifySessionTurn([
    sessionEvent("input_accepted", { input_seq: 1 }),
    sessionEvent("user_message", { input_seq: 1, text: `Reply with exactly: ${session.nonce}` }),
  ].join("\n"), session.nonce)).toContain("without a completed turn");
  // A completed turn whose reply does not carry the nonce.
  expect(verifySessionTurn([
    sessionEvent("assistant_message", { text: "OK" }),
    sessionEvent("turn_completed", { finish: "end" }),
  ].join("\n"), session.nonce)).toContain("nonce");
  // A reply that merely contains the nonce is not the exact reply asked for (review round 56).
  expect(verifySessionTurn([
    sessionEvent("assistant_message", { text: `prefix ${session.nonce} suffix` }),
    sessionEvent("turn_completed", { finish: "end" }),
  ].join("\n"), session.nonce)).toContain("nonce");
  // The echo alone never satisfies the reply: the nonce rides the user
  // frame's own text.
  expect(verifySessionTurn([
    sessionEvent("user_message", { input_seq: 1, text: `Reply with exactly: ${session.nonce}` }),
    sessionEvent("turn_completed", { finish: "end" }),
  ].join("\n"), session.nonce)).toContain("nonce");
});

test("probe F rejects a failed turn and a completion from another turn", () => {
  // Review round 5, contracts-2 finding 1: finish "failed"/"interrupted"
  // is protocol-legal on a session that still exits 0, so the finish
  // value and the completing turn's identity decide, never the event's
  // presence alone.
  const session = prepareSessionProbe();
  const reply = (turnId: string | null): string =>
    sessionEvent("assistant_message", { text: session.nonce, ...(turnId === null ? {} : { turn_id: turnId }) });
  const completed = (finish: string, turnId: string | null): string =>
    sessionEvent("turn_completed", { finish, ...(turnId === null ? {} : { turn_id: turnId }) });
  // The nonce echoed, but the turn failed.
  expect(verifySessionTurn([reply("t1"), completed("failed", "t1")].join("\n"), session.nonce))
    .toContain("finish 'failed'");
  expect(verifySessionTurn([reply("t1"), completed("interrupted", "t1")].join("\n"), session.nonce))
    .toContain("finish 'interrupted'");
  // A turn_completed with no finish field fails closed the same way.
  expect(verifySessionTurn(
    [reply("t1"), sessionEvent("turn_completed", { turn_id: "t1" })].join("\n"),
    session.nonce
  )).toContain("not 'end'");
  // The nonce's own turn ending well is the one passing shape.
  const ended = sessionEvent("session_ended", { reason: "shutdown", exit_code: 0 });
  expect(verifySessionTurn([reply("t1"), completed("end", "t1"), ended].join("\n"), session.nonce)).toBeNull();
  // Without a turn_id on the reply, the next completion pairs by order.
  expect(verifySessionTurn([reply(null), completed("end", "t1"), ended].join("\n"), session.nonce)).toBeNull();
  // The nonce rode one turn; another turn's end never completes it.
  expect(verifySessionTurn([reply("t1"), completed("end", "t2")].join("\n"), session.nonce))
    .toContain("the turn that carried the nonce reply never completed");
  // A failed turn pairing by order fails too.
  expect(verifySessionTurn([reply(null), completed("failed", null)].join("\n"), session.nonce))
    .toContain("finish 'failed'");
});

test("probe F requires an orderly session_ended after the completed turn", () => {
  // Finding 1: the probe's exchange ends the session with one shutdown
  // frame, so the documented end state is session_ended with reason
  // "shutdown" and exit code 0 (docs/sessions.md, "End conditions and
  // failures"). The live gate's own evidence showed the shapes that are
  // not it: codex ended `stdin-close` — the old probe closed stdin before
  // the turn ran — and kimi's drain grace expired mid-turn and the child
  // stopped by signal.
  const session = prepareSessionProbe();
  const turn = [
    sessionEvent("assistant_message", { text: session.nonce }),
    sessionEvent("turn_completed", { finish: "end" }),
  ].join("\n");
  expect(verifySessionTurn(turn, session.nonce)).toContain("without a session_ended event");
  for (const reason of ["stdin-close", "signal", "crash", "harness_failed"] as const) {
    expect(verifySessionTurn([turn, sessionEvent("session_ended", { reason, exit_code: 0 })].join("\n"), session.nonce))
      .toContain(`reason is "${reason}", not 'shutdown'`);
  }
  expect(verifySessionTurn([turn, sessionEvent("session_ended", { reason: "shutdown", exit_code: 1 })].join("\n"), session.nonce))
    .toContain("exit_code is 1, not 0");
  // An event with neither field fails closed the same way.
  expect(verifySessionTurn([turn, sessionEvent("session_ended")].join("\n"), session.nonce))
    .toContain("reason is absent, not 'shutdown'");
  expect(verifySessionTurn([turn, sessionEvent("session_ended", { reason: "shutdown" })].join("\n"), session.nonce))
    .toContain("exit_code is absent, not 0");
  // The orderly end is the one passing shape.
  expect(verifySessionTurn([turn, sessionEvent("session_ended", { reason: "shutdown", exit_code: 0 })].join("\n"), session.nonce)).toBeNull();
});

const usageBlock = { input_tokens: 1, output_tokens: 2, cached_input_tokens: null, total_tokens: 3, cost_usd: null };
// Codex's envelope spells the answer `result` (src/result-envelope/codex.ts).
const envelope = (servedModel: string | null, agent: "codex" | "claude" = "codex"): string =>
  `${JSON.stringify({ result: "OK\n", codemux: { agent, model: servedModel, served_model: servedModel,
    labels: null, usage: usageBlock, session_id: null, recording: null, failure_code: null } })}\n`;
// Probe G's recording fixtures: one probe directory's worth of JSONL per
// harness, shaped as that harness's own run records it (finding 2 — the
// recording is the delivery proof, so the verifier reads it, and every
// reply-passing case needs one to read).
const CODEX_HEADER = "Wall time: 0.1234 seconds\nOutput:";
const KIMI_HEADER = "Wall time: 0.123 seconds\n";
const recording = (result: object, comparison: object): string =>
  `${JSON.stringify({ run_id: "r", seq: 0, t: 1, ...result })}\n${JSON.stringify({ run_id: "r", seq: 1, t: 2, ...comparison })}\n`;
const codexDelivered = (output: unknown): string => recording(
  { kind: "model_tool_result", call_id: "call_1", output, item: {} },
  { kind: "result_comparison", call_id: "call_1", relay_index: 0, equal: true, harness_prefix: "codex-wall-time", header: CODEX_HEADER },
);
const kimiDelivered = (content: unknown): string => recording(
  { kind: "model_tool_result", call_id: "tool_1", content, output: content, wire_content: [], item: {} },
  { kind: "result_comparison", call_id: "tool_1", relay_index: 0, equal: true, harness_prefix: "kimi-wall-time", header: KIMI_HEADER },
);
const claudeDelivered = (content: unknown): string => recording(
  { kind: "model_tool_result", tool_use_id: "t1", block: { type: "tool_result", content } },
  { kind: "result_comparison", tool_use_id: "t1", equal: true },
);
const codexGood = codexDelivered([{ type: "input_text", text: CODEX_HEADER }, { type: "input_text", text: MARKER }]);
const kimiGood = kimiDelivered([{ type: "text", text: `${KIMI_HEADER}${MARKER}` }]);
const claudeGood = claudeDelivered(MARKER);
const gateDirectory = (recordingText?: string): string => {
  const directory = fixtureDirectory();
  if (recordingText !== undefined) writeFileSync(join(directory, `${randomUUID()}.jsonl`), recordingText);
  return directory;
};

test("probe G's reply rule accepts the bare marker and the harness's own header echo", () => {
  // Finding 2: both live-gate replies arrived as the bare marker — models
  // drop the wall-time header codemux prepends — so the bare marker passes
  // for every experiment harness and the header rule stays only for a
  // harness that echoed its own header. The headers still differ by
  // harness (round 15, blocker): codex spells `Wall time: N.NNNN
  // seconds\nOutput:` (four decimals), kimi `Wall time: N.NNN seconds\n`
  // (three decimals, no Output: line).
  const codexDirectory = gateDirectory(codexGood);
  const kimiDirectory = gateDirectory(kimiGood);
  const claudeDirectory = gateDirectory(claudeGood);
  const zaiDirectory = gateDirectory(claudeGood);
  const directories = [codexDirectory, kimiDirectory, claudeDirectory, zaiDirectory];
  try {
    // Codex: bare marker and its own header echo pass, in either recorded
    // form (items, or one header-prefixed string); the marker glued
    // straight after `Output:` (round 18, edges 6) and kimi's header
    // shape fail.
    expect(verifyExperimentEcho(MARKER, MARKER, "codex", codexDirectory)).toBeNull();
    expect(verifyExperimentEcho(`${CODEX_HEADER}\n${MARKER}`, MARKER, "codex", codexDirectory)).toBeNull();
    expect(verifyExperimentEcho(`${CODEX_HEADER}${MARKER}`, MARKER, "codex", codexDirectory))
      .toContain("neither the bare marker");
    expect(verifyExperimentEcho(`${KIMI_HEADER}${MARKER}`, MARKER, "codex", codexDirectory))
      .toContain("neither the bare marker");
    // Kimi: bare marker and its own glued header pass; a doubled newline
    // and codex's four-decimal Output: shape fail, and a wrong marker
    // after a valid header still fails.
    expect(verifyExperimentEcho(MARKER, MARKER, "kimi", kimiDirectory)).toBeNull();
    expect(verifyExperimentEcho(`${KIMI_HEADER}${MARKER}`, MARKER, "kimi", kimiDirectory)).toBeNull();
    expect(verifyExperimentEcho(`${KIMI_HEADER}\n${MARKER}`, MARKER, "kimi", kimiDirectory))
      .toContain("neither the bare marker");
    expect(verifyExperimentEcho(`${CODEX_HEADER}\n${MARKER}`, MARKER, "kimi", kimiDirectory))
      .toContain("neither the bare marker");
    expect(verifyExperimentEcho(`${KIMI_HEADER}WRONG-MARKER`, MARKER, "kimi", kimiDirectory))
      .toContain("neither the bare marker");
    // Claude and zai carry no header on their wires: the bare marker is
    // their one compliant reply, with or without the trailing newline.
    expect(verifyExperimentEcho(MARKER, MARKER, "claude", claudeDirectory)).toBeNull();
    expect(verifyExperimentEcho(`${MARKER}\n`, MARKER, "zai", zaiDirectory)).toBeNull();
    expect(verifyExperimentEcho(`${CODEX_HEADER}\n${MARKER}`, MARKER, "claude", claudeDirectory))
      .toContain("not the bare marker");
    expect(verifyExperimentEcho("WRONG-MARKER", MARKER, "zai", zaiDirectory)).toContain("not the bare marker");
  } finally {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  }
});

test("probe G proves delivery from the recording, and fails without it (finding 2)", () => {
  // The model_tool_result record holds the result as delivered to the
  // model — the header first for codex and kimi, the bare marker for
  // claude and zai — and the reply can never prove the header, because
  // models drop it when they echo. A missing, unreadable, or unparseable
  // recording fails the probe naming the path: without it, nothing shows
  // what the model was given.
  const cases: { label: string; agent: AgentId; recording?: string; reply: string; failure: string }[] = [
    { label: "codex delivered as one header-prefixed string", agent: "codex", recording: codexDelivered(`${CODEX_HEADER}\n${MARKER}`), reply: MARKER, failure: "" },
    { label: "codex delivered without the header", agent: "codex", recording: codexDelivered([{ type: "input_text", text: MARKER }]), reply: MARKER, failure: "no valid codex wall-time header" },
    { label: "kimi delivered without the header", agent: "kimi", recording: kimiDelivered([{ type: "text", text: MARKER }]), reply: MARKER, failure: "no valid kimi wall-time header" },
    { label: "codex header with a changed marker after it", agent: "codex", recording: codexDelivered([{ type: "input_text", text: CODEX_HEADER }, { type: "input_text", text: "WRONG" }]), reply: MARKER, failure: "carries the codex header but not the marker after it" },
    { label: "claude delivered text is not the bare marker", agent: "claude", recording: claudeDelivered("WRONG"), reply: MARKER, failure: "is not the bare marker" },
    { label: "a reply without the marker", agent: "codex", recording: codexGood, reply: "WRONG-MARKER", failure: "neither the bare marker" },
    { label: "no recording at all", agent: "claude", reply: MARKER, failure: "holds no experiment recording" },
    { label: "a comparison that found the result changed", agent: "claude", recording: recording(
      { kind: "model_tool_result", tool_use_id: "t1", block: { type: "tool_result", content: MARKER } },
      { kind: "result_comparison", tool_use_id: "t1", equal: false },
    ), reply: MARKER, failure: "not equal: true" },
    { label: "a comparison that never ran", agent: "claude", recording: `${JSON.stringify({ kind: "model_tool_result", tool_use_id: "t1", block: { type: "tool_result", content: MARKER } })}\n`, reply: MARKER, failure: "0 result_comparison records" },
    { label: "a recording that does not parse", agent: "claude", recording: "not json\n", reply: MARKER, failure: "does not parse (line 1)" },
    { label: "two recordings in one probe directory", agent: "claude", reply: MARKER, failure: "holds 2 experiment recordings" },
    // The harness log copy codemux writes beside the recording
    // (`<id>.codex-rollout.jsonl`, src/experiment-harness-log.ts) is not a
    // second recording; the 2026-11-02 codex G rerun was failed for it.
    { label: "a harness log copy beside the recording", agent: "codex", recording: codexGood, reply: MARKER, failure: "" },
  ];
  for (const one of cases) {
    const directory = one.label === "two recordings in one probe directory"
      ? gateDirectory(claudeGood)
      : gateDirectory(one.recording);
    try {
      if (one.label === "two recordings in one probe directory") {
        writeFileSync(join(directory, `${randomUUID()}.jsonl`), claudeGood);
      }
      if (one.label === "a harness log copy beside the recording") {
        writeFileSync(join(directory, `${randomUUID()}.codex-rollout.jsonl`), "{}\n");
      }
      const failure = verifyExperimentEcho(one.reply, MARKER, one.agent, directory);
      if (one.failure === "") {
        expect(failure).toBeNull();
      } else {
        expect(failure).toContain(one.failure);
        // A missing recording names the path it looked for.
        if (one.label === "no recording at all") expect(failure).toContain(directory);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  // A directory that cannot be read at all fails the same way, naming it.
  const absent = join(fixtureDirectory(), "absent");
  try {
    expect(verifyExperimentEcho(MARKER, MARKER, "claude", absent)).toContain("could not read the probe directory");
    expect(verifyExperimentEcho(MARKER, MARKER, "claude", absent)).toContain(absent);
  } finally {
    rmSync(dirname(absent), { recursive: true, force: true });
  }
});

test("probe C's envelope check requires the documented schema for the probed agent", () => {
  // Review round 14, edges 5: any JSON with a nonempty codemux.agent
  // used to pass, so a cross-wired envelope builder could pass the gate.
  // Round 16, edges 3: the answer field is the probed harness's own
  // spelling, never either-or.
  const block = { agent: "claude", model: null, served_model: null, labels: null,
    usage: usageBlock, session_id: null, recording: null, failure_code: null };
  expect(verifyResultEnvelope(`${JSON.stringify({ result: "OK\n", codemux: block })}\n`, "claude")).toBeNull();
  expect(verifyResultEnvelope(`${JSON.stringify({ codemux: block })}\n`, "claude"))
    .toContain("carries no 'result' text");
  // The other family's spelling never substitutes: a claude envelope that
  // answers in `reply` is cross-wired, and so is a kimi envelope that
  // answers in `result` (kimi and opencode spell the answer `reply`).
  expect(verifyResultEnvelope(`${JSON.stringify({ reply: "OK\n", codemux: block })}\n`, "claude"))
    .toContain("carries no 'result' text");
  const kimiBlock = { ...block, agent: "kimi" };
  expect(verifyResultEnvelope(`${JSON.stringify({ reply: "OK\n", codemux: kimiBlock })}\n`, "kimi")).toBeNull();
  expect(verifyResultEnvelope(`${JSON.stringify({ result: "OK\n", codemux: kimiBlock })}\n`, "kimi"))
    .toContain("carries no 'reply' text");
  expect(verifyResultEnvelope(`${JSON.stringify({ result: "OK\n", codemux: { ...block, agent: "opencode" } })}\n`, "claude"))
    .toContain('not the probed claude');
  expect(verifyResultEnvelope(`${JSON.stringify({ result: "OK\n", codemux: { ...block, usage: {} } })}\n`, "claude"))
    .toContain("codemux.usage is missing the documented key 'input_tokens'");
  const { failure_code: _dropped, ...withoutKey } = block;
  expect(verifyResultEnvelope(`${JSON.stringify({ result: "OK\n", codemux: withoutKey })}\n`, "claude"))
    .toContain("missing the documented key 'failure_code'");
});

test("probe C fails a present key with an undocumented type, naming the field (round 16, edges 4)", () => {
  // Key presence alone certified malformed envelopes: an object `model`, a
  // string `labels`, or a string token count passed the gate.
  const block = { agent: "claude", model: null, served_model: null, labels: null,
    usage: usageBlock, session_id: null, recording: null, failure_code: null };
  expect(verifyResultEnvelope(`${JSON.stringify({ result: "OK\n", codemux: { ...block, model: {} } })}\n`, "claude"))
    .toContain("codemux.model must be a string or null, not object");
  expect(verifyResultEnvelope(`${JSON.stringify({ result: "OK\n", codemux: { ...block, served_model: 5 } })}\n`, "claude"))
    .toContain("codemux.served_model must be a string or null, not number");
  expect(verifyResultEnvelope(`${JSON.stringify({ result: "OK\n", codemux: { ...block, labels: "x" } })}\n`, "claude"))
    .toContain("codemux.labels must be an object of strings or null");
  expect(verifyResultEnvelope(`${JSON.stringify({ result: "OK\n", codemux: { ...block, labels: { team: 7 } } })}\n`, "claude"))
    .toContain("codemux.labels must be an object of strings or null");
  expect(verifyResultEnvelope(`${JSON.stringify({ result: "OK\n", codemux: { ...block, usage: { ...usageBlock, input_tokens: "12" } } })}\n`, "claude"))
    .toContain("codemux.usage.input_tokens must be a non-negative integer or null");
  expect(verifyResultEnvelope(`${JSON.stringify({ result: "OK\n", codemux: { ...block, usage: { ...usageBlock, cost_usd: -1 } } })}\n`, "claude"))
    .toContain("codemux.usage.cost_usd must be a non-negative number or null");
});

test("probe C requires the requested OK answer, not merely a string (round 18, edges 5)", () => {
  // The prompt asks the harness to reply with exactly OK (run.ts). A
  // well-formed envelope whose answer says something else — the harness
  // answered a different question, or refused and answered in prose —
  // passed the gate when the check stopped at "the field is a string".
  const block = { agent: "claude", model: null, served_model: null, labels: null,
    usage: usageBlock, session_id: null, recording: null, failure_code: null };
  // The compliant reply passes, padded the way the run probes accept it.
  expect(verifyResultEnvelope(`${JSON.stringify({ result: "  OK \n", codemux: block })}\n`, "claude")).toBeNull();
  // Every other string fails, naming the answer field.
  expect(verifyResultEnvelope(`${JSON.stringify({ result: "Sure, I can do that.", codemux: block })}\n`, "claude"))
    .toContain("result' is not the requested OK reply");
  expect(verifyResultEnvelope(`${JSON.stringify({ result: "OK?", codemux: block })}\n`, "claude"))
    .toContain("result' is not the requested OK reply");
  expect(verifyResultEnvelope(`${JSON.stringify({ result: "", codemux: block })}\n`, "claude"))
    .toContain("result' is not the requested OK reply");
});

test("probe H runs exactly on the harnesses whose envelopes carry served-model evidence", () => {
  // The SERVED_MODEL_EVIDENCE set is derived from the envelope builders'
  // own table (SERVED_MODEL_EVIDENCE_HARNESSES,
  // src/result-envelope/index.ts — round 20, minor 13), and the hard-coded
  // membership catches a wrong edit there: claude and zai read modelUsage,
  // codex reads its reroute; opencode's pinned run wire and kimi's
  // stream-json and wire log expose no served-model field, so their rows
  // print UNSUPPORTED (review round 14, edges 2).
  expect(SERVED_MODEL_EVIDENCE).toBe(SERVED_MODEL_EVIDENCE_HARNESSES);
  // Codex reports a served model only in a reroute notice, so it carries no
  // evidence an override probe can assert on (round 26, edges 2).
  expect([...SERVED_MODEL_EVIDENCE].sort()).toEqual(["claude", "zai"]);
  for (const id of AGENT_IDS) {
    const facts = factsFor(id);
    expect(probeApplies("H", facts)).toBe(facts.providerOverride && facts.resultJson && SERVED_MODEL_EVIDENCE.has(id));
  }
});

test("probe H verification requires the envelope to show the override's served model", () => {
  expect(verifyProviderOverrideEnvelope(envelope("glm-5.3"), "glm-5.3", "codex")).toBeNull();
  // A harness that ignored the override and answered from the default
  // login: the generic OK reply carries no override evidence. `model`
  // alone no longer proves anything (review round 14, edges 2): codemux
  // writes its own selection there, so the provider-reported
  // served_model decides.
  expect(verifyProviderOverrideEnvelope(envelope(null), "glm-5.3", "codex")).toContain("no codemux.served_model");
  expect(verifyProviderOverrideEnvelope(envelope("gpt-6-default"), "glm-5.3", "codex")).toContain(`not the override's "glm-5.3"`);
  expect(verifyProviderOverrideEnvelope("OK\n", "glm-5.3", "codex")).toContain("does not parse");
});

test.each([
  ["a session that completes the turn and ends on the shutdown frame", "good", null],
  ["a session whose turn never completes", "never", "without a completed turn"],
])("probe F against a fake session harness: %s", async (_label, mode, failure) => {
  const reportDirectory = fixtureDirectory();
  const fake = join(reportDirectory, "fake-codemux");
  // The fake reads its stdin frame by frame, the way a session driver
  // does — the old fake read all of stdin at once, which only worked
  // because the old probe closed stdin immediately. The mid-turn sleep
  // makes the exchange observable: a probe that closes stdin before the
  // turn ran leaves the fake's second read at EOF, its session_ended
  // says `stdin-close`, and the verifier fails the probe.
  writeFileSync(fake, `#!${process.execPath}
    const reader = Bun.stdin.stream().getReader();
    const decoder = new TextDecoder();
    let pending = "";
    const readFrame = async () => {
      for (;;) {
        const newline = pending.indexOf("\\n");
        if (newline !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          return JSON.parse(line);
        }
        const { value, done } = await reader.read();
        if (done) return { type: "stdin-eof" };
        pending += decoder.decode(value, { stream: true });
      }
    };
    const event = (type, fields = {}) => console.log(JSON.stringify({ seq: 1, ts: "2026-11-01T00:00:00.000Z", session_id: "s", type, raw: null, ...fields }));
    const first = await readFrame();
    event("session_started", {});
    event("input_accepted", { input_seq: 1 });
    if (${JSON.stringify(mode === "good")}) {
      await Bun.sleep(400);
      event("assistant_message", { text: first.text.split(": ")[1] });
      event("turn_completed", { finish: "end" });
      const second = await readFrame();
      event("session_ended", { reason: second.type === "shutdown" ? "shutdown" : "stdin-close", exit_code: 0 });
      process.exit(0);
    }
    await Bun.sleep(300);
    process.exit(0);
  `, { mode: 0o700 });
  // Probe F ends with the live-session leak check, which reads the
  // operator's real registry when left alone. Round 16 (contracts-2 1)
  // made an unreadable registry a failure instead of a silent pass, so
  // this test pins its own — absent here, which the check reads as
  // nothing to check — and stays independent of the machine it runs on.
  const registryMock = spyOn(registry, "sessionRegistryPath")
    .mockReturnValue(join(reportDirectory, "live-sessions.json"));
  try {
    const rows = await runProbes([factsFor("codex")], parseOptions(["--probe", "F", "--codemux", fake, "--timeout", "10"], ""),
      new ProbeRunner(), reportDirectory, loggedInEnv().env);
    if (failure === null) {
      expect(rows[0]!.results.F).toMatchObject({ status: "PASS" });
    } else {
      expect(rows[0]!.results.F).toMatchObject({ status: "FAIL" });
      expect(rows[0]!.results.F!.stderr).toContain(failure);
      // A turn that never completed also left the exchange's last frame
      // unwritten: the probe ended with the child, never by hanging.
      expect(rows[0]!.results.F!.stderr).not.toContain("timeout");
    }
  } finally {
    registryMock.mockRestore();
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("probe H fails a fake harness that ignores the override", async () => {
  const reportDirectory = fixtureDirectory();
  const fake = join(reportDirectory, "fake-codemux");
  // The fake answers a well-formed envelope whose served_model is null —
  // exactly a harness that printed OK from its default credentials and
  // never read the override environment.
  // claude carries served-model evidence (codex does not since round 26).
  writeFileSync(fake, `#!/bin/sh
    printf '%s\\n' '${envelope(null, "claude").trim()}'
  `, { mode: 0o700 });
  try {
    const rows = await runProbes([factsFor("claude")],
      parseOptions(["--probe", "H", "--codemux", fake, "--timeout", "10"], ""),
      new ProbeRunner(), reportDirectory,
      loggedInEnv({
        LIVE_GATE_PROVIDER_OVERRIDE: "1",
        CODEMUX_CLAUDE_PROVIDER_BASE_URL: "http://127.0.0.1:8011/v1",
        CODEMUX_CLAUDE_PROVIDER_API_KEY: "sk-test",
        CODEMUX_CLAUDE_PROVIDER_MODEL: "glm-5.3",
      }).env);
    expect(rows[0]!.results.H).toMatchObject({ status: "FAIL" });
    expect(rows[0]!.results.H!.stderr).toContain("no codemux.served_model");
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("probe F refuses any event after session_ended (round 26, edges 4)", () => {
  const nonce = "0123456789ab";
  const lines = [
    { type: "assistant_message", text: `${nonce}`, turn_id: "t1" },
    { type: "turn_completed", turn_id: "t1", finish: "end" },
    { type: "session_ended", reason: "shutdown", exit_code: 0 },
  ];
  const good = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  expect(verifySessionTurn(good, nonce)).toBeNull();
  const late = good + JSON.stringify({ type: "turn_completed", turn_id: "t2", finish: "end" }) + "\n";
  expect(verifySessionTurn(late, nonce)).toContain("followed session_ended");
  // A line that is not even JSON after the end is the same violation (round 32, edges 1).
  expect(verifySessionTurn(good + "not-json\n", nonce)).toContain("followed session_ended");
  // A banner or corrupt line anywhere is a protocol violation too (round 34, edges 5).
  expect(verifySessionTurn("codemux banner\n" + good, nonce)).toContain("is not a JSON event");
});


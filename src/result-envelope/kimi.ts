import { join } from "node:path";
import type { RunContext } from "../run-context.js";
import type { CodemuxResultBlock, RunRequest, RunResult } from "../types.js";
import { findKimiWireLog, kimiWireUsage, MAX_KIMI_WIRE_BYTES, readBoundedKimiFile } from "../kimi-wire-log.js";
import { appendDiagnostic, emptyUsage, envelopeBoundLine } from "./common.js";
import { experimentFailure, type ExperimentFailure } from "../experiment-records.js";
import { MAX_CAPTURE_BYTES, OUTPUT_LIMIT_EXIT_CODE } from "../process-runner.js";
import { kimiWireShapedLine, parseKimiStreamLine } from "../session/kimi-session.js";

function parseEvents(stdout: string): { events: Record<string, unknown>[]; error?: string } {
  const events: Record<string, unknown>[] = [];
  let knownSessionId: string | null = null;
  const lines = stdout.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const event: unknown = JSON.parse(line);
      if (event === null || typeof event !== "object" || Array.isArray(event)) {
        throw new Error("kimi stream-json line is not an event object");
      }
      const record = event as Record<string, unknown>;
      // The one wire-shape rule the fold's regime decision and the session
      // parser share (kimiWireShapedLine): a typed roleless event is a
      // forward-compatible `unknown` line, not a broken wire (round 33).
      if (!kimiWireShapedLine(line)) {
        throw new Error("kimi stream-json line has no recognized role or type");
      }
      const parsed = parseKimiStreamLine(line, { knownSessionId });
      if (parsed.kind === "grammar_error") throw new Error(parsed.message);
      if (parsed.kind === "resume_hint") knownSessionId = parsed.sessionId;
      events.push(record);
    } catch (error) {
      return { events, error: `kimi stream-json line ${index + 1}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { events };
}

function capturedEvents(stdout: string): ReturnType<typeof parseEvents> {
  try {
    const envelope = JSON.parse(stdout);
    if (envelope?.codemux?.agent === "kimi" && Array.isArray(envelope.events)) {
      const parsed = parseEvents(envelope.events.map((event: unknown) => JSON.stringify(event)).join("\n"));
      // The events array carries no original line positions, so a parse
      // error here counts the reconstructed stream, not the capture; the
      // diagnostic says so instead of citing a line the capture never had
      // (round 381).
      return parsed.error === undefined
        ? parsed
        : { ...parsed, error: `${parsed.error} (line numbers count the reconstructed stream, not the original capture)` };
    }
  } catch { /* A native capture contains several JSON lines. */ }
  return parseEvents(stdout);
}

const TRUNCATION_NOTE = "\n[truncated by codemux]";

/** Bound a serialized experiment envelope the way the Codex experiment
 * envelope does: the events copy goes first, then the reply is truncated
 * to whatever still fits MAX_CAPTURE_BYTES after JSON escaping (review
 * round 100 — the reply rode in the envelope twice, once as `reply` and
 * once inside `events`, with no bound after serialization). */
function boundedKimiEnvelope(envelope: Record<string, unknown>): {
  stdout: string;
  truncated: boolean;
} {
  const serialize = () => JSON.stringify(envelope) + "\n";
  let stdout = serialize();
  if (Buffer.byteLength(stdout) <= MAX_CAPTURE_BYTES) return { stdout, truncated: false };
  delete envelope.events;
  stdout = serialize();
  if (Buffer.byteLength(stdout) <= MAX_CAPTURE_BYTES) return { stdout, truncated: true };
  const original = envelope[KIMI_ANSWER_FIELD];
  const text = typeof original === "string" ? original : "";
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    envelope[KIMI_ANSWER_FIELD] = text.slice(0, middle) + TRUNCATION_NOTE;
    if (Buffer.byteLength(serialize()) <= MAX_CAPTURE_BYTES) low = middle;
    else high = middle - 1;
  }
  // Avoid cutting a UTF-16 surrogate pair in the retained reply.
  if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1]!)) low--;
  envelope[KIMI_ANSWER_FIELD] = text.slice(0, low) + TRUNCATION_NOTE;
  stdout = serialize();
  // Oversized metadata (caller labels, a long model name) can keep the
  // envelope past the bound with no reply left to cut. The emergency
  // envelope keeps every documented key with nulls where the metadata is
  // dropped, as the Codex experiment envelope does (review round 102).
  if (Buffer.byteLength(stdout) > MAX_CAPTURE_BYTES) {
    const block = envelope.codemux as CodemuxResultBlock;
    stdout = JSON.stringify({ [KIMI_ANSWER_FIELD]: null, session_id: null,
      codemux: { agent: "kimi", model: null, served_model: null, labels: null, usage: emptyUsage(),
        session_id: null, recording: null, failure_code: block.failure_code } }) + "\n";
  }
  return { stdout, truncated: true };
}

/** Stream text matches the plain printer after its bullet blocks are removed. */
/** The field kimi's --result-json envelope spells its answer text with.
 * The release gate's probe C verifies this exact field per agent, so the
 * builder and the gate share one name (review round 16, edges 3). */
export const KIMI_ANSWER_FIELD = "reply";

export function kimiResult(result: RunResult, request: RunRequest, brandHome: string, context?: RunContext,
  failure?: ExperimentFailure): RunResult {
  const captured = capturedEvents(result.stdout);
  const events = captured.events;
  let sessionId: string | null = null;
  let text = "";
  let usage = result.usage ?? context?.experimentKimi?.foldedUsage() ?? emptyUsage();
  let wireSurface = "";
  let outputFailure: string | null = captured.error ?? null;
  const reply = events.filter((event) => event.role === "assistant" && typeof event.content === "string" && event.content.length)
    .map((event) => (event.content as string).replace(/\r\n/g, "\n").replace(/\n+$/, ""))
    .join("\n\n");
  text = reply ? `${reply}\n` : "";
  // The provider's own error event outranks every failure derived below,
  // and it must be read before the hint requirement throws (round 259): a
  // failed provider run prints its error and never reaches the resume
  // hint, so the hint's absence is that failure's consequence, and
  // reporting it instead hid the error that explains the run.
  const errorEvents = events.filter((event) => event.type === "error");
  if (errorEvents.length > 0) {
    outputFailure ??= `kimi reported an error event: ${JSON.stringify(errorEvents[0])}`;
  }
  try {
    const hints = events.filter((event) => event.role === "meta" && event.type === "session.resume_hint");
    const nativeSession = hints.at(-1)?.session_id;
    sessionId = typeof nativeSession === "string" && nativeSession ? nativeSession : null;
    if (sessionId === null) {
      throw new Error(`kimi stream-json has no session.resume_hint session id; cannot read ${join(brandHome, "sessions", "*", "session_<id>", "agents", "main", "wire.jsonl")}`);
    }
    if (hints.some((hint) => hint.session_id !== sessionId)) throw new Error("kimi stream-json contains conflicting session ids");
    const path = context?.experimentKimi?.evidence.wireLogPath ?? findKimiWireLog(brandHome, sessionId);
    if (context) context.kimiWireLogPath = path;
    usage = kimiWireUsage(path);
    if (request.experimentMcp) wireSurface = readBoundedKimiFile(path, MAX_KIMI_WIRE_BYTES);
    outputFailure ??= !reply.trim() ? "kimi printed no assistant reply in stream-json" : null;
  } catch (error) {
    outputFailure ??= error instanceof Error ? error.message : String(error);
  }
  if (request.experimentMcp) {
    failure ??= context?.experimentKimi?.relay.failureError ?? undefined;
    if (outputFailure) {
      failure ??= experimentFailure(new Error(outputFailure));
      context?.experimentKimi?.relay.fail(failure);
    }
  }
  const block: CodemuxResultBlock = {
    agent: "kimi", labels: request.labels ?? null, model: request.model ?? null,
    model_alias: request.modelAlias ?? null,
    // No provider-reported evidence exists: the pinned stream-json lines
    // (assistant, tool, meta resume hints) and the wire log's records
    // (loop events, agent.message.appended, usage.record) carry no model
    // field, so `model` above is codemux's own selection.
    served_model: null,
    usage, session_id: null, recording: context?.experimentRecording ?? null,
    failure_code: failure?.code ?? context?.experimentKimi?.relay.failureCode ?? null,
  };
  const diagnostic = failure ? `experiment failure [${failure.code}]: ${outputFailure ?? failure.message}` : outputFailure;
  const envelope: Record<string, unknown> = { [KIMI_ANSWER_FIELD]: text, events, session_id: sessionId, codemux: block };
  const experimentFields = request.experimentMcp
    // Every channel boundary carries a newline (the adapter's rule for
    // stdout/stderr/fold evidence; round 361): bytes at a boundary must
    // not fuse into the canary marker, on the wire surface too.
    ? { reply: text, scanSurface: `${result.scanSurface ?? `${result.stdout}\n${result.stderr}`}\n${wireSurface}` }
    : {};
  const failureFields: { success: false; exitCode: number; stderr?: string } | {} = failure || outputFailure
    ? { success: false as const, exitCode: result.exitCode || 1,
      ...(diagnostic ? { stderr: appendDiagnostic(result.stderr, `codemux: ${diagnostic}`) } : {}) }
    : {};
  if (request.experimentMcp) {
    // The experiment rule: bound the serialized envelope by dropping the
    // events copy, then truncating the reply, and say so on stderr.
    const { stdout, truncated } = boundedKimiEnvelope(envelope);
    return { ...result, stdout, usage, servedModel: null, ...experimentFields, ...failureFields,
      ...(truncated ? { stderr: appendDiagnostic("stderr" in failureFields ? failureFields.stderr ?? "" : result.stderr,
        "codemux: result truncated to the 16 MiB capture limit") } : {}) };
  }
  const serialized = JSON.stringify(envelope) + "\n";
  // The plain rule (opencode's), for the run whose stdout IS this envelope:
  // a caller must never read a success it cannot hold, so an envelope past
  // the capture bound fails the run with the reply dropped and the bound
  // named on stderr. A plain non-envelope run never serializes for output
  // (kimiPlainResult keeps only the reply), so it is not refused here.
  if (request.resultJson && Buffer.byteLength(serialized) > MAX_CAPTURE_BYTES) {
    // The refusal keeps the failure fields an earlier diagnosis already
    // set (a parse error, a missing reply) and appends the bound notice
    // beside them, the way every other agent's bound refusal does
    // (common.ts; review round 341 — the diagnostic used to vanish
    // behind the output-limit exit).
    const base = "stderr" in failureFields ? failureFields.stderr ?? "" : result.stderr;
    return { ...result, ...failureFields, success: false, exitCode: OUTPUT_LIMIT_EXIT_CODE,
      usage, servedModel: null, stdout: "",
      stderr: appendDiagnostic(base, envelopeBoundLine("kimi")) };
  }
  return { ...result, stdout: serialized, usage, servedModel: null, ...experimentFields, ...failureFields };
}

/** Whether kimi's stdout opens like the stream-json wire the launch asked
 * for: the first non-empty line passes the wire-shape test
 * (kimiWireShapedLine — a line that parses as a JSON object with a
 * recognized role or the error event's type). Any other JSON — a bare
 * string, number, array, an object with no recognized role, or a
 * `{`-shaped line that does not parse alone (one line of an indented
 * object) — is a value the wire never spells, so a binary that ignored
 * `--output-format` and printed a plain JSON answer keeps the plain run's
 * escape hatch and the answer is returned (review round 20, edges
 * finding 3; lane C30, item 3; plain-unwrap.ts's shared rule). */
function wireShapedStdout(stdout: string): boolean {
  const first = stdout.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
  return kimiWireShapedLine(first);
}

const REPLY_BULLET_PREFIX = "• ";
const REPLY_CONTINUATION_INDENT = "  ";

/** The 2.3.2 bullet-block unwrap for plain text a binary printed without the
 * requested wire: applied only for installed major versions 2 and higher,
 * and only when ALL stdout matches the bullet grammar. Anything else stays
 * unchanged (the adapter's former inline rule, verbatim). */
function unwrapBulletedPlain(result: RunResult, majorVersion: number | undefined): RunResult {
  if (majorVersion === undefined || majorVersion < 2) return result;
  const blocks: string[] = [];
  const stdout = result.stdout.replace(/\r\n/g, "\n");
  for (const block of stdout.replace(/\n+$/, "").split(/\n+(?=• )/)) {
    const [first, ...continuation] = block.split("\n");
    if (
      !first?.startsWith(REPLY_BULLET_PREFIX) ||
      continuation.some((line) => line !== "" && !line.startsWith(REPLY_CONTINUATION_INDENT))
    ) {
      return result;
    }
    blocks.push([
      first.slice(REPLY_BULLET_PREFIX.length),
      ...continuation.map((line) => line.slice(REPLY_CONTINUATION_INDENT.length)),
    ].join("\n").replace(/\n+$/, ""));
  }
  return { ...result, stdout: blocks.join("\n\n").replace(/\n+$/, "") + "\n" };
}

/**
 * The plain-run unwrap: the launch asks every run for the stream-json wire
 * (the result-json one), so a plain run gets its reply and usage the same
 * way while stdout keeps the plain contract — the model's reply and nothing
 * else, never the wire, failed or not — and the wire-log usage lands on the
 * RunResult for the call ledger. The escape hatch is plain-unwrap.ts's
 * shared rule: stdout that never used the wire's grammar — an older binary,
 * a wrapper that strips the flag, a fake in a test — passes through
 * verbatim with the run unchanged and no usage, and the 2.3.2 bullet
 * unwrap still applies to that text. `majorVersion` is the installed
 * version's major part when the launch probed one.
 */
export function kimiPlainResult(
  result: RunResult,
  request: RunRequest,
  brandHome: string,
  context?: RunContext,
  majorVersion?: number
): RunResult {
  // Every launch requests stream-json, so a zero-exit run with no stdout
  // produced neither a reply nor the wire: a truncated or broken harness,
  // never a success (review round 46).
  if (result.success && result.stdout.trim() === "") {
    const separator = result.stderr === "" || result.stderr.endsWith("\n") ? "" : "\n";
    return {
      ...result,
      success: false,
      exitCode: result.exitCode || 1,
      stderr: `${result.stderr}${separator}kimi produced no output: a stream-json run carries at least its reply\n`,
    };
  }
  const captured = capturedEvents(result.stdout);
  if (captured.events.length === 0 && !wireShapedStdout(result.stdout)) {
    return unwrapBulletedPlain(result, majorVersion);
  }
  const normalized = kimiResult(result, request, brandHome, context);
  // The envelope's reply is the plain reply; the JSON wire never reaches a
  // plain run's stdout, failed or not (a failed run carries the reply text,
  // or nothing when the stream had none).
  let reply: string | null = null;
  try {
    const parsed: unknown = JSON.parse(normalized.stdout);
    // Read through the shared constant, never a literal field name
    // (round 35, contracts 7): the builder above and this reader cannot drift.
    const answer = (parsed as Record<string, unknown> | null)?.[KIMI_ANSWER_FIELD];
    if (typeof answer === "string") {
      reply = answer;
    }
  } catch {
    reply = null;
  }
  return { ...normalized, stdout: reply ?? "" };
}

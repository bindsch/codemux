import { join } from "node:path";
import type { RunContext } from "../run-context.js";
import type { CodemuxResultBlock, RunRequest, RunResult } from "../types.js";
import { findKimiWireLog, kimiWireUsage, MAX_KIMI_WIRE_BYTES, readBoundedKimiFile } from "../kimi-wire-log.js";
import { appendDiagnostic, emptyUsage } from "./common.js";
import { experimentFailure, type ExperimentFailure } from "../experiment-records.js";
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
      return parseEvents(envelope.events.map((event: unknown) => JSON.stringify(event)).join("\n"));
    }
  } catch { /* A native capture contains several JSON lines. */ }
  return parseEvents(stdout);
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
    const errors = events.filter((event) => event.type === "error");
    outputFailure ??= errors.length ? `kimi reported an error event: ${JSON.stringify(errors[0])}` :
      !reply.trim() ? "kimi printed no assistant reply in stream-json" : null;
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
    // No provider-reported evidence exists: the pinned stream-json lines
    // (assistant, tool, meta resume hints) and the wire log's records
    // (loop events, agent.message.appended, usage.record) carry no model
    // field, so `model` above is codemux's own selection.
    served_model: null,
    usage, session_id: null, recording: context?.experimentRecording ?? null,
    failure_code: failure?.code ?? context?.experimentKimi?.relay.failureCode ?? null,
  };
  const diagnostic = failure ? `experiment failure [${failure.code}]: ${outputFailure ?? failure.message}` : outputFailure;
  return { ...result, stdout: `${JSON.stringify({ [KIMI_ANSWER_FIELD]: text, events, session_id: sessionId, codemux: block })}\n`,
    usage, servedModel: null,
    ...(request.experimentMcp ? { reply: text, scanSurface: (result.scanSurface ?? result.stdout + result.stderr) + wireSurface } : {}),
    ...(failure || outputFailure ? { success: false, exitCode: result.exitCode || 1,
      ...(diagnostic ? { stderr: appendDiagnostic(result.stderr, `codemux: ${diagnostic}`) } : {}) } : {}) };
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

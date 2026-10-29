import { join } from "node:path";
import type { RunContext } from "../run-context.js";
import type { CodemuxResultBlock, RunRequest, RunResult } from "../types.js";
import { findKimiWireLog, kimiWireUsage, MAX_KIMI_WIRE_BYTES, readBoundedKimiFile } from "../kimi-wire-log.js";
import { appendDiagnostic, emptyUsage } from "./common.js";
import { experimentFailure, type ExperimentFailure } from "../experiment-records.js";
import { parseKimiStreamLine } from "../session/kimi-session.js";

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
      if (!["assistant", "tool", "meta"].includes(String(record.role)) && record.type !== "error") {
        throw new Error("kimi stream-json line has no recognized role or error type");
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
    usage, session_id: null, recording: context?.experimentRecording ?? null,
    failure_code: failure?.code ?? context?.experimentKimi?.relay.failureCode ?? null,
  };
  const diagnostic = failure ? `experiment failure [${failure.code}]: ${outputFailure ?? failure.message}` : outputFailure;
  return { ...result, stdout: `${JSON.stringify({ reply: text, events, session_id: sessionId, codemux: block })}\n`,
    usage, servedModel: null,
    ...(request.experimentMcp ? { reply: text, scanSurface: (result.scanSurface ?? result.stdout + result.stderr) + wireSurface } : {}),
    ...(failure || outputFailure ? { success: false, exitCode: result.exitCode || 1,
      ...(diagnostic ? { stderr: appendDiagnostic(result.stderr, `codemux: ${diagnostic}`) } : {}) } : {}) };
}

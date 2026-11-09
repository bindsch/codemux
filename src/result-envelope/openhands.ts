import type { CodemuxResultBlock, ResultUsageBlock, RunRequest, RunResult } from "../types.js";
import { appendDiagnostic, boundResultEnvelope, emptyUsage } from "./common.js";

/**
 * Parses the JSONL stream openhands prints for a headless run launched
 * with `--json` (1.16.0: entrypoint.py's `json_mode = args.json and
 * args.headless` wires openhands_cli/utils.py's json_callback, which
 * prints `json.dumps(event.model_dump())` — one line per conversation
 * event, SystemPromptEvent excepted; read 2026-11-09). The answer text is
 * the LAST MessageEvent with `source == "agent"`: its `llm_message.content`
 * is a list of content blocks whose text parts join into the reply
 * (openhands/sdk/event/llm_convertible/message.py at 1.21.0). Failure is
 * an AgentErrorEvent or ConversationErrorEvent. NO event carries token
 * usage: the TokenUsage metrics live in the conversation state, not the
 * event stream, and the CLI prints no metrics line in json mode — so the
 * codemux usage block reports every field null rather than fabricating a
 * count (ResultUsageBlock semantics).
 */
/** The field openhands's --result-json envelope spells its answer text
 * with; the harness's own MessageEvent names its answer `llm_message`.
 * The release gate's probe C verifies this exact field per agent, so the
 * parser and the gate share one name (review round 16, edges 3). */
export const OPENHANDS_ANSWER_FIELD = "llm_message";

export interface OpenhandsEnvelopeInfo {
  answer: string | null;
  errorText: string | null;
}

function messageText(llmMessage: unknown): string | null {
  if (typeof llmMessage !== "object" || llmMessage === null) return null;
  const content = (llmMessage as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "object" && part !== null) {
      const record = part as Record<string, unknown>;
      // TextContent blocks carry `type: "text"` and `text`; any other
      // block (images) contributes nothing to the answer.
      if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

export function parseOpenhandsResultEnvelope(stdout: string): OpenhandsEnvelopeInfo | null {
  let sawWire = false;
  let answer: string | null = null;
  let errorText: string | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const event = parsed as Record<string, unknown>;
    sawWire = true;
    // The event class name rides pydantic's DiscriminatedUnionMixin `kind`
    // field; the serialized line carries it as `kind`.
    if (event.kind === "MessageEvent" && event.source === "agent") {
      const text = messageText(event.llm_message);
      if (text !== null) answer = text;
    } else if (event.kind === "AgentErrorEvent" || event.kind === "ConversationErrorEvent") {
      if (typeof event.error === "string") errorText = event.error;
      else if (
        typeof event.error === "object" && event.error !== null &&
        typeof (event.error as Record<string, unknown>).message === "string"
      ) {
        errorText = String((event.error as Record<string, unknown>).message);
      }
    }
  }
  if (!sawWire) return null;
  return { answer, errorText };
}

/**
 * Finishes a `--result-json` run for openhands: the envelope is codemux's
 * own — the folded answer text, an all-null usage block (no event carries
 * tokens), and the codemux block. Stdout with no JSON lines breaks the
 * contract the launch made (it ran with `--json --headless`), so the run
 * fails loudly. A stream with no agent message fails too — the harness
 * exited without a reply — and so does an error event: the structured
 * report is read, not the process exit trusted.
 */
export function openhandsResult(result: RunResult, request: RunRequest): RunResult {
  const agent = "openhands" as const;
  const parsed = parseOpenhandsResultEnvelope(result.stdout);
  if (parsed === null) {
    return {
      ...result,
      stderr: appendDiagnostic(
        result.stderr,
        `codemux: ${agent} printed no wire events, ` +
          "so this --result-json run carries no codemux block"
      ),
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
      success: false,
    };
  }
  const failure =
    parsed.errorText !== null
      ? `error event (${parsed.errorText})`
      : parsed.answer === null || parsed.answer.trim() === ""
        ? "no agent message"
        : null;
  const usage: ResultUsageBlock = emptyUsage();
  // The event stream carries no model name, so the block reports the model
  // codemux selected, else null. No conversation id rides the EVENTS (the
  // state events are websocket-only), and the run envelope does not parse
  // the tail entrypoint.py prints after them (`Conversation ID: <hex>` and
  // the resume hint, entrypoint.py:230-238, printed for every main-command
  // run including headless) — the session driver owns that channel
  // (src/session/openhands-session.ts), so a plain run's session_id stays
  // null and no codemux run resumes this conversation.
  const block: CodemuxResultBlock = {
    agent,
    labels: request.labels ?? null,
    model_alias: request.modelAlias ?? null,
    model: request.model ?? null,
    served_model: null,
    usage,
    session_id: null,
    recording: null,
    failure_code: failure !== null ? "harness-error" : null,
  };
  const envelope = `${JSON.stringify({ [OPENHANDS_ANSWER_FIELD]: parsed.answer ?? "", usage, codemux: block })}\n`;
  if (failure !== null) {
    return boundResultEnvelope(
      agent,
      {
        ...result,
        stdout: envelope,
        stderr: appendDiagnostic(
          result.stderr,
          `codemux: ${agent} reported ${failure}, ` +
            `so this --result-json run fails even though the harness exited ${result.exitCode}`
        ),
        exitCode: result.exitCode === 0 ? 1 : result.exitCode,
        success: false,
        usage,
        servedModel: null,
      },
      usage,
      null
    );
  }
  return boundResultEnvelope(
    agent,
    {
      ...result,
      stdout: envelope,
      usage,
      servedModel: null,
    },
    usage,
    null
  );
}

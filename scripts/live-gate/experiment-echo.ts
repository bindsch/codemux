// Probe G's verification: the echo marker reply and the experiment
// recording that proves codemux delivered the marker to the model.
// Kept beside probes.ts (the probe set) so each module stays under the
// repository's file-size ceiling; no module in scripts/live-gate/ imports
// the hub (scripts/live-gate.ts) back.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { modelResultMatches } from "../../src/experiment-claude-content.js";
import { compareCodexOutput, wallTimeHeader } from "../../src/experiment-codex-content.js";
import { kimiWallTimeHeader, kimiWithoutHeader } from "../../src/experiment-kimi-content.js";
import { geminiExperimentOutput } from "../../src/gemini-experiment-content.js";
import type { AgentId } from "../../src/types.js";

/** The reply rule: the marker is the reply's substance — models drop the
 * wall-time header codemux prepends (both live-gate replies arrived as the
 * bare marker), so the bare marker passes for every experiment harness.
 * Codex and kimi may also echo their own header under its production
 * boundary: codex separates header and marker with one newline
 * (compareCodexOutput builds `${header}\n${text}`), kimi's header already
 * ends with the boundary newline (kimiProjectedResult builds
 * `${header}${text}`). Claude and zai carry no header on their wires, so
 * the bare marker is their one compliant reply. */
function replyFailure(trimmed: string, marker: string, agent: AgentId): string | null {
  if (trimmed === marker) return null;
  if (agent === "codex" || agent === "kimi") {
    const header = agent === "codex" ? wallTimeHeader(trimmed) : kimiWallTimeHeader(trimmed);
    if (header !== null && trimmed === (agent === "codex" ? `${header}\n${marker}` : `${header}${marker}`)) {
      return null;
    }
    return `stdout is neither the bare marker nor the marker after a valid ${agent} wall-time header: ${escapePreview(trimmed)}`;
  }
  return `stdout is not the bare marker (${agent} results carry no wall-time header): ${escapePreview(trimmed)}`;
}

/** The delivered text of one recorded `model_tool_result`, checked under
 * the probed harness's own rule: codex and kimi must have received the
 * harness's wall-time header first (codex as one header item before the
 * content items or one `header\n` text; kimi as a header glued to the
 * text's first part), claude and zai the bare marker, under Claude's own
 * canonicalization of a single text block. The header is what the probe
 * exists to prove — the recording holds the result as delivered to the
 * model, and the reply alone cannot show it, because models drop the
 * header when they echo. Returns the failure reason, or null. */
function deliveredResultFailure(record: Record<string, unknown>, marker: string, agent: AgentId, path: string): string | null {
  if (agent === "codex") {
    // The recorded output is the rollout's own shape: one header
    // input_text item before the content items, or one header-prefixed
    // string (compareCodexOutput accepts both). classifyCodexHeader reads
    // the first item's text because the array arm of compareCodexOutput
    // reports any input_text there as the header, valid or not.
    const first = Array.isArray(record.output)
      ? record.output[0] as { type?: unknown; text?: unknown } | undefined
      : undefined;
    const firstText = first !== undefined && first.type === "input_text" && typeof first.text === "string"
      ? first.text
      : typeof record.output === "string" ? record.output : null;
    const opensWithHeader = firstText !== null && wallTimeHeader(firstText) !== null;
    if (!opensWithHeader) {
      return `the recording's model_tool_result opens with no valid codex wall-time header, so codemux did not prepend the header to the model-bound result (${path})`;
    }
    return compareCodexOutput([{ type: "text", text: marker }], record.output).equal
      ? null
      : `the recording's model_tool_result carries the codex header but not the marker after it (${path})`;
  }
  if (agent === "kimi") {
    const content = record.content;
    const first = Array.isArray(content)
      ? content[0] as { type?: unknown; text?: unknown } | undefined
      : undefined;
    const header = first?.type === "text" && typeof first.text === "string" ? kimiWallTimeHeader(first.text) : null;
    if (header === null) {
      return `the recording's model_tool_result opens with no valid kimi wall-time header, so codemux did not prepend the header to the model-bound result (${path})`;
    }
    const without = kimiWithoutHeader(content as { type: string; text: string }[], header);
    if (without === undefined || !modelResultMatches([{ type: "text", text: marker }], without)) {
      return `the recording's model_tool_result carries the kimi header but not the marker after it (${path})`;
    }
    return null;
  }
  if (agent === "gemini") {
    const text = geminiExperimentOutput({ content: [{ type: "text", text: marker }] });
    return modelResultMatches([{ type: "text", text }], record.content)
      ? null
      : `the recording's model_tool_result lacks the marker in Gemini's exact untrusted-context wrapper (${path})`;
  }
  // Claude and Z.AI record the SDK block; OpenCode, Pi, Qwen, Copilot,
  // and Cline record the delivered content directly. Goose's ledger
  // cannot prove model delivery, so it emits neither required record.
  const sdkBlock = agent === "claude" || agent === "zai";
  const block = record.block as { content?: unknown } | null | undefined;
  const content = sdkBlock ? (block !== null && typeof block === "object" ? block.content : undefined) : record.content;
  if (!modelResultMatches([{ type: "text", text: marker }], content)) {
    return `the recording's model_tool_result text is not the bare marker (${agent} delivers no wall-time header) (${path})`;
  }
  return null;
}

/** The recording rule: the probe's one tool call must have exactly one
 * `model_tool_result` record whose delivered text passes the harness's own
 * rule above, and one `result_comparison` record with `equal: true` —
 * codemux's own comparison of the delivered result against the server's.
 * A probe directory with no recording, an unreadable one, or one that does
 * not parse fails naming the path: without it, nothing shows what the
 * model was given. */
function recordingFailure(directory: string, marker: string, agent: AgentId): string | null {
  let names: string[];
  try {
    // The recording is `<run id>.jsonl`; codemux writes the harness log copy
    // beside it as `<run id>.codex-rollout.jsonl` or `<run id>.kimi-wire.jsonl`
    // (src/experiment-harness-log.ts), which is evidence of its own, not a
    // second recording (the 2026-11-02 codex G rerun was failed for it).
    names = readdirSync(directory).filter((name) => /^[^.]+\.jsonl$/.test(name));
  } catch (error) {
    return `could not read the probe directory for the experiment recording: ${directory} (${reason(error)})`;
  }
  if (names.length === 0) {
    return `the probe directory holds no experiment recording, so the delivered result is unproven: ${directory}`;
  }
  if (names.length > 1) {
    return `the probe directory holds ${names.length} experiment recordings; one probe run writes exactly one (${names.join(", ")}): ${directory}`;
  }
  const path = join(directory, names[0]!);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return `could not read the experiment recording ${path} (${reason(error)})`;
  }
  const results: Record<string, unknown>[] = [];
  const comparisons: Record<string, unknown>[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return `the experiment recording does not parse (line ${index + 1}): ${path}`;
    }
    if (record.kind === "model_tool_result") results.push(record);
    if (record.kind === "result_comparison") comparisons.push(record);
  }
  if (results.length !== 1) {
    return `the recording holds ${results.length} model_tool_result records; the probe's one tool call must have exactly one (${path})`;
  }
  const delivered = deliveredResultFailure(results[0]!, marker, agent, path);
  if (delivered !== null) return delivered;
  if (comparisons.length !== 1) {
    return `the recording holds ${comparisons.length} result_comparison records; the probe's one tool call must have exactly one (${path})`;
  }
  if (comparisons[0]!.equal !== true) {
    return `the recording's result_comparison is not equal: true — codemux compared the delivered result against the server's and found it changed (${path})`;
  }
  return null;
}

/** Probe G's verification over the run's stdout and the probe directory
 * the spec sent its recording to. The reply carries the marker (bare, or
 * under the harness's own header boundary for codex and kimi); the
 * recording in the directory is the delivery proof, read and judged by
 * the rules above. Returns the failure reason, or null when both pass. */
export function verifyExperimentEcho(stdout: string, marker: string, agent: AgentId, directory: string): string | null {
  const reply = replyFailure(stdout.trim(), marker, agent);
  if (reply !== null) return reply;
  return recordingFailure(directory, marker, agent);
}

function escapePreview(text: string): string {
  return text.slice(0, 80) || "(empty)";
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Shared result-envelope API. Harness parsers live in separate modules. */
export { emptyUsage, normalizeClaudeUsage, appendDiagnostic } from "./result-envelope/common.js";
export { claudeFamilyResult, parseClaudeResultEnvelope, type ClaudeEnvelopeInfo } from "./result-envelope/claude.js";
export { agyResult, parseAgyResultEnvelope, type AgyEnvelopeInfo } from "./result-envelope/agy.js";
export { parseCodexEventStream, type CodexEventStream } from "./result-envelope/codex-stream.js";
export { CodexEventReducer, codexWarningNote, codexWarningNoteBytes } from "./result-envelope/codex-reducer.js";
export {
  CODEX_FINAL_MESSAGE_FALLBACK_NOTE,
  applyCodexFinalMessageFallback,
  codexStreamVerdict,
  codexResult,
  type CodexStreamVerdictOptions,
  type CodexFinalMessageFallback,
} from "./result-envelope/codex.js";

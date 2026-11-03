// The --result-json envelope shapes, one name per harness: the field each
// builder spells the answer text with. The release gate's probe C verifies
// exactly this field for the probed agent (review round 16, edges 3), so
// the builders and the gate share one table — a builder whose spelling
// changes moves the gate with it, and an envelope cross-wired to another
// harness's spelling fails the gate instead of passing.
import type { AgentId } from "../types.js";
import { AGY_ANSWER_FIELD } from "./agy.js";
import { CLAUDE_FAMILY_ANSWER_FIELD } from "./claude.js";
import { CODEX_ANSWER_FIELD } from "./codex.js";
import { KIMI_ANSWER_FIELD } from "./kimi.js";
import { OPENCODE_ANSWER_FIELD } from "./opencode.js";

/** The six --result-json harnesses and the field each envelope spells its
 * answer with. Agents without --result-json support are absent; a lookup
 * that misses is the caller's refusal (no documented envelope). */
export const RESULT_ANSWER_FIELD: Partial<Record<AgentId, string>> = {
  agy: AGY_ANSWER_FIELD,
  claude: CLAUDE_FAMILY_ANSWER_FIELD,
  codex: CODEX_ANSWER_FIELD,
  kimi: KIMI_ANSWER_FIELD,
  opencode: OPENCODE_ANSWER_FIELD,
  zai: CLAUDE_FAMILY_ANSWER_FIELD,
};

/** The harnesses whose result envelope carries provider-reported model
 * evidence: claude's and zai's modelUsage key names the single model that
 * served the run. Codex names a served model only in a reroute notice, so
 * a successful run that was not rerouted reports `served_model: null` and
 * codex is NOT in this set: probe H cannot assert an override on evidence
 * that arrives only when the provider rerouted (round 26, edges 2). Agy,
 * kimi, and opencode pins expose no served-model field, so their
 * envelopes report `served_model: null`. The release gate's
 * probe H (the override is asserted on the envelope's served_model) and
 * `codemux list --json` (candidate discovery) read this one table, so
 * the gate's set, the envelope builders, and the listing cannot drift. */
export const SERVED_MODEL_EVIDENCE_HARNESSES: ReadonlySet<AgentId> = new Set([
  "claude",
  "zai",
]);

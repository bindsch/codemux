// The --result-json envelope shapes, one name per harness: the field each
// builder spells the answer text with. The release gate's probe C verifies
// exactly this field for the probed agent (review round 16, edges 3), so
// the builders and the gate share one table — a builder whose spelling
// changes moves the gate with it, and an envelope cross-wired to another
// harness's spelling fails the gate instead of passing.
import type { AgentId } from "../types.js";
import { AGY_ANSWER_FIELD } from "./agy.js";
import { CLAUDE_FAMILY_ANSWER_FIELD } from "./claude.js";
import { COPILOT_ANSWER_FIELD } from "./copilot.js";
import { CODEX_ANSWER_FIELD } from "./codex.js";
import { GEMINI_ANSWER_FIELD } from "./gemini.js";
import { GOOSE_ANSWER_FIELD } from "./goose.js";
import { KIMI_ANSWER_FIELD } from "./kimi.js";
import { CURSOR_ANSWER_FIELD } from "./cursor.js";
import { DROID_ANSWER_FIELD } from "./droid.js";
import { OPENCODE_ANSWER_FIELD } from "./opencode.js";
import { OPENHANDS_ANSWER_FIELD } from "./openhands.js";
import { PI_ANSWER_FIELD } from "./pi.js";
import { QWEN_ANSWER_FIELD } from "./qwen.js";

/** The --result-json harnesses and the field each envelope spells its
 * answer with. Agents without --result-json support are absent; a lookup
 * that misses is the caller's refusal (no documented envelope). */
export const RESULT_ANSWER_FIELD: Partial<Record<AgentId, string>> = {
  agy: AGY_ANSWER_FIELD,
  claude: CLAUDE_FAMILY_ANSWER_FIELD,
  cline: "text",
  codex: CODEX_ANSWER_FIELD,
  copilot: COPILOT_ANSWER_FIELD,
  cursor: CURSOR_ANSWER_FIELD,
  droid: DROID_ANSWER_FIELD,
  gemini: GEMINI_ANSWER_FIELD,
  goose: GOOSE_ANSWER_FIELD,
  kimi: KIMI_ANSWER_FIELD,
  opencode: OPENCODE_ANSWER_FIELD,
  openhands: OPENHANDS_ANSWER_FIELD,
  pi: PI_ANSWER_FIELD,
  qwen: QWEN_ANSWER_FIELD,
  zai: CLAUDE_FAMILY_ANSWER_FIELD,
};

/** The harnesses whose result envelope carries provider-reported model
 * evidence: claude's and zai's modelUsage key names the single model that
 * served the run. Codex names a served model only in a reroute notice, so
 * a successful run that was not rerouted reports `served_model: null` and
 * codex is NOT in this set: probe H cannot assert an override on evidence
 * that arrives only when the provider rerouted (round 26, edges 2). Agy,
 * kimi, openhands, and opencode pins expose no served-model field, so their
 * envelopes report `served_model: null`. Qwen's assistant message.model
 * comes from its configuration, so it also reports null. The release gate's
 * probe H (the override is asserted on the envelope's served_model) and
 * `codemux list --json` (candidate discovery) read this one table, so
 * the gate's set, the envelope builders, and the listing cannot drift. */
export const SERVED_MODEL_EVIDENCE_HARNESSES: ReadonlySet<AgentId> = new Set([
  "claude",
  "gemini",
  "pi",
  "zai",
  "goose",
  // Qwen's message.model is configuration, not provider-reported identity.
  // A --result-json run is the observed RPC session; the model comes from
  // the provider response bytes (src/copilot-model-evidence.ts).
  "copilot",
]);

/** Where a SESSION's served model comes from (design P5): "provider"
 * when the wire names what served each turn (claude and zai's
 * message.model / modelUsage; Pi's assistant model; codex's model/rerouted notice), "harness"
 * when the wire names what it configured (claude's init frame, codex's
 * thread response — both agents carry the two sources side by side: the
 * events report whichever named one), "none" when no machine-readable
 * naming exists on the recorded wire (a declared limitation, never a
 * missing field). An absent entry is an agent whose session driver
 * reports no served model yet; its events carry the fields as null. */
export type SessionServedModelSource = "provider" | "harness" | "none";

export const SESSION_SERVED_MODEL: Partial<
  Record<AgentId, SessionServedModelSource[]>
> = {
  claude: ["provider", "harness"],
  zai: ["provider", "harness"],
  codex: ["provider", "harness"],
  pi: ["provider"],
  agy: ["none"],
  kimi: ["none"],
  opencode: ["none"],
  aider: ["none"],
};

/**
 * The session autonomy ceiling (design §4.1): pure, table-driven
 * predicates that decide whether one permission request is ALLOWABLE at
 * the session's start-time autonomy level. They never talk to a process
 * and never throw — a verdict is a value, so every driver's answer path
 * stays uniform.
 *
 * The ceiling is not the boundary (scode is); it is the rule that no
 * caller answer can exceed the autonomy the session launched with. A
 * caller `allow` on a request the ceiling denies is answered to the
 * harness as a deny and the caller line is rejected with
 * `autonomy_escalation` (the drivers, steps 5–8, do that; this module
 * only supplies the verdict).
 *
 * Fail-closed on what codemux cannot read: an unknown tool, a missing
 * tool name, an unparsable argument set, an unresolvable or unjudgeable
 * target path spelling, or an `updated_input` key outside the tool's
 * known schema all deny — when codemux cannot tell what the action is,
 * the answer is deny. Low
 * narrows that rule; it does not erase it. The level's meaning is "the
 * caller answers", so an unknown or ungranted tool is allow-able at low,
 * and so is a known tool without a schema (Read, WebFetch, Task,
 * `mcp__*`): there is nothing to check its arguments against. Only the
 * tools with a schema (Edit, Write, NotebookEdit, Bash) carrying a key
 * outside it still deny at low,
 * because the caller would be approving an action whose arguments nobody
 * parsed (the tool table in ./ceiling/tools.ts runs the schema check
 * before low's fast path, exactly as the tests pin it).
 */

// The predicates live in ./ceiling/ (paths.ts judges target paths,
// tools.ts holds the tool table); re-exported here so importers keep
// this one path.
export type { CeilingVerdict } from "./ceiling/paths.js";
export {
  foldForProtectedLookup,
  pathInsideScope,
  spellingsInsideScope,
} from "./ceiling/paths.js";
export { knownClaudeTools, claudeCeiling } from "./ceiling/tools.js";

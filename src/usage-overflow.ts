// Overflow marks for usage blocks (review rounds 81 to 85). A token field
// that left the safe-integer range is null in the block, the same null an
// unreported field carries; the mark tells the two apart, so a fold never
// revives an overflowed field with a later count. Shared by the usage
// normalizers (src/result-envelope, src/session) and the session folds
// (src/session/usage.ts); it imports nothing from either.

import type { ResultUsageBlock } from "./types.js";

export type TokenField = "input_tokens" | "output_tokens" | "cached_input_tokens";
export const TOKEN_FIELDS: readonly TokenField[] = ["input_tokens", "output_tokens", "cached_input_tokens"];

/** The fields a running block lost to overflow, keyed by the block's
 * identity. An overflowed field is null in the block, the same null an
 * unreported field carries, so without this mark the next fold would
 * read it as "never reported" and revive it with the later turn's count
 * (review round 81). The mark is sticky: every block the helpers here
 * derive from a marked one carries it forward. Callers hold the block
 * the helpers return and never rebuild it by hand (the drivers assign
 * `cumulative` from addTurnUsage alone), so identity is the carrier. */
export const overflowMarks = new WeakMap<ResultUsageBlock, ReadonlySet<TokenField>>();

/** The token fields of `block` that overflowed in an earlier fold. */
export function overflowedFields(block: ResultUsageBlock): readonly TokenField[] {
  return [...(overflowMarks.get(block) ?? [])];
}

/** Marks `fields` of a freshly normalized block as lost to overflow: a
 * normalizer whose own sum (a cache pair, a total) left the safe range
 * reports null for the field, and the mark keeps that null from being
 * read as "never reported" by the folds (review round 84). Returns the
 * block for chaining. */
export function markOverflowed(block: ResultUsageBlock, fields: readonly TokenField[]): ResultUsageBlock {
  if (fields.length === 0) return block;
  const marks = new Set<TokenField>(overflowMarks.get(block) ?? []);
  for (const field of fields) marks.add(field);
  overflowMarks.set(block, marks);
  return block;
}

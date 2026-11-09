/**
 * The codex approval ceiling and decision picking (design §4.1):
 * judging one approval request against start-time autonomy and picking
 * the refusal an approval's decision list offers. src/session/codex-session.ts
 * owns the lifecycle and re-exports these.
 */

import type { AutonomyLevel } from "../types.js";
import type { CeilingVerdict } from "./ceiling.js";
import { isRecord } from "./codex-parse-facts.js";
import { pathInsideScope } from "./ceiling.js";

// --- approval ceiling ------------------------------------------------------

/** The three approval kinds the app-server surfaces (§4.1). */
export type CodexApprovalKind =
  | "commandExecution"
  | "fileChange"
  | "permissions";

/** The approval request methods codemux answers; anything else is an
 * unimplemented server request. */
export const CODEX_APPROVAL_METHODS: Readonly<Record<string, CodexApprovalKind>> = {
  "item/commandExecution/requestApproval": "commandExecution",
  "item/fileChange/requestApproval": "fileChange",
  "item/permissions/requestApproval": "permissions",
};

/**
 * Judge one codex approval request against the session's start-time
 * autonomy (§4.1). Sessions above read-only use an asking approval
 * policy, including those contained by scode. Read-only denies all three
 * kinds; low is caller approval, so everything is allow-able; medium
 * allows workspace patches and denies commands; high's mapping is full
 * access, and requests within it are allow-able. Turn-scoped permission
 * grants widen beyond every mapping above low, so they deny everywhere
 * else. Fail-closed: a patch whose paths codemux cannot parse denies.
 */
export function codexApprovalCeiling(
  level: AutonomyLevel,
  kind: CodexApprovalKind,
  input: Record<string, unknown>,
  launchDir: string
): CeilingVerdict {
  if (level === "read-only") {
    return { allowable: false, reason: "read-only allows no tool use" };
  }
  if (level === "low") {
    return { allowable: true, reason: "low allows every request" };
  }
  if (kind === "permissions") {
    return {
      allowable: false,
      reason: `the ${level} mapping grants no turn-scoped permissions`,
    };
  }
  if (kind === "commandExecution") {
    return level === "high"
      ? { allowable: true, reason: "high's mapping is full access; the command is within it" }
      : { allowable: false, reason: "medium denies commands; only workspace patches are allow-able" };
  }
  if (level === "high") {
    return { allowable: true, reason: "high's mapping is full access; the patch is within it" };
  }
  const paths = fileChangePaths(input);
  if (paths.length === 0) {
    return { allowable: false, reason: "the patch carries no parsable paths" };
  }
  for (const path of paths) {
    const verdict = pathInsideScope(path, launchDir);
    if (!verdict.allowable) return verdict;
  }
  return { allowable: true, reason: "every patched path is inside the launch directory" };
}

/** The paths a fileChange approval would touch; empty when the changes
 * list is missing or unparsable (§4.1's opaque-action rule). An update
 * that moves a file names its destination separately (`kind.move_path`):
 * the destination is as much "where this patch writes" as the source,
 * so it is judged too — a move from inside the workspace to outside it
 * is not an in-scope patch (found by review live3; the shape is
 * openclaw's PatchChangeKind, `update` alone carries `move_path`). */
export function fileChangePaths(input: Record<string, unknown>): string[] {
  const changes = input["changes"];
  if (!Array.isArray(changes)) return [];
  const paths: string[] = [];
  for (const change of changes) {
    if (!isRecord(change)) return [];
    const path = change["path"];
    if (typeof path !== "string" || path.length === 0) return [];
    paths.push(path);
    const kind = change["kind"];
    const movePath = isRecord(kind) ? kind["move_path"] : undefined;
    if (movePath !== undefined && movePath !== null) {
      if (typeof movePath !== "string" || movePath.length === 0) return [];
      paths.push(movePath);
    }
  }
  return paths;
}

/**
 * Pick the decision string for an approval response, respecting the
 * request's `availableDecisions` the way openclaw's bridge does: the
 * preferred decision when available (or when the list is absent), else
 * the other refusal, never `acceptForSession` — the session-persistent
 * variant is dropped, not forwarded (§4.1). A decline is only picked for
 * a request that `offersRefusal`: the driver keeps every other one away
 * from the decline paths, so the final "decline" fallback is never an
 * answer the server did not offer.
 */
export function pickApprovalDecision(
  available: unknown,
  preferred: "accept" | "decline"
): string {
  if (!Array.isArray(available)) return preferred;
  if (available.includes(preferred)) return preferred;
  const alternate = preferred === "decline" ? "cancel" : "decline";
  if (available.includes(alternate)) return alternate;
  return preferred === "accept" ? alternate : "decline";
}

/** Whether an approval's decision list lets codemux refuse it: an absent
 * list allows every decision, and a present one must name "decline" or
 * "cancel". A list without either has no refusal codemux may send
 * (review live17); the driver never forwards such a request. */
export function offersRefusal(available: unknown): boolean {
  if (!Array.isArray(available)) return true;
  return available.includes("decline") || available.includes("cancel");
}

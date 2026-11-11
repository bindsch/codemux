/** The session-keyed name the SessionPrivateHome contract settles onto
 * (src/session/private-home-types.ts): `session-<id>` beside the fresh
 * run-shaped directory. The drivers need the path BEFORE or WITHOUT
 * calling `settle` — a registry record or a session_started report
 * written at the first resume hint must name the path a `--resume`
 * computes — so the one naming rule lives here, beside the contract's
 * own doc comment that states it. `dir` follows the settle rename
 * (the launcher's contract), so once settled this function is
 * idempotent on `dir`: it recomputes the path the home already sits
 * on. If the launcher's settle ever names the key differently, this
 * function and that doc comment move together. */
import { dirname, join } from "node:path";
import { assertSafeSessionId } from "./id-pattern.js";
import { assertDirectChildPath } from "../safe-remove.js";

export function settledPrivateHomePath(privateHomeDir: string, sessionId: string): string {
  return sessionKeyedHomePath(dirname(privateHomeDir), sessionId);
}

/** The same key spelled from the PARENT directory every home sits under:
 * what a `--resume` computes before any home is open (the launcher knows
 * the parent and the recorded id, never a run-shaped dir). The two
 * spellings must agree, or a resume looks one directory too high and
 * answers the missing-home refusal (review round 412, blocker). */
export function sessionKeyedHomePath(parent: string, sessionId: string): string {
  assertSafeSessionId(sessionId);
  const path = join(parent, `session-${sessionId}`);
  assertDirectChildPath(path, parent);
  return path;
}

/** The private home's CURRENT directory: the fresh run-shaped path until
 * settle, the session-keyed path after — which is what `dir` answers
 * too (the launcher's contract keeps `dir` on the directory's live
 * name). Kept as the spawn-side spelling of that rule for the drivers
 * that respawn the harness per turn (kimi): a path captured before a
 * settle is never reused, and reading through here states why. */
export function currentPrivateHomeDir(
  home: { readonly dir: string; readonly settled: boolean },
  sessionId: string
): string {
  return home.settled ? settledPrivateHomePath(home.dir, sessionId) : home.dir;
}

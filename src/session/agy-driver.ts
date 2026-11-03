/**
 * The agy session driver (design §4.7, plan step 8): the launcher-owned
 * context that turns one SessionProcess plus the caller's stdin into the
 * event stream. This file is the assembled driver's public shape only;
 * the per-run state lives in the agy-driver-io.ts line it extends — the
 * FSM, the parser context, the output queue, the registry writes — never
 * on a singleton adapter. The driver never throws across the stream:
 * every failure is an event, an end path, or both.
 *
 * Turn model: one caller input line is one harness turn. The capability
 * matrix is honestly narrow (src/session/agy-session.ts): no steer, no
 * interrupt, no permissions, no mid-turn input — the input parser
 * rejects each of those with a named reason before anything reaches the
 * harness, so the driver carries no queue, no buffer, and no approval
 * machinery. Turn ids are codemux-local (t1, t2, …) assigned at submit,
 * and `turn_started` is emitted at submit, ahead of the `user_message`
 * that names it and of the write, because writing the line is what opens
 * an agy turn (the claude and codex order; review live17). The stdin
 * close is the only end carrier (`finish`).
 *
 * Identity model: a fresh agy session has no init frame — the first
 * fact that names the conversation is the first result envelope. The FSM
 * therefore leaves `starting` silently on the first user input (nothing
 * else can ever be submitted), while the caller-facing
 * `session_started` event and the registry record wait for that first
 * usable conversation id; events before it carry an empty session_id. A
 * resumed session (`--conversation`, registry-vouched) adopts its id at
 * spawn instead. A first result that names NO conversation id (the
 * auth-failure fixture) completes the open turn as failed and then ends
 * the session: an untracked live session must not run (§4.8).
 */

import { AgyTurns } from "./agy-turns.js";

export type { AgyDriverOptions, SessionEndReason } from "./agy-driver-io.js";

export class AgySessionDriver extends AgyTurns {}

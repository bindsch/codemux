/**
 * Wire writers, the state-dir recorder, and the shared mutable state for
 * the codex app-server fake; tests/fixtures/live/fake-codex-app-server.ts
 * owns the lifecycle and the scenario switch.
 */
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export const stateDir = process.env.FAKE_STATE_DIR ?? "/tmp/fake-codex-app-server";
mkdirSync(stateDir, { recursive: true });
export const record = (name: string, value: unknown): void => {
  appendFileSync(join(stateDir, name), `${JSON.stringify(value)}\n`);
};

// FAKE_THREAD_ID bends the id the fake starts (review live16: an id
// `--resume` would refuse must never reach the registry).
export const THREAD_ID = process.env.FAKE_THREAD_ID ?? "0123456789abcdef";
export const FAKE_CWD = process.env.FAKE_CWD ?? process.cwd();

export const write = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};
export const respond = (id: unknown, result: unknown): void => {
  write({ id, result });
};
export const respondError = (id: unknown, message: string): void => {
  write({ id, error: { code: -1, message } });
};
export const notify = (method: string, params: Record<string, unknown>): void => {
  write({ method, params });
};
export const serverRequest = (
  method: string,
  id: string | number,
  params: Record<string, unknown>
): void => {
  write({ method, id, params });
};

/** The approval waiting on a decision response, and the turn it froze.
 * The id keeps its wire type: numeric ids must be answered numerically. */
export interface CodexPendingApproval {
  id: string | number;
  kind: "command" | "patch" | "permissions";
  callId: string;
  command: string;
  turnId: string;
}

/** The fake's session-spanning mutable state, shared by the entry's
 * dispatch and the part modules. */
export interface CodexFakeState {
  turnCounter: number;
  currentTurn: string | null;
  currentScenario: string;
  pendingApproval: CodexPendingApproval | null;
  // FAKE_SIGTERM_PERSIST=ask state: the drain-window approval is NOT
  // tracked in pendingApproval — resumeAfterApproval would complete the
  // turn "completed", while the held end-interrupt must complete it
  // "interrupted" once the decline lands.
  drainApprovalPending: boolean;
  heldInterruptId: string | number | undefined;
  // FAKE_HOLD_TURNSTART=1 state: the turn/start request held until the
  // shutdown SIGTERM releases it inside the drain window.
  heldTurnStart: { id: unknown; params: Record<string, unknown> } | null;
  // staleinterrupt state: the interrupt whose response is held until a
  // later interrupt flushes the rejection first.
  staleInterruptId: string | number | undefined;
  // FAKE_STALL_INIT=release/rejectrelease state: the initialize held until
  // the shutdown SIGTERM answers it inside codemux's drain window.
  heldInitId: unknown;
  // laggard state: the completed turn whose stragglers the next
  // turn/start releases.
  laggardTurnId: string | null;
  // Turn starts to let pass before the laggard's stragglers go out.
  laggardSkip: number;
  /** Steer texts the current wait/steer turn has absorbed. */
  steeredTexts: string[];
}

export const state: CodexFakeState = {
  turnCounter: 0,
  currentTurn: null,
  currentScenario: "",
  pendingApproval: null,
  drainApprovalPending: false,
  heldInterruptId: undefined,
  heldTurnStart: null,
  staleInterruptId: undefined,
  heldInitId: undefined,
  laggardTurnId: null,
  laggardSkip: 0,
  steeredTexts: [],
};

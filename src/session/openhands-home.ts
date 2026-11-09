/**
 * The openhands hermetic session home: a session-lifetime private HOME
 * under `~/.openhands/.codemux-hermetic/` (the run path's parent,
 * src/openhands-hermetic.ts), held across turns and `--resume`, and the
 * native deny rule `--permission-policy deny` plants in it.
 *
 * The home starts empty, as the run path's does: `~/.openhands` holds
 * the whole agent spec, which is operator customization, so nothing is
 * carried. Headless mode then starts only with LLM env overrides, so a
 * hermetic session requires the provider override (the adapter's own
 * rule). Each turn wraps its command in the run path's env prefix
 * (openhandsSessionEnvPrefix): HOME, OPENHANDS_PERSISTENCE_DIR, and
 * OPENHANDS_CONVERSATIONS_DIR all point into this home, so the
 * conversation store that `--resume <id>` reads lives here. openhands
 * mints the conversation id (the deferred identity), so a fresh home
 * starts run-shaped and settles onto `session-<id>` at the adopt.
 *
 * The deny rule (OpenHands 1.16.0 with SDK 1.21.0, read 2026-11-09):
 * headless mode always selects NeverConfirm (tui/textual_app.py:726), so
 * no permission request ever reaches a caller. The SDK's PreToolUse hook
 * is the native deny channel: setup.py:142 loads
 * `HookConfig.load(working_dir=...)`, which reads the first of
 * `{working_dir}/.openhands/hooks.json` and `Path.home()/.openhands/
 * hooks.json` that exists (sdk/hooks/config.py:219-239); a hook that
 * exits 2 blocks the action (sdk/hooks/executor.py:23-29 and 237), and
 * the agent answers the blocked action with a UserRejectObservation
 * (sdk/agent/agent.py:171-199) instead of running it. The planted rule
 * matches every tool except `finish` and `think` (tool names are the
 * class name in snake case without `_tool`, sdk/tool/tool.py:228), so a
 * denied session can still answer and end its turn. The hermetic
 * session's clean-cwd rule keeps a working-directory hooks.json from
 * displacing it, and the session CLI refuses deny with
 * `--experiment-project-settings`, whose whole point is that file.
 */

import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PARENT_DIR_NAME } from "../hermetic-home.js";
import { readProviderOverride } from "../provider-override.js";
import { UsageRefusalError } from "../validation.js";
import { OPENHANDS_CONVERSATION_ID_PATTERN } from "./openhands-session.js";
import { openSessionPrivateHome } from "./private-home.js";
import type { SessionPrivateHome } from "./private-home-types.js";

/** The refusal a hermetic openhands session without the override reads:
 * the run path's own wording (src/adapters/openhands.ts). */
export const OPENHANDS_HERMETIC_OVERRIDE_REFUSAL =
  "openhands --hermetic requires the provider override: a private home carries no settings, and headless mode starts only with LLM env overrides (set CODEMUX_OPENHANDS_PROVIDER_BASE_URL and CODEMUX_OPENHANDS_PROVIDER_API_KEY)";

/** The tools a denied session keeps: the two that act on nothing. */
const OPENHANDS_DENY_MATCHER = "/(?!(?:finish|think)$).*/";

/** The planted hooks.json: one PreToolUse rule that exits 2 (blocking)
 * on every tool but `finish` and `think`. */
export const OPENHANDS_DENY_HOOKS_JSON = `${JSON.stringify({
  pre_tool_use: [{
    matcher: OPENHANDS_DENY_MATCHER,
    hooks: [{
      type: "command",
      command: "printf '%s\\n' 'denied by codemux --permission-policy deny' >&2; exit 2",
      timeout: 10,
    }],
  }],
}, null, 2)}\n`;

/** The brand directory inside the home: openhands's persistence dir and
 * the `Path.home()/.openhands` the hook search reads. */
function brandDir(home: string): string {
  return join(home, ".openhands");
}

/** Make sure the brand directory is a real directory this home owns. A
 * link or a file at the name is refused: a turn with tools could have
 * planted one, and a write through it would land outside the home. */
function ensureBrandDir(home: string): string {
  const dir = brandDir(home);
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (stat === undefined) {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    return dir;
  }
  if (!stat.isDirectory()) {
    throw new Error(`the openhands session home's ${dir} is not a directory; refusing to write through it`);
  }
  return dir;
}

/**
 * Bring the home's hooks.json in line with this command's policy. Deny
 * writes the planted rule (an existing entry is unlinked first, so a
 * link never redirects the write). Default removes the planted rule when
 * it is still there verbatim, and leaves any other file alone: a resumed
 * session runs with the policy its command names.
 */
export function applyOpenhandsSessionPolicy(home: string, policy: "default" | "deny"): void {
  const path = join(brandDir(home), "hooks.json");
  if (policy === "deny") {
    const dir = ensureBrandDir(home);
    const target = join(dir, "hooks.json");
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (stat !== undefined) {
      if (stat.isDirectory()) throw new Error(`the openhands deny rule cannot replace the directory ${target}`);
      unlinkSync(target);
    }
    writeFileSync(target, OPENHANDS_DENY_HOOKS_JSON, { mode: 0o600, flag: "wx" });
    return;
  }
  // Only a real brand directory is read through: a link there names
  // something outside the home, which this removal must never touch.
  if (lstatSync(brandDir(home), { throwIfNoEntry: false })?.isDirectory() !== true) return;
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) return;
  if (readFileSync(path, "utf8") === OPENHANDS_DENY_HOOKS_JSON) unlinkSync(path);
}

export interface OpenhandsSessionHomeInput {
  /** The real openhands directory (`~/.openhands`). */
  stateRoot: string;
  /** True on `--resume`. */
  resume: boolean;
  /** The resumed conversation id; null on a fresh session. */
  sessionId: string | null;
  permissionPolicy: "default" | "deny";
}

/**
 * Open (fresh) or reopen (`--resume`) the hermetic openhands session
 * home and apply the policy. Refused without the provider override,
 * before any directory exists. A fresh home whose policy write fails is
 * removed before the error propagates.
 */
export function openOpenhandsSessionHome(input: OpenhandsSessionHomeInput): SessionPrivateHome {
  if (readProviderOverride("openhands", process.env) === null) {
    throw new UsageRefusalError(OPENHANDS_HERMETIC_OVERRIDE_REFUSAL);
  }
  const home = openSessionPrivateHome({
    parent: join(input.stateRoot, PARENT_DIR_NAME),
    sessionId: input.sessionId ?? undefined,
    resume: input.resume,
    idPattern: OPENHANDS_CONVERSATION_ID_PATTERN,
    blockedPaths: [],
    populate: (dir) => {
      ensureBrandDir(dir);
      applyOpenhandsSessionPolicy(dir, input.permissionPolicy);
    },
  });
  // A resume reopens the recorded home (populate never runs there), so
  // the policy is applied to it directly.
  if (input.resume) applyOpenhandsSessionPolicy(home.dir, input.permissionPolicy);
  return home;
}

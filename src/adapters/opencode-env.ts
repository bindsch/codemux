/**
 * The environment construction opencode launches carry: the hermetic
 * env prefix that wires the private home, the `--tools none` permission
 * switch, and the refusal reasons for the runs that may not use them.
 * src/adapters/opencode.ts owns the adapter lifecycle.
 */

import { join } from "node:path";

// Hermetic runs point OpenCode's XDG world at a private home (see
// opencode-hermetic.ts) and close the channels a home cannot with these
// env-only switches, read in packages/core/src/flag/flag.ts and
// packages/opencode/src/effect/runtime-flags.ts at 1.18.18. The config
// variables are REMOVED, not blanked: Global.Path.config reads
// `Flag.OPENCODE_CONFIG_DIR ?? Path.config` (packages/core/src/global.ts),
// and an empty string survives `??`, degenerating `path.join(global.config,
// "AGENTS.md")` into a project-relative file the ungated global-files loop
// then loads — a leak, not a neutralizer (verified live: the empty
// assignment carried a planted canary into the system prompt at 1.18.18).
// A provider override sets OPENCODE_CONFIG to codemux's own config file —
// the one channel hermetic deliberately keeps, because codemux wrote it.
//
// projectSettings (--experiment-project-settings) omits the
// OPENCODE_DISABLE_PROJECT_CONFIG assignment only, so the working
// directory's own opencode.json/opencode.jsonc, .opencode directory, and
// instruction files load while everything the private home covers stays
// out; the ancestors above the working directory are refused instead
// (opencode-project-settings.ts), and `--pure` is dropped alongside it so
// the project's plugins run.
export const OPENCODE_HERMETIC_ENV = (
  home: string,
  realDataParent: string,
  providerConfigPath: string | null,
  projectSettings = false
): string[] => [
  "-u",
  "OPENCODE_CONFIG",
  "-u",
  "OPENCODE_CONFIG_DIR",
  "-u",
  "OPENCODE_CONFIG_CONTENT",
  // Auth.all reads OPENCODE_AUTH_CONTENT before the auth.json file
  // (packages/opencode/src/auth/index.ts), so a passed-through value is a
  // login state codemux never inspected — removed like the config
  // variables, and for the same reason: hermetic carries no channel the
  // operator named.
  "-u",
  "OPENCODE_AUTH_CONTENT",
  // The private home reaches OpenCode through env(1), never through the
  // environment codemux hands to scode: scode derives its deny rules from
  // $HOME, and these assignments override any XDG_* the sanitized child
  // environment carries.
  `HOME=${home}`,
  `XDG_CONFIG_HOME=${join(home, ".config")}`,
  `XDG_CACHE_HOME=${join(home, ".cache")}`,
  `XDG_STATE_HOME=${join(home, ".local", "state")}`,
  // The login lives in the real data directory (auth.json, rewritten in
  // place), so it stays real while everything else moves — and is
  // inspected for remote-config carriers before the launch
  // (opencode-remote-config.ts).
  `XDG_DATA_HOME=${realDataParent}`,
  // Project AGENTS.md/CLAUDE.md/CONTEXT.md discovery, opencode.json and
  // .opencode directories come from the working directory
  // (packages/opencode/src/session/instruction.ts, config/paths.ts) —
  // suppressed except under --experiment-project-settings, where the
  // project's own config is the point of the run.
  ...(projectSettings ? [] : ["OPENCODE_DISABLE_PROJECT_CONFIG=1"]),
  // ~/.claude/CLAUDE.md and the .claude skills fallback; the paths are
  // already unreachable under the private home, and the flag holds even if a
  // future release resolves them elsewhere. Kept under project settings
  // too: the project's instructions load through OpenCode's own walk, and
  // an ancestor CLAUDE.md is refused rather than loaded
  // (opencode-project-settings.ts).
  "OPENCODE_DISABLE_CLAUDE_CODE=1",
  // ~/.claude/skills and ~/.agents/skills (packages/opencode/src/skill/index.ts).
  "OPENCODE_DISABLE_EXTERNAL_SKILLS=1",
  ...(providerConfigPath === null ? [] : [`OPENCODE_CONFIG=${providerConfigPath}`]),
];

// `--tools none`: a pattern-"*" deny in the permission rules removes every
// tool from the model's request (packages/opencode/src/permission/index.ts
// disabled() and session/llm/request.ts resolveTools drop them). The env
// JSON merges after every config layer (config.ts). That is the whole
// story only where no later fold can append per-agent permission rules
// after the global ones (agent config at packages/opencode/src/agent/
// agent.ts: `item.permission = Permission.merge(item.permission, …)`, and
// the `mode` entries fold into agents after even OPENCODE_CONFIG_CONTENT;
// the last matching rule wins, `findLast` in permission.ts). On a plain
// run the operator's own config can do exactly that, and a hermetic run
// keeps the real data directory for the login, so a login carrying remote
// configuration can too: OpenCode fetches a well-known login's
// `.well-known/opencode` document and an active organization's `/api/config`
// and merges them as global config (config.ts at 1.18.18), verified live
// through this adapter's own plain-run path for the operator config (h2
// review): with `"agent": {"build": {"permission": {"bash": "allow"}}}`,
// a `--tools none` run's request carried the bash tool. No environment
// variable spells per-agent or mode permissions and a codemux-written
// config layer still merges before the mode fold, so plain runs refuse the
// capability; the login's remote configuration is refused the same way
// (opencode-remote-config.ts, h3 review). Admin-managed settings — the
// machine administrator's layer, `/Library/Application Support/opencode`,
// `/etc/opencode`, MDM plists — can also append and cannot be refused;
// they are the documented residual (docs/isolation.md, "Residual inputs
// and enforcement").
export const OPENCODE_NO_TOOLS_PERMISSION = 'OPENCODE_PERMISSION={"*":"deny"}';

/** Why a hermetic run refuses a login that carries remote configuration. */
export const hermeticRemoteConfigRefusal = (carrier: string): string =>
  `opencode --hermetic is refused while the login carries remote configuration: ${carrier}; ` +
  "agent permissions from it would override the --tools none deny (docs/isolation.md)";

/** Why a plain (non-hermetic) run refuses `--tools none`. */
export const PLAIN_NO_TOOLS_REFUSAL =
  "opencode --tools none requires --hermetic: the operator's opencode config can override the permission deny per agent";

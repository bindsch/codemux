/**
 * `--experiment-project-settings` on OpenCode: the request rules that
 * differ from the Claude family and the ancestor refusal. The shared
 * entry is validateProjectSettingsRequest (claude-project-settings.ts).
 *
 * Under the flag a hermetic OpenCode run keeps its private home and the
 * rest of the hermetic environment but omits OPENCODE_DISABLE_PROJECT_
 * CONFIG and `--pure`, so the working directory's own opencode.json/
 * opencode.jsonc, .opencode directory (plugins, agents, commands), and
 * instruction files load while the operator's global configuration —
 * everything under the redirected XDG config home — stays out
 * (adapters/opencode.ts; packages/opencode/src/config/config.ts and
 * config/paths.ts at 1.18.18).
 *
 * The ancestor refusal exists because both project walks are bounded by
 * the worktree, and the worktree is every ancestor when there is no
 * version control: OpenCode resolves the worktree from git
 * (core/src/project.ts resolve: no repository means
 * `{directory: "/", vcs: undefined}`), and a directory without VCS gets
 * worktree "/" (packages/opencode/src/project/project.ts line 217), so
 * the config walk (ConfigPaths.files/directories, `stop: worktree`) and
 * the instruction walk (session/instruction.ts findUp with the same
 * stop) read every ancestor up to and including the filesystem root.
 * With VCS the walks stop at the worktree root, which is at or below an
 * ancestor of the working directory, so a refusal over every ancestor
 * strictly above the working directory covers both cases on its own and
 * no separate git-root requirement is needed.
 */
import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { UsageRefusalError, validateWorkingDirectory } from "./validation.js";

// The names OpenCode's project walks look for above the working directory
// (verified in the 1.18.18 source): ConfigPaths.files searches
// `opencode.jsonc` and `opencode.json`, ConfigPaths.directories searches
// `.opencode` (config/paths.ts), and the instruction walk searches
// AGENTS.md, CLAUDE.md, and CONTEXT.md (session/instruction.ts).
// CLAUDE.md is dropped from the instruction list while
// OPENCODE_DISABLE_CLAUDE_CODE=1 is set — which hermetic runs keep — but
// the name refuses anyway: fail closed against a release that resolves it
// elsewhere (the same reason the adapter keeps that flag at all).
const ANCESTOR_PROJECT_CONFIG_NAMES = [
  "opencode.json",
  "opencode.jsonc",
  ".opencode",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTEXT.md",
];

/** The run autonomy levels the flag accepts on OpenCode: low maps to
 * `--agent build` with no `--auto`, high to `--agent build --auto`. What
 * a level means is the build agent's permission defaults, not the level
 * flag itself: the defaults allow every unlisted tool call ("*" allow)
 * and ask only for a doom loop, an external directory, and an `.env`
 * read (agent/agent.ts `defaults`). A headless run answers every ask
 * with reject (cli/cmd/run.ts), so at LOW an ask-shaped rule rejects and
 * an unlisted command runs; a fixture that wants unlisted commands
 * rejected writes them as ask rules, e.g. `"bash": {"*": "ask",
 * "touch allowed.txt": "allow"}`. At HIGH `--auto` approves every ask.
 * Explicit `deny` rules bind at both levels: a deny fails the call
 * before the question is ever emitted (permission/index.ts). */
export const OPENCODE_RUN_AUTONOMIES = "low or high";

// The run builds the whole hermetic environment itself, so an operator
// redirect of any of these is a second hand on the same knob:
// OPENCODE_CONFIG/OPENCODE_CONFIG_DIR/OPENCODE_CONFIG_CONTENT name other
// config layers, OPENCODE_PERMISSION merges after every config layer and
// would override the project's own rules, and OPENCODE_AUTH_CONTENT is
// login state codemux never inspected (packages/opencode/src/auth).
export const OPENCODE_PASSTHROUGH_REFUSALS = [
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_PERMISSION",
  "OPENCODE_AUTH_CONTENT",
];

/**
 * Refuses the run when any directory above the working directory carries
 * an OpenCode project config or instruction name. Every directory entry
 * of such a name refuses it: a file, a directory, or a link, including a
 * dangling one, and an ancestor that cannot be inspected refuses it too.
 * The walk covers every directory strictly above the canonical working
 * directory and includes the filesystem root, which OpenCode's own walk
 * also visits when the working directory has no version control; the
 * working directory itself is the fixture's own and may carry the names.
 * The error names the nearest offending path, starting from the immediate
 * parent.
 */
export function assertNoAncestorOpenCodeProjectConfig(cwd: string): void {
  const start = validateWorkingDirectory(cwd) ?? process.cwd();
  for (let dir = dirname(start); ; dir = dirname(dir)) {
    for (const name of ANCESTOR_PROJECT_CONFIG_NAMES) {
      const candidate = join(dir, name);
      try {
        lstatSync(candidate);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        throw new UsageRefusalError(
          `--experiment-project-settings: cannot inspect ${candidate} (${code ?? "unknown error"}); ` +
            "an ancestor of the working directory that might carry project config refuses the run"
        );
      }
      throw new UsageRefusalError(
        `--experiment-project-settings: ${candidate} would load as project config or instructions. OpenCode walks from the ` +
          "working directory up to the worktree root for opencode.json, opencode.jsonc, .opencode, AGENTS.md, CLAUDE.md, and " +
          "CONTEXT.md, and a working directory without version control gets worktree \"/\", so the walk can reach the filesystem " +
          "root; the private home does not stop it (a home directory usually carries an AGENTS.md or CLAUDE.md, so a fixture " +
          "under it is refused). Place the fixture where no ancestor carries them; the working directory itself may."
      );
    }
    if (dirname(dir) === dir) break;
  }
}

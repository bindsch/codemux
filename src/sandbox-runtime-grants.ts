import { basename, dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { containsPath, effectiveSandboxCommand, StrictSandboxRefusalError } from "./sandbox-command.js";
import { canonicalSandboxBlockPath } from "./session/registry/format.js";
import type { AgentId } from "./types.js";

function canonicalRuntimePath(path: string): string {
  try { return canonicalSandboxBlockPath(path); }
  catch (error) {
    throw new StrictSandboxRefusalError(error instanceof Error ? error.message : String(error));
  }
}

/** Runtime state omitted by scode 0.6.5's strict harness detection.
 * The adapter identity selects grants, never an executable path or argument.
 * Environment wrappers may relocate state; inspect their assignments too.
 */
export function strictRuntimeGrants(
  agentId: AgentId | undefined,
  command: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  uid = process.getuid?.()
): string[] {
  const { executable, env } = effectiveSandboxCommand(command, environment);
  if (!executable || !isAbsolute(executable)) return [];
  const paths: string[] = [];
  // Claude ignores TMPDIR for this per-user scratch root. Scode's private
  // TMPDIR grant therefore does not cover it. Never allow the /tmp parent.
  if ((agentId === "claude" || agentId === "zai") && platform === "darwin" && uid !== undefined) {
    paths.push(`/private/tmp/claude-${uid}`);
  }
  const home = env.HOME ?? homedir();
  if (paths.length > 0 || agentId === "opencode") {
    if (!isAbsolute(home)) throw new StrictSandboxRefusalError("strict runtime HOME requires an absolute path");
  }
  if (agentId === "opencode") {
    paths.push(join(home, ".opencode"));
    paths.push(join(env.XDG_STATE_HOME || join(home, ".local/state"), "opencode"));
    paths.push(join(env.XDG_CACHE_HOME || join(home, ".cache"), "opencode"));
  }
  return paths.map((path) => {
    if (!isAbsolute(path)) throw new StrictSandboxRefusalError("strict runtime state requires an absolute path");
    if (canonicalRuntimePath(dirname(path)) === "/") {
      throw new StrictSandboxRefusalError("strict runtime state must not use the filesystem root as its parent");
    }
    const canonical = canonicalRuntimePath(path);
    for (const protectedHome of [home, homedir()]) {
      const canonicalHome = canonicalRuntimePath(protectedHome);
      if (containsPath(canonical, canonicalHome)) {
        throw new StrictSandboxRefusalError("strict runtime state must not grant HOME or its ancestors");
      }
    }
    // An application-state symlink must not turn a narrow default into a
    // grant of its parent, HOME, or an unrelated credential directory.
    const expected = join(canonicalRuntimePath(dirname(path)), basename(path));
    if (canonical !== expected) {
      throw new StrictSandboxRefusalError(`strict runtime state path is redirected by a symlink: ${path}`);
    }
    return canonical;
  });
}

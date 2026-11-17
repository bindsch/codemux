import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";

/** Preserve the native login namespace while isolating Claude's configuration.
 * An empty value selects the default item; an explicit default path hashes it. */
export function claudeSecureStorageEnv(
  environment: NodeJS.ProcessEnv,
  platform = process.platform
): Record<string, string> {
  return platform === "darwin" ? {
    CLAUDE_SECURESTORAGE_CONFIG_DIR:
      environment.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? environment.CLAUDE_CONFIG_DIR ?? "",
  } : {};
}

/** Make the login selection agree with the configuration the child reads.
 * The profile fallback above exists for private-configuration launches,
 * where the child's CLAUDE_CONFIG_DIR is a private directory and the login
 * must still come from the operator's profile. A plain launch forwards the
 * operator's CLAUDE_CONFIG_DIR only under `--pass-env`: when the child
 * receives none it reads `~/.claude`, so its login is the default item
 * too, never the item of a profile it does not use (review round 4). An
 * explicit CLAUDE_SECURESTORAGE_CONFIG_DIR is kept as given. */
export function alignClaudeSecureStorage(childEnv: Record<string, string>, ambient: NodeJS.ProcessEnv): void {
  if (childEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR === undefined) return;
  if (ambient.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined) return;
  if (childEnv.CLAUDE_CONFIG_DIR === undefined) childEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR = "";
}

/** Match Claude's plaintext fallback, including an explicitly empty override.
 * An empty value of either variable selects the default directory: an empty
 * CLAUDE_CONFIG_DIR must never resolve the login root, and with it the
 * sandbox's lock and credential grants, to the working directory. */
export function claudeLoginDirectory(environment: NodeJS.ProcessEnv): string {
  const secure = environment.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const fallback = join(environment.HOME || homedir(), ".claude");
  return secure !== undefined ? secure || fallback : environment.CLAUDE_CONFIG_DIR || fallback;
}

/** Native refresh locks are independent of the private configuration directory.
 * The lock owner is advisory; Claude's atomic file staging also needs scode's
 * narrowly scoped sibling-file support when this root is blocked. */
export function claudeLoginPaths(environment: NodeJS.ProcessEnv, cwd = process.cwd()): string[] {
  const root = resolve(cwd, claudeLoginDirectory(environment).normalize("NFC"));
  let canonical = root;
  try { canonical = realpathSync(root); } catch { /* The harness may create its storage root. */ }
  return [join(root, ".oauth_refresh.lock"), join(root, ".oauth_refresh.lock.owner"), `${canonical}.lock`,
    ...[join(root, ".credentials.json")].filter(existsSync)];
}

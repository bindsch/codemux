import { chmodSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmdirSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { UsageRefusalError } from "./validation.js";

/**
 * Kimi serializes token refresh across processes itself: before it rotates
 * the refresh token it takes a proper-lockfile lock on
 * `<KIMI_CODE_HOME>/oauth/<provider>` (the lock directory is
 * `<KIMI_CODE_HOME>/oauth/<provider>.lock`, opened with `realpath: false`;
 * Kimi 2.6.0 OAuth module, `resolveLockTarget` and `acquireRefreshLock`).
 * A private brand home that shares only `credentials` shares the token
 * file and not that lock, so two Kimi processes could rotate one refresh
 * token at the same time and the provider revoked the login. Every private
 * brand home therefore links `oauth` to the operator's directory, exactly
 * as it links `credentials`, and Kimi's own lock covers every launch.
 */
export const KIMI_OAUTH_DIRECTORY = "oauth";

/** The operator's refresh-lock directory, created private when absent.
 * The path is `<operator brand home>/oauth` as written: `credentials` may
 * be a symlink to another directory, and Kimi still locks under the brand
 * home. A brand home codemux cannot write keeps what it has: the link then
 * points at a directory that does not exist yet, and Kimi fails closed
 * when it needs the lock ("Unable to prepare OAuth refresh lock"), exactly
 * as a native Kimi does in that read-only home. It never refreshes
 * without the lock. */
export function kimiOperatorOauthDirectory(operatorBrandHome: string): string {
  const directory = resolve(operatorBrandHome, KIMI_OAUTH_DIRECTORY);
  const entry = lstatSync(directory, { throwIfNoEntry: false });
  if (entry === undefined) {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      // mkdir's mode is masked by the umask; state it.
      chmodSync(directory, 0o700);
    } catch (error) {
      if (!["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    return directory;
  }
  // An operator's own symlink to a directory is followed, as Kimi follows it.
  // A link whose target does not exist yet is a private home's link to a
  // read-only operator home (above): the chain is kept as it is.
  const target = statSync(directory, { throwIfNoEntry: false });
  if (entry.isSymbolicLink() && target === undefined) return directory;
  if (!target?.isDirectory()) {
    throw new UsageRefusalError(`Kimi's refresh-lock directory ${directory} is not a directory; ` +
      "codemux never deletes it. Remove or repair it so Kimi can lock token refreshes there");
  }
  return directory;
}

/** A directory Kimi made for itself in a private home (homes created before
 * 2.0.4 had no link): only empty sentinel files and empty `.lock`
 * directories. Anything else is not removed. */
function removeOwnLockDirectory(directory: string): void {
  // Kimi names its sentinel after the provider (`kimi-code`,
  // `kimi-code-env-<id>`) and its lock directory `<sentinel>.lock`.
  const sentinel = /^kimi-code[A-Za-z0-9._-]*$/;
  const entries = readdirSync(directory).map((name) => ({ name, path: join(directory, name), stat: lstatSync(join(directory, name)) }));
  // Check everything first: a foreign entry refuses before anything is removed.
  for (const { name, path, stat } of entries) {
    const own = sentinel.test(name) &&
      ((stat.isFile() && stat.size === 0 && !name.endsWith(".lock")) ||
        (stat.isDirectory() && name.endsWith(".lock") && readdirSync(path).length === 0));
    if (!own) throw new Error(`${path} is not one of Kimi's lock files`);
  }
  for (const { path, stat } of entries) {
    if (stat.isDirectory()) rmdirSync(path); else unlinkSync(path);
  }
  rmdirSync(directory);
}

/** Link `<private brand home>/oauth` to the operator's directory. An
 * existing identical link passes. A directory Kimi created there before
 * the link existed is replaced; any other entry refuses the launch by
 * path and is never deleted. */
export function linkKimiOauthDirectory(operatorBrandHome: string, privateBrandHome: string): void {
  const target = kimiOperatorOauthDirectory(operatorBrandHome);
  const link = join(privateBrandHome, KIMI_OAUTH_DIRECTORY);
  const existing = lstatSync(link, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) {
    if (readlinkSync(link) === target) return;
    throw new UsageRefusalError(`Kimi's refresh-lock link ${link} points somewhere else; ` +
      `remove it before launching again, and codemux links it to ${target}`);
  }
  if (existing !== undefined) {
    try {
      if (!existing.isDirectory()) throw new Error(`${link} is not a directory`);
      removeOwnLockDirectory(link);
    } catch (error) {
      throw new UsageRefusalError(`the private Kimi home holds its own refresh-lock entry at ${link}, ` +
        `which codemux does not delete (${error instanceof Error ? error.message : String(error)}); ` +
        "remove it before launching again so this home shares Kimi's refresh lock");
    }
  }
  symlinkSync(target, link, "dir");
}

/** A resumed private home shares the refresh lock whenever it shares the
 * credential store: a home created before 2.0.4 gains the link here. */
export function relinkKimiOauthDirectory(operatorBrandHome: string, privateBrandHome: string): void {
  if (!lstatSync(join(privateBrandHome, "credentials"), { throwIfNoEntry: false })?.isSymbolicLink()) return;
  linkKimiOauthDirectory(operatorBrandHome, privateBrandHome);
}

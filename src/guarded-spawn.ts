// The spawn functions for every child that can run a harness. Each one
// runs the keychain-home check (darwin-keychain-home.ts) on the child's
// argv and environment before the child exists, so a child with a private
// HOME cannot start without a resolvable default keychain. A refusal
// throws before anything is spawned.
//
// tests/guarded-spawn-scan.test.ts fails when another file under src/ or
// scripts/ starts a process without these functions, unless the file is
// in that test's list of fixed, non-harness system tools.
import { guardChildKeychainHomes } from "./darwin-keychain-home.js";

type GuardedOptions = { env?: Record<string, string | undefined>; cwd?: string } | undefined;

function check(args: readonly unknown[]): void {
  const first = args[0] as readonly string[] | ({ cmd: readonly string[] } & NonNullable<GuardedOptions>);
  const command = Array.isArray(first) ? first as readonly string[] : (first as { cmd: readonly string[] }).cmd;
  const options = (Array.isArray(first) ? args[1] : first) as GuardedOptions;
  guardChildKeychainHomes(command, options?.env, options?.cwd, {}, true);
}

/** `Bun.spawn` after the keychain-home check. */
export const spawnGuarded: typeof Bun.spawn = ((...args: unknown[]) => {
  check(args);
  return (Bun.spawn as (...inner: unknown[]) => unknown)(...args);
}) as typeof Bun.spawn;

/**
 * `Bun.spawn` without the check, for the two scode probes: `<scode> --version`
 * and `<scode> --help`. The launch paths run them with the launch's
 * environment, whose HOME can be a private home that a `--print-sandbox`
 * preview must not create or change. scode answers both flags by printing
 * text and starts nothing. The argv must be one executable and one of the
 * two flags, so nothing can be launched behind it, and the scan test allows
 * only the scode probes (cli-runtime/scode.ts) to select this function. The
 * executable's name is not checked: the resolved scode path may be a link
 * target with another name.
 */
export const spawnScodeProbe: typeof Bun.spawn = ((...args: unknown[]) => {
  const command = args[0];
  if (!Array.isArray(command) || command.length !== 2 || (command[1] !== "--version" && command[1] !== "--help")) {
    throw new Error("spawnScodeProbe starts only `scode --version` and `scode --help`");
  }
  return (Bun.spawn as (...inner: unknown[]) => unknown)(...args);
}) as typeof Bun.spawn;

/** `Bun.spawnSync` after the keychain-home check. */
export const spawnSyncGuarded: typeof Bun.spawnSync = ((...args: unknown[]) => {
  check(args);
  return (Bun.spawnSync as (...inner: unknown[]) => unknown)(...args);
}) as typeof Bun.spawnSync;

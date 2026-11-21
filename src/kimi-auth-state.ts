import { closeSync, constants, fchmodSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { commandProgramIndex } from "./executable-security.js";
import { tryExclusiveFlock } from "./flock.js";
import { writeOwnedSync } from "./fs-durable.js";
import { readBoundedKimiFile } from "./kimi-wire-log.js";

const MAX_STATE_BYTES = 4096;
const STATE_FILES = ["device_id", "region"] as const;
const COPY_LOCK_WAIT_MS = 10_000;
const COPY_LOCK_RETRY_MS = 20;

function readOptional(path: string): string | undefined {
  try { return readBoundedKimiFile(path, MAX_STATE_BYTES); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** The brand home the child itself resolves: the command's own env
 * prefixes applied, before scode wraps it. Null for a command that is not
 * kimi, and for its version and help probes. */
export function kimiCommandBrandHome(command: readonly string[], env: NodeJS.ProcessEnv, cwd: string): string | null {
  const program = commandProgramIndex(command);
  if (basename(command[program] ?? "") !== "kimi") return null;
  if (command.length === program + 2 && ["--version", "--help", "-h"].includes(command[program + 1]!)) return null;
  const childEnv = { ...env };
  for (let i = 0; i < program; i++) {
    const part = command[i]!;
    if (part === "-u" || part === "--unset") { delete childEnv[command[++i]!]; continue; }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(part);
    if (match) childEnv[match[1]!] = match[2];
  }
  return resolve(cwd, childEnv.KIMI_CODE_HOME ?? join(childEnv.HOME || homedir(), ".kimi-code"));
}

const canonical = (path: string): string => {
  try { return realpathSync(path); } catch { return resolve(path); }
};

// Private brand homes whose location does not name their operator home:
// a caller-owned --harness-home and a planted canary home. Their builders
// register them; the path is never read back from a file or a link, which
// a child with write access to the private home could change.
const registered = new Map<string, string>();

/** Record that `privateBrandHome` shares the operator's OAuth grant.
 * Returns the function that forgets it. */
export function registerKimiPrivateHome(privateBrandHome: string, operatorBrandHome: string): () => void {
  const key = canonical(privateBrandHome);
  if (key === canonical(operatorBrandHome)) return () => {};
  registered.set(key, operatorBrandHome);
  return () => { if (registered.get(key) === operatorBrandHome) registered.delete(key); };
}

/** The operator brand home a codemux private brand home was built from,
 * or undefined for any other brand home (a plain run). Run and session
 * homes sit at `<operator>/.codemux-hermetic/<name>/.kimi-code`, a shape
 * that survives the session home's rename at settle. */
export function kimiPrivateHomeOperator(brandHome: string): string | undefined {
  const known = registered.get(canonical(brandHome));
  if (known !== undefined) return known;
  const parent = dirname(dirname(brandHome));
  if (basename(brandHome) === ".kimi-code" && basename(parent) === ".codemux-hermetic" && dirname(parent) !== parent) {
    return dirname(parent);
  }
  return undefined;
}

/** The brand home at the end of the private-home chain: the one whose
 * `credentials` and `oauth` every private home on the way links to. */
export function kimiOperatorBrandHome(brandHome: string): string {
  let current = brandHome;
  for (let depth = 0; depth < 16; depth++) {
    const operator = kimiPrivateHomeOperator(current);
    if (operator === undefined) return current;
    current = operator;
  }
  return current;
}

/** Hold an exclusive flock on the operator brand home for one copy, never
 * for a child's lifetime. The directory itself is the lock, so no file is
 * left behind and the kernel drops it with the descriptor. */
function withCopyLock<T>(operatorBrandHome: string, copy: () => T): T {
  let fd: number;
  try { fd = openSync(operatorBrandHome, constants.O_RDONLY | constants.O_DIRECTORY); }
  catch (error) {
    // No operator home: nothing to copy from, and a write-back reports itself.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return copy();
    throw error;
  }
  try {
    const deadline = Date.now() + COPY_LOCK_WAIT_MS;
    while (!tryExclusiveFlock(fd)) {
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for another codemux process that is copying Kimi's device state; retry the launch");
      }
      Bun.sleepSync(COPY_LOCK_RETRY_MS);
    }
    return copy();
  } finally { closeSync(fd); }
}

/** Device identity and region belong to the shared OAuth grant. */
export function copyKimiAuthState(operatorBrandHome: string, privateBrandHome: string): void {
  withCopyLock(operatorBrandHome, () => {
    for (const name of STATE_FILES) {
      const value = readOptional(join(operatorBrandHome, name));
      if (value !== undefined) writeOwnedSync(join(privateBrandHome, name), value, 0o600);
    }
  });
}

/** Refresh a private home from its operator home. Returns the write-back:
 * if native Kimi creates an identity the operator home lacked, its exact
 * bytes are published there. Exclusive creation never overwrites state an
 * external native process wrote meanwhile. Callers hold the copy lock. */
export function prepareKimiAuthState(operatorBrandHome: string, privateBrandHome: string): () => void {
  if (operatorBrandHome === privateBrandHome) return () => {};
  const missing: string[] = [];
  for (const name of STATE_FILES) {
    const value = readOptional(join(operatorBrandHome, name));
    if (value !== undefined) writeOwnedSync(join(privateBrandHome, name), value, 0o600);
    else {
      if (readOptional(join(privateBrandHome, name)) !== undefined) {
        throw new Error(`Kimi's canonical ${name} is missing but this private home has stale state; start a new session. Native authentication has not been checked.`);
      }
      missing.push(name);
    }
  }
  return () => {
    for (const name of missing) {
      const value = readOptional(join(privateBrandHome, name));
      if (value === undefined) continue;
      let fd: number;
      try { fd = openSync(join(operatorBrandHome, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
      try { fchmodSync(fd, 0o600); writeFileSync(fd, value); } finally { closeSync(fd); }
    }
  };
}

export interface KimiPrivateState {
  /** Publish native-created state now (a signal path calls it before the
   * private home is removed). Safe to call more than once. */
  publish(): void;
  /** Publish once more and stop tracking the launch. */
  end(): void;
}

const NO_STATE: KimiPrivateState = { publish: () => {}, end: () => {} };

/**
 * Synchronize a private brand home's device state around one child. A
 * plain run (the child reads the operator's own brand home) does nothing
 * and can never be refused here. Each copy holds the short copy lock; the
 * child runs with no codemux lock at all, so concurrent and nested Kimi
 * launches never wait on each other. Kimi's own refresh lock, shared
 * through the `oauth` link, is what serializes token refresh.
 */
export function beginKimiPrivateState(command: readonly string[], env: NodeJS.ProcessEnv, cwd: string,
  announce: (line: string) => void = (line) => process.stderr.write(`${line}\n`)): KimiPrivateState {
  const home = kimiCommandBrandHome(command, env, cwd);
  const operator = home === null ? undefined : kimiPrivateHomeOperator(home);
  if (home === null || operator === undefined) return NO_STATE;
  const writeBack = withCopyLock(operator, () => prepareKimiAuthState(operator, home));
  // The write-back runs after the child has finished. Its failure must not
  // replace the run's own result: one warning line, at most once per launch.
  let warned = false;
  const publish = (): void => {
    try { withCopyLock(operator, writeBack); }
    catch (error) {
      if (warned) return;
      warned = true;
      announce(`Warning: codemux could not write Kimi's native state back to its shared home; the run's result is unaffected: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    process.off("exit", end);
    publish();
  };
  // An abort leaves through process.exit and skips every pending finally.
  // The exit event still runs, so the write-back happens there: without
  // it, state Kimi created in a private home is never published and the
  // next resume refuses that home as stale (review round 4).
  process.on("exit", end);
  return { publish, end };
}

/** Run one child between the refresh and the write-back. */
export async function withKimiPrivateState<T>(command: readonly string[], env: NodeJS.ProcessEnv, cwd: string,
  run: (publish: () => void) => Promise<T>, announce?: (line: string) => void): Promise<T> {
  const state = beginKimiPrivateState(command, env, cwd, announce);
  try { return await run(state.publish); } finally { state.end(); }
}

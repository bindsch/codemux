import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, sep } from "node:path";
import { assertExecutablesUnchanged, executableCheck, resolveTrustedExecutable } from "./executable-security.js";
import { callLogPath } from "./call-log.js";
import { agyKeychainHost, templateLock } from "./agy-keychain-lock.js";

// The keychain host seams and the template lock live in
// agy-keychain-lock.ts (split for the file-size cap, review round 381);
// the public names are re-exported here so every importer keeps one
// address.
export { agyKeychainHost, reclaimStaleLock } from "./agy-keychain-lock.js";

export const AGY_MIRROR_PATH = "Library/Keychains/login.keychain-db";
const SECURITY_TIMEOUT_MS = 10_000;
const USABILITY_PROBE_SERVICE = "codemux-usability-probe";
export const AGY_TEMPLATE_NAME = "agy-mirror-template.keychain-db";
// Apple's interactive reader has a 4096-byte buffer, including the terminator.
const SECURITY_LINE_BYTES = 4096;

/** One location per login user, independent of adapter HOME and log overrides. */
export function agyKeychainStateDir(): string {
  return dirname(callLogPath({ HOME: agyKeychainHost.home() })!);
}

class CanonicalPathError extends Error {
  constructor(path: string, readonly unresolvedPath: string, cause: unknown) {
    super(`cannot canonicalize ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

// Dangling search-list entries still need recovery. Resolve the existing
// ancestor so symlink escapes and canonical aliases obey the same boundary.
function canonicalPath(path: string): string {
  let canonical = parse(path).root;
  const parts = path.slice(canonical.length).split(sep);
  for (const [index, part] of parts.entries()) {
    if (!part || part === ".") continue;
    if (part === "..") { canonical = dirname(canonical); continue; }
    const candidate = join(canonical, part);
    try { canonical = realpathSync(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new CanonicalPathError(path, join(candidate, ...parts.slice(index + 1)), error);
      }
      canonical = candidate;
    }
  }
  return canonical;
}

/** Validate every recovery root before reading or changing the search list. */
export function agyProbeRoots(environment: NodeJS.ProcessEnv): string[] {
  const roots = new Set<string>();
  for (const home of new Set([agyKeychainHost.home(), environment.HOME ?? agyKeychainHost.home()])) {
    if (!isAbsolute(home)) throw new Error("agy probe HOME must be absolute");
    const canonicalHome = realpathSync(home);
    const homeStat = lstatSync(canonicalHome);
    if (!homeStat.isDirectory() || homeStat.uid !== process.getuid?.()) {
      throw new Error("agy probe HOME must be a user-owned directory");
    }
    // Dotfile managers may link .gemini; the probe root itself must not be a link.
    const root = join(canonicalPath(join(canonicalHome, ".gemini")), ".codemux-isolation-probes");
    const stat = lstatSync(root, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new Error("agy probe home root must be a directory, not a symlink");
    if ((stat && stat.uid !== process.getuid?.()) || canonicalPath(root) !== root) {
      throw new Error("agy probe root must be canonical and user-owned, without symlink components");
    }
    roots.add(root);
  }
  return [...roots];
}

function isPrivateKeychain(path: string, roots: readonly string[], template: string): boolean {
  if (!isAbsolute(path)) return false;
  let canonical: string;
  try { canonical = canonicalPath(path); }
  catch (error) {
    // Keep the resolved prefix so aliases of owned mirrors cannot hide errors.
    if (hasPrivateKeychainLayout(path, roots, template) ||
        (error instanceof CanonicalPathError && hasPrivateKeychainLayout(error.unresolvedPath, roots, template))) {
      throw error;
    }
    return false; // An inaccessible unrelated entry must be preserved.
  }
  return hasPrivateKeychainLayout(canonical, roots, template);
}

function hasPrivateKeychainLayout(canonical: string, roots: readonly string[], template: string): boolean {
  if (canonical === template) return true;
  return roots.some((root) => {
    if (!canonical.startsWith(root + sep)) return false;
    const entry = canonical.slice(root.length + 1).split(sep)[0]!;
    // `session-<id>` is a settled hermetic SESSION's home (session/
    // private-home.ts): the same mirror layout a run-shaped home carries,
    // living past its creating process for --resume, so recovery and
    // verification must recognize it exactly like a run's.
    const named = entry.startsWith("run-") || entry.startsWith("session-");
    return named && canonical === join(root, entry, AGY_MIRROR_PATH);
  });
}

function client(environment: NodeJS.ProcessEnv, cwd?: string, home = agyKeychainHost.home()) {
  const path = agyKeychainHost.securityPath(environment);
  if (!path) return;
  const security = resolveTrustedExecutable(path, "security", cwd);
  // This client's own resolution, captured where it happened: the re-stat
  // below compares this identity alone, never one a later launch in this
  // process recorded for the same path (review round 13, edges 2).
  const securityCheck = executableCheck(security) ?? undefined;
  // Use the real login HOME unless explicitly selecting a private default.
  const env = { HOME: home, PATH: "/usr/bin:/bin" };
  return (args: string[], failure: string, stdin?: string): Buffer => {
    try {
      assertExecutablesUnchanged([security], "security", undefined, securityCheck && [securityCheck]);
      const result = agyKeychainHost.spawnSync([security, ...args], {
        env, stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
        stdout: "pipe", stderr: "pipe", timeout: SECURITY_TIMEOUT_MS,
      });
      if (result.exitCode === 0 && !result.signalCode) return result.stdout;
    } catch { /* Subprocess errors and output may contain credentials. */ }
    throw new Error(failure);
  };
}

function searchList(invoke: NonNullable<ReturnType<typeof client>>): string[] {
  const output = invoke(["list-keychains", "-d", "user"], "cannot read user Keychain search list").toString("utf8");
  return output.split("\n").filter((line) => line.trim()).map((line) => {
    const match = /^\s*"(.*)"\s*$/.exec(line);
    if (!match) throw new Error("cannot parse user Keychain search list");
    return match[1]!;
  });
}

function defaultKeychain(invoke: NonNullable<ReturnType<typeof client>>): string {
  const output = invoke(["default-keychain", "-d", "user"], "cannot read user default keychain").toString("utf8");
  const match = /^\s*"([^\r\n]+)"\s*$/.exec(output);
  if (!match || !isAbsolute(match[1]!)) throw new Error("cannot parse user default keychain");
  return match[1]!;
}

function restoreDefault(invoke: NonNullable<ReturnType<typeof client>>, original: string): void {
  invoke(["default-keychain", "-d", "user", "-s", original], "cannot restore user default keychain");
  if (defaultKeychain(invoke) !== original) throw new Error("user default keychain was not restored");
}

function setMirrorDefault(invoke: NonNullable<ReturnType<typeof client>>, home: string, keychain: string,
  environment: NodeJS.ProcessEnv, cwd?: string): void {
  let original: string;
  try { original = defaultKeychain(invoke); }
  catch {
    try { original = defaultKeychain(invoke); }
    catch {
      // Without a default for the private HOME, agy's token refresh raises
      // the macOS "a keychain cannot be found to store antigravity" prompt
      // on the operator's screen. Refuse instead (2026-11-03).
      throw new Error(
        "cannot read the user's default keychain, so the agy private HOME cannot be given one; " +
        "refusing to launch agy because it would prompt to store its token"
      );
    }
  }
  const privateInvoke = client(environment, cwd, home);
  if (!privateInvoke) throw new Error("cannot select agy private keychain client");
  // The selection's own failure owns the report (review round 381: the
  // read-back's throw used to replace it, and the operator saw the
  // verification message alone). The pending error keeps propagating when
  // the finally below completes without throwing.
  let selectionFailure: Error | undefined;
  try {
    privateInvoke(["default-keychain", "-d", "user", "-s", keychain],
      "cannot set agy keychain mirror as the private HOME's default keychain");
  } catch (error) {
    selectionFailure = error instanceof Error ? error : new Error(String(error));
    throw selectionFailure;
  } finally {
    // Still verified after a failed selection (the finally's purpose): a
    // `set` that reported failure may have applied anyway, and the real
    // default must not stay pointed at the mirror either way.
    let current: string | undefined;
    try { current = defaultKeychain(invoke); }
    catch {
      try { current = defaultKeychain(invoke); }
      catch {
        if (selectionFailure === undefined) {
          throw new Error("real default keychain could not be verified after the private selection");
        }
        selectionFailure.message += "; the real default keychain could not be verified afterwards";
      }
    }
    // Another process may have selected an unrelated default while we ran.
    if (current === keychain) {
      restoreDefault(invoke, original);
      throw new Error("agy keychain mirror changed the user's default keychain; restored");
    }
  }
  if (defaultKeychain(privateInvoke) !== keychain) {
    throw new Error("agy keychain mirror is not the private HOME's default keychain");
  }
}

function interactiveCommand(args: string[]): string {
  if (args.some((arg) => /[\0\r\n]/.test(arg))) {
    throw new Error("cannot populate agy keychain mirror: unsupported interactive input");
  }
  const line = args.map((arg) => `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(" ") + "\n";
  if (Buffer.byteLength(line) >= SECURITY_LINE_BYTES) {
    throw new Error("cannot populate agy keychain mirror: interactive input exceeds limit");
  }
  return line;
}

export function verifyAgyKeychainSearchList(environment: NodeJS.ProcessEnv): void {
  const roots = agyProbeRoots(environment);
  const template = canonicalPath(join(agyKeychainStateDir(), AGY_TEMPLATE_NAME));
  const invoke = client(environment);
  if (!invoke) return;
  if (searchList(invoke).some((path) => isPrivateKeychain(path, roots, template))) {
    throw new Error("agy keychain cleanup failed: mirror remains in the user's Keychain search list");
  }
}

function restoreSearchList(invoke: NonNullable<ReturnType<typeof client>>, original: string[]): void {
  invoke(["list-keychains", "-d", "user", "-s", ...original], "cannot restore user Keychain search list");
  if (JSON.stringify(searchList(invoke)) !== JSON.stringify(original)) {
    throw new Error("user Keychain search list was not restored");
  }
}

function recoverSearchList(invoke: NonNullable<ReturnType<typeof client>>, roots: readonly string[]): void {
  const template = canonicalPath(join(agyKeychainStateDir(), AGY_TEMPLATE_NAME));
  const current = searchList(invoke);
  const restored = current.filter((path) => !isPrivateKeychain(path, roots, template));
  // An empty filtered list — only mirror entries remained, the
  // interrupted-cleanup state — never reaches `list-keychains -s`, which
  // would fail or empty the account's search list and pass the
  // after-restore check: it is refused by name (round 372, item 14).
  if (restored.length === 0 && current.length > 0) {
    throw new Error("refusing to set an empty user Keychain search list; every entry was a codemux mirror — re-add the login keychain with 'security list-keychains -d user -s <path>'");
  }
  if (restored.length !== current.length) restoreSearchList(invoke, restored);
  if (restored.some((path) => basename(path) === AGY_TEMPLATE_NAME || path.includes("/.codemux-isolation-probes/"))) {
    console.error("codemux: left an unrelated keychain with a codemux-like path in the user search list");
  }
}

/** Repair interrupted creation even when authentication does not need a mirror. */
export function recoverAgyKeychainSearchList(environment: NodeJS.ProcessEnv, cwd?: string): void {
  const roots = agyProbeRoots(environment);
  const invoke = client(environment, cwd);
  if (!invoke) return;
  const state = agyKeychainStateDir();
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const unlock = templateLock(join(state, `${AGY_TEMPLATE_NAME}.lock`));
  try { recoverSearchList(invoke, roots); }
  finally { unlock(); }
}

function copyTemplate(invoke: NonNullable<ReturnType<typeof client>>,
  keychain: string, roots: readonly string[], failedPassword?: string): string {
  const state = agyKeychainStateDir();
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const template = join(state, AGY_TEMPLATE_NAME);
  const passwordPath = `${template}.password`;
  const unlock = templateLock(`${template}.lock`);
  try {
    recoverSearchList(invoke, roots);
    let password = existsSync(passwordPath) ? readFileSync(passwordPath, "utf8") : "";
    if (!existsSync(template) || !/^[a-f0-9]{32}$/.test(password) || password === failedPassword) {
      for (const path of [template, passwordPath]) if (existsSync(path)) unlinkSync(path);
      password = randomBytes(16).toString("hex");
      const original = searchList(invoke);
      let creationError: unknown;
      try { invoke(["-i"], "cannot create agy template keychain",
        interactiveCommand(["create-keychain", "-p", password, template])); }
      catch (error) { creationError = error; }
      // Restore creation's temporary search-list entry while still holding the lock.
      try {
        restoreSearchList(invoke, original);
      } catch (error) {
        if (creationError instanceof Error) {
          creationError.message += `; cleanup failed: ${(error as Error).message}`;
          throw creationError;
        }
        throw error;
      }
      if (creationError) throw creationError;
      chmodSync(template, 0o600);
      writeFileSync(passwordPath, password, { flag: "wx", mode: 0o600 });
    }
    for (const path of [template, passwordPath]) {
      if (!lstatSync(path).isFile()) throw new Error("agy template must contain regular files");
      chmodSync(path, 0o600);
    }
    copyFileSync(template, keychain);
    chmodSync(keychain, 0o600);
    return password;
  } finally { unlock(); }
}

function prepareKeychainCopy(invoke: NonNullable<ReturnType<typeof client>>, home: string,
  roots: readonly string[], failedPassword?: string): string {
  const keychain = join(home, AGY_MIRROR_PATH);
  mkdirSync(dirname(keychain), { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt++) {
    const password = copyTemplate(invoke, keychain, roots, failedPassword);
    try {
      // The observed backend reports -25293 on a usable copy. Check it separately.
      try { invoke(["-i"], "cannot unlock agy keychain mirror",
        interactiveCommand(["unlock-keychain", "-p", password, keychain])); }
      catch { /* A successful write below proves the copy is unlocked. */ }
      invoke(["-i"], "cannot configure agy keychain mirror", interactiveCommand(["set-keychain-settings", keychain]));
      invoke(["-i"], "cannot prepare agy private keychain", interactiveCommand([
        "add-generic-password", "-s", USABILITY_PROBE_SERVICE, "-a", "probe", "-w", randomBytes(16).toString("hex"), keychain,
      ]));
    } catch {
      if (attempt === 1) throw new Error("cannot prepare agy private keychain");
      failedPassword = password;
      continue;
    }
    invoke(["delete-generic-password", "-s", USABILITY_PROBE_SERVICE, "-a", "probe", keychain],
      "cannot prepare agy private keychain");
    return password;
  }
}

/** Prepare outside scode so token refreshes have a private default Keychain. */
export function prepareAgyPrivateKeychain(home: string, environment: NodeJS.ProcessEnv, cwd?: string): string | undefined {
  const roots = agyProbeRoots(environment);
  const invoke = client(environment, cwd);
  if (!invoke) return;
  const password = prepareKeychainCopy(invoke, home, roots);
  setMirrorDefault(invoke, home, join(home, AGY_MIRROR_PATH), environment, cwd);
  return password;
}

/** Re-select an existing mirror as a private HOME's default keychain —
 * a resumed hermetic SESSION whose recorded selection drifted (the
 * preference lives inside the private HOME, so drift means something
 * rewrote it there). The fresh path's setMirrorDefault verbatim: it
 * creates and inserts nothing, only selects under the private HOME and
 * verifies the real default never moved. */
export function ensureAgyMirrorDefault(home: string, environment: NodeJS.ProcessEnv, cwd?: string): void {
  const invoke = client(environment, cwd);
  if (!invoke) return;
  setMirrorDefault(invoke, home, join(home, AGY_MIRROR_PATH), environment, cwd);
}

/** Best-effort unlock of a resumed session's mirror with the template's
 * password (the mirror is a copy of the template, so its password is the
 * template's own): securityd keeps unlock state per keychain, so a
 * reboot between turns relocks the mirror. A failure is ignored exactly
 * as the fresh path ignores a failed unlock (prepareKeychainCopy) — a
 * harness read that works proves it unlocked, and one that does not
 * fails inside the sandbox with the credential error; the private
 * default keeps the failure from becoming a store prompt on the
 * operator's screen. */
export function unlockAgyMirrorBestEffort(home: string, environment: NodeJS.ProcessEnv, cwd?: string): void {
  const invoke = client(environment, cwd);
  if (!invoke) return;
  const passwordPath = join(agyKeychainStateDir(), `${AGY_TEMPLATE_NAME}.password`);
  let password = "";
  try {
    password = existsSync(passwordPath) ? readFileSync(passwordPath, "utf8") : "";
  } catch {
    return;
  }
  if (!/^[a-f0-9]{32}$/.test(password)) return;
  try {
    invoke(["-i"], "cannot unlock agy keychain mirror",
      interactiveCommand(["unlock-keychain", "-p", password, join(home, AGY_MIRROR_PATH)]));
  } catch {
    /* best-effort, like the fresh path */
  }
}

/** Never attach argv, output, or a subprocess error to an error. */
export function insertAgyKeychainItem(home: string, environment: NodeJS.ProcessEnv,
  password: string | undefined, cwd?: string): void {
  const roots = agyProbeRoots(environment);
  const invoke = client(environment, cwd);
  if (!invoke) throw new Error("agy is not logged in; run `agy` to log in");
  const secret = invoke(["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"],
    "agy is not logged in; run `agy` to log in").toString("utf8").replace(/\n$/, "");
  const agy = Bun.which("agy", { PATH: environment.PATH ?? "" });
  if (!agy) throw new Error("cannot build agy keychain mirror: agy executable is unavailable");
  const executable = resolveTrustedExecutable(agy, "agy", cwd);
  const keychain = join(home, AGY_MIRROR_PATH);
  const input = interactiveCommand(["add-generic-password", "-s", "gemini", "-a", "antigravity", "-l", "gemini",
    "-w", secret, "-T", "/usr/bin/security", "-T", executable, keychain]);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      invoke(["-i"], "cannot populate agy keychain mirror", input);
    } catch (error) {
      if (attempt === 1) throw error;
      password = prepareKeychainCopy(invoke, home, roots, password);
      continue;
    }
    return;
  }
}

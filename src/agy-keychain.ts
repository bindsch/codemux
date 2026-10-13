import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, sep } from "node:path";
import { resolveTrustedExecutable } from "./executable-security.js";
import { callLogPath } from "./call-log.js";

export const AGY_MIRROR_PATH = "Library/Keychains/login.keychain-db";
const SECURITY_TIMEOUT_MS = 10_000;
export const AGY_TEMPLATE_NAME = "agy-mirror-template.keychain-db";
const LOCK_WAIT_MS = 60_000;
const LOCK_POLL_MS = 25;
const EMPTY_LOCK_STALE_MS = 60_000;
// Apple's interactive reader has a 4096-byte buffer, including the terminator.
const SECURITY_LINE_BYTES = 4096;
export const agyKeychainHost = {
  home: homedir,
  securityPath: (_environment: NodeJS.ProcessEnv): string | undefined =>
    existsSync("/usr/bin/security") ? "/usr/bin/security" : undefined,
  spawnSync: Bun.spawnSync,
};

/** One location per login user, independent of adapter HOME and log overrides. */
export function agyKeychainStateDir(): string {
  return dirname(callLogPath({ HOME: agyKeychainHost.home() })!);
}

// Dangling search-list entries still need recovery. Resolve the existing
// ancestor so symlink escapes and canonical aliases obey the same boundary.
function canonicalPath(path: string): string {
  let canonical = parse(path).root;
  for (const part of path.slice(canonical.length).split(sep)) {
    if (!part || part === ".") continue;
    if (part === "..") { canonical = dirname(canonical); continue; }
    const candidate = join(canonical, part);
    try { canonical = realpathSync(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      canonical = candidate;
    }
  }
  return canonical;
}

function isPrivateKeychain(path: string): boolean {
  if (!isAbsolute(path)) return false;
  const canonical = canonicalPath(path);
  const root = canonicalPath(join(agyKeychainHost.home(), ".gemini", ".codemux-isolation-probes"));
  return canonical === canonicalPath(join(agyKeychainStateDir(), AGY_TEMPLATE_NAME)) ||
    canonical.startsWith(root + sep);
}

function client(environment: NodeJS.ProcessEnv, cwd?: string) {
  const path = agyKeychainHost.securityPath(environment);
  if (!path) return;
  const security = resolveTrustedExecutable(path, "security", cwd);
  // HOME selects the real login store, independently of instruction/config HOME.
  const env = { HOME: agyKeychainHost.home(), PATH: "/usr/bin:/bin" };
  return (args: string[], failure: string, stdin?: string): Buffer => {
    try {
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
  const invoke = client(environment);
  if (invoke && searchList(invoke).some(isPrivateKeychain)) {
    throw new Error("agy keychain cleanup failed: mirror remains in the user's Keychain search list");
  }
}

function restoreSearchList(invoke: NonNullable<ReturnType<typeof client>>, original: string[]): void {
  invoke(["list-keychains", "-d", "user", "-s", ...original], "cannot restore user Keychain search list");
  if (JSON.stringify(searchList(invoke)) !== JSON.stringify(original)) {
    throw new Error("user Keychain search list was not restored");
  }
}

function recoverSearchList(invoke: NonNullable<ReturnType<typeof client>>): void {
  const current = searchList(invoke);
  const restored = current.filter((path) => !isPrivateKeychain(path));
  if (restored.length !== current.length) restoreSearchList(invoke, restored);
  if (restored.some((path) => basename(path) === AGY_TEMPLATE_NAME || path.includes("/.codemux-isolation-probes/"))) {
    console.error("codemux: left an unrelated keychain with a codemux-like path in the user search list");
  }
}

/** Repair interrupted creation even when authentication does not need a mirror. */
export function recoverAgyKeychainSearchList(environment: NodeJS.ProcessEnv, cwd?: string): void {
  const invoke = client(environment, cwd);
  if (!invoke) return;
  const state = agyKeychainStateDir();
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const unlock = templateLock(join(state, `${AGY_TEMPLATE_NAME}.lock`));
  try { recoverSearchList(invoke); }
  finally { unlock(); }
}

/** Synchronous preparation uses an exclusive, process-owned lock across launches. */
function templateLock(path: string): () => void {
  const deadline = Date.now() + LOCK_WAIT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600);
      const identity = fstatSync(fd);
      try { writeFileSync(fd, String(process.pid)); }
      catch (error) { closeSync(fd); unlinkSync(path); throw error; }
      closeSync(fd);
      return () => {
        const current = lstatSync(path, { throwIfNoEntry: false });
        if (current?.ino === identity.ino && current.dev === identity.dev) unlinkSync(path);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      const identity = lstatSync(path);
      if (!identity.isFile()) throw new Error("agy template lock must be a regular file");
      const owner = readFileSync(path, "utf8");
      let stale = !owner && Date.now() - identity.mtimeMs > EMPTY_LOCK_STALE_MS;
      if (/^[1-9]\d*$/.test(owner)) {
        try { process.kill(Number(owner), 0); }
        catch (error) { stale = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      }
      if (stale) {
        const current = lstatSync(path);
        if (current.ino === identity.ino && current.dev === identity.dev) unlinkSync(path);
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) throw new Error("timed out waiting for agy template keychain lock");
    Atomics.wait(pause, 0, 0, LOCK_POLL_MS);
  }
}

function copyTemplate(invoke: NonNullable<ReturnType<typeof client>>,
  keychain: string, failedPassword?: string): string {
  const state = agyKeychainStateDir();
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const template = join(state, AGY_TEMPLATE_NAME);
  const passwordPath = `${template}.password`;
  const unlock = templateLock(`${template}.lock`);
  try {
    recoverSearchList(invoke);
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

/** Build outside scode. Never attach argv, output, or a subprocess error to an error. */
export function buildAgyKeychainMirror(home: string, environment: NodeJS.ProcessEnv, cwd?: string): void {
  const invoke = client(environment, cwd);
  if (!invoke) throw new Error("agy is not logged in; run `agy` to log in");
  const secret = invoke(["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"],
    "agy is not logged in; run `agy` to log in").toString("utf8").replace(/\n$/, "");
  const agy = Bun.which("agy", { PATH: environment.PATH ?? "" });
  if (!agy) throw new Error("cannot build agy keychain mirror: agy executable is unavailable");
  const executable = resolveTrustedExecutable(agy, "agy", cwd);
  const directory = join(home, "Library/Keychains");
  const keychain = join(home, AGY_MIRROR_PATH);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const input = interactiveCommand(["add-generic-password", "-s", "gemini", "-a", "antigravity", "-l", "gemini",
    "-w", secret, "-T", "/usr/bin/security", "-T", executable, keychain]);
  let failedPassword: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const password = copyTemplate(invoke, keychain, failedPassword);
    // The observed backend reports -25293 on a usable copy. Insertion decides.
    try { invoke(["-i"], "cannot unlock agy keychain mirror",
      interactiveCommand(["unlock-keychain", "-p", password, keychain])); }
    catch { /* A successful add below proves the copy is usable. */ }
    invoke(["-i"], "cannot configure agy keychain mirror", interactiveCommand(["set-keychain-settings", keychain]));
    try {
      invoke(["-i"], "cannot populate agy keychain mirror", input);
      return;
    } catch (error) {
      if (attempt === 1) throw error;
      failedPassword = password;
    }
  }
}

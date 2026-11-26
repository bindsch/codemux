// Fixtures for the keychain-home tests. Nothing here stores to or reads
// from a keychain: the probe asks Security.framework which keychain is the
// default one (SecKeychainCopyDefault returns a status and shows no window),
// and the stand-in account home holds an empty file named like a login
// keychain, which is all the default-keychain lookup checks for.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountHome } from "../../src/account-home.js";
import { KEYCHAIN_DIRECTORY, LOGIN_KEYCHAIN, keychainResolves, type KeychainHomeOptions } from "../../src/darwin-keychain-home.js";

/** errSecNoDefaultKeychain: the state in which a store shows the dialog. */
export const NO_DEFAULT_KEYCHAIN = -25307;

const PROBE = `
import { dlopen, FFIType, ptr } from "bun:ffi";
const lib = dlopen("/System/Library/Frameworks/Security.framework/Security", {
  SecKeychainCopyDefault: { args: [FFIType.ptr], returns: FFIType.i32 },
});
console.log(lib.symbols.SecKeychainCopyDefault(ptr(new BigUint64Array(1))));
`;

/** A scratch directory under the ignored scratch/fix tree, canonical. */
export function scratchRoot(label: string): string {
  const parent = join(import.meta.dir, "../../scratch/fix");
  mkdirSync(parent, { recursive: true });
  return realpathSync(mkdtempSync(join(parent, `${label}-`)));
}

/** A stand-in account home with a login keychain entry (an empty file). */
export function fakeAccountHome(root: string, withKeychain = true): string {
  const account = join(root, "account");
  mkdirSync(account, { recursive: true });
  if (withKeychain) {
    mkdirSync(join(account, KEYCHAIN_DIRECTORY), { recursive: true });
    writeFileSync(join(account, KEYCHAIN_DIRECTORY, LOGIN_KEYCHAIN), "");
  }
  return account;
}

/** Options that make the function act as on macOS with the stand-in account. */
export function darwinWith(account: string | null): KeychainHomeOptions {
  return { platform: "darwin", accountHome: account };
}

/** The SecKeychainCopyDefault status a child process with this HOME gets.
 * macOS only. The child is this bun binary; it queries and exits. */
export function defaultKeychainStatus(home: string): number {
  const child = Bun.spawnSync([process.execPath, "-e", PROBE], {
    cwd: "/", env: { HOME: home, PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe",
  });
  const text = child.stdout.toString().trim();
  if (child.exitCode !== 0 || !/^-?\d+$/.test(text)) {
    throw new Error(`keychain probe failed (exit ${child.exitCode}): ${child.stderr.toString().trim()}`);
  }
  return Number(text);
}

/** Whether this machine's account has a login keychain to link. The
 * builder tests use the real account home, because the builders do. */
export function accountHasLoginKeychain(): boolean {
  const account = accountHome();
  return process.platform === "darwin" && account !== null && keychainResolves(account);
}

const PATH_PROBE = `
import { dlopen, FFIType, ptr } from "bun:ffi";
const lib = dlopen("/System/Library/Frameworks/Security.framework/Security", {
  SecKeychainCopyDefault: { args: [FFIType.ptr], returns: FFIType.i32 },
  SecKeychainGetPath: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
});
const out = new BigUint64Array(1);
const status = lib.symbols.SecKeychainCopyDefault(ptr(out));
let path = "";
if (status === 0) {
  const length = new Uint32Array([4096]);
  const buffer = new Uint8Array(4096);
  if (lib.symbols.SecKeychainGetPath(out[0], ptr(length), ptr(buffer)) === 0) path = new TextDecoder().decode(buffer.subarray(0, length[0]));
}
console.log(JSON.stringify({ status, path }));
`;

/** The status and the path of the default keychain a child process with
 * this HOME is given. macOS only. Both calls only report: SecKeychainGetPath
 * returns the path string of the reference and opens nothing. */
export function defaultKeychain(home: string): { status: number; path: string } {
  const child = Bun.spawnSync([process.execPath, "-e", PATH_PROBE], {
    cwd: "/", env: { HOME: home, PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe",
  });
  if (child.exitCode !== 0) throw new Error(`keychain probe failed (exit ${child.exitCode}): ${child.stderr.toString().trim()}`);
  return JSON.parse(child.stdout.toString()) as { status: number; path: string };
}

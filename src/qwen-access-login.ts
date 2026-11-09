/**
 * The access-token-only Qwen login a private home receives.
 *
 * Qwen 0.24.0 (@qwen-code/qwen-code, read 2026-11-09) rewrites
 * `oauth_creds.json` through a temp file and a rename: saveCredentialsToFile
 * calls atomicWriteFile (chunks/chunk-6DB6UHY3.js:543-579,
 * chunk-CA63HYHU.js atomicWriteFile), and cacheQwenCredentials renames its
 * temp file over the name (chunk-6DB6UHY3.js:1362-1385). A refresh also
 * accepts a rotated refresh token (`tokenData.refresh_token ||
 * currentCredentials.refresh_token`, :495). So neither a copy nor a hard
 * link keeps a refresh with the operator's file: the rename gives the
 * private name a new inode, the rotated token stays in the private home,
 * and the operator's file keeps a token the provider may no longer accept.
 *
 * A private home therefore never holds the operator's refresh token. It
 * receives the access token, its type, expiry, and resource URL, rewritten
 * from the operator's file on every launch. validateCredentials requires a
 * nonempty refresh_token string (:179-198), so that field carries a fixed
 * placeholder that is not a credential: a refresh attempt with it fails at
 * the provider and cannot rotate or revoke the operator's grant. An access
 * token at or near expiry refuses the launch; the operator's own Qwen
 * refreshes the real file.
 */
import { join } from "node:path";
import { readFileBytesBounded } from "./file-io.js";
import { writePrivateFile } from "./private-write.js";

export const QWEN_LOGIN_FILE = "oauth_creds.json";
/** Not a credential: it only satisfies Qwen's credential-shape check. */
export const QWEN_ACCESS_ONLY_REFRESH_TOKEN = "codemux-access-only";
/** Qwen refreshes 30 s before expiry (TOKEN_REFRESH_BUFFER_MS, :157). */
const MINIMUM_REMAINING_MS = 60_000;

function refuse(source: string, reason: string): never {
  throw new Error(`qwen: the OAuth login at ${source} ${reason}`);
}

/** Writes `<directory>/oauth_creds.json` from `source`. The read is bounded
 * and refuses a symlink; nothing but the access fields is written. */
export function writeQwenAccessOnlyLogin(source: string, directory: string, now: number = Date.now()): void {
  const bytes = readFileBytesBounded(source, { maxBytes: 1024 * 1024, label: "Qwen OAuth credentials", noFollow: true });
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { refuse(source, "is not a parseable credential object"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(source, "is not a credential object");
  const { access_token: access, token_type: type, expiry_date: expiry, resource_url: resource } = value as Record<string, unknown>;
  if (typeof access !== "string" || !access || typeof type !== "string" || !type || typeof expiry !== "number") {
    refuse(source, "lacks an access token, token type, or expiry date");
  }
  if (expiry - now < MINIMUM_REMAINING_MS) {
    refuse(source, "holds an expired access token; run qwen once outside codemux to refresh it, then retry " +
      "(private homes never receive the refresh token)");
  }
  const login = { access_token: access, token_type: type, refresh_token: QWEN_ACCESS_ONLY_REFRESH_TOKEN,
    expiry_date: expiry, ...(typeof resource === "string" ? { resource_url: resource } : {}) };
  writePrivateFile(directory, QWEN_LOGIN_FILE, `${JSON.stringify(login)}\n`);
}

export function qwenLoginPath(brandHome: string): string {
  return join(brandHome, QWEN_LOGIN_FILE);
}

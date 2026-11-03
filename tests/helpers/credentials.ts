import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SecretReadResult } from "../../src/credentials.js";

export const SECRET = JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "r" } });
// A Keychain access token must be unexpired to be mirrored; the file side may hold anything.
export const FUTURE = Date.now() + 3_600_000;
export const LATER = FUTURE + 60_000;
export const gives = (value: string) => (_service: string): SecretReadResult => ({
  kind: "secret",
  value,
});
export const missing = (_service: string): SecretReadResult => ({ kind: "missing" });
export const errors = (_service: string): SecretReadResult => ({ kind: "error", detail: "locked" });

/** Backups for a temp target go beside it, never into the real ~/Library. */
export const BACKUPS = (target: string) => ({ backupDir: join(dirname(target), "backups") });

export function withTarget(fn: (target: string, dir: string) => void, seed = SECRET): void {
  const dir = mkdtempSync(join(tmpdir(), "codemux-cred-"));
  const target = join(dir, ".credentials.json");
  if (seed !== "") writeFileSync(target, `${seed}\n`, { mode: 0o600 });
  try {
    fn(target, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SECRET = JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "r" } });

export function withTarget(fn: (target: string, dir: string) => void, seed = SECRET): void {
  const scratch = join(import.meta.dir, "../../scratch/credential-tests");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "fixture-"));
  const target = join(dir, ".credentials.json");
  if (seed !== "") writeFileSync(target, `${seed}\n`, { mode: 0o600 });
  try {
    fn(target, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

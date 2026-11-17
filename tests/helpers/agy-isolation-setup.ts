import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyAdapter } from "../../src/adapters/agy.js";
import type { RunRequest } from "../../src/types.js";

export const dirs: string[] = [];
export function cleanupAgyIsolation(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}
export function setup(apiKey = true) {
  const home = mkdtempSync(join(tmpdir(), "codemux-agy-probe-test-"));
  dirs.push(home);
  const cwd = join(home, "workspace");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const request: RunRequest = { agent: "agy", prompt: "probe", cwd, autonomy: "read-only", sandboxed: true };
  return { home, request, adapter: new AgyAdapter({ HOME: home, ...(apiKey ? { GEMINI_API_KEY: "synthetic-api-key" } : {}) }) };
}

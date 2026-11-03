/** The shared experiment-bridge test setup: one temp cwd holding a spec
 * file and the run request that names it, plus the registry its consumers
 * clear in afterEach. Kept here so tests/experiment-bridge.test.ts and
 * tests/experiment-bridge-check.test.ts cannot drift apart. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RunRequest } from "../../src/types.js";

export const experimentDirs: string[] = [];

export function cleanupExperimentDirs(): void {
  for (const dir of experimentDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function setupExperiment(): {
  cwd: string;
  spec: { name: string; command: string; args: string[]; env: string[] };
  path: string;
  request: RunRequest;
} {
  const cwd = mkdtempSync(join(tmpdir(), "codemux-bridge-test-"));
  experimentDirs.push(cwd);
  const spec = { name: "experiment", command: process.execPath, args: ["--no-env-file", "--no-install",
    `--config=${resolve("bunfig.runtime.toml")}`, resolve("tests/fixtures/experiment-mcp.ts")], env: [] };
  const path = join(cwd, "spec.json");
  writeFileSync(path, JSON.stringify(spec));
  const request: RunRequest = { agent: "claude", prompt: "probe", cwd, hermetic: true, tools: "none",
    autonomy: "read-only", sandboxed: true, experimentMcp: path };
  return { cwd, spec, path, request };
}

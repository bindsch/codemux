import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { UsageRefusalError } from "./validation.js";
import { readBoundedKimiFile } from "./kimi-wire-log.js";

const KIMI_PROJECT_INPUTS = ["AGENTS.md", "agents.md", ".kimi-code", ".agents", ".mcp.json"] as const;
const MAX_GIT_POINTER_BYTES = 16 * 1024;

function present(path: string): boolean {
  try { return lstatSync(path, { throwIfNoEntry: false }) !== undefined; }
  catch { throw new UsageRefusalError(`kimi cannot inspect project configuration: ${path}`); }
}

function gitRoot(directory: string): boolean {
  const path = join(directory, ".git");
  let stat;
  try { stat = statSync(path); }
  catch { return false; }
  if (stat.isDirectory()) return true;
  if (!stat.isFile()) return false;
  if (stat.size > MAX_GIT_POINTER_BYTES) throw new UsageRefusalError(`kimi cannot inspect oversized Git pointer: ${path}`);
  try {
    const content = readBoundedKimiFile(realpathSync(path), MAX_GIT_POINTER_BYTES);
    const line = content.replace(/^\uFEFF/, "").trimStart().split(/\r?\n/, 1)[0]?.trim();
    return Boolean(line?.startsWith("gitdir:") && line.slice("gitdir:".length).trim());
  } catch { return false; }
}

/** Kimi reads instructions from the Git root through cwd, or just cwd outside Git. */
export function assertNoKimiHermeticProjectConfig(cwd: string): void {
  const leaf = realpathSync(cwd);
  const ancestors = [leaf];
  let directory = leaf;
  while (!gitRoot(directory)) {
    const parent = dirname(directory);
    if (directory === parent) { ancestors.splice(1); break; }
    directory = parent;
    ancestors.push(directory);
  }
  for (const base of ancestors.reverse()) {
    for (const name of KIMI_PROJECT_INPUTS) {
      const path = join(base, name);
      if (present(path)) throw new UsageRefusalError(`kimi hermetic runs refuse project customization: ${path}`);
    }
  }
}

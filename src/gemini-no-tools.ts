/**
 * The generated system-settings file behind gemini's `--tools none`.
 *
 * Gemini CLI 0.60.0 has no tool-removal flag (`--allowed-tools` only bypasses
 * confirmation and is deprecated), but the `tools.core` setting is an
 * allowlist: "Restrict the set of built-in tools with an allowlist"
 * (settings schema, `packages/cli/src/config/settingsSchema.ts` at 0.60.0).
 * An empty array is schema-valid (items are strings, no minimum length) and
 * is enforced twice. `loadCliConfig` passes `coreTools: settings.tools?.core
 * || void 0` (`packages/cli/src/config/config.ts`) — an empty array is
 * truthy, so it survives — and `Config.createToolRegistry`'s
 * `maybeRegister` (`packages/core/dist/src/config/config.js` in the shipped
 * bundle) keeps a built-in tool only when that non-null allowlist names it,
 * so no built-in registers and the model is never offered the schemas. The
 * policy engine adds a second, independent layer: whenever
 * `settings.tools.core` is set it resolves the listed tools to ALLOW and
 * then pushes `{toolName: "*", decision: DENY}` just beneath them
 * ("Settings (Core Tools Allowlist Enforcement)",
 * `packages/core/dist/src/policy/config.js`), which denies every remaining
 * execution path, MCP tools included.
 *
 * The settings reach the run through the system layer: codemux already
 * points `GEMINI_CLI_SYSTEM_SETTINGS_PATH` at a packaged settings file for
 * every gemini run (it pins `advanced.ignoreLocalEnv`), and that layer has
 * the highest merge precedence — `customDeepMerge(schemaDefaults,
 * systemDefaults, user, safeWorkspace, system)` merges system last
 * (`packages/cli/src/config/settings.ts`) — so the operator's user and
 * workspace settings cannot re-widen the list. A `--tools none` run writes
 * the same packaged pins plus `tools.core: []` into a private file and
 * points the variable there instead; the packaged file is read at launch
 * and merged rather than duplicated, so pins added to it later carry over.
 *
 * Gemini validates the file it is pointed at: `loadSystemFile`
 * (`packages/cli/src/config/settings.ts`) skips a system settings file whose
 * file or any ancestor directory is group- or world-writable or a symlink
 * (`isFileAndDirectorySecureSync`), with a warning, and the run would then
 * start with the tools restored. The file is created 0600 under a 0700
 * directory this process owns; the residual (an operator home loose enough
 * to fail that check) is recorded in docs/HERMETIC.md, and the capability
 * stays unclaimed until the live probe runs — gemini is not installed on
 * the release machine.
 *
 * The file lives under the real gemini directory in `.codemux/`, a
 * directory no gemini discovery scans (user extensions come from
 * `~/.gemini/extensions`, skills from `~/.gemini/skills`) and one scode
 * keeps reachable as harness state; never under the temp root, whose Linux
 * sandbox mount would hide it.
 */

import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface GeminiNoToolsSettings {
  /** The path for `GEMINI_CLI_SYSTEM_SETTINGS_PATH`. */
  path: string;
  /** Removes the file. */
  finalize: () => void;
}

const PARENT_DIR_NAME = ".codemux";
const FILE_PREFIX = "no-tools-";

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// A codemux that died without its exit handler leaves the file behind; it is
// swept only once older than any run could still be reading it.
const STALE_FILE_MS = 2 * 86_400_000;

/** Removes files left behind by codemux processes that no longer exist. */
function sweepStaleFiles(parent: string): void {
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = /^no-tools-(\d+)-/.exec(entry);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || processAlive(pid)) continue;
    const path = join(parent, entry);
    let age: number;
    try {
      age = Date.now() - statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (age < STALE_FILE_MS) continue;
    rmSync(path, { force: true });
  }
}

/**
 * Writes the no-tools system settings. `geminiDir` is the real gemini
 * directory a plain run reads (`~/.gemini`, or the operator's
 * GEMINI_CLI_HOME); `packagedSettingsPath` is codemux's packaged settings
 * file, whose pins are merged in. A missing or malformed packaged file
 * throws: the run must not start with its pins silently dropped.
 */
export function writeGeminiNoToolsSettings(
  geminiDir: string,
  packagedSettingsPath: string
): GeminiNoToolsSettings {
  let packaged: Record<string, unknown>;
  try {
    packaged = JSON.parse(
      readFileSync(packagedSettingsPath, "utf-8")
    ) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `cannot read codemux gemini settings ${packagedSettingsPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const settings = {
    ...packaged,
    tools: { ...(packaged.tools as Record<string, unknown>), core: [] },
  };

  const parent = join(geminiDir, PARENT_DIR_NAME);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // A run with write access to the gemini directory could have replaced the
  // parent with a symlink, pointing the sweep's rm elsewhere.
  const parentStat = lstatSync(parent);
  if (
    !parentStat.isDirectory() ||
    (process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      parentStat.uid !== process.getuid())
  ) {
    throw new Error(`${parent} must be a directory owned by the current user`);
  }
  sweepStaleFiles(parent);
  const path = join(
    parent,
    `${FILE_PREFIX}${process.pid}-${randomBytes(6).toString("hex")}.json`
  );
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });

  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    rmSync(path, { force: true });
    process.off("exit", finalize);
  };
  process.once("exit", finalize);

  return { path, finalize };
}

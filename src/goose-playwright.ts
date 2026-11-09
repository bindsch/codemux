/**
 * The sandbox-scoped Playwright MCP carrier for goose: the per-run stdio
 * extension. Goose has no `--mcp-config` flag; its CLI delivers extra MCP
 * servers as extension commands — `--with-extension
 * '[name:]ENV1=val1 ENV2=val2 command args...'`, repeatable, on both the
 * run and session commands ("Session behavior options shared between
 * Session and Run commands … Add stdio extensions from full commands with
 * environment variables. Can be specified multiple times.", goose 1.50.1
 * embedded help strings, read 2026-11-09). Without the optional name the
 * extension is named after its launcher, so the carrier names it
 * `playwright` explicitly: `--with-extension "playwright:<abs-binary>"`.
 *
 * The binary resolves and is trust-checked exactly the way the claude
 * family's `--mcp-config` carrier does (src/mcp.ts): the resolved path is
 * embedded in argv, and the captured check flows to the spawn site's
 * re-stat — the path sits inside a plain argument here, so the ordinary
 * command re-check sees it too, but the check rides along for uniformity
 * (the pi rule).
 *
 * This module is owned and tested; the shared all-surface allowlist
 * (PLAYWRIGHT_MCP_AGENTS, src/mcp.ts) still excludes goose, because the
 * shared session threading does not carry the flag to the turn builder
 * yet. Applying scratch/fix/w4-shared.patch flips goose's Playwright cells
 * to supported.
 */

import { executableCheck, resolveTrustedExecutable, type ExecutableCheck } from "./executable-security.js";

export interface GoosePlaywrightExtensionOptions {
  enabled: boolean;
  /** The PATH the binary resolves through: the adapter-built child
   * environment's PATH, never the ambient one (the mcp.ts rule). */
  pathEnv: string;
  forbiddenRoot?: string;
}

export interface GoosePlaywrightExtension {
  /** The argv to append to a `goose run` / `goose session` command. */
  args: string[];
  /** This build's trust check of the binary the argv names. */
  check: ExecutableCheck | null;
}

export function buildGoosePlaywrightExtension(
  sandboxed: boolean | undefined,
  options: GoosePlaywrightExtensionOptions
): GoosePlaywrightExtension {
  if (!sandboxed || !options.enabled) {
    return { args: [], check: null };
  }
  const binaryPath = Bun.which("playwright-mcp", { PATH: options.pathEnv });
  if (!binaryPath) {
    throw new Error(
      "--enable-playwright-mcp requires a locally installed playwright-mcp binary"
    );
  }
  const resolvedBinary = resolveTrustedExecutable(
    binaryPath,
    "playwright-mcp",
    options.forbiddenRoot
  );
  // Captured in the resolution's own synchronous block, so the spawn's
  // re-stat compares this build's identity, never another launch's.
  const check = executableCheck(resolvedBinary);
  return {
    args: ["--with-extension", `playwright:${resolvedBinary}`],
    check,
  };
}

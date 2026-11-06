/**
 * Probe P of the live gate: `run --print-sandbox` on every installed harness.
 * It spends nothing and must read or write no credential; the gate pairs it
 * with the Keychain hygiene snapshot (keychain.ts). Added 2026-11-03 after a
 * print-only agy path prepared credentials and raised a macOS Keychain prompt.
 */

import { realpathSync } from "node:fs";
import { getAdapter } from "../../src/adapters/index.js";
import { envProgramIndex } from "../../src/executable-security.js";
import type { AgentId } from "../../src/types.js";

/** Where the harness entry name leads on this machine: the PATH match and
 * the file it resolves to. The launch prints the resolved file, whose own
 * name can differ from the entry name (the Claude Code package installs
 * `claude` as a link to `bin/claude.exe`; live gate, 2026-11-06). */
export function resolvedBinaryPaths(binary: string, path = process.env.PATH ?? ""): string[] {
  const found = Bun.which(binary, { PATH: path });
  if (found === null) return [];
  try {
    return [found, realpathSync(found)];
  } catch {
    return [found];
  }
}

/** The command a printed argv would start inside the sandbox: the first
 * word after the `--` separator, past an `env` wrapper's own options and
 * assignments (agy and the private-home launches start through
 * `env NAME=value ...`). The wrapper is read by the launch path's own
 * parse (envProgramIndex), so both of its unset spellings count and a
 * prefix the launch would refuse names no command here either (review
 * round 188). Null when there is no separator, nothing follows it, or
 * the wrapper is malformed. */
export function printedCommand(lines: readonly string[]): string | null {
  const separator = lines.indexOf("--");
  if (separator === -1) return null;
  const command = lines.slice(separator + 1);
  try {
    return command[envProgramIndex(command) ?? 0] ?? null;
  } catch {
    return null;
  }
}

/** Probe P: the printed sandbox argv names scode and starts the harness
 * binary, one argument per line (docs/cli.md, --print-sandbox). scode is
 * the argv's first word, and the harness is judged past the `--` separator:
 * the command the sandbox would start must be the entry name, a path
 * ending in it, or the file that name resolves to. A harness path that
 * only appears as some argument does not count (review round 183). */
export function verifyPrintedSandbox(
  stdout: string,
  agent: AgentId,
  binaryName?: string,
  resolve: (binary: string) => string[] = resolvedBinaryPaths
): string | null {
  const lines = stdout.split("\n").filter((line) => line !== "");
  if (lines.length === 0) return "nothing was printed";
  // scode is the program the argv starts: its first word, not a word that
  // appears later (review round 192).
  const scode = lines[0]!;
  if (scode !== "scode" && !scode.endsWith("/scode")) return "the printed argv does not name scode";
  // The candidate's own binary name when the listing carried one (round 52).
  const binary = binaryName ?? getAdapter(agent).binaryName;
  const command = printedCommand(lines);
  if (command !== null &&
    (command === binary || command.endsWith(`/${binary}`) || resolve(binary).includes(command))) {
    return null;
  }
  return `the printed argv does not name the ${agent} binary (${binary})`;
}

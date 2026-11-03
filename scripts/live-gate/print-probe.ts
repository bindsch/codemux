/**
 * Probe P of the live gate: `run --print-sandbox` on every installed harness.
 * It spends nothing and must read or write no credential; the gate pairs it
 * with the Keychain hygiene snapshot (keychain.ts). Added 2026-11-03 after a
 * print-only agy path prepared credentials and raised a macOS Keychain prompt.
 */

import { getAdapter } from "../../src/adapters/index.js";
import type { AgentId } from "../../src/types.js";
/** Probe P: the printed sandbox argv names scode and the harness binary, one
 * argument per line (docs/cli.md, --print-sandbox). */
export function verifyPrintedSandbox(stdout: string, agent: AgentId, binaryName?: string): string | null {
  const lines = stdout.split("\n").filter((line) => line !== "");
  if (lines.length === 0) return "nothing was printed";
  if (!lines.some((line) => line === "scode" || line.endsWith("/scode"))) return "the printed argv does not name scode";
  // The candidate's own binary name when the listing carried one (round 52).
  const binary = binaryName ?? getAdapter(agent).binaryName;
  if (!lines.some((line) => line === binary || line.endsWith(`/${binary}`))) {
    return `the printed argv does not name the ${agent} binary (${binary})`;
  }
  return null;
}

import { join } from "node:path";
import { writeOwnedSync } from "./fs-durable.js";
import type { ToolSelection } from "./types.js";

/** Gemini 0.60.0 accepts --policy paths at the user tier. A priority of
 * 999 outranks built-in and workspace rules in every approval mode.
 * Evidence: gemini-LUNNHKPJ.js option("policy"); chunk-M6NSK26M.js
 * PolicyRuleSchema/getPolicyTier (2026-11-09). */
export const GEMINI_POLICY_PRIORITY = 999;
export const GEMINI_POLICY_FILENAME = "codemux-policy.toml";
export const GEMINI_WEB_TOOLS = ["google_web_search", "web_fetch"] as const;

export function geminiToolPolicy(options: { tools?: ToolSelection; web?: boolean }): string | null {
  const names = options.tools === "none" ? ["*"] : options.web === false ? [...GEMINI_WEB_TOOLS] : [];
  if (names.length === 0) return null;
  return names.map((name) =>
    `[[rule]]\ntoolName = ${JSON.stringify(name)}\ndecision = "deny"\npriority = ${GEMINI_POLICY_PRIORITY}\n`
  ).join("\n");
}

export function writeGeminiToolPolicy(
  home: string,
  options: { tools?: ToolSelection; web?: boolean }
): string | null {
  const policy = geminiToolPolicy(options);
  if (policy === null) return null;
  const path = join(home, GEMINI_POLICY_FILENAME);
  writeOwnedSync(path, policy, 0o600);
  return path;
}

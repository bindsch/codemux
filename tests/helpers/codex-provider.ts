import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The provider-override settings every codex-provider test writes into the
// session home's config.toml.
export const OVERRIDE = {
  baseUrl: "http://127.0.0.1:9/v1",
  apiKey: "unit-key",
  maxContextTokens: 32768,
};
export const MODEL = "clawvm-qwen32b-coder";
export const SESSION_ID = "0123456789abcdef";

export function makeCodexHome(): string {
  return mkdtempSync(join(tmpdir(), "cmx-codprov-"));
}

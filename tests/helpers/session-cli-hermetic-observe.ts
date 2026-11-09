// Loaded only by the synthetic harness wrappers in session-cli-hermetic.ts.
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME!;
const marker = join(home, "synthetic-session-state");
const previous = existsSync(marker) ? readFileSync(marker, "utf8") : null;
const state = previous ?? crypto.randomUUID();
if (previous === null) writeFileSync(marker, state, { mode: 0o600 });
const codexHome = process.env.CODEX_HOME ?? null;
const kimiHome = process.env.KIMI_CODE_HOME ?? null;
const config = codexHome === null ? null : join(codexHome, "config.toml");
appendFileSync(join(process.env.FAKE_STATE_DIR!, "homes.jsonl"), `${JSON.stringify({
  home,
  codexHome,
  kimiHome,
  mode: statSync(home).mode & 0o777,
  previous,
  state,
  config: config !== null && existsSync(config) ? readFileSync(config, "utf8") : null,
  hasProviderKey: process.env.CODEMUX_CODEX_PROVIDER_API_KEY !== undefined,
})}\n`);

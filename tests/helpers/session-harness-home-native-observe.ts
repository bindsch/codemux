import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME!;
const agent = process.env.FAKE_NATIVE_AGENT!;
const configPaths: Record<string, string> = {
  kimi: ".kimi-code/config.toml", opencode: ".config/opencode/opencode.json",
  agy: ".gemini/antigravity-cli/settings.json", aider: ".aider.conf.yml",
};
const configPath = join(home, configPaths[agent]!);
const providerPath = process.env.OPENCODE_CONFIG;
appendFileSync(join(process.env.FAKE_STATE_DIR!, "native-homes.jsonl"), JSON.stringify({
  home, args: process.argv.slice(2), config: existsSync(configPath) ? readFileSync(configPath, "utf8") : null,
  skill: readFileSync(join(home, "caller-skill.md"), "utf8"),
  kimiHome: process.env.KIMI_CODE_HOME, opencodeConfig: process.env.OPENCODE_CONFIG_DIR,
  providerPath, provider: providerPath && existsSync(providerPath) ? readFileSync(providerPath, "utf8") : null,
  providerKey: Boolean(process.env.CODEMUX_OPENCODE_PROVIDER_API_KEY),
}) + "\n");

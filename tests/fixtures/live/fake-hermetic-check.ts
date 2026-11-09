/** Synthetic instruction discovery. No harness, credential, or provider is used.
 * The switch's cases are per agent, not scenarios; each answers the canary
 * marker when the instruction file it models is reachable, and OK otherwise:
 *   claude    — CLAUDE.md in the cwd unless --safe-mode (zai shares the arm)
 *   codex     — AGENTS.md in the cwd unless project_doc_max_bytes=0
 *   opencode  — AGENTS.md in the cwd unless OPENCODE_DISABLE_PROJECT_CONFIG=1
 *   pi        — AGENTS.md in the cwd unless --no-context-files
 *   copilot   — copilot-instructions.md under COPILOT_HOME unless --no-custom-instructions
 *   gemini    — .gemini/GEMINI.md under GEMINI_CLI_HOME or HOME
 *   kimi      — AGENTS.md under KIMI_CODE_HOME
 *   agy       — .gemini/GEMINI.md under HOME
 *   aider     — the file a HOME .aider.conf.yml names under read:
 *   droid     — .factory/AGENTS.md under FACTORY_HOME_OVERRIDE or HOME
 *   goose     — goose/.goosehints under XDG_CONFIG_HOME
 *   openhands — .openhands/microagents/canary.md under HOME */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentId } from "../../../src/types.js";

export interface FakeHermeticCheckInput {
  agent: AgentId;
  cwd: string;
  command: readonly string[];
  environment: Record<string, string | undefined>;
  cleanControl?: boolean;
}

/** Apply nested env prefixes in their actual order. Native hermetic prefixes
 * must override the planted home added by the check adapter. */
function commandEnvironment(input: FakeHermeticCheckInput): Record<string, string | undefined> {
  const environment = { ...input.environment };
  let index = 0;
  while (input.command[index] === "env") {
    index++;
    while (index < input.command.length) {
      const arg = input.command[index]!;
      if (arg === "-u") {
        delete environment[input.command[index + 1]!];
        index += 2;
      } else if (/^[A-Z_][A-Z0-9_]*=/.test(arg)) {
        const separator = arg.indexOf("=");
        environment[arg.slice(0, separator)] = arg.slice(separator + 1);
        index++;
      } else break;
    }
  }
  return environment;
}

/** These paths and flags are independent of the production channel table. */
export function fakeHermeticCheckAnswer(input: FakeHermeticCheckInput): string {
  if (input.cleanControl) return "OK\n";
  const env = commandEnvironment(input);
  const home = env.HOME ?? input.cwd;
  const has = (flag: string) => input.command.includes(flag);
  let path: string | undefined;
  switch (input.agent) {
    case "claude": case "zai":
      if (!has("--safe-mode")) path = join(input.cwd, "CLAUDE.md");
      break;
    case "codex":
      if (!has("project_doc_max_bytes=0")) path = join(input.cwd, "AGENTS.md");
      break;
    case "opencode":
      if (env.OPENCODE_DISABLE_PROJECT_CONFIG !== "1") path = join(input.cwd, "AGENTS.md");
      break;
    case "pi":
      if (!has("--no-context-files")) path = join(input.cwd, "AGENTS.md");
      break;
    case "copilot":
      if (!has("--no-custom-instructions")) {
        path = join(env.COPILOT_HOME ?? join(home, ".copilot"), "copilot-instructions.md");
      }
      break;
    case "gemini":
      path = join(env.GEMINI_CLI_HOME ?? home, ".gemini", "GEMINI.md");
      break;
    case "kimi":
      path = join(env.KIMI_CODE_HOME ?? join(home, ".kimi-code"), "AGENTS.md");
      break;
    case "agy":
      path = join(home, ".gemini", "GEMINI.md");
      break;
    case "aider": {
      const config = join(home, ".aider.conf.yml");
      if (existsSync(config)) {
        const target = /read:\s*\[?\s*["']?([^\n"'\]]+)/.exec(readFileSync(config, "utf8"))?.[1]?.trim();
        if (target) path = target.startsWith("~/") ? join(home, target.slice(2)) : join(home, target);
      }
      break;
    }
    case "droid":
      path = join(env.FACTORY_HOME_OVERRIDE ?? home, ".factory", "AGENTS.md");
      break;
    case "goose":
      path = join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "goose", ".goosehints");
      break;
    case "openhands":
      path = join(home, ".openhands", "microagents", "canary.md");
      break;
    default:
      throw new Error(`No synthetic instruction reader for ${input.agent}`);
  }
  if (!path || !existsSync(path)) return "OK\n";
  const marker = /CODEMUX-(?:AGY-)?CANARY-[A-Z0-9-]+/i.exec(readFileSync(path, "utf8"))?.[0];
  return marker ? `${marker}\n` : "OK\n";
}

if (import.meta.main) {
  const input = JSON.parse(await Bun.stdin.text()) as FakeHermeticCheckInput;
  process.stdout.write(fakeHermeticCheckAnswer(input));
}

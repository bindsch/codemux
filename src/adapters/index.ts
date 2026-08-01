import { AGENT_IDS, type AgentId } from "../types.js";
import { BaseAdapter } from "./base.js";
import { AiderAdapter } from "./aider.js";
import { ClaudeAdapter } from "./claude.js";
import { ClineAdapter } from "./cline.js";
import { CodexAdapter } from "./codex.js";
import { CopilotAdapter } from "./copilot.js";
import { CursorAdapter } from "./cursor.js";
import { DroidAdapter } from "./droid.js";
import { GooseAdapter } from "./goose.js";
import { GeminiAdapter } from "./gemini.js";
import { OpencodeAdapter } from "./opencode.js";
import { PiAdapter } from "./pi.js";
import { QwenAdapter } from "./qwen.js";
import { ZaiAdapter } from "./zai.js";

const adapters: Readonly<Record<AgentId, BaseAdapter>> = Object.freeze({
  aider: new AiderAdapter(),
  claude: new ClaudeAdapter(),
  cline: new ClineAdapter(),
  codex: new CodexAdapter(),
  copilot: new CopilotAdapter(),
  cursor: new CursorAdapter(),
  droid: new DroidAdapter(),
  goose: new GooseAdapter(),
  gemini: new GeminiAdapter(),
  opencode: new OpencodeAdapter(),
  pi: new PiAdapter(),
  qwen: new QwenAdapter(),
  zai: new ZaiAdapter(),
});

export function getAdapter(id: AgentId): BaseAdapter {
  const adapter = adapters[id];
  if (!adapter) {
    throw new Error(`Unknown agent: ${id}`);
  }
  return adapter;
}

export function getAllAdapters(): readonly BaseAdapter[] {
  return Object.values(adapters);
}

export function getAvailableAdapters(): readonly BaseAdapter[] {
  return getAllAdapters().filter((a) => a.isAvailable());
}

export { AGENT_IDS };

export { BaseAdapter };

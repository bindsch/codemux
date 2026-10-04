import { AGENT_IDS, type AgentId } from "../types.js";
import { BaseAdapter } from "./base.js";
import { AgyAdapter } from "./agy.js";
import { AiderAdapter } from "./aider.js";
import { ClaudeAdapter } from "./claude.js";
import { ClineAdapter } from "./cline.js";
import { CodexAdapter } from "./codex.js";
import { CopilotAdapter } from "./copilot.js";
import { CursorAdapter } from "./cursor.js";
import { DroidAdapter } from "./droid.js";
import { GooseAdapter } from "./goose.js";
import { GeminiAdapter } from "./gemini.js";
import { KimiAdapter } from "./kimi.js";
import { OpenHandsAdapter } from "./openhands.js";
import { OpencodeAdapter } from "./opencode.js";
import { PiAdapter } from "./pi.js";
import { QwenAdapter } from "./qwen.js";
import { ZaiAdapter } from "./zai.js";

// The environment view an adapter is constructed against. The launch path
// passes nothing and gets process.env — the operator's shell, exported
// opt-ins included (cursor's CODEMUX_CURSOR_ENTRY is the one today).
// Static diagnostics pass their own explicit view (verify an empty one),
// so an exported variable cannot change a static wiring result. Only
// cursor's constructor consumes the view; adapters whose environment is
// plumbing (codex's and zai's HOME/CODEX_HOME seams) keep process.env.
type AdapterEnv = Record<string, string | undefined>;
type AdapterFactory = (env: AdapterEnv) => BaseAdapter;

const adapterFactories: Readonly<Record<AgentId, AdapterFactory>> = Object.freeze({
  agy: () => new AgyAdapter(),
  aider: () => new AiderAdapter(),
  claude: () => new ClaudeAdapter(),
  cline: () => new ClineAdapter(),
  codex: () => new CodexAdapter(),
  copilot: () => new CopilotAdapter(),
  cursor: (env) => new CursorAdapter(undefined, env),
  droid: () => new DroidAdapter(),
  goose: () => new GooseAdapter(),
  gemini: () => new GeminiAdapter(),
  kimi: () => new KimiAdapter(),
  openhands: () => new OpenHandsAdapter(),
  opencode: () => new OpencodeAdapter(),
  pi: () => new PiAdapter(),
  qwen: () => new QwenAdapter(),
  zai: () => new ZaiAdapter(),
});

// Constructed per call, never cached: an adapter views the environment at
// the moment it is obtained, so a caller that passes its own view (verify)
// or a test that exports an opt-in mid-process is never answered from a
// stale module-load snapshot. Construction is spawn-free Bun.which work,
// so nothing here costs a process.
export function getAdapter(id: AgentId, env: AdapterEnv = process.env): BaseAdapter {
  const factory = adapterFactories[id];
  if (!factory) {
    throw new Error(`Unknown agent: ${id}`);
  }
  return factory(env);
}

export function getAllAdapters(): readonly BaseAdapter[] {
  return Object.values(adapterFactories).map((factory) => factory(process.env));
}

export function getAvailableAdapters(): readonly BaseAdapter[] {
  return getAllAdapters().filter((a) => a.isAvailable());
}

export { AGENT_IDS };

export { BaseAdapter };

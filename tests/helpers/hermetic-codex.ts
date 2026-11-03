import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../../src/adapters/codex.js";
import type { RunContext } from "../../src/adapters/base.js";
import type { RunRequest } from "../../src/types.js";

export { newSignalListeners, signalListeners } from "./signal-listeners.js";
export type { SignalListener } from "./signal-listeners.js";

export const scratch: string[] = [];
// Every context this describe prepares, disposed per launch -- the same
// ownership rule the launcher follows, never a whole-adapter sweep.
export const prepared: { adapter: CodexAdapter; context: RunContext }[] = [];
export const codexAdapter = (env: NodeJS.ProcessEnv, home?: string): CodexAdapter =>
  new CodexAdapter(env, home);
export const prepare = (adapter: CodexAdapter, request: RunRequest): RunContext => {
  const context = adapter.prepareRun(request);
  prepared.push({ adapter, context });
  return context;
};

export function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "codemux-codex-home-"));
  scratch.push(home);
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "auth.json"), '{"tokens":{"access_token":"a"}}\n', { mode: 0o600 });
  return home;
}

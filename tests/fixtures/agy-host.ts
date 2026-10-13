import { realpathSync } from "node:fs";
// Test-only host seams. Production never reads these fixture environment keys.
import { agyKeychainHost } from "../../src/agy-keychain.js";

export const productionSecurityPath = agyKeychainHost.securityPath;
const spawnSync = agyKeychainHost.spawnSync;
const environments = new Map<string, NodeJS.ProcessEnv>();
// Keys are canonical paths: the client resolves the binary through the trust
// check, which canonicalizes it (macOS temp dirs live under a symlink).
const canonical = (path: string) => { try { return realpathSync(path); } catch { return path; } };
agyKeychainHost.securityPath = (env) => {
  const path = env.CODEMUX_TEST_AGY_SECURITY;
  if (path) environments.set(canonical(path), env);
  return path;
};
agyKeychainHost.spawnSync = ((command: string[], options: Parameters<typeof Bun.spawnSync>[1]) => {
  const env = environments.get(canonical(command[0]!));
  return spawnSync(command, { ...options, env: { ...env, ...options?.env } });
}) as typeof Bun.spawnSync;
// Child CLI tests already run with an isolated HOME.
agyKeychainHost.home = () => process.env.HOME!;

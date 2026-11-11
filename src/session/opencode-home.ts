import { linkSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertNoCallerBlockOverStateDirs, type SandboxOptions } from "../sandbox.js";
import { opencodeRemoteConfigCarrier } from "../opencode-remote-config.js";
import { hermeticRemoteConfigRefusal } from "../adapters/opencode-env.js";
import { UsageRefusalError } from "../validation.js";
import { carryOpencodeModelState } from "../opencode-hermetic.js";
import { openSessionPrivateHome } from "./private-home.js";
import type { SessionPrivateHome } from "./private-home-types.js";
import { OPENCODE_SESSION_ID_PATTERN } from "./opencode-session.js";
import { callerHarnessHomeEnvAssignments, isCallerHarnessHome } from "./harness-home.js";
import type { CallerHarnessHome } from "./harness-home.js";
import type { ProviderOverride } from "../provider-override.js";
import type { RunContext } from "../run-context.js";
import { writeOpencodeProviderConfig } from "../opencode-provider.js";

/** Provider overlays merge with caller settings and live beneath the caller root. */
export function prepareOpenCodeCallerTurnContext(
  home: CallerHarnessHome,
  override: ProviderOverride | null,
  model: string | undefined,
  argv: readonly string[],
  printOnly = false
): { context: RunContext; argv: string[] } {
  if (override === null) return { context: {}, argv: [...argv] };
  const native = argv.lastIndexOf("opencode");
  if (native === -1) throw new Error("OpenCode caller turn is missing its native command");
  const selected = model ?? override.model;
  if (!override.baseUrl || !override.apiKey || !selected) {
    throw new UsageRefusalError("opencode provider override requires a base URL, API key, and model");
  }
  if (!printOnly) home.verify();
  const data = join(home.dir, ".local", "share", "opencode");
  const config = printOnly
    ? { path: join(data, ".codemux", "provider-preview", "opencode.json"), finalize() {} }
    : writeOpencodeProviderConfig(data,
      { ...override, baseUrl: override.baseUrl, apiKey: override.apiKey }, selected);
  const assignment = `OPENCODE_CONFIG=${config.path}`;
  const command = native === 0
    ? ["env", ...callerHarnessHomeEnvAssignments(home), assignment, ...argv]
    : [...argv.slice(0, native), assignment, ...argv.slice(native)];
  return { context: { opencodeProviderConfig: config }, argv: command };
}

/** OpenCode 1.19.5, bin/opencode, read 2026-11-09: Global.Path.data
 * derives from XDG_DATA_HOME; Auth reads data/auth.json. Only that login
 * is linked. The native database stays inside the session's private home. */
export function openOpenCodeSessionHome(input: {
  dataDir: string;
  stateDir: string;
  resumeSessionId?: string;
  printOnly?: boolean;
}): SessionPrivateHome {
  return openSessionPrivateHome({
    printOnly: input.printOnly,
    parent: join(input.dataDir, ".codemux-hermetic"),
    sessionId: input.resumeSessionId,
    resume: input.resumeSessionId !== undefined,
    idPattern: OPENCODE_SESSION_ID_PATTERN,
    blockedPaths: [input.dataDir, input.stateDir],
    populate(dir) {
      if (input.printOnly) return;
      const privateData = join(dir, ".local", "share", "opencode");
      mkdirSync(privateData, { recursive: true, mode: 0o700 });
      const auth = join(input.dataDir, "auth.json");
      linkLogin(auth, join(privateData, "auth.json"));
      const problem = carryOpencodeModelState(input.stateDir, dir);
      if (problem) throw new Error(`opencode session model state: ${problem}`);
    },
  });
}

/** OpenCode rewrites auth.json in place (opencode-hermetic.ts), and its
 * OAuth providers rotate refresh tokens. A copy in this persistent home
 * would strand a rotated token and leave the real login stale (review
 * R420 M4 class), so the home holds a HARD LINK, the codex rule. The home
 * lives under the real data directory, so a link failure refuses instead
 * of falling back to a copy or a symlink the sandbox would block. */
function linkLogin(source: string, destination: string): void {
  let stat;
  try { stat = lstatSync(source); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("opencode session login must be an owned regular file");
  }
  if (!stat.isFile() || stat.uid !== process.getuid?.()) {
    throw new Error("opencode session login must be an owned regular file");
  }
  try { linkSync(source, destination); }
  catch { throw new Error("opencode session login cannot be hard-linked into the private home"); }
  const linked = lstatSync(destination);
  if (linked.ino !== stat.ino || linked.dev !== stat.dev) throw new Error("opencode session login changed while linking");
}

/** Keep data/state across turns. HOME, config, and cache stay in the fresh
 * per-turn home so a prior turn cannot install later permission overrides.
 * Recheck the private login/database because both can carry remote config. */
export function openCodeSessionHomePrefix(home: SessionPrivateHome): string[] {
  if (isCallerHarnessHome(home)) {
    home.verify();
    return ["env", ...callerHarnessHomeEnvAssignments(home)];
  }
  const dir = home.dir;
  const carrier = opencodeRemoteConfigCarrier(join(dir, ".local", "share", "opencode"));
  if (carrier) throw new UsageRefusalError(hermeticRemoteConfigRefusal(carrier));
  return [
    "env",
    `XDG_STATE_HOME=${join(dir, ".local", "state")}`,
    `XDG_DATA_HOME=${join(dir, ".local", "share")}`,
  ];
}

/** Replace the initial home spelling after settlement and allow only this
 * turn's provider config beside the blocked real data directory. */
export function openCodeSessionSandboxOptions(
  options: SandboxOptions,
  home: SessionPrivateHome,
  initialHome: string,
  providerConfigPath?: string,
  callerBlockPaths: readonly string[] = [],
  turnHome?: string
): SandboxOptions {
  const directories = [home.dir, ...(turnHome ? [turnHome] : []),
    ...(providerConfigPath ? [dirname(providerConfigPath)] : [])];
  assertNoCallerBlockOverStateDirs(callerBlockPaths, directories);
  return { ...options, harnessStateDirs: [
    ...(options.harnessStateDirs ?? []).filter((path) => path !== initialHome),
    ...directories,
  ] };
}

/** Rename only after the turn process has settled; SQLite may still have
 * open files while it is producing output. A failed rename forbids resume. */
export function settleOpenCodeSessionHome(home: SessionPrivateHome, id: string): boolean {
  if (isCallerHarnessHome(home)) return true;
  try {
    home.settle(id);
    return true;
  } catch (error) {
    console.error(`codemux: opencode session home settlement failed: ${String(error)}`);
    return false;
  }
}

export async function finishOpenCodeSessionHome(
  home: SessionPrivateHome | null | undefined,
  input: { final: boolean; resumable: boolean; sessionId: string | null }
): Promise<{ usable: boolean; removed: boolean }> {
  if (!home || isCallerHarnessHome(home)) return { usable: true, removed: false };
  const remove = (): boolean => {
    try { return home.remove(); }
    catch (error) {
      console.error(`codemux: opencode session home removal failed: ${String(error)}`);
      return false;
    }
  };
  if (input.final) {
    if (remove()) return { usable: false, removed: true };
    await Bun.sleep(100);
    if (remove()) return { usable: false, removed: true };
  }
  if (input.resumable && input.sessionId !== null) {
    return { usable: settleOpenCodeSessionHome(home, input.sessionId), removed: false };
  }
  if (!home.resumed && !input.final) remove();
  return { usable: false, removed: false };
}

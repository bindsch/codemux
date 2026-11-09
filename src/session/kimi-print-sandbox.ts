// `codemux session -a kimi --print-sandbox`: the representative first-turn
// argv under the session's sandbox policy, printed without opening state.
// Split from src/session/cli-spawn-prep.ts for the file-size rule.
import type { BaseAdapter } from "../adapters/base.js";
import { buildPlaywrightSandboxMcp } from "../mcp.js";
import { withKeepEnvExemption, type SandboxOptions } from "../sandbox.js";
import type { AutonomyLevel, RunRequest } from "../types.js";
import { escapeArgvForPrint } from "../usage-protocol.js";
import { kimiHarnessHome } from "./cli-homes.js";
import type { SessionEnvironmentBuilder } from "./cli-environment.js";
import { isCallerHarnessHome } from "./harness-home.js";
import { buildKimiSessionPreview } from "./kimi-preview.js";
import { kimiHermeticTurnContext } from "./kimi-turn-context.js";
import type { SessionPrivateHome } from "./private-home-types.js";
import { resolveSessionSandboxSpawn } from "./spawn.js";

export async function printKimiSessionSandbox(input: {
  adapter: BaseAdapter; runLike: RunRequest; sessionPrivateHome: SessionPrivateHome | null;
  buildSessionEnvironment: SessionEnvironmentBuilder; overrideActive: boolean;
  model: string | undefined; resumeId: string | undefined; enablePlaywrightMcp: boolean | undefined;
  workdir: string; requestedAutonomy: AutonomyLevel; sandboxOptions: SandboxOptions | undefined;
}): Promise<string[]> {
  const { adapter, runLike, sessionPrivateHome: home, workdir } = input;
  const probe = input.buildSessionEnvironment(home === null ? undefined : kimiHermeticTurnContext(home));
  const preview = buildKimiSessionPreview({ model: input.overrideActive ? undefined : input.model,
    resumeSessionId: input.resumeId, homeDir: home?.dir,
    callerHome: isCallerHarnessHome(home) ? home : undefined,
    harnessHome: kimiHarnessHome([...(runLike.passthroughEnv ?? [])]),
    hermetic: runLike.hermetic === true, projectSettings: runLike.experimentProjectSettings,
    tools: runLike.tools });
  const mcp = buildPlaywrightSandboxMcp(true, { enabled: input.enablePlaywrightMcp,
    pathEnv: adapter.executionPathEnv(), forbiddenRoot: workdir });
  const policy = input.sandboxOptions === undefined ? undefined : withKeepEnvExemption(
    input.sandboxOptions, { ...adapter.getEnv(), ...probe.runEnv }, input.overrideActive);
  const { scodeCmd } = await resolveSessionSandboxSpawn(preview, probe.env, {
    cwd: workdir, sandboxed: true, autonomy: input.requestedAutonomy, sandboxOptions: policy,
    envOmissions: adapter.getEnvOmissions(), extraExecutableChecks: mcp.check ? [mcp.check] : [],
  }, workdir);
  process.stdout.write(`${scodeCmd.map(escapeArgvForPrint).join("\n")}\n`);
  return preview;
}

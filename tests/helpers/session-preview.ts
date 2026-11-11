import { spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { getAdapter } from "../../src/adapters/index.js";
import { getDefaultConfig } from "../../src/config.js";
import * as copilotProject from "../../src/copilot-project-settings.js";
import * as runtime from "../../src/cli-runtime.js";
import { SESSION_AGENTS } from "../../src/session/cli-agents.js";
import * as homes from "../../src/session/cli-homes.js";
import { prepareSessionLaunch } from "../../src/session/cli-launch.js";
import { prepareSessionChild } from "../../src/session/cli-spawn-prep.js";
import { isTurnAgent } from "../../src/session/turn-driver-launch.js";
import { turnAgentStateRoot } from "../../src/session/turn-driver-homes.js";
import type { SandboxOptions } from "../../src/sandbox.js";
import type { AgentId, RunRequest } from "../../src/types.js";
import { createFakeBinaryEnv } from "./cli.js";

/** All paths and version responses are synthetic; no harness may start. */
export function sessionPreviewFixture(agent: AgentId) {
  const root = realpathSync(mkdtempSync(join(import.meta.dir, "../../scratch/session-preview-")));
  const home = join(root, "home"), cwd = join(home, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const binary = getAdapter(agent, {}).binaryName;
  const fake = createFakeBinaryEnv({
    scode: 'if [ "$1" = --help ]; then echo --keep-env; exit 0; fi; exit 99',
  });
  symlinkSync("/bin/echo", join(fake.env.PATH!.split(":")[0]!, binary));
  const original = { ...process.env }, prefix = `CODEMUX_${agent.toUpperCase()}_PROVIDER_`;
  const environment = { ...fake.env, HOME: home, QWEN_HOME: join(home, ".qwen"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache"),
    ZAI_API_KEY: "synthetic", GEMINI_API_KEY: "synthetic",
    ...(getAdapter(agent, {}).capabilities().supportsProviderOverride ? {
      [`${prefix}BASE_URL`]: "https://provider.invalid/v1", [`${prefix}API_KEY`]: "synthetic",
      [`${prefix}MODEL`]: "synthetic" } : {}) };
  Object.assign(process.env, environment);
  const mocks = [
    spyOn(homes, "aiderHarnessHome").mockReturnValue(join(home, ".aider")),
    spyOn(homes, "kimiHarnessHome").mockReturnValue(join(home, ".kimi-code")),
    spyOn(homes, "agyHarnessHome").mockReturnValue(join(home, ".gemini", "antigravity-cli")),
    spyOn(process.stdout, "write").mockReturnValue(true),
    spyOn(process.stderr, "write").mockReturnValue(true),
    spyOn(runtime, "assertHarnessSupported").mockResolvedValue(SESSION_AGENTS[agent]!.floor),
    // This fixture lives below the repository's .github. Project-root
    // validation is covered separately; exercise real policy preparation here.
    ...(agent === "copilot" ? [spyOn(copilotProject, "validateCopilotProjectSettingsRun").mockImplementation(() => {})] : []),
  ];
  const adapter = getAdapter(agent, environment), override = adapter.providerOverride();
  const id = agent === "cline" ? "1234567890123_abcde_cli" : agent === "opencode" ? "ses_abcdefgh1234"
    : agent === "openhands" ? "1234567890abcdef1234567890abcdef" : `${agent === "kimi" ? "session_" : ""}1b91a970-7a85-421e-b9d0-09b06665b637`;
  const hermetic = SESSION_AGENTS[agent]!.hermetic;
  const stateRoot = isTurnAgent(agent) ? turnAgentStateRoot(agent, []) : agent === "opencode"
    ? join(home, ".local/share/opencode") : join(home, agent === "zai" ? ".claude" : agent === "agy" ? ".gemini" : `.${agent === "kimi" ? "kimi-code" : agent}`);
  const parent = join(stateRoot, agent === "agy" ? ".codemux-isolation-probes" : ".codemux-hermetic");
  const privateDir = join(parent, `session-${id}`);
  const request: RunRequest = { agent, prompt: "unused", cwd, hermetic, sandboxed: true, autonomy: "low",
    experimentProjectSettings: agent === "copilot", model: "synthetic" };
  const policy: SandboxOptions = { agentId: agent, trust: "standard", strict: true, scrubEnv: true,
    blockPaths: [], callerBlockPaths: [], harnessStateDirs: [], keepEnv: [] };
  const common = { agentId: agent, adapter, override, runLike: request, model: "synthetic", autonomy: "low" as const,
    effort: undefined, workdir: cwd, sandboxOptions: policy };
  const prepare = async (resumeId?: string) => {
    const options = { sandbox: true, printSandbox: true, cwd };
    const launch = await prepareSessionLaunch({ ...common, options, config: getDefaultConfig(),
      sessionSupport: SESSION_AGENTS[agent]!, passthroughEnv: [], enablePlaywrightMcp: false,
      hermetic, experimentProjectSettings: request.experimentProjectSettings === true,
      sandboxTrust: "standard", claudeSessionId: agent === "claude" || agent === "zai" ? resumeId ?? id : undefined, resumeId,
      codexHome: () => join(home, ".codex"), codexOverride: null });
    return { launch, child: await prepareSessionChild({ ...common, ...launch, options,
      resumeId, requestedAutonomy: "low" }) };
  };
  return { root, home, cwd, adapter, override, id, parent, privateDir, policy, request, common, prepare,
    cleanup() {
      for (const mock of mocks) mock.mockRestore();
      for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
      Object.assign(process.env, original);
      fake.cleanup(); rmSync(root, { recursive: true, force: true });
    } };
}

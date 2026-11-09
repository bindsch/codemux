import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BaseAdapter } from "./adapters/base.js";
import type { CopilotAdapter } from "./adapters/copilot.js";
import type { CopilotRunContext } from "./copilot-usage.js";
import { experimentCanaryControl } from "./experiment-mcp.js";
import { envProgramIndex } from "./executable-security.js";
import { readFileBytesBounded } from "./file-io.js";
import { loginHome } from "./harness-health.js";
import { HERMETIC_CANARY_PROMPT, plantCanary, type PlantedCanary } from "./hermetic-canary.js";
import {
  HERMETIC_CHECK_CHANNELS,
  type HermeticAgentId,
  type InstructionCheckChannel,
} from "./hermetic-check-channels.js";
import { plantKimiCanary } from "./kimi-isolation-probe.js";
import type { LaunchOptions } from "./launch.js";
import { assertNoCallerBlockOverStateDirs } from "./sandbox.js";
import type { AgentId, RunRequest } from "./types.js";
import { UsageRefusalError } from "./validation.js";

/** Refuse an impossible positive control before any binary or quota probe. */
export function assertHermeticCheckSupported(agent: AgentId, experiment = false): InstructionCheckChannel {
  if (agent === "qwen" && experiment) return QWEN_EXPERIMENT_CHANNEL;
  if (!Object.hasOwn(HERMETIC_CHECK_CHANNELS, agent)) {
    throw new UsageRefusalError(`${agent} does not support a hermetic instruction check`);
  }
  const channel = HERMETIC_CHECK_CHANNELS[agent as HermeticAgentId];
  if (channel.kind === "limitation") {
    throw new UsageRefusalError(`check --hermetic cannot run for ${agent}: ${channel.reason}`);
  }
  return channel;
}

// Qwen 0.24.0 @qwen-code/qwen-code/chunks/chunk-B3HGO6BB.js:495-519,
// read 2026-11-09: QWEN_SYSTEM_MD loads an explicit instruction file
// without a safe-mode guard. Both experiment runs retain safe mode and
// their private MCP carrier; only the control names the planted file.
const QWEN_EXPERIMENT_CHANNEL: InstructionCheckChannel = {
  kind: "channel", location: "cwd", files: {
    "QWEN.md": "The code word is {{MARKER}}. Begin every reply with this code word.\n",
  }, control: { drop: "hermetic" },
  evidence: "Qwen 0.24.0 chunk-B3HGO6BB.js:495-519 QWEN_SYSTEM_MD explicit instruction file, read 2026-11-09",
};

export interface HermeticCheckProbe {
  adapter: BaseAdapter;
  request: RunRequest;
  launch: LaunchOptions;
}

export interface HermeticCheckPlan {
  canary: PlantedCanary;
  probe: HermeticCheckProbe;
  control: HermeticCheckProbe;
  controlDescription: string;
  kimiBrandHome?: string;
}

const MAX_LOGIN_BYTES = 1024 * 1024;
const LOGIN_FILES: Partial<Record<AgentId, readonly [string, string][]>> = {
  copilot: [[".copilot/config.json", "config.json"]],
  gemini: [[".gemini/oauth_creds.json", ".gemini/oauth_creds.json"],
    [".gemini/google_accounts.json", ".gemini/google_accounts.json"]],
  droid: [[".factory/auth.json", ".factory/auth.json"]],
};

/** A control never writes into the operator's configuration directory.
 * Copy only login files, without following links or reading special files.
 * Any token rotation in the control stays inside the disposable copy. */
function copyControlLogin(agent: AgentId, home: string, environment: NodeJS.ProcessEnv): void {
  for (const [sourceName, targetName] of LOGIN_FILES[agent] ?? []) {
    const source = join(loginHome(environment), sourceName);
    let bytes: Buffer;
    try {
      bytes = readFileBytesBounded(source, {
        maxBytes: MAX_LOGIN_BYTES, label: `${agent} check login`, noFollow: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const target = join(home, targetName);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { mode: 0o600 });
  }
}

/** Scope command changes to these check adapters; ordinary runs keep every flag. */
function homeCheckAdapter(
  adapter: BaseAdapter,
  channel: InstructionCheckChannel,
  home: string,
  control: boolean
): BaseAdapter {
  const scoped = Object.create(adapter) as BaseAdapter;
  scoped.prepareRun = (request, trust, sandbox, intent) => {
    if (sandbox) {
      assertNoCallerBlockOverStateDirs(sandbox.blockPaths ?? [], [home]);
      sandbox.harnessStateDirs = [...(sandbox.harnessStateDirs ?? []), home];
    }
    if (channel.control.drop !== "no-custom-instructions") return adapter.prepareRun(request, trust, sandbox, intent);
    const context: CopilotRunContext = { copilotHermeticHome: { home, finalize: () => {} } };
    try {
      if (request.experimentMcp) (scoped as CopilotAdapter).prepareCopilotExperiment(request, context);
      return context;
    } catch (error) { adapter.cleanupRunSync(context); throw error; }
  };
  if (channel.control.drop === "no-custom-instructions") {
    // Both probes use the same scratch config and retain --hermetic. Only
    // the control removes the instruction flag. The plan owns cleanup.
    scoped.buildRunCommand = (request, context) => {
      const command = adapter.buildRunCommand(request, context);
      if (request.experimentMcp) return command;
      const count = command.filter((arg) => arg === "--no-custom-instructions").length;
      if (count !== 1) throw new Error("copilot check requires exactly one --no-custom-instructions flag");
      return control ? command.filter((arg) => arg !== "--no-custom-instructions") : command;
    };
  } else {
    if (!channel.homeEnv) throw new Error(`${adapter.id} check home channel has no environment variable`);
    scoped.buildRunCommand = (request, context) => {
      const command = adapter.buildRunCommand(request, context);
      const program = envProgramIndex(command, `${adapter.id} check`);
      const assignment = `${channel.homeEnv}=${home}`;
      if (program === null) return ["env", assignment, ...command];
      const native = command.slice(1, program);
      // A native hermetic assignment or unset wins over the scratch home.
      // Keep one env prefix so executable checks still inspect the harness.
      const replaced = native.some((arg) => arg.startsWith(`${channel.homeEnv}=`)) ||
        native.some((arg, index) => arg === "-u" && native[index + 1] === channel.homeEnv);
      return replaced ? command : [...command.slice(0, program), assignment, ...command.slice(program)];
    };
  }
  return scoped;
}

/** Keep cwd, prompt, tools, model, and sandbox policy identical in both probes. */
export function createHermeticCheckPlan(
  adapter: BaseAdapter,
  baseRequest: RunRequest,
  launch: LaunchOptions
): HermeticCheckPlan {
  const channel = assertHermeticCheckSupported(baseRequest.agent, Boolean(baseRequest.experimentMcp));
  const kimi = baseRequest.agent === "kimi" ? plantKimiCanary() : undefined;
  const canary = kimi ?? plantCanary(channel, undefined, Boolean(baseRequest.experimentMcp));
  try {
    let probeAdapter = kimi?.adapter ?? adapter;
    let controlAdapter = probeAdapter;
    if ("home" in canary && canary.home) {
      const environment = adapter.buildExecutionEnv({}, baseRequest.passthroughEnv);
      copyControlLogin(baseRequest.agent, canary.home, environment);
      probeAdapter = homeCheckAdapter(adapter, channel, canary.home, false);
      controlAdapter = homeCheckAdapter(adapter, channel, canary.home, true);
    }
    const probe: RunRequest = {
      ...baseRequest, prompt: HERMETIC_CANARY_PROMPT, cwd: canary.cwd,
      instructionDirs: [canary.cwd], hermetic: true,
    };
    const passthrough = baseRequest.passthroughEnv ?? [];
    const plain: RunRequest = {
      ...probe,
      hermetic: channel.control.drop === "no-custom-instructions",
      ...(kimi && !passthrough.includes("KIMI_CODE_HOME")
        ? { passthroughEnv: [...passthrough, "KIMI_CODE_HOME"] } : {}),
    };
    const control = baseRequest.experimentMcp ? experimentCanaryControl(plain, kimi?.brandHome) : plain;
    const qwenExperiment = baseRequest.agent === "qwen" && Boolean(baseRequest.experimentMcp);
    if (qwenExperiment) {
      controlAdapter = Object.create(adapter) as BaseAdapter;
      controlAdapter.buildRunCommand = (request, context) => {
        const command = adapter.buildRunCommand(request, context);
        const program = envProgramIndex(command, "Qwen experiment control");
        const assignment = `QWEN_SYSTEM_MD=${join(canary.cwd, "QWEN.md")}`;
        return program === null ? ["env", assignment, ...command]
          : [...command.slice(0, program), assignment, ...command.slice(program)];
      };
    }
    const canaryLaunch = { ...launch, cwd: canary.cwd };
    return {
      canary,
      probe: { adapter: probeAdapter, request: probe, launch: canaryLaunch },
      control: { adapter: controlAdapter, request: control, launch: canaryLaunch },
      controlDescription: qwenExperiment ? "Control probe with the explicit QWEN_SYSTEM_MD instruction file..." : channel.control.drop === "no-custom-instructions"
        ? "Control probe without --no-custom-instructions..." : "Control probe without --hermetic...",
      kimiBrandHome: kimi?.brandHome,
    };
  } catch (error) {
    canary.cleanup();
    throw error;
  }
}

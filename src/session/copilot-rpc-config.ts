import type { BaseAdapter, RunContext } from "../adapters/base.js";
import { copilotProviderConfiguration } from "../copilot-provider.js";
import type { RunRequest } from "../types.js";
import type { TurnCommandInput } from "./turn-driver-types.js";
import type { CopilotRpcSessionConfig } from "./copilot-rpc-control.js";
import { join } from "node:path";

/** The SDK's create/resume configuration fields, installed 1.0.85
 * copilot-sdk/index.js and types.d.ts, read 2026-11-09. Explicit source
 * wildcards restore tools on resume without an absent-field ambiguity. */
export function buildCopilotRpcLaunch(input: {
  adapter: BaseAdapter;
  request: RunRequest;
  context?: RunContext;
  turn: TurnCommandInput;
  harnessHome: string;
}): { argv: string[]; config: CopilotRpcSessionConfig } {
  const { adapter, request, turn } = input;
  const context: RunContext = { ...input.context };
  // Reuse native provider routing and the nested executable trust check.
  const command = adapter.buildRunCommand({ ...request, prompt: turn.text, model: turn.model,
    autonomy: turn.autonomy, effort: turn.effort, hermetic: false }, context);
  if (input.context !== undefined) input.context.playwrightMcpCheck = context.playwrightMcpCheck;
  const binary = command.indexOf("copilot");
  if (binary < 0) throw new Error("Copilot RPC needs a Copilot adapter command");
  const mcp = command.indexOf("--additional-mcp-config");
  const provider = adapter.providerOverride();
  const project = request.experimentProjectSettings === true;
  const isolated = request.hermetic === true || turn.hermeticHome !== null;
  const discover = !isolated || project;
  return {
    argv: [...(turn.hermeticHome === null ? [] : ["env", `COPILOT_HOME=${turn.hermeticHome}`]),
      ...command.slice(0, binary), "copilot", "--headless", "--stdio", "--no-auto-update",
      ...command.slice(binary + 1).filter((argument) => ["--no-bash-env", "--no-remote", "--no-remote-export",
        ...(turn.callerHome === undefined ? ["--no-custom-instructions"] : []),
        "--no-experimental", "--disable-builtin-mcps"].includes(argument))],
    config: {
      workingDirectory: request.cwd ?? process.cwd(),
      configDir: turn.callerHome === undefined ? turn.hermeticHome ?? input.harnessHome : join(turn.callerHome, ".copilot"),
      model: provider === null ? turn.model : "codemux/model", reasoningEffort: turn.effort,
      ...(provider === null ? {} : copilotProviderConfiguration(provider, turn.model)),
      availableTools: request.tools === "none" ? ["codemux-no-tools"] : ["builtin:*", "mcp:*", "custom:*"],
      excludedTools: request.web === false ? ["builtin:web_fetch", "mcp:web_search"] : [],
      toolFilterPrecedence: "excluded",
      ...(mcp < 0 ? {} : { mcpServers: JSON.parse(command[mcp + 1]!).mcpServers }),
      enableConfigDiscovery: discover, enableFileHooks: discover, enableSkills: discover,
      enableOnDemandInstructionDiscovery: project || turn.callerHome !== undefined,
      ...(!isolated || project ? {} : { pluginDirectories: [], skillDirectories: [], instructionDirectories: [] }),
      customAgentsLocalOnly: true, envValueMode: "direct",
    },
  };
}

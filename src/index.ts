import { program } from "commander";
import { readFileSync } from "node:fs";
import { getDefaultConfig, loadConfig } from "./config.js";
import { registerCheckCommand } from "./check-command.js";
import { registerInfoCommands } from "./info-commands.js";
import { registerCallsCommand } from "./calls-command.js";
import { registerSessionCommand } from "./session/cli.js";
import { registerRunCommand } from "./run-command.js";
import { registerTuiCommand } from "./tui-command.js";

let configError: Error | undefined;
const config = (() => {
  try {
    return loadConfig();
  } catch (error) {
    configError = error instanceof Error ? error : new Error(String(error));
    return getDefaultConfig();
  }
})();

function requireValidConfig(): void {
  if (configError) throw configError;
}

const packageVersion = (() => {
  const packagePath = new URL("../package.json", import.meta.url);
  const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string") {
    throw new Error("package.json is missing a string version");
  }
  return parsed.version;
})();

program
  .name("codemux")
  .description("Unified CLI for AI coding agents")
  .version(packageVersion)
  .exitOverride((error) => {
    const missingLabelArgument = error.code === "commander.optionMissingArgument" &&
      (error.message.includes("--label") || error.message.includes("--by"));
    process.exit(missingLabelArgument ? 64 : error.exitCode);
  });

registerRunCommand(program, config, requireValidConfig);
registerTuiCommand(program, config, requireValidConfig);
registerCheckCommand(program, config, requireValidConfig);
registerInfoCommands(program, config, configError);
registerCallsCommand(program);
registerSessionCommand(program, config, requireValidConfig);

await program.parseAsync();

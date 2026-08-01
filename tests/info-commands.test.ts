import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { getDefaultConfig } from "../src/config.js";
import { registerInfoCommands } from "../src/info-commands.js";
import { AGENT_IDS } from "../src/types.js";

async function runInfoCommand(
  args: string[],
  configError?: Error
): Promise<{ output: string; exitCode: number | undefined }> {
  const command = new Command();
  command.exitOverride();
  let exitCode: number | undefined;
  registerInfoCommands(command, getDefaultConfig(), configError, (code) => {
    exitCode = code;
  });
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => lines.push(values.map(String).join(" "));
  try {
    await command.parseAsync(["node", "codemux", ...args]);
    return { output: lines.join("\n"), exitCode };
  } finally {
    console.log = originalLog;
  }
}

describe("information commands", () => {
  test("renders the autonomy matrix", async () => {
    const result = await runInfoCommand(["autonomy"]);
    expect(result.output).toContain("Autonomy equivalence matrix");
    expect(result.output).toContain("| codex |");
  });

  test("renders verifier warning details and scode previews", async () => {
    const result = await runInfoCommand(["verify", "-a", "codex", "--show-scode"]);
    expect(result.output).not.toContain("Warning details:");
    expect(result.output).toContain("Effective scode command preview");
    expect(result.output).toContain("--ro");
  });

  test("doctor reports a malformed configuration without hiding diagnostics", async () => {
    const result = await runInfoCommand(["doctor"], new Error("invalid configuration"));
    expect(result.output).toContain("Configuration: ❌ invalid configuration");
    expect(result.output).toContain("Summary:");
    expect(result.exitCode).toBe(1);
  });

  test("doctor reports sandbox wrapper compatibility", async () => {
    const result = await runInfoCommand(["doctor"]);
    expect(result.output).toContain("scode (sandbox):");
  });

  test("lists every registered adapter", async () => {
    const result = await runInfoCommand(["list"]);
    expect(result.output).toContain("Available agents:");
    for (const agentId of AGENT_IDS) {
      expect(result.output).toContain(` ${agentId}`);
    }
  });
});

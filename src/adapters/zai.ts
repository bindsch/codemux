import { readFileSync, existsSync } from "node:fs";
import { BaseAdapter } from "./base.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  RunResult,
  AdapterCapabilities,
} from "../types.js";

const ZAI_BASE_URL = "https://api.z.ai/api/anthropic";

export class ZaiAdapter extends BaseAdapter {
  readonly id: AgentId = "zai";
  readonly binaryName = "claude";

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: false,
      effortLevels: [],
    };
  }

  private getZaiApiKey(): string {
    // Env var takes precedence if set
    if (process.env.ZAI_API_KEY) {
      return process.env.ZAI_API_KEY;
    }

    // Try ~/.zai file
    const homedir = process.env.HOME || process.env.USERPROFILE || "";
    const zaiFile = `${homedir}/.zai`;
    if (existsSync(zaiFile)) {
      try {
        const content = readFileSync(zaiFile, "utf-8").trim();
        if (content) {
          return content;
        }
      } catch {
        // File unreadable
      }
    }

    throw new Error(
      "Z.AI API key not found.\n" +
      "Either create ~/.zai with your API key, or set ZAI_API_KEY env var.\n" +
      "Get your API key from: https://z.ai/manage-apikey/apikey-list"
    );
  }

  override getEnv(): Record<string, string> {
    const apiKey = this.getZaiApiKey();
    return {
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_BASE_URL: ZAI_BASE_URL,
      API_TIMEOUT_MS: process.env.API_TIMEOUT_MS || "3000000",
    };
  }

  override beforeLaunch(): void {
    // Validate key exists (throws if missing)
    this.getZaiApiKey();
    console.log("\x1b[38;5;208m╔══════════════════════════════════════╗\x1b[0m");
    console.log("\x1b[38;5;208m║\x1b[0m  \x1b[1;38;5;208m🔸 Z.AI MODE\x1b[0m - Using z.ai API       \x1b[38;5;208m║\x1b[0m");
    console.log("\x1b[38;5;208m║\x1b[0m     api.z.ai/api/anthropic           \x1b[38;5;208m║\x1b[0m");
    console.log("\x1b[38;5;208m╚══════════════════════════════════════╝\x1b[0m");
    console.log();
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return [];
      case "low":
        return ["--permission-mode", "acceptEdits"];
      case "medium":
        return ["--permission-mode", "dontAsk"];
      case "high":
        return ["--dangerously-skip-permissions"];
    }
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = ["claude", "-p"];
    cmd.push("--model", request.model || "opus");

    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }

    return cmd;
  }

  override getStdinInput(request: RunRequest): string | null {
    return request.prompt;
  }

  buildTuiCommand(model?: string, autonomy?: AutonomyLevel, _effort?: ReasoningEffort): string[] {
    const cmd = ["claude"];
    cmd.push("--model", model || "opus");
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }

  override async run(request: RunRequest): Promise<RunResult> {
    const command = this.buildRunCommand(request);
    const cwd = request.cwd || process.cwd();
    const stdinInput = this.getStdinInput(request);
    const env = { ...process.env, ...this.getEnv() } as Record<string, string>;

    const proc = Bun.spawn(command, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: stdinInput ? new TextEncoder().encode(stdinInput) : "inherit",
      env,
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    return {
      stdout,
      stderr,
      exitCode,
      success: exitCode === 0,
    };
  }

  override async runInteractive(model?: string, cwd?: string, autonomy?: AutonomyLevel, effort?: ReasoningEffort): Promise<number> {
    const command = this.buildTuiCommand(model, autonomy, effort);
    const workdir = cwd || process.cwd();
    const env = { ...process.env, ...this.getEnv() } as Record<string, string>;

    const proc = Bun.spawn(command, {
      cwd: workdir,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
      env,
    });

    return await proc.exited;
  }
}

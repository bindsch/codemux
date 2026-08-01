import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BaseAdapter } from "./base.js";
import { getPlaywrightSandboxMcpArgs } from "../mcp.js";
import { readUtf8FileBounded } from "../file-io.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  AdapterCapabilities,
} from "../types.js";

const ZAI_BASE_URL = "https://api.z.ai/api/anthropic";
const MAX_KEY_FILE_BYTES = 16 * 1024;
const DEFAULT_API_TIMEOUT_MS = 3_000_000;
const MAX_API_TIMEOUT_MS = 86_400_000;

export class ZaiAdapter extends BaseAdapter {
  readonly id: AgentId = "zai";
  readonly binaryName = "claude";

  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly homeDirectory?: string
  ) {
    super();
  }

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
    const environmentKey = this.environment.ZAI_API_KEY?.trim();
    if (environmentKey) {
      return this.validateCredential(environmentKey, "ZAI_API_KEY");
    }

    if (this.homeDirectory !== undefined && !isAbsolute(this.homeDirectory)) {
      throw new Error("Z.AI home directory must be an absolute path");
    }
    const configuredHome =
      this.homeDirectory ||
      this.environment.HOME ||
      this.environment.USERPROFILE;
    const home = configuredHome && isAbsolute(configuredHome)
      ? configuredHome
      : homedir();
    const zaiFile = join(home, ".zai");
    try {
      const content = readUtf8FileBounded(zaiFile, {
        maxBytes: MAX_KEY_FILE_BYTES,
        label: zaiFile,
        noFollow: true,
        validate: (stat) => {
          if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
            throw new Error(`${zaiFile} permissions must be 0600 or stricter`);
          }
          if (
            process.platform !== "win32" &&
            typeof process.getuid === "function" &&
            stat.uid !== process.getuid()
          ) {
            throw new Error(`${zaiFile} must be owned by the current user`);
          }
        },
      }).trim();
      if (content) {
        return this.validateCredential(content, zaiFile);
      }
      throw new Error(`${zaiFile} is empty`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }

    throw new Error(
      "Z.AI API key not found.\n" +
      "Either create ~/.zai with your API key, or set ZAI_API_KEY env var.\n" +
      "Get your API key from: https://z.ai/manage-apikey/apikey-list"
    );
  }

  private validateCredential(value: string, source: string): string {
    if (value.includes("\0") || /[\r\n]/.test(value)) {
      throw new Error(`${source} must contain exactly one credential line`);
    }
    if (Buffer.byteLength(value, "utf8") > MAX_KEY_FILE_BYTES) {
      throw new Error(`${source} exceeds ${MAX_KEY_FILE_BYTES} bytes`);
    }
    return value;
  }

  private getApiTimeout(): string {
    const raw = this.environment.API_TIMEOUT_MS?.trim();
    if (raw === undefined || raw === "") return String(DEFAULT_API_TIMEOUT_MS);
    if (!/^\d+$/.test(raw)) {
      throw new Error("API_TIMEOUT_MS must be a positive integer in milliseconds");
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_API_TIMEOUT_MS) {
      throw new Error(
        `API_TIMEOUT_MS must be between 1 and ${MAX_API_TIMEOUT_MS}`
      );
    }
    return String(value);
  }

  override getEnv(): Record<string, string> {
    const apiKey = this.getZaiApiKey();
    return {
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_BASE_URL: ZAI_BASE_URL,
      API_TIMEOUT_MS: this.getApiTimeout(),
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    };
  }

  override getEnvOmissions(): readonly string[] {
    return ["ZAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];
  }

  override beforeLaunch(): void {
    this.getZaiApiKey();
    if (process.stderr.isTTY) {
      console.error("Z.AI mode: using api.z.ai/api/anthropic");
    }
  }

  override configurationIssues(): string[] {
    try {
      this.getZaiApiKey();
      return [];
    } catch (error) {
      return [error instanceof Error ? error.message.split("\n")[0]! : String(error)];
    }
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--permission-mode", "plan"];
      case "low":
        return ["--permission-mode", "manual"];
      case "medium":
        return ["--permission-mode", "acceptEdits"];
      case "high":
        return ["--dangerously-skip-permissions"];
    }
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = [
      "claude",
      "-p",
      "--setting-sources",
      "user",
      "--strict-mcp-config",
      "--no-session-persistence",
    ];
    cmd.push(...getPlaywrightSandboxMcpArgs(request.sandboxed, {
      enabled: request.enablePlaywrightMcp,
      forbiddenRoot: request.cwd ?? process.cwd(),
    }));
    cmd.push("--model", request.model || "opus");

    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }

    return cmd;
  }

  override getStdinInput(request: RunRequest): string | null {
    return request.prompt;
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    sandboxed?: boolean,
    enablePlaywrightMcp?: boolean,
    cwd?: string
  ): string[] {
    const cmd = enablePlaywrightMcp
      ? ["claude", "--setting-sources", "user", "--strict-mcp-config"]
      : ["claude", "--safe-mode"];
    cmd.push(...getPlaywrightSandboxMcpArgs(sandboxed, {
      enabled: enablePlaywrightMcp,
      forbiddenRoot: cwd ?? process.cwd(),
    }));
    cmd.push("--model", model || "opus");
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }

}

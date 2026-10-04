import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BaseAdapter } from "./base.js";
import { getPlaywrightSandboxMcpArgs } from "../mcp.js";
import {
  claudeAutonomyFlags,
  claudeNativeAutonomyFlags,
} from "../claude-autonomy.js";
import { readUtf8FileBounded } from "../file-io.js";
import { claudeFamilyResult } from "../result-envelope.js";
import { assertAbsoluteClaudeConfigDir } from "../claude-family.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  RunResult,
  AdapterCapabilities,
} from "../types.js";

const ZAI_BASE_URL = "https://api.z.ai/api/anthropic";
const MAX_KEY_FILE_BYTES = 16 * 1024;
const DEFAULT_API_TIMEOUT_MS = 3_000_000;
const MAX_API_TIMEOUT_MS = 86_400_000;
// The model zai runs when the request names none (buildRunCommand and
// buildTuiCommand both fall back to it); result processing must report the
// same one, or an envelope without modelUsage would claim codemux selected
// nothing.
export const ZAI_DEFAULT_MODEL = "opus";

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
      supportsHermetic: true,
      supportsToolSelection: true,
      // Same binary as claude, so the same --output-format json envelope.
      supportsResultJson: true,
    };
  }

  /** The user home a run sees: the seam, else $HOME, else the account home. */
  private effectiveHome(): string {
    if (this.homeDirectory !== undefined && !isAbsolute(this.homeDirectory)) {
      throw new Error("Z.AI home directory must be an absolute path");
    }
    const configuredHome =
      this.homeDirectory ||
      this.environment.HOME ||
      this.environment.USERPROFILE;
    return configuredHome && isAbsolute(configuredHome)
      ? configuredHome
      : homedir();
  }

  private getZaiApiKey(): string {
    const environmentKey = this.environment.ZAI_API_KEY?.trim();
    if (environmentKey) {
      return this.validateCredential(environmentKey, "ZAI_API_KEY");
    }

    const zaiFile = join(this.effectiveHome(), ".zai");
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
    // The TUI has a human to approve; write grants ride only on headless
    // runs (see buildRunCommand).
    return claudeNativeAutonomyFlags(level);
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    // The adapter pins no CLAUDE_CONFIG_DIR, so a passed-through one is the
    // only redirect -- and a relative one would resolve against the child's
    // working directory, landing the config store somewhere --cwd decides.
    assertAbsoluteClaudeConfigDir(request.passthroughEnv);
  }

  override validateTuiRequest(
    model?: string,
    cwd?: string,
    autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    passthroughEnv: readonly string[] = [],
    enablePlaywrightMcp = false
  ): void {
    super.validateTuiRequest(model, cwd, autonomy, _effort, passthroughEnv, enablePlaywrightMcp);
    assertAbsoluteClaudeConfigDir(passthroughEnv);
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = ["claude", "-p"];
    if (request.hermetic) {
      // --safe-mode starts with every customization disabled: CLAUDE.md
      // (user and project), skills, plugins, hooks, MCP servers, custom
      // commands and agents. Auth, model selection, built-in tools and
      // permissions work normally. --bare would go further but never reads
      // the OAuth login, so a subscription run would silently bill an API
      // key instead.
      cmd.push("--safe-mode");
    }
    // Kept under --safe-mode too: it costs nothing and settles whether a
    // repository's own settings file could still reach the run. Project
    // instruction files load only with the project source, so a request
    // that names instruction directories (the hermetic check's control)
    // enables it; under --safe-mode that is exactly the channel being
    // proven closed.
    // The project source is enabled only when the working directory is one
    // of the named instruction directories, so a repository's own settings
    // file can never ride in on an unrelated instruction directory. The
    // user source resolves under the ordinary Claude Code home the child
    // already uses (CLAUDE_CONFIG_DIR, default ~/.claude) -- Z.AI runs load
    // the operator's ~/.claude/settings.json directly, exactly as claude
    // runs do, because both run the same binary against the same store.
    const instructionDirs = request.instructionDirs ?? [];
    const cwdIsInstructionDir = instructionDirs.includes(request.cwd ?? process.cwd());
    cmd.push(
      "--setting-sources",
      cwdIsInstructionDir ? "user,project" : "user",
      "--strict-mcp-config"
    );
    // No run of this adapter persists a session (same binary and rule as
    // claude): nothing a later run could resume is left behind.
    cmd.push("--no-session-persistence");
    if (request.resultJson) {
      // Claude Code's single-result envelope (same binary as claude): the
      // reply under `result`, plus `usage`, `modelUsage`, and
      // `total_cost_usd`, which `--result-json` re-emits with the codemux
      // block appended.
      cmd.push("--output-format", "json");
    }
    if (request.tools === "none") {
      // An empty --tools list removes every built-in tool definition.
      cmd.push("--tools", "");
    }
    for (const dir of instructionDirs) {
      cmd.push("--add-dir", dir);
    }
    cmd.push(...getPlaywrightSandboxMcpArgs(request.sandboxed, {
      enabled: request.enablePlaywrightMcp,
      forbiddenRoot: request.cwd ?? process.cwd(),
    }));
    cmd.push("--model", request.model || ZAI_DEFAULT_MODEL);

    if (request.autonomy) {
      cmd.push(...claudeAutonomyFlags(request.autonomy, request.cwd ?? process.cwd()));
    }

    return cmd;
  }

  override getStdinInput(request: RunRequest): string | null {
    return request.prompt;
  }

  override processRunResult(result: RunResult, request: RunRequest): RunResult {
    // Same envelope as claude (same binary): with --result-json the harness's
    // envelope is re-emitted with the codemux block appended. Anything that is
    // not the envelope fails loudly, as in claude's adapter.
    if (request.resultJson) {
      // buildRunCommand ran --model opus when the request named none (or an
      // empty string -- same `||` fallback), so the envelope's model fallback
      // sees the model codemux actually selected.
      return claudeFamilyResult(
        result,
        { ...request, model: request.model || ZAI_DEFAULT_MODEL },
        this.id
      );
    }
    return result;
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
    cmd.push("--model", model || ZAI_DEFAULT_MODEL);
    if (autonomy) {
      // The TUI has a human to approve; write grants ride only on
      // headless runs.
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }

}

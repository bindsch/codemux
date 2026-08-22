import { BaseAdapter, type SandboxPreparation } from "./base.js";
import {
  CLAUDE_KEYCHAIN_SERVICE,
  claudeCredentialTarget,
  readKeychainSecret,
  syncKeychainCredential,
  type SecretReader,
} from "../credentials.js";
import { getPlaywrightSandboxMcpArgs } from "../mcp.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  AdapterCapabilities,
} from "../types.js";

export class ClaudeAdapter extends BaseAdapter {
  readonly id: AgentId = "claude";
  readonly binaryName = "claude";

  override getEnv(): Record<string, string> {
    return { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" };
  }

  // Overridable seams so unit tests exercise the launch wiring without
  // touching the user's real Keychain or real credential file. (The spawned
  // end-to-end CLI tests cannot inject these; they disable the sync outright
  // via CODEMUX_NO_KEYCHAIN_SYNC.)
  protected credentialReader: SecretReader = readKeychainSecret;
  protected credentialTarget: () => string = claudeCredentialTarget;

  // Env vars that repoint Claude's credential mirror off the default path.
  // If any is forwarded to the child, the child reads a DIFFERENT file, so
  // refreshing the default one is pointless and could touch an unrelated
  // profile — those setups own their own credential story.
  private static readonly PROFILE_REDIRECTS = [
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  ];

  /**
   * Refresh Claude Code's on-disk credential MIRROR from the macOS Keychain
   * before a sandboxed launch. The scode sandbox cannot reach the Keychain,
   * so a sandboxed Claude reads only the file — which goes stale as the
   * Keychain token rotates. Sandboxed launches only: an unsandboxed Claude
   * reads the Keychain directly and needs nothing. See credentials.ts for
   * the deliberately narrow scope (only an existing mirror is refreshed).
   */
  override prepareSandbox(context: SandboxPreparation = {}): void {
    // An untrusted sandbox denies harness-state access by design: the child
    // cannot read the file, so refreshing it would be pointless work.
    if (context.sandboxTrust === "untrusted") return;
    const passthrough = context.passthroughEnv ?? [];
    const redirect = ClaudeAdapter.PROFILE_REDIRECTS.find(
      (name) => passthrough.includes(name) && name in process.env
    );
    if (redirect !== undefined) {
      console.error(
        `claude: ${redirect} points the child at a non-default credential ` +
          "mirror; skipping the Keychain sync (that profile owns its own file)"
      );
      return;
    }
    const target = this.credentialTarget();
    const outcome = syncKeychainCredential(
      CLAUDE_KEYCHAIN_SERVICE,
      target,
      this.credentialReader
    );
    if (outcome === "failed") {
      // A silently stale mirror produces the exact 401 this exists to
      // prevent; the launch proceeds, but the operator gets the diagnosis.
      console.error(
        `claude: could not refresh the credential mirror at ${target}; ` +
          "a sandboxed run may fail to authenticate"
      );
    } else if (outcome === "synced" && process.stderr.isTTY) {
      console.error("claude: refreshed the credential mirror from the Keychain");
    }
  }

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: true,
      effortLevels: ["low", "medium", "high", "xhigh", "max"],
    };
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

  override mapEffort(level: ReasoningEffort): string[] {
    return level === "none" ? [] : ["--effort", level];
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

    if (request.model) {
      cmd.push("--model", request.model);
    }

    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }
    if (request.effort) {
      cmd.push(...this.mapEffort(request.effort));
    }

    return cmd;
  }

  override getStdinInput(request: RunRequest): string | null {
    return request.prompt;
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    effort?: ReasoningEffort,
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
    if (model) {
      cmd.push("--model", model);
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    if (effort) {
      cmd.push(...this.mapEffort(effort));
    }
    return cmd;
  }
}

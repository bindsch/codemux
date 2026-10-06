import { isAbsolute, join } from "node:path";
import { BaseAdapter, type SandboxPreparation } from "./base.js";
import {
  CLAUDE_KEYCHAIN_SERVICE,
  claudeCredentialTarget,
  defaultCredentialBackupDir,
  fileCarriesRefreshToken,
  readKeychainSecret,
  syncKeychainCredential,
  type SecretReader,
} from "../credentials.js";
import { getPlaywrightSandboxMcpArgs } from "../mcp.js";
import { claudeFamilyResult } from "../result-envelope.js";
import {
  claudeAutonomyFlags,
  claudeNativeAutonomyFlags,
} from "../claude-autonomy.js";
import { assertAbsoluteClaudeConfigDir } from "../claude-family.js";
import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  RunResult,
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
  protected credentialBackupDir: () => string = defaultCredentialBackupDir;

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
    const redirects = ClaudeAdapter.PROFILE_REDIRECTS.filter(
      (name) => passthrough.includes(name) && name in process.env
    );
    for (const redirect of redirects) {
      // That profile owns its own credential story: codemux does not know
      // which Keychain entry (if any) backs it, so it neither syncs nor
      // scrubs nor refuses it — a file-only profile login would otherwise be
      // refused or destroyed. The operator is told what the file carries.
      // Only an absolute directory names a file worth reporting on
      // (`CLAUDE_CONFIG_DIR` is validated absolute before launch; the
      // secure-storage variable is simply not reported on when relative).
      const dir = process.env[redirect] as string;
      const profileFile = isAbsolute(dir) ? join(dir, ".credentials.json") : null;
      console.error(
        `claude: ${redirect} points the child at a non-default credential ` +
          "mirror; not syncing it (that profile owns its own file)" +
          (profileFile !== null && fileCarriesRefreshToken(profileFile)
            ? `. Note: ${profileFile} holds a refresh token codemux does not manage; ` +
              "a sandboxed child can read it"
            : "")
      );
    }
    // The default mirror is checked even when the child is pointed
    // elsewhere: it sits in ~/.claude, which the sandbox lets the child
    // read, so a refresh token left in it is the same hazard.
    const target = this.credentialTarget();
    const outcome = syncKeychainCredential(
      CLAUDE_KEYCHAIN_SERVICE,
      target,
      this.credentialReader,
      { backupDir: this.credentialBackupDir() }
    );
    if (outcome === "skipped" && fileCarriesRefreshToken(target)) {
      console.error(
        `claude: CODEMUX_NO_KEYCHAIN_SYNC is set and ${target} holds a refresh token ` +
          "codemux will not touch without the Keychain; a sandboxed child can read it"
      );
    }
    if (outcome === "unsafe") {
      // The mirror still carries a refresh token and could not be scrubbed.
      // A sandboxed child holding it could rotate the operator's login and
      // get every Claude session revoked (2026-10-05), so this launch does
      // not happen at all.
      throw new Error(
        `claude: the credential mirror at ${target} holds a refresh token that ` +
          "could not be removed safely; refusing the sandboxed launch (a child " +
          "holding that token could revoke your Claude login). Unlock the " +
          "Keychain if it is locked, make the file and its directory writable, " +
          "replace a symlinked ~/.claude or .credentials.json with a real one, " +
          "or empty the refreshToken value in that file yourself, then retry."
      );
    }
    if (outcome === "failed") {
      // A silently stale mirror produces the exact 401 this exists to
      // prevent; the launch proceeds, but the operator gets the diagnosis.
      console.error(
        `claude: could not refresh the credential mirror at ${target}; ` +
          "a sandboxed run may fail to authenticate"
      );
    } else if (outcome === "unrecognized") {
      console.error(
        `claude: the credential mirror at ${target} holds an emptied Claude ` +
          "credential with keys this codemux does not know; left untouched, so " +
          "a sandboxed run may fail to authenticate (a newer Claude Code?)"
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
      supportsHermetic: true,
      supportsToolSelection: true,
      supportsResultJson: true,
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    // The TUI has a human to approve; write grants ride only on headless
    // runs (see buildRunCommand).
    return claudeNativeAutonomyFlags(level);
  }

  override mapEffort(level: ReasoningEffort): string[] {
    return level === "none" ? [] : ["--effort", level];
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
    effort?: ReasoningEffort,
    passthroughEnv: readonly string[] = [],
    enablePlaywrightMcp = false
  ): void {
    super.validateTuiRequest(model, cwd, autonomy, effort, passthroughEnv, enablePlaywrightMcp);
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
    // file can never ride in on an unrelated instruction directory.
    const instructionDirs = request.instructionDirs ?? [];
    const cwdIsInstructionDir = instructionDirs.includes(request.cwd ?? process.cwd());
    cmd.push(
      "--setting-sources",
      cwdIsInstructionDir ? "user,project" : "user",
      "--strict-mcp-config"
    );
    // No run of this adapter persists a session, so the harness is told so
    // explicitly: nothing a later run could resume is left behind.
    cmd.push("--no-session-persistence");
    if (request.resultJson) {
      // Claude Code's single-result envelope: the reply under `result`, plus
      // `usage`, `modelUsage`, and `total_cost_usd`, which `--result-json`
      // re-emits with the codemux block appended.
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

    if (request.model) {
      cmd.push("--model", request.model);
    }

    if (request.autonomy) {
      cmd.push(...claudeAutonomyFlags(request.autonomy, request.cwd ?? process.cwd()));
    }
    if (request.effort) {
      cmd.push(...this.mapEffort(request.effort));
    }

    return cmd;
  }

  override getStdinInput(request: RunRequest): string | null {
    return request.prompt;
  }

  override processRunResult(result: RunResult, request: RunRequest): RunResult {
    // The run was launched with --output-format json (resultJson), so stdout
    // should be one result envelope; it is re-emitted with every original
    // field untouched plus the codemux block (usage, model). Anything that
    // is not the envelope fails loudly: the raw stdout stays on stdout,
    // stderr says what is missing, and the exit is non-zero.
    if (request.resultJson) {
      return claudeFamilyResult(result, request, this.id);
    }
    return result;
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
      // The TUI has a human to approve; write grants ride only on
      // headless runs.
      cmd.push(...this.mapAutonomy(autonomy));
    }
    if (effort) {
      cmd.push(...this.mapEffort(effort));
    }
    return cmd;
  }
}

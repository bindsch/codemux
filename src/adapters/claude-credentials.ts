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
  type SecretReadResult,
} from "../credentials.js";
import { readProviderOverride } from "../provider-override.js";

export abstract class ClaudeCredentialAdapter extends BaseAdapter {
  // Overridable seams so unit tests exercise the launch wiring without
  // touching the user's real Keychain or real credential file. (The spawned
  // end-to-end CLI tests cannot inject these; they disable the sync outright
  // via CODEMUX_NO_KEYCHAIN_SYNC.)
  protected credentialReader: SecretReader = readKeychainSecret;
  protected credentialTarget: () => string = () => claudeCredentialTarget(this.environment.HOME);
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
   * Report a passed-through profile redirect. That profile owns its own
   * credential story: codemux does not know which Keychain entry (if any)
   * backs it, so it neither syncs nor scrubs nor refuses it -- a file-only
   * profile login would otherwise be refused or destroyed. The operator is
   * told what the file carries. Only an absolute directory names a file
   * worth reporting on (`CLAUDE_CONFIG_DIR` is validated absolute before
   * launch; the secure-storage variable is simply not reported on when
   * relative). Shared by the claude and zai sandboxed launches (review
   * round 372): the child is the same binary on both.
   */
  protected reportProfileRedirects(label: string, passthrough: readonly string[]): void {
    const redirects = ClaudeCredentialAdapter.PROFILE_REDIRECTS.filter(
      (name) => passthrough.includes(name) && name in this.environment
    );
    for (const redirect of redirects) {
      const dir = this.environment[redirect] as string;
      const profileFile = isAbsolute(dir) ? join(dir, ".credentials.json") : null;
      console.error(
        `${label}: ${redirect} points the child at a non-default credential ` +
          "mirror; not syncing it (that profile owns its own file)" +
          (profileFile !== null && fileCarriesRefreshToken(profileFile)
            ? `. Note: ${profileFile} holds a refresh token codemux does not manage; ` +
              "a sandboxed child can read it"
            : "")
      );
    }
  }

  /**
   * The guard for a run that authenticates with its OWN credential (a
   * provider override on claude, every Z.AI run): nothing of the operator's
   * login is copied, so the Keychain sync is skipped, but the child -- the
   * same claude binary under the same sandbox -- still reads the default
   * config directory, and a refresh token left in the mirror is the same
   * hazard as on a subscription run. A refresh token in the file is a hazard
   * only when the file is a MIRROR, i.e. a Keychain entry owns the login
   * (macOS). With no entry at all (Linux, a file-only macOS login) the file
   * is Claude Code's only store and that token is normal -- the same rule
   * the sync module applies. The Keychain is consulted for presence only,
   * and only when the file carries a refresh token; nothing is copied. The
   * opt-out means "do not consult the Keychain" here as on a plain run: the
   * file is reported, never refused, and the operator who set it owns what
   * is in it. `runKind` names the run in the refusal ("A provider-override
   * run", "A Z.AI run").
   */
  protected guardMirrorForForeignCredential(label: string, runKind: string, target: string): void {
    if (!fileCarriesRefreshToken(target)) return;
    if (process.env.CODEMUX_NO_KEYCHAIN_SYNC === "1") {
      console.error(
        `${label}: CODEMUX_NO_KEYCHAIN_SYNC is set and ${target} holds a refresh token ` +
          "codemux will not touch without the Keychain; a sandboxed child can read it"
      );
      return;
    }
    let read: SecretReadResult;
    try {
      read = this.credentialReader(CLAUDE_KEYCHAIN_SERVICE);
    } catch {
      read = { kind: "error", detail: "the Keychain read threw" };
    }
    if (read.kind !== "missing") {
      throw new Error(
        `${label}: the credential mirror at ${target} holds a refresh token. ${runKind} ` +
          "never uses the operator login, but a sandboxed child can still read the file, " +
          "and a refresh token in it could revoke your Claude login (2026-10-05). One " +
          "plain sandboxed claude run scrubs it (a Keychain entry owns the login), then retry."
      );
    }
  }

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
    this.reportProfileRedirects("claude", context.passthroughEnv ?? []);
    // The default mirror is checked even when the child is pointed
    // elsewhere: the sandbox lets the child read the default config
    // directory, so a refresh token left in it is the same hazard.
    const target = this.credentialTarget();
    // A provider override authenticates with its own token, so nothing of
    // the operator's login is copied for the run: the Keychain sync is
    // skipped entirely. The mirror is still guarded, because the child
    // reads the default config directory whatever credential it uses. A
    // refresh token in the file is the same hazard as on a subscription run.
    if (readProviderOverride("claude", this.environment) !== null) {
      this.guardMirrorForForeignCredential("claude", "A provider-override run", target);
      return;
    }
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

}

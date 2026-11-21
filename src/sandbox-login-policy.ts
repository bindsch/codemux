import type { SandboxOptions } from "./sandbox.js";

/** The credential names scode's --scrub-env removes from the ambient
 * environment (scode's credential patterns, restricted to the names this
 * policy decides on). The keep-env exemption — the names codemux itself
 * injected — is the only spelling that survives a scrub. */
const SCRUBBED_CREDENTIAL_ENV = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

/** Whether `name` reaches the child as a usable, non-blank value: decided
 * on the environment the child will actually receive, not the one codemux
 * was handed. A credential the scrub removes is not authentication, so a
 * scrubbed key neither suppresses the login-store grant nor silences the
 * inaccessible-login notice. ANTHROPIC_BASE_URL is configuration, not a
 * credential: scode's scrub never removes it, so it counts as delivered. */
function deliveredCredential(
  options: SandboxOptions | undefined, env: NodeJS.ProcessEnv, name: string
): boolean {
  if (!env[name]?.trim()) return false;
  const scrubbing = options?.scrubEnv === true || options?.trust === "untrusted";
  if (!scrubbing || !SCRUBBED_CREDENTIAL_ENV.has(name)) return true;
  return options?.keepEnv?.includes(name) ?? false;
}

/** Determine the authentication route from launch inputs, never stored logins.
 * Call after the keep-env exemption is attached (withKeepEnvExemption), so a
 * credential codemux injected and exempted still counts as delivered. */
export function usesOperatorLogin(options: SandboxOptions | undefined, env: NodeJS.ProcessEnv): boolean {
  if (options?.agentId === "agy") {
    return !["GEMINI_API_KEY", "GOOGLE_API_KEY"]
      .some((name) => deliveredCredential(options, env, name));
  }
  return options?.agentId === "claude" && !env.ANTHROPIC_BASE_URL?.trim() &&
    !["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]
      .some((name) => deliveredCredential(options, env, name));
}

export function grantsLoginStore(options: SandboxOptions | undefined, env: NodeJS.ProcessEnv): boolean {
  return options?.loginStore === true && !options.noLoginStore && options.trust !== "untrusted" &&
    usesOperatorLogin(options, env);
}

/** The login-store grant a session records and a resume probe compares:
 * the EFFECTIVE one. `--sandbox-trust untrusted` and `--sandbox-no-login-store`
 * never grant, so a request that carries the option under either records
 * no grant, and the same flags on resume compare equal to that record
 * (review round 3). The record side and the probe side both call this. */
export function effectiveLoginStoreGrant(flags: {
  sandboxed: boolean; loginStore?: boolean; noLoginStore?: boolean; trust?: SandboxOptions["trust"];
}): boolean {
  return flags.sandboxed && flags.loginStore === true && !flags.noLoginStore && flags.trust !== "untrusted";
}

/** agy's file token (`~/.gemini/antigravity-cli/antigravity-oauth-token`)
 * is agy's own state file, on every platform. It is not the Keychain login
 * store, so it needs no opt-in: every agy sandbox that authenticates with
 * the operator login is granted that one file. `--sandbox-trust untrusted`
 * and `--sandbox-no-login-store` withhold it. */
export function grantsAgyFileToken(options: SandboxOptions | undefined, env: NodeJS.ProcessEnv): boolean {
  return options?.agentId === "agy" && !options.noLoginStore && options.trust !== "untrusted" &&
    usesOperatorLogin(options, env);
}

/** The notice is about the macOS Keychain only. Outside macOS no login is
 * withheld by default: agy's file token is granted without the opt-in
 * (grantsAgyFileToken), and Claude's login-store grants exist on macOS
 * only. The file token is withheld only where the operator asked for that
 * (`--sandbox-trust untrusted`, `--sandbox-no-login-store`), so no notice
 * prints there. */
export function sandboxLoginUnavailable(options: SandboxOptions | undefined, env: NodeJS.ProcessEnv,
  platform = process.platform): boolean {
  return platform === "darwin" && usesOperatorLogin(options, env) && !grantsLoginStore(options, env);
}

export const SANDBOX_LOGIN_UNAVAILABLE = "the sandbox was not granted the login store: it does not reach the macOS Keychain, so a Keychain login is not available inside it; --sandbox-login-store or sandboxLoginStore: true grants it; see docs/isolation.md for what that exposes.";

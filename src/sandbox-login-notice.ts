import { NATIVE_LOGIN_PATHS } from "./native-login-paths.js";
import type { SandboxOptions } from "./sandbox.js";
import { SANDBOX_LOGIN_UNAVAILABLE, sandboxLoginUnavailable } from "./sandbox-login-policy.js";

/** Describe the effective grant, without inspecting the login store. */
export function reportSandboxLoginStore(
  command: readonly string[], options?: SandboxOptions, preview = false,
  tty = process.stderr.isTTY === true,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  environment: NodeJS.ProcessEnv = process.env
): void {
  if (sandboxLoginUnavailable(options, environment)) {
    write(`Info: ${SANDBOX_LOGIN_UNAVAILABLE}`);
    return;
  }
  if (preview || !tty || (options?.agentId !== "claude" && options?.agentId !== "agy")) return;
  const grants = command.slice(0, command.indexOf("--")).filter((path, index) =>
    command[index - 1] === "--allow" && NATIVE_LOGIN_PATHS.some((suffix) => path.endsWith(`/${suffix}`)));
  if (grants.length) write("Info: native login-store grant: every sandboxed process can read Keychain items trusting the system security tool without a dialog, including refresh tokens and other tools' tokens, copy login.keychain-db for offline attack, and create, modify or delete Keychains directory files; security preferences are read-only. See docs/isolation.md; disable with --sandbox-no-login-store.");
}

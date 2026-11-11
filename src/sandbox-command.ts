import { isAbsolute } from "node:path";
import { envProgramIndex, trustCheckedCommandPaths } from "./executable-security.js";
import { canonicalSandboxBlockPath } from "./session/registry/format.js";
import { UsageRefusalError, USAGE_REFUSAL_EXIT_CODE } from "./validation.js";

/** Preserve the strict launch refusal through per-turn session end paths. */
export class StrictSandboxRefusalError extends UsageRefusalError {}

export function strictLaunchFailureExitCode(error: unknown): 64 | 1 {
  return error instanceof StrictSandboxRefusalError ? USAGE_REFUSAL_EXIT_CODE : 1;
}

/** Scode 0.6.5's system read/execute roots. No writable grant substitutes
 * for its exact leading-command exception when env hides an executable. */
const SYSTEM_ROOTS = process.platform === "darwin"
  ? ["/usr", "/opt", "/System", "/Library", "/private/var/db", "/private/var/run",
    "/private/var/select", "/private/etc", "/dev", "/bin", "/sbin", "/etc"]
  : process.platform === "linux" ? ["/usr", "/opt", "/lib", "/lib64", "/bin", "/sbin", "/etc"] : [];

export function containsPath(parent: string, child: string): boolean {
  return parent === child || child.startsWith(parent === "/" ? "/" : `${parent}/`);
}

export function strictCommandPaths(command: readonly string[]): readonly string[] {
  try { return trustCheckedCommandPaths(command); }
  catch (error) {
    throw new StrictSandboxRefusalError(error instanceof Error ? error.message : String(error));
  }
}

export function assertStrictExecutables(command: readonly string[], blocks: readonly string[], grants: readonly string[]): void {
  const paths = strictCommandPaths(command);
  const canonicalBlocks = blocks.map(canonicalSandboxBlockPath);
  const canonicalGrants = grants.map(canonicalSandboxBlockPath);
  for (const [index, executable] of paths.entries()) {
    const path = isAbsolute(executable) ? canonicalSandboxBlockPath(executable) : executable;
    const diagnosticPath = JSON.stringify(executable).slice(1, -1);
    if (canonicalGrants.some((grant) => containsPath(grant, path))) {
      throw new StrictSandboxRefusalError(`strict sandbox refuses writable executable grant: ${diagnosticPath}`);
    }
    if (index === 0) continue; // scode's exact, read/execute-only command exception
    if (!isAbsolute(path) || !SYSTEM_ROOTS.some((root) => containsPath(root, path)) ||
        canonicalBlocks.some((block) => containsPath(block, path))) {
      throw new StrictSandboxRefusalError(`strict sandbox cannot read env-wrapped executable ${diagnosticPath}; scode has no read-only path grant`);
    }
  }
}

/** Apply every wrapper in execution order without rewriting argv or HOME
 * seen by scode. An inner unset or assignment overrides the outer one. */
export function effectiveSandboxCommand(command: readonly string[], environment: NodeJS.ProcessEnv) {
  strictCommandPaths(command); // malformed wrappers are usage refusals
  const env = { ...environment };
  let offset = 0;
  while (offset < command.length) {
    const program = envProgramIndex(command.slice(offset));
    if (program === null) break;
    for (let i = offset + 1; i < offset + program; i++) {
      const argument = command[i]!;
      if (argument === "-u" || argument === "--unset") delete env[command[++i]!];
      else {
        const equals = argument.indexOf("=");
        env[argument.slice(0, equals)] = argument.slice(equals + 1);
      }
    }
    offset += program;
  }
  return { executable: command[offset], env };
}

import {
  accessSync,
  constants,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

function isWithin(path: string, root: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

export function resolveTrustedExecutable(
  binaryPath: string,
  label: string,
  forbiddenRoot?: string
): string {
  let resolvedBinary: string;
  try {
    resolvedBinary = realpathSync(resolve(binaryPath));
    const stat = statSync(resolvedBinary);
    if (!stat.isFile()) {
      throw new Error("path is not a regular file");
    }
    accessSync(resolvedBinary, constants.X_OK);
    if (process.platform !== "win32") {
      if ((stat.mode & 0o022) !== 0) {
        throw new Error("path must not be group- or world-writable");
      }
      if (
        typeof process.getuid === "function" &&
        stat.uid !== process.getuid() &&
        stat.uid !== 0
      ) {
        throw new Error("path must be owned by the current user or root");
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`${label} binary is not a trusted executable${detail}`);
  }

  if (
    forbiddenRoot !== undefined &&
    isWithin(resolvedBinary, realpathSync(resolve(forbiddenRoot)))
  ) {
    throw new Error(
      `${label} binary must not be inside the execution working directory`
    );
  }
  return resolvedBinary;
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Resolves every executable a command names to a trusted absolute path.
 *
 * A command may start with `env NAME=value ... program`, the only way to
 * hand a child a different HOME than the sandbox wrapper itself runs with
 * (Codex's hermetic home). Validating `env` alone would let the program it
 * launches come from PATH unchecked, so both are resolved and validated.
 */
export function resolveTrustedCommand(
  command: readonly string[],
  label: string,
  forbiddenRoot?: string,
  pathEnv: string | undefined = process.env.PATH
): string[] {
  if (command.length === 0 || typeof command[0] !== "string" || command[0].length === 0) {
    throw new Error(`${label} produced an invalid command`);
  }
  const resolved = [...command];
  const resolveAt = (index: number, keepName = false): void => {
    const name = command[index]!;
    const binaryPath = Bun.which(name, { PATH: pathEnv });
    if (!binaryPath) {
      throw new Error(`${label} executable '${name}' was not found`);
    }
    const trusted = resolveTrustedExecutable(binaryPath, name, forbiddenRoot);
    // A multi-call binary (busybox, single-binary coreutils) picks its
    // applet from argv[0], so `env` must run under its own name; the
    // realpath is only validated.
    resolved[index] = keepName ? binaryPath : trusted;
  };
  const isEnv = command[0] === "env" || command[0].endsWith("/env");
  resolveAt(0, isEnv);
  if (isEnv) {
    let index = 1;
    while (index < command.length && ENV_ASSIGNMENT.test(command[index]!)) index++;
    if (index >= command.length || command[index]!.startsWith("-")) {
      throw new Error(`${label} env prefix names no program to run`);
    }
    resolveAt(index);
  }
  return resolved;
}

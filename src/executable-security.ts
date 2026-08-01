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

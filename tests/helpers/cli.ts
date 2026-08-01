import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runCli(
  args: string[],
  envOverrides?: Record<string, string>
): Promise<CliResult> {
  const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-cli-home-"));
  try {
    const proc = Bun.spawn(
      [join(import.meta.dir, "..", "..", "bin", "codemux"), ...args],
      {
        cwd: join(import.meta.dir, "..", ".."),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: isolatedHome,
          XDG_CONFIG_HOME: join(isolatedHome, ".config"),
          ...envOverrides,
        } as Record<string, string>,
      }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
}

export function minimalPath(): string {
  const bunPath = Bun.which("bun", { PATH: process.env.PATH });
  return [
    bunPath ? dirname(bunPath) : dirname(process.execPath),
    "/usr/bin",
    "/bin",
  ].join(":");
}

export function createFakeBinaryEnv(
  binaries: Record<string, string>
): { env: Record<string, string>; cleanup: () => void } {
  const binDir = mkdtempSync(join(tmpdir(), "codemux-cli-bin-"));
  for (const [name, body] of Object.entries(binaries)) {
    const scriptPath = join(binDir, name);
    const versionPreamble = name === "scode"
      ? "if [ \"$1\" = \"--version\" ]; then printf 'scode 0.2.0\\n'; exit 0; fi\n"
      : "";
    writeFileSync(scriptPath, `#!/bin/sh\n${versionPreamble}${body}\n`);
    chmodSync(scriptPath, 0o755);
  }

  return {
    env: {
      PATH: `${binDir}:${minimalPath()}`,
    },
    cleanup: () => {
      rmSync(binDir, { recursive: true, force: true });
    },
  };
}

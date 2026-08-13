import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// A PATH that provably contains no optional Codemux integration.
//
// This used to expose the real directory holding `bun`, which silently stopped
// being minimal once `bun` and `usagemux` were both installed under the same
// Homebrew prefix: tests asserting "usagemux is absent" then passed or failed
// depending on the machine. Link `bun` into a private directory instead, so
// nothing else on the host can leak in.
let isolatedBunDir: string | null = null;

export function minimalPath(): string {
  if (isolatedBunDir === null) {
    const bunPath =
      Bun.which("bun", { PATH: process.env.PATH }) ?? process.execPath;
    isolatedBunDir = mkdtempSync(join(tmpdir(), "codemux-cli-bin-"));
    symlinkSync(bunPath, join(isolatedBunDir, "bun"));
  }
  return [isolatedBunDir, "/usr/bin", "/bin"].join(":");
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

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
  envOverrides?: Record<string, string>,
  // `holdStdin` writes `stdin` but leaves the pipe open until the process
  // exits, for a session that must end on its own rather than on EOF.
  // `cwd` overrides the repository root the CLI spawns from (the operator
  // cwd a command like hermetic check validates against).
  options?: { stdin?: string | Uint8Array; holdStdin?: boolean; cwd?: string }
): Promise<CliResult> {
  const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-cli-home-"));
  try {
    const childEnv = {
      ...process.env,
      // Spawned CLI tests run against a throwaway HOME, so no spawned
      // codemux can reach the operator's real login stores.
      HOME: isolatedHome,
      XDG_CONFIG_HOME: join(isolatedHome, ".config"),
      ...envOverrides,
    } as Record<string, string>;
    // The quota gate's in-process hermeticity switch stays behind:
    // a spawned codemux runs the real gate against its own fake or
    // absent usagemux (tests/setup.ts sets the variable).
    delete childEnv.CODEMUX_TEST_NO_QUOTA_GATE;
    const proc = Bun.spawn(
      [join(import.meta.dir, "..", "..", "bin", "codemux"), ...args],
      {
        cwd: options?.cwd ?? join(import.meta.dir, "..", ".."),
        stdout: "pipe",
        stderr: "pipe",
        // "ignore" keeps a run that reads stdin (-f -) failing fast on EOF
        // rather than inheriting the test runner's terminal.
        stdin: options?.stdin === undefined ? "ignore" : "pipe",
        env: childEnv,
      }
    );
    const stdin = proc.stdin;
    if (options?.stdin !== undefined && stdin !== null && stdin !== undefined) {
      stdin.write(options.stdin);
      if (options.holdStdin === true) stdin.flush();
      else stdin.end();
    }
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

/**
 * A fake run harness's first line: read the prompt the way a real harness
 * does. codemux feeds a run's prompt on stdin and fails a run whose write
 * the child never took (src/process-stdin.ts, review round 66). A fake
 * that exited without reading raced that write: under load the child was
 * gone first, the write hit EPIPE, and the run failed (CI runs
 * 42706848920 and 42713067223, ubuntu-latest). For one-shot runs only:
 * codemux ends stdin after the prompt there, so the read reaches EOF;
 * session and repeating-stdin fakes keep stdin open and must not use it.
 * The version probe is left alone.
 */
export const READS_PROMPT = 'if [ "$1" != "--version" ]; then cat >/dev/null; fi\n';

/**
 * createFakeBinaryEnv for one-shot run and check tests: every harness body
 * that does not already read stdin starts with READS_PROMPT. Tools that are
 * not harnesses (usagemux, security, git) and a scode that execs what it
 * wraps are left alone, since the wrapped harness reads the prompt itself.
 * Never for session fakes: their stdin stays open.
 */
export function createRunFakeBinaryEnv(
  binaries: Record<string, string>,
  scodeVersion?: string
): { env: Record<string, string>; cleanup: () => void } {
  const tools = new Set(["usagemux", "security", "git", "codexbar"]);
  const readsStdin = (body: string): boolean => /\bcat\b|\bread\b|\bhead\b|\/dev\/stdin|\bdd\b/.test(body);
  const prepared = Object.fromEntries(Object.entries(binaries).map(([name, body]) => [
    name,
    tools.has(name) || readsStdin(body) || (name === "scode" && /\bexec\b/.test(body)) ? body : READS_PROMPT + body,
  ]));
  return scodeVersion === undefined ? createFakeBinaryEnv(prepared) : createFakeBinaryEnv(prepared, scodeVersion);
}

export function createFakeBinaryEnv(
  binaries: Record<string, string>,
  scodeVersion = "0.6.0"
): { env: Record<string, string>; cleanup: () => void } {
  const binDir = mkdtempSync(join(tmpdir(), "codemux-cli-bin-"));
  const apiKeyLogin = Boolean(binaries.agy);
  for (const [name, body] of Object.entries(binaries)) {
    const scriptPath = join(binDir, name);
    const versionPreamble = name === "scode"
      ? `if [ "$1" = "--version" ]; then printf 'scode ${scodeVersion}\\n'; exit 0; fi\n`
      : "";
    const interpreter = "/bin/sh";
    writeFileSync(scriptPath, `#!${interpreter}\n${versionPreamble}${body}\n`);
    chmodSync(scriptPath, 0o755);
  }

  return {
    env: {
      PATH: `${binDir}:${minimalPath()}`,
      ...(apiKeyLogin ? { GEMINI_API_KEY: "synthetic-api-key" } : {}),
    },
    cleanup: () => {
      rmSync(binDir, { recursive: true, force: true });
    },
  };
}

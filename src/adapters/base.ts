import type {
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  RunResult,
  AdapterCapabilities,
} from "../types.js";

/**
 * Wait for a spawned interactive process, shielding it from signals that would
 * otherwise propagate through the process group and kill grandchildren (e.g. a
 * Playwright browser).
 *
 * - SIGINT: swallowed in parent (child receives it from the terminal via the
 *   shared process group). Rapid triple-SIGINT forces a SIGTERM to the child.
 * - SIGTERM/SIGHUP: forwarded to child only (proc.kill), not broadcast.
 */
export async function guardedWait(proc: ReturnType<typeof Bun.spawn>): Promise<number> {
  let sigintCount = 0;
  let sigintTimer: ReturnType<typeof setTimeout> | null = null;

  const onSigint = () => {
    sigintCount++;
    if (sigintCount >= 3) {
      proc.kill("SIGTERM");
      return;
    }
    if (sigintTimer) clearTimeout(sigintTimer);
    sigintTimer = setTimeout(() => { sigintCount = 0; }, 1000);
  };
  const onSigterm = () => proc.kill("SIGTERM");
  const onSighup = () => proc.kill("SIGHUP");

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);

  const exitCode = await proc.exited;

  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  process.off("SIGHUP", onSighup);
  if (sigintTimer) clearTimeout(sigintTimer);

  return exitCode;
}

export abstract class BaseAdapter {
  abstract readonly id: AgentId;
  abstract readonly binaryName: string;

  abstract capabilities(): AdapterCapabilities;

  abstract buildRunCommand(request: RunRequest): string[];

  abstract buildTuiCommand(model?: string, autonomy?: AutonomyLevel, effort?: ReasoningEffort): string[];

  isAvailable(): boolean {
    const result = Bun.spawnSync(["which", this.binaryName]);
    return result.exitCode === 0;
  }

  resolveModel(model: string, mapping?: Record<string, string>): string {
    if (mapping) {
      const resolved = mapping[this.id];
      if (resolved) {
        return resolved;
      }
    }
    return model;
  }

  mapAutonomy(level: AutonomyLevel): string[] {
    return [];
  }

  mapEffort(level: ReasoningEffort): string[] {
    return [];
  }

  getStdinInput(request: RunRequest): string | null {
    return null;
  }

  /**
   * Returns custom environment variables for this adapter.
   * Override in subclasses to set things like API endpoints.
   */
  getEnv(): Record<string, string> {
    return {};
  }

  /**
   * Called before launching the agent. Use for banners, validation, etc.
   * Throw to abort launch.
   */
  beforeLaunch(): void {
    // Default: no-op
  }

  async run(request: RunRequest): Promise<RunResult> {
    const command = this.buildRunCommand(request);
    const cwd = request.cwd || process.cwd();
    const stdinInput = this.getStdinInput(request);

    const proc = Bun.spawn(command, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });

    if (stdinInput) {
      proc.stdin.write(stdinInput);
    }
    proc.stdin.end();

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return {
      stdout,
      stderr,
      exitCode,
      success: exitCode === 0,
    };
  }

  async runInteractive(model?: string, cwd?: string, autonomy?: AutonomyLevel, effort?: ReasoningEffort): Promise<number> {
    const command = this.buildTuiCommand(model, autonomy, effort);
    const workdir = cwd || process.cwd();

    const proc = Bun.spawn(command, {
      cwd: workdir,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });

    return await guardedWait(proc);
  }
}

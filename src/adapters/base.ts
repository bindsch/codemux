import type {
  AgentId,
  AutonomyLevel,
  RunRequest,
  RunResult,
  AdapterCapabilities,
} from "../types.js";

export abstract class BaseAdapter {
  abstract readonly id: AgentId;
  abstract readonly binaryName: string;

  abstract capabilities(): AdapterCapabilities;

  abstract buildRunCommand(request: RunRequest): string[];

  abstract buildTuiCommand(model?: string): string[];

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

  async run(request: RunRequest): Promise<RunResult> {
    const command = this.buildRunCommand(request);
    const cwd = request.cwd || process.cwd();

    const proc = Bun.spawn(command, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "inherit",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    return {
      stdout,
      stderr,
      exitCode,
      success: exitCode === 0,
    };
  }

  async runInteractive(model?: string, cwd?: string): Promise<number> {
    const command = this.buildTuiCommand(model);
    const workdir = cwd || process.cwd();

    const proc = Bun.spawn(command, {
      cwd: workdir,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });

    return await proc.exited;
  }
}

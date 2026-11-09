import { expect, spyOn, test } from "bun:test";
import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import * as runtime from "../src/cli-runtime.js";
import { getDefaultConfig } from "../src/config.js";
import { registerTuiCommand } from "../src/tui-command.js";
import { withOpenCodeLaunch } from "./helpers/opencode-launch.js";

async function tui(args: string[]) {
  const program = new Command(); program.exitOverride();
  registerTuiCommand(program, getDefaultConfig(), () => {});
  const handler = spyOn(runtime, "handleUnexpectedError").mockImplementation((error) => { throw error; });
  try { await program.parseAsync(["tui", "-a", "opencode", "--no-quota-gate", ...args], { from: "user" }); }
  finally { handler.mockRestore(); }
}

test.each([
  { sandbox: true, effort: "high", mode: "normal", expected: 0 },
  { sandbox: false, effort: "none", mode: "normal", expected: 0 },
  { sandbox: true, effort: "none", mode: "failure", expected: 7 },
  { sandbox: false, effort: "high", mode: "failure", expected: 7 },
])("OpenCode TUI owns its effort state through child exit: %j", async ({ sandbox, effort, mode, expected }) => {
  await withOpenCodeLaunch(async (rig) => {
    const originalState = join(rig.home, ".local/state/opencode");
    mkdirSync(originalState, { recursive: true });
    const previous = JSON.stringify({ variant: { "provider/model": "low" } });
    writeFileSync(join(originalState, "model.json"), previous);
    await tui(["--cwd", rig.cwd, "--model", "provider/model", "--effort", effort,
      ...(sandbox ? [] : ["--no-sandbox", "--auto", "high"])]);
    expect(process.exitCode, rig.errors.join("\n")).toBe(expected);
    const observed = rig.observations(); expect(observed).toHaveLength(1);
    expect(observed[0]!.variant).toMatchObject({ variant: { "provider/model": effort } });
    expect(observed[0]!.args).toContain("provider/model");
    expect(existsSync(observed[0]!.state)).toBe(false);
    expect(readFileSync(join(originalState, "model.json"), "utf8")).toBe(previous);
  }, { mode });
});

test("OpenCode TUI provider selection and effort reach the same prepared child", async () => {
  await withOpenCodeLaunch(async (rig) => {
    await tui(["--cwd", rig.cwd, "--effort", "medium"]);
    expect(process.exitCode).toBe(0);
    const observed = rig.observations()[0]!;
    expect(observed.args).toContain("codemux/model");
    expect(observed.variant).toMatchObject({ variant: { "codemux/model": "medium" } });
    expect(observed.config.provider.codemux.options.apiKey).toBe("{env:CODEMUX_OPENCODE_PROVIDER_API_KEY}");
    expect(JSON.stringify(observed)).not.toContain("synthetic-key");
    expect(existsSync(observed.state)).toBe(false);
  }, { provider: true });
});

test("OpenCode TUI print-only effort creates neither private state nor a child", async () => {
  await withOpenCodeLaunch(async (rig) => {
    await tui(["--cwd", rig.cwd, "--model", "provider/model", "--effort", "high", "--print-sandbox"]);
    expect(process.exitCode).toBe(0);
    expect(rig.observations()).toHaveLength(0);
    expect(rig.stdout.join("")).toContain("provider/model");
    const data = join(rig.home, ".local/share/opencode");
    expect(existsSync(data) ? readdirSync(data) : []).toEqual([]);
  });
});

test("OpenCode TUI cleans prepared state when the sandbox runner rejects before spawning", async () => {
  await withOpenCodeLaunch(async (rig) => {
    let state: string | undefined;
    const prepare = OpencodeAdapter.prototype.prepareTuiEnvironment;
    const preparation = spyOn(OpencodeAdapter.prototype, "prepareTuiEnvironment").mockImplementation(function (
      this: OpencodeAdapter, ...args: Parameters<OpencodeAdapter["prepareTuiEnvironment"]>
    ) {
      const prepared = prepare.apply(this, args); state = prepared.env.XDG_STATE_HOME; return prepared;
    });
    const runner = spyOn(runtime, "runSandboxed").mockImplementation(async () => {
      expect(state).toBeDefined(); expect(existsSync(state!)).toBe(true);
      throw new Error("synthetic spawn failure");
    });
    try {
      await expect(tui(["--cwd", rig.cwd, "--model", "provider/model", "--effort", "high"]))
        .rejects.toThrow("synthetic spawn failure");
      expect(existsSync(state!)).toBe(false);
      expect(rig.observations()).toHaveLength(0);
    } finally { runner.mockRestore(); preparation.mockRestore(); }
  });
});

test("OpenCode direct TUI cleans prepared state when native spawn throws", async () => {
  await withOpenCodeLaunch(async (rig) => {
    const adapter = new OpencodeAdapter(process.env, rig.home);
    let state: string | undefined;
    const spawn = spyOn(Bun, "spawn").mockImplementation(((_command: unknown, options?: { env?: NodeJS.ProcessEnv }) => {
      state = options?.env?.XDG_STATE_HOME;
      expect(existsSync(state!)).toBe(true);
      throw new Error("synthetic native spawn failure");
    }) as unknown as typeof Bun.spawn);
    try {
      await expect(adapter.runInteractive("provider/model", rig.cwd, "high", "high"))
        .rejects.toThrow("synthetic native spawn failure");
      expect(existsSync(state!)).toBe(false);
    } finally { spawn.mockRestore(); }
  });
});

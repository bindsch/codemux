/**
 * The launcher side of the --print-sandbox refusals: a launch that must
 * not run anything can never reach the point that mints the experiment
 * MCP relay (review round 1, blocker), and a direct launch has no
 * sandbox to print at all (review round 7, edges). run-command.ts
 * refuses both up front; these pin the launcher itself, so a caller
 * that bypasses the CLI (or a refactor that moves the guard) still
 * refuses before any preparation or spawn.
 */

import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import * as claudeProjectConfig from "../src/claude-project-config.js";
import { launchRunRequest } from "../src/launch.js";
import type { RunContext } from "../src/adapters/base.js";
import type { RunRequest } from "../src/types.js";
import { createFakeBinaryEnv, READS_PROMPT } from "./helpers/cli.js";

test("a printSandbox launch without sandbox refuses before any spawn", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codemux-print-sandbox-direct-"));
  const ambient = createFakeBinaryEnv({ scode: "exit 7", claude: "printf '2.1.220\\n'" });
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = ambient.env.PATH;
    const adapter = new ClaudeAdapter(ambient.env);
    // If the launch ever reaches the direct branch's preparation, this
    // error surfaces instead of the refusal and the assertion fails.
    const detonate = (): never => {
      throw new Error("the direct branch must not run under --print-sandbox");
    };
    const prepare = spyOn(adapter, "prepareRun").mockImplementation(detonate);
    const request: RunRequest = {
      agent: "claude", prompt: "probe", cwd, sandboxed: false, autonomy: "read-only",
    };
    try {
      await expect(launchRunRequest(adapter, request, {
        sandbox: false, requestedAutonomy: "read-only", cwd, printSandbox: true,
      })).rejects.toThrow("--print-sandbox requires --sandbox");
    } finally {
      prepare.mockRestore();
    }
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    ambient.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a printSandbox launch refuses before the experiment relay is minted", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codemux-print-sandbox-"));
  const ambient = createFakeBinaryEnv({ scode: "exit 7", claude: "printf '2.1.220\\n'" });
  const spec = join(cwd, "experiment.json");
  writeFileSync(spec, JSON.stringify({ name: "experiment", command: "/bin/echo", args: [], env: [] }));
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = ambient.env.PATH;
    const adapter = new ClaudeAdapter(ambient.env);
    // A context whose experiment preparation detonates: if the launch ever
    // reaches prepare(), this error surfaces instead of the refusal, and
    // the rejection assertion below fails.
    const detonate = (): never => {
      throw new Error("experiment prepare must not run under --print-sandbox");
    };
    const poisoned: RunContext = {
      experimentCodex: { prepare: detonate } as unknown as RunContext["experimentCodex"],
      experimentKimi: { prepare: detonate } as unknown as RunContext["experimentKimi"],
    };
    const prepare = spyOn(adapter, "prepareRun").mockReturnValue(poisoned);
    const request: RunRequest = {
      agent: "claude", prompt: "probe", cwd, sandboxed: true, autonomy: "read-only",
      hermetic: true, tools: "none", experimentMcp: spec,
    };
    try {
      await expect(launchRunRequest(adapter, request, {
        sandbox: true, requestedAutonomy: "read-only", cwd, printSandbox: true,
      })).rejects.toThrow(
        "--print-sandbox cannot be combined with --experiment-mcp: the MCP relay is minted at start, so its argv cannot be shown without starting it"
      );
    } finally {
      prepare.mockRestore();
    }
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    ambient.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a print-only sandboxed launch never runs prepareSandbox (round 18, edges 2)", async () => {
  // Print-only launches skip adapter preparation.
  const cwd = mkdtempSync(join(tmpdir(), "codemux-print-sandbox-prep-"));
  // The fake scode reads the prompt before it refuses (READS_PROMPT):
  // one that exited unread raced codemux's stdin write into EPIPE under
  // load (CI run 42713067223, ubuntu-latest).
  const ambient = createFakeBinaryEnv({ scode: `${READS_PROMPT}exit 9`, claude: "printf '2.1.220\\n'" });
  const previousPath = process.env.PATH;
  let prepare: ReturnType<typeof spyOn> | undefined;
  try {
    process.env.PATH = ambient.env.PATH;
    const adapter = new ClaudeAdapter(ambient.env);
    prepare = spyOn(adapter, "prepareSandbox");
    const request: RunRequest = {
      agent: "claude", prompt: "probe", cwd, sandboxed: true, autonomy: "read-only",
    };
    const printed = await launchRunRequest(adapter, request, {
      sandbox: true, requestedAutonomy: "read-only", cwd, printSandbox: true,
    });
    expect(printed.exitCode).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
    // The execution path still calls the adapter preparation seam.
    await launchRunRequest(adapter, request, {
      sandbox: true, requestedAutonomy: "read-only", cwd,
    });
    expect(prepare).toHaveBeenCalledTimes(1);
  } finally {
    prepare?.mockRestore();
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    ambient.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a print-only project-settings run never reads or copies the credential mirror (round 19, edges 3)", async () => {
  // The printed environment must not prepare private login state.
  const cwd = mkdtempSync(join(tmpdir(), "codemux-print-sandbox-mirror-"));
  const home = mkdtempSync(join(tmpdir(), "codemux-print-sandbox-home-"));
  // The source is a synthetic file-only login.
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { refreshToken: "synthetic-refresh-token", accessToken: "sk-ant-syntax" } })
  );
  // The fake scode reads the prompt before it refuses (READS_PROMPT):
  // one that exited unread raced codemux's stdin write into EPIPE under
  // load (CI run 42713067223, ubuntu-latest).
  const ambient = createFakeBinaryEnv({ scode: `${READS_PROMPT}exit 9`, claude: "printf '2.1.220\\n'" });
  const previousPath = process.env.PATH;
  let copy: ReturnType<typeof spyOn> | undefined;
  try {
    process.env.PATH = ambient.env.PATH;
    const adapter = new ClaudeAdapter({ ...ambient.env, HOME: home });
    copy = spyOn(claudeProjectConfig, "copyClaudeCredentialMirror");
    const request: RunRequest = {
      agent: "claude", prompt: "probe", cwd, sandboxed: true, autonomy: "low",
      hermetic: true, experimentProjectSettings: true,
    };
    const printed = await launchRunRequest(adapter, request, {
      sandbox: true, requestedAutonomy: "low", cwd, printSandbox: true,
    });
    expect(printed.exitCode).toBe(0);
    expect(copy).not.toHaveBeenCalled();
    // Execution reaches the copy seam, which is a no-op on macOS.
    await launchRunRequest(adapter, request, {
      sandbox: true, requestedAutonomy: "low", cwd,
    });
    expect(copy).toHaveBeenCalledTimes(1);
  } finally {
    copy?.mockRestore();
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    ambient.cleanup();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

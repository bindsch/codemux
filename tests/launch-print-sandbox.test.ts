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
import * as credentialsModule from "../src/credentials.js";
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
  // prepareSandbox exists for its side effects: the claude family's
  // implementation refreshes or scrubs the operator's default credential
  // mirror and prunes its backups. A diagnostic that promises to print
  // the argv and run nothing must not touch authentication state, and the
  // printed argv loses nothing — prepareSandbox contributes no argv input.
  const cwd = mkdtempSync(join(tmpdir(), "codemux-print-sandbox-prep-"));
  // The fake scode reads the prompt before it refuses (READS_PROMPT):
  // one that exited unread raced codemux's stdin write into EPIPE under
  // load (CI run 42713067223, ubuntu-latest).
  const ambient = createFakeBinaryEnv({ scode: `${READS_PROMPT}exit 9`, claude: "printf '2.1.220\\n'" });
  const previousPath = process.env.PATH;
  // The credential sync is stubbed so the control launch below — which
  // DOES call prepareSandbox — never reads the operator's Keychain.
  const sync = spyOn(credentialsModule, "syncKeychainCredential").mockReturnValue("skipped");
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
    expect(sync).not.toHaveBeenCalled();
    // Control: the same launch without printSandbox runs prepareSandbox
    // (and with it the credential sync), so the assertion above pins the
    // print-only skip, not a launch that never reaches the step.
    await launchRunRequest(adapter, request, {
      sandbox: true, requestedAutonomy: "read-only", cwd,
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
  } finally {
    prepare?.mockRestore();
    sync.mockRestore();
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    ambient.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a print-only project-settings run never reads or copies the credential mirror (round 19, edges 3)", async () => {
  // getRunEnv still runs on the print path — the printed argv needs
  // CLAUDE_CONFIG_DIR — and claude's implementation copies the operator's
  // mirror into the private directory unless the context defers it, which
  // only the session path did. A mirror holding a refresh token made the
  // print itself fail, and a valid mirror was written into the temporary
  // private directory. The print must answer the environment with neither
  // side effect.
  const cwd = mkdtempSync(join(tmpdir(), "codemux-print-sandbox-mirror-"));
  const home = mkdtempSync(join(tmpdir(), "codemux-print-sandbox-home-"));
  // A synthetic mirror carrying a refresh token: copyClaudeCredentialMirror
  // refuses it, so any read of the mirror fails the launch loudly.
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
  // The control launch below DOES call prepareSandbox; stub the sync so it
  // never consults the operator's real Keychain (the planted mirror is the
  // only credential this test owns).
  const sync = spyOn(credentialsModule, "syncKeychainCredential").mockReturnValue("skipped");
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
    // The refresh-token mirror neither fails the print nor is read.
    expect(printed.exitCode).toBe(0);
    expect(copy).not.toHaveBeenCalled();
    // Control: the same launch without printSandbox DOES read the mirror,
    // so the assertion above pins the deferral, not a path that never
    // reaches the copy.
    await expect(launchRunRequest(adapter, request, {
      sandbox: true, requestedAutonomy: "low", cwd,
    })).rejects.toThrow("holds a refresh token");
    expect(copy).toHaveBeenCalledTimes(1);
  } finally {
    copy?.mockRestore();
    sync.mockRestore();
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    ambient.cleanup();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

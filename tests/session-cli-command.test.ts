/**
 * The in-process side of the session command: registerSessionCommand
 * runs inside the coverage process, so every refusal, resume guard,
 * quota-gate arm, and --print-sandbox path the spawned-CLI suites pin
 * only in a child is measured too. The full session drives (a fake
 * harness speaking the wire) live in tests/session-cli-command-drives.test.ts.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ClaudeCredentialAdapter } from "../src/adapters/claude-credentials.js";
import {
  projectSettingsConfigRoot,
  projectSettingsSessionDirPath,
} from "../src/claude-project-config.js";
import {
  claudeRecord,
  runSessionCommand,
  seedRegistry,
  tempWorkdir,
  removeDir,
} from "./helpers/session-command.js";
import { result, window } from "./helpers/quota-gate.js";

// --version answers the contract's floor; any other invocation exits 7.
const FAKE_CLAUDE = `if [ "$1" = "--version" ]; then printf '2.1.280\\n'; exit 0; fi
exit 7`;

const fakeWithVersion = (version: string): string =>
  `if [ "$1" = "--version" ]; then printf '${version}\\n'; exit 0; fi\nexit 7`;

describe("the session command's option validation in process", () => {
  test("an unknown agent is a usage refusal: exit 64", async () => {
    const outcome = await runSessionCommand(["-a", "nope"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("Unknown agent 'nope'");
    expect(outcome.stderr).toContain("Available agents:");
  });

  test("an agent without a session driver is refused by name", async () => {
    const outcome = await runSessionCommand(["-a", "cline"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("sessions are not implemented for 'cline' in this release");
  });

  test("--tools none is refused for sessions", async () => {
    const outcome = await runSessionCommand(["-a", "claude", "--tools", "none"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("--tools none is refused for sessions");
  });

  test("--tools default names no selection a session carries", async () => {
    const outcome = await runSessionCommand(["-a", "claude", "--tools", "default"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("--tools is not implemented for 'claude' sessions");
  });

  test("--enable-playwright-mcp without --sandbox is refused", async () => {
    const outcome = await runSessionCommand(["-a", "claude", "--no-sandbox", "--enable-playwright-mcp"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("--enable-playwright-mcp requires --sandbox");
  });

  test("--enable-playwright-mcp at an autonomy above low is refused", async () => {
    const outcome = await runSessionCommand(["-a", "claude", "--auto", "high", "--enable-playwright-mcp"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("--enable-playwright-mcp requires --auto low for sessions");
  });

  test("--hermetic without --experiment-project-settings is refused with the reason", async () => {
    const outcome = await runSessionCommand(["-a", "claude", "--hermetic"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("--hermetic is refused for sessions in this release");
    expect(outcome.stderr).toContain("--experiment-project-settings");
  });

  test("--experiment-project-settings is claude/zai only", async () => {
    const outcome = await runSessionCommand(["-a", "codex", "--hermetic", "--experiment-project-settings"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain(
      "--experiment-project-settings applies to the claude and zai agents only in this release"
    );
  });

  test("--final without --experiment-project-settings is refused", async () => {
    const outcome = await runSessionCommand(["-a", "claude", "--final"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("--final requires --hermetic --experiment-project-settings");
  });

  test("a --permission-policy value outside the two supported ones is refused", async () => {
    const outcome = await runSessionCommand(["-a", "claude", "--permission-policy", "banana"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("--permission-policy accepts 'default' or 'deny' in this release");
  });

  test("--permission-policy deny is claude/zai only", async () => {
    const outcome = await runSessionCommand(["-a", "codex", "--permission-policy", "deny"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("--permission-policy deny is supported only by claude and zai sessions");
  });

  test("--permission-policy default is accepted for every session agent", async () => {
    // The value `default` passes validation on every session agent: the
    // run stops at the missing harness (exit 1), never at a
    // --permission-policy complaint.
    const outcome = await runSessionCommand(["-a", "codex", "--permission-policy", "default"]);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("codex is not installed");
    expect(outcome.stderr).not.toContain("--permission-policy");
  });

  test("--sandbox-trust untrusted is refused for sessions", async () => {
    const outcome = await runSessionCommand(["-a", "claude", "--sandbox-trust", "untrusted"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("--sandbox-trust untrusted is refused for sessions");
  });

  test("--turn-timeout on an agent without an interrupt channel is refused", async () => {
    const outcome = await runSessionCommand(["-a", "agy", "--turn-timeout", "30"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("--turn-timeout requires an agent whose sessions support interrupt");
  });

  test("an out-of-range --timeout is refused with its bound", async () => {
    const outcome = await runSessionCommand(["-a", "claude", "--timeout", "100000"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("--timeout must be a number from 0 (exclusive) to 86400 seconds");
  });

  test("an out-of-range --permission-timeout names its flag", async () => {
    const outcome = await runSessionCommand(["-a", "claude", "--permission-timeout", "-1"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("--permission-timeout must be a number from 0 (exclusive) to 86400 seconds");
  });

  test("an autonomy below high without --sandbox is refused", async () => {
    const outcome = await runSessionCommand(["-a", "claude", "--no-sandbox", "--auto", "read-only"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("claude cannot enforce 'read-only' autonomy without --sandbox");
  });

  test("--effort none passes codex session validation: no flag is sent (audit round 2, A2)", async () => {
    // `none` is the CLI's "send no effort flag" spelling on every command,
    // sessions included. The old refusal ("not carried by codex sessions
    // in this release") is gone; the run stops at the missing harness,
    // never at the effort option.
    const outcome = await runSessionCommand(["-a", "codex", "--effort", "none"]);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("codex is not installed");
    expect(outcome.stderr).not.toContain("--effort");
  });

  test("a missing harness is refused with its binary name", async () => {
    const outcome = await runSessionCommand(["-a", "claude"]);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("claude is not installed");
  });

  test("a sandboxed session without scode is refused", async () => {
    const outcome = await runSessionCommand(["-a", "claude"], { claude: FAKE_CLAUDE });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("scode is not installed (required for --sandbox)");
  });
});

describe("the session command's quota gate in process", () => {
  const gateSnapshot = (results: unknown[]) =>
    JSON.stringify({ schemaVersion: "1", generatedAt: new Date().toISOString(), results });

  test("an absent usagemux with the gate on warns once and proceeds", async () => {
    // The launch proceeds past the gate to the spawn, where the fake scode
    // fails at once: the warning is the gate's, the failure the child's.
    // (A --print-sandbox launch runs no gate at all; review round 56.)
    const outcome = await runSessionCommand(
      ["-a", "claude"],
      { claude: FAKE_CLAUDE, scode: "exit 9" },
      { quotaGate: true }
    );
    expect(outcome.stderr).toContain(
      "Warning: quota gate skipped: usagemux is not installed (optional usage integration)"
    );
    expect(outcome.exitCode).not.toBe(64);
  });

  test("a print-only session runs no quota gate (review round 56)", async () => {
    const outcome = await runSessionCommand(
      ["-a", "claude", "--print-sandbox"],
      { claude: FAKE_CLAUDE, scode: "exit 9" },
      { quotaGate: true }
    );
    expect(outcome.stderr).not.toContain("quota gate");
    expect(outcome.stdout).toContain("/claude");
    expect(outcome.exitCode).toBe(0);
  });

  test("a usagemux status error warns and the session proceeds", async () => {
    // An error status carries no evidence of spent quota, so the gate
    // warns and proceeds rather than blocking every launch (gateOnResult).
    const snapshot = gateSnapshot([result({ status: "error", message: "login expired" })]);
    const outcome = await runSessionCommand(
      ["-a", "claude"],
      { claude: FAKE_CLAUDE, scode: "exit 9", usagemux: `printf '%s' '${snapshot}'` },
      { quotaGate: true }
    );
    expect(outcome.exitCode).not.toBe(64);
    expect(outcome.stderr).toContain("Warning: quota gate: claude: usage unreadable (login expired); proceeding");
  });

  test("a healthy window passes the gate and the launch proceeds", async () => {
    const snapshot = gateSnapshot([
      result({ windows: [window({ remainingPercent: 61, usedPercent: 39 })] }),
    ]);
    const outcome = await runSessionCommand(
      ["-a", "claude", "--print-sandbox"],
      { claude: FAKE_CLAUDE, scode: "exit 9", usagemux: `printf '%s' '${snapshot}'` },
      { quotaGate: true }
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).not.toContain("quota gate");
  });

  test("a malformed --quota-ceiling is a usage refusal: exit 64", async () => {
    const outcome = await runSessionCommand(
      ["-a", "claude", "--quota-ceiling", "banana", "--print-sandbox"],
      { claude: FAKE_CLAUDE, scode: "exit 9" }
    );
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("--quota-ceiling must be a number from 0 to 100");
  });
});

describe("the session command's --print-sandbox in process", () => {
  test("prints the scode argv of the claude session child and records nothing", async () => {
    const root = tempWorkdir("session-print");
    const regRoot = tempWorkdir("session-print-reg");
    const registry = join(regRoot, "live-sessions.json");
    // Print only is side-effect free: prepareSandbox never runs (round 18, edges 2).
    const prepare = spyOn(ClaudeCredentialAdapter.prototype, "prepareSandbox");
    try {
      const outcome = await runSessionCommand(
        ["-a", "claude", "--print-sandbox", "--cwd", root],
        { claude: FAKE_CLAUDE, scode: "exit 9" },
        { registryFile: registry }
      );
      expect(outcome.exitCode).toBe(0);
      expect(prepare).not.toHaveBeenCalled();
      // The print path leaves through the single exit: process.exit is
      // never called, so no finalizer can be bypassed (edges 3).
      expect(outcome.exitCalls).toEqual([]);
      const lines = outcome.stdout.split("\n");
      expect(lines.some((line) => line.endsWith("/scode"))).toBe(true);
      expect(lines.some((line) => line.endsWith("/claude"))).toBe(true);
      expect(lines).toContain("--session-id");
      expect(lines).toContain("--permission-prompt-tool");
      expect(outcome.stdout).not.toContain("session_started");
      expect(existsSync(registry)).toBe(false);
    } finally {
      prepare.mockRestore();
      removeDir(root);
      removeDir(regRoot);
    }
  });

  test("--print-sandbox without --sandbox is refused", async () => {
    const outcome = await runSessionCommand(
      ["-a", "claude", "--no-sandbox", "--auto", "high", "--print-sandbox"],
      { claude: FAKE_CLAUDE }
    );
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("--print-sandbox requires --sandbox");
  });

  test("--print-sandbox on a turn-per-process agent is refused", async () => {
    const outcome = await runSessionCommand(
      ["-a", "kimi", "--print-sandbox"],
      { kimi: fakeWithVersion("0.31.1"), scode: "exit 9" }
    );
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain(
      "--print-sandbox is not available for this agent: its session children spawn per turn"
    );
  });
});

describe("the session command's resume guards in process", () => {
  test("an id of the wrong shape is refused before the registry is read", async () => {
    const outcome = await runSessionCommand(
      ["-a", "claude", "--resume", "not-a-uuid"],
      { claude: FAKE_CLAUDE, scode: "exit 9" }
    );
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("--resume expects a UUID session id; 'not-a-uuid' is not one");
  });

  test("a missing registry entry exits 66", async () => {
    const root = tempWorkdir("session-resume-66");
    const registry = join(root, "live-sessions.json");
    const workdir = join(root, "work");
    mkdirSync(workdir, { recursive: true });
    try {
      const id = randomUUID();
      seedRegistry(registry, [claudeRecord(randomUUID(), workdir)]);
      const outcome = await runSessionCommand(
        ["-a", "claude", "--resume", id, "--no-sandbox", "--auto", "high", "--cwd", workdir],
        { claude: FAKE_CLAUDE },
        { registryFile: registry }
      );
      expect(outcome.exitCalls[0]).toBe(66);
      expect(outcome.stderr).toContain(`no recorded session has the id ${id}`);
    } finally {
      removeDir(root);
    }
  });

  test("a foreign agent's entry is a provenance refusal: exit 78", async () => {
    const root = tempWorkdir("session-resume-78");
    const registry = join(root, "live-sessions.json");
    const workdir = join(root, "work");
    mkdirSync(workdir, { recursive: true });
    try {
      const id = randomUUID();
      seedRegistry(registry, [claudeRecord(id, workdir, { agent: "zai" })]);
      const outcome = await runSessionCommand(
        ["-a", "claude", "--resume", id, "--no-sandbox", "--auto", "high", "--cwd", workdir],
        { claude: FAKE_CLAUDE },
        { registryFile: registry }
      );
      expect(outcome.exitCalls[0]).toBe(78);
      expect(outcome.stderr).toContain(`cannot resume ${id}`);
      expect(outcome.stderr).toContain("agent");
    } finally {
      removeDir(root);
    }
  });

  test("an autonomy mismatch is a provenance refusal: exit 78", async () => {
    const root = tempWorkdir("session-resume-78-auto");
    const registry = join(root, "live-sessions.json");
    const workdir = join(root, "work");
    mkdirSync(workdir, { recursive: true });
    try {
      const id = randomUUID();
      seedRegistry(registry, [claudeRecord(id, workdir, { autonomy: "high", sandboxed: true })]);
      const outcome = await runSessionCommand(
        ["-a", "claude", "--resume", id, "--auto", "low", "--cwd", workdir],
        { claude: FAKE_CLAUDE, scode: "exit 9" },
        { registryFile: registry }
      );
      expect(outcome.exitCalls[0]).toBe(78);
      expect(outcome.stderr).toContain("was created at autonomy high and cannot resume above it at low");
    } finally {
      removeDir(root);
    }
  });

  test("a resume that drops a recorded --sandbox-block path is refused 78 before the spawn", async () => {
    // Round 4, edges 2: the record persisted no block paths, so a session
    // created with --sandbox-block resumed without the flag and silently
    // unblocked the recorded tree. The refusal fires in the resume guards,
    // before the claim rewrites the record.
    const root = tempWorkdir("session-resume-block");
    const registry = join(root, "live-sessions.json");
    const workdir = join(root, "work");
    const blocked = tempWorkdir("session-resume-block-tree");
    mkdirSync(workdir, { recursive: true });
    try {
      const id = randomUUID();
      seedRegistry(registry, [
        claudeRecord(id, workdir, { sandboxed: true, sandbox_block: [blocked] }),
      ]);
      const outcome = await runSessionCommand(
        ["-a", "claude", "--resume", id, "--auto", "high", "--cwd", workdir],
        { claude: FAKE_CLAUDE, scode: "exit 9" },
        { registryFile: registry }
      );
      expect(outcome.exitCalls[0]).toBe(78);
      expect(outcome.stderr).toContain(`cannot resume ${id}`);
      expect(outcome.stderr).toContain(`--sandbox-block ${blocked}`);
      // Nothing spawned and nothing was claimed: no session events, and
      // the record still names its dead owner as it was seeded.
      expect(outcome.stdout).toBe("");
      const after = JSON.parse(readFileSync(registry, "utf8")) as { sessions: Array<{ owner_pid: number; ended: string | null }> };
      expect(after.sessions[0]?.owner_pid).toBe(999999);
      expect(after.sessions[0]?.ended).toBeTruthy();
    } finally {
      removeDir(root);
      removeDir(blocked);
    }
  });

  test("a resumed project-settings session without its directory is policy-refused", async () => {
    const root = tempWorkdir("session-resume-eps");
    const registry = join(root, "live-sessions.json");
    const workdir = join(root, "work");
    mkdirSync(workdir, { recursive: true });
    try {
      const id = randomUUID();
      const expectedHome = projectSettingsSessionDirPath(projectSettingsConfigRoot(process.env), id);
      seedRegistry(registry, [
        claudeRecord(id, workdir, {
          hermetic: true,
          project_settings: true,
          sandboxed: true,
          harness_home: expectedHome,
          autonomy: "low",
          pass_env: [],
        }),
      ]);
      const outcome = await runSessionCommand(
        [
          "-a", "claude", "--resume", id, "--cwd", workdir, "--auto", "low",
          "--hermetic", "--experiment-project-settings",
        ],
        { claude: FAKE_CLAUDE, scode: "exit 9" },
        { registryFile: registry }
      );
      expect(outcome.exitCalls[0]).toBe(78);
      expect(outcome.stderr).toContain("its private config directory");
      expect(outcome.stderr).toContain(expectedHome);
    } finally {
      removeDir(root);
    }
  });

  test("a registry inside the working directory is refused: exit 64", async () => {
    const root = tempWorkdir("session-registry-inside");
    const registry = join(root, "registry", "live-sessions.json");
    try {
      const outcome = await runSessionCommand(
        ["-a", "claude", "--cwd", root],
        { claude: FAKE_CLAUDE, scode: "exit 9" },
        { registryFile: registry }
      );
      expect(outcome.exitCode).toBe(64);
      expect(outcome.stderr).toContain("sits inside the working directory or harness home");
    } finally {
      removeDir(root);
    }
  });

  // The home-passthrough refusals (KIMI_CODE_HOME, CODEX_HOME) live in
  // tests/session-cli-passthrough.test.ts.

  // A read-only registry directory makes every registry write fail, so
  // each pre-spawn record path (claude's record, agy's probe) fails.
  test("a claude session whose registry write fails exits 1 without spawning", async () => {
    const root = tempWorkdir("ro-reg-claude");
    const workdir = join(root, "work");
    mkdirSync(workdir, { recursive: true });
    mkdirSync(join(root, "ro"), { recursive: true });
    chmodSync(join(root, "ro"), 0o500);
    try {
      const outcome = await runSessionCommand(
        ["-a", "claude", "--no-sandbox", "--auto", "high", "--cwd", workdir],
        { claude: FAKE_CLAUDE },
        { registryFile: join(root, "ro", "live-sessions.json") }
      );
      expect(outcome.exitCalls[0]).toBe(1);
      expect(outcome.stderr).toContain("cannot record the session in the registry");
    } finally {
      chmodSync(join(root, "ro"), 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("an agy session whose registry probe fails exits 1 before the spawn", async () => {
    const root = tempWorkdir("ro-reg-agy");
    const workdir = join(root, "work");
    mkdirSync(workdir, { recursive: true });
    mkdirSync(join(root, "ro"), { recursive: true });
    chmodSync(join(root, "ro"), 0o500);
    try {
      const outcome = await runSessionCommand(
        ["-a", "agy", "--cwd", workdir],
        { agy: fakeWithVersion("1.2.14"), scode: "exit 9" },
        { registryFile: join(root, "ro", "live-sessions.json") }
      );
      expect(outcome.exitCalls[0]).toBe(1);
      expect(outcome.stderr).toContain("cannot record the session in the registry");
    } finally {
      chmodSync(join(root, "ro"), 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

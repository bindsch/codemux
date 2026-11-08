/**
 * Review round 338, item 14, the tui twin of tests/run-command-gate-env:
 * the tui command's version gate read the executable redirect from
 * process.env while its spawn read the adapter-built environment, so an
 * adapter injecting OPENCODE_BIN_PATH through its own getEnv produced a
 * session whose redirect was trust-pinned by the spawn but never
 * version-gated. The gate now receives the adapter-built environment
 * (tui-command.ts). The adapter is injected by mock.module in a CHILD
 * process, so the module registry of the test process is never touched;
 * --print-sandbox keeps the launch from spawning anything.
 */

import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeBinaryEnv } from "./helpers/cli.js";

/** The redirect target: an audited-shape version BELOW opencode's floor
 * (1.18.10) on --version, a marker when run. */
const TARGET_BODY =
  "#!/bin/sh\ncase \"$1\" in --version) printf '1.18.0\\n';; *) printf 'REDIRECT-RAN\\n';; esac\n";
/** The PATH launcher the gate measured before the fix: an audited version. */
const LAUNCHER_BODY =
  "#!/bin/sh\nif [ \"$1\" = --version ]; then printf '1.19.0\\n'; exit 0; fi\nexec \"$OPENCODE_BIN_PATH\" \"$@\"\n";

const ROOT = join(import.meta.dir, "..");

test("the tui version gate reads the redirect from the adapter-built environment (review 338, item 14)", async () => {
  // The tui resolves scode before its version gate (--sandbox); a passthrough
  // scode that never runs here lets the gate be the first refusal.
  const fake = createFakeBinaryEnv({ opencode: LAUNCHER_BODY, scode: "exit 0" });
  const targetDir = mkdtempSync(join(tmpdir(), "codemux-gate-target-"));
  const home = mkdtempSync(join(tmpdir(), "codemux-gate-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "codemux-gate-work-"));
  const target = join(targetDir, "redirected-opencode");
  writeFileSync(target, TARGET_BODY);
  chmodSync(target, 0o755);
  // The adapter: OpenCode's shape, injecting the redirect through its own
  // environment view — the exact injection no production adapter performs.
  const source = `
    import { mock } from "bun:test";
    const { ClaudeAdapter } = await import(${JSON.stringify(join(ROOT, "src/adapters/claude.js"))});
    class InjectingAdapter extends ClaudeAdapter {
      override readonly id = "opencode" as const;
      override readonly binaryName = "opencode";
      override getEnv() {
        return { OPENCODE_BIN_PATH: ${JSON.stringify(target)} };
      }
      override prepareRun() {
        return {};
      }
      override buildTuiCommand() {
        return ["opencode"];
      }
    }
    mock.module(${JSON.stringify(join(ROOT, "src/adapters/index.ts"))}, () => ({
      AGENT_IDS: ["claude", "codex", "opencode", "agy"],
      getAdapter: (id) => (id === "opencode" ? new InjectingAdapter(process.env) : undefined),
      getAvailableAdapters: () => [],
    }));
    // The quota gate's test seam, matched the way the preload matches it.
    const nonce = crypto.randomUUID();
    (globalThis).__codemuxTestNoQuotaGate = nonce;
    process.env.CODEMUX_TEST_NO_QUOTA_GATE = nonce;
    const { Command } = await import("commander");
    const { registerTuiCommand } = await import(${JSON.stringify(join(ROOT, "src/tui-command.js"))});
    const { getDefaultConfig } = await import(${JSON.stringify(join(ROOT, "src/config.js"))});
    const program = new Command();
    program.exitOverride();
    registerTuiCommand(program, getDefaultConfig(), () => {});
    try {
      await program.parseAsync(["node", "codemux", "tui", "--sandbox", "--print-sandbox", "--auto", "high",
        "-a", "opencode", "--pass-env", "OPENCODE_BIN_PATH",
        "--cwd", ${JSON.stringify(workdir)}]);
      process.exit(0);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  `;
  try {
    const proc = Bun.spawn([process.execPath, "-e", source], {
      cwd: ROOT,
      env: {
        PATH: fake.env.PATH ?? "",
        HOME: home,
        CODEMUX_CALL_LOG: join(home, "state", "calls.jsonl"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    // Before the fix the gate measured the PATH launcher (1.19.0, audited)
    // and went on to the sandbox preparation; the redirect target below
    // the floor was never named.
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("older than the 1.18.10");
    expect(stdout).not.toContain("REDIRECT-RAN");
  } finally {
    fake.cleanup();
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

/**
 * The spawn parity test (design §4.7): a sandboxed session must sit
 * behind the exact scode argv and environment `run` builds for the same
 * request — same prefix, same trust and policy flags — so a session is
 * never a second, slightly different sandbox. Drives spawnSessionChild
 * against a fake scode that records its argv and environment and execs
 * the rest.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveScodeExecutable } from "../src/cli-runtime.js";
import { buildClaudeSessionCommand } from "../src/session/claude-session.js";
import { spawnSessionChild } from "../src/session/spawn.js";
import { buildSandboxEnv, buildScodeCommand } from "../src/sandbox.js";
import { resolveSandboxOptionsForAgent } from "../src/sandbox-policy.js";
import { validateWorkingDirectory } from "../src/validation.js";

const FAKE = fileURLToPath(new URL("./fixtures/live/fake-claude-session.ts", import.meta.url));

describe("spawnSessionChild scode parity", () => {
  test("the sandboxed session's scode argv matches run's buildScodeCommand", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-parity-"));
    const binDir = join(dir, "bin");
    const workDir = join(dir, "work");
    const stateDir = join(dir, "state");
    mkdirSync(binDir);
    mkdirSync(workDir);
    mkdirSync(stateDir);
    const argvPath = join(stateDir, "scode-argv.txt");
    const envPath = join(stateDir, "scode-env.txt");
    const claudeScript = join(binDir, "claude");
    const scodeScript = join(binDir, "scode");
    writeFileSync(claudeScript, `#!/bin/sh\nexec bun '${FAKE}' "$@"\n`);
    chmodSync(claudeScript, 0o755);
    writeFileSync(
      scodeScript,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'scode 0.2.1\\n'; exit 0; fi\n` +
        `for a in "$@"; do printf '%s\\n' "$a" >> '${argvPath}'; done\n` +
        `env | LC_ALL=C sort > '${envPath}'\n` +
        `exec "$@"\n`
    );
    chmodSync(scodeScript, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    try {
      const { argv } = buildClaudeSessionCommand({
        agent: "claude",
        autonomy: "medium",
        cwd: workDir,
      });
      const sandboxOptions = resolveSandboxOptionsForAgent("claude", "medium");
      // FAKE_CWD doubles as the omission probe: envOmissions must delete
      // it from the sandbox environment the way `run` deletes its own.
      const childEnv = {
        PATH: process.env.PATH ?? "",
        HOME: dir,
        FAKE_STATE_DIR: stateDir,
        FAKE_CWD: workDir,
      };
      const proc = await spawnSessionChild(
        argv,
        childEnv,
        {
          cwd: workDir,
          sandboxed: true,
          autonomy: "medium",
          sandboxOptions,
          graceMs: 500,
          envOmissions: ["FAKE_CWD"],
        },
        { onLine: () => {}, onFatal: () => {} }
      );
      try {
        // Give the fake scode a moment to exec and the fake harness to
        // write its init, then read back what scode was invoked with.
        await Bun.sleep(500);
      } finally {
        proc.requestStop();
        await proc.settled;
      }
      const text = readFileSync(argvPath, "utf8");
      // One recorded argument per line; the file ends with the newline the
      // last append wrote.
      const recorded = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");

      // Build the expectation the way `run` builds the real argv: the
      // cwd through validateWorkingDirectory (launch.ts runs every spawn
      // through it, which realpaths the directory), the harness binary
      // realpath'd the way resolveTrustedExecutable does. On a host whose
      // TMPDIR is spelled through a symlink (/var -> /private/var), the
      // spawned child records the resolved spellings — the expectation
      // must derive them the same way rather than match by luck of the
      // temp dir.
      const realWorkDir = validateWorkingDirectory(workDir) ?? workDir;
      const scode = resolveScodeExecutable(realWorkDir);
      expect(scode).not.toBeNull();
      const claude = Bun.which("claude", { PATH: process.env.PATH });
      expect(claude).not.toBeNull();
      if (scode !== null && claude !== null) {
        // The resolved trusted command replaces argv[0] with the absolute
        // binary path, exactly as the run path's resolution does.
        const expected = buildScodeCommand(
          [realpathSync(claude), ...argv.slice(1)],
          realWorkDir,
          "medium",
          sandboxOptions,
          scode
        );
        expect([scode, ...recorded]).toEqual(expected);

        // Environment parity: the child saw exactly what the shared
        // builder produced for the same request — the SCODE_* scrub, no
        // additions of the spawn layer's own, and the omitted name gone.
        // Both sides sort by code unit (LC_ALL=C sort vs .sort()), and no
        // value in this environment contains a newline. PWD/SHLVL/_ are
        // the shell-script fake's own additions (the real scode binary
        // adds nothing), so they are filtered before comparing.
        const expectedEnv = buildSandboxEnv(childEnv, sandboxOptions);
        delete expectedEnv["FAKE_CWD"];
        const shellArtifacts = new Set(["PWD", "SHLVL", "_"]);
        const recordedEnv = readFileSync(envPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .filter((line) => !shellArtifacts.has(line.slice(0, line.indexOf("="))));
        expect(recordedEnv).toEqual(
          Object.entries(expectedEnv).map(([name, value]) => `${name}=${value}`).sort()
        );
        expect(recordedEnv.some((line) => line.startsWith("FAKE_CWD="))).toBe(false);
      }
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

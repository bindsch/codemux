/**
 * The spawn parity test (design §4.7): a sandboxed session must sit
 * behind the exact scode argv and environment `run` builds for the same
 * request — same prefix, same trust and policy flags — so a session is
 * never a second, slightly different sandbox. Drives spawnSessionChild
 * against a fake scode that records its argv and environment and execs
 * the rest.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveScodeExecutable } from "../src/cli-runtime.js";
import { signalProcess } from "../src/process-runner.js";
import { createTerminationTarget } from "../src/process-tree.js";
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

  test("the session's scode resolves through the launch environment's PATH, not the ambient one (al14)", async () => {
    // The blocker's seam, one level down: spawnSessionChild must resolve
    // scode through the child environment's PATH — the same resolver the
    // run runner uses — never the ambient process.env.PATH. Before al14 a
    // fake scode reachable only through the launch environment answered
    // "scode is not installed" (the ambient lookup found nothing) while
    // the trusted-command resolution beside it, which always read
    // env.PATH, would have found the harness: two lookups, one launch,
    // disagreement.
    const dir = mkdtempSync(join(tmpdir(), "spawn-envpath-"));
    const binDir = join(dir, "bin");
    const workDir = join(dir, "work");
    const stateDir = join(dir, "state");
    mkdirSync(binDir);
    mkdirSync(workDir);
    mkdirSync(stateDir);
    const markerPath = join(stateDir, "scode-ran.txt");
    const argvPath = join(stateDir, "scode-argv.txt");
    const scodeScript = join(binDir, "scode");
    writeFileSync(
      scodeScript,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'scode 0.2.1\\n'; exit 0; fi\n` +
        `printf '%s\\n' "$@" > '${argvPath}'\n` +
        `printf 'ran\\n' > '${markerPath}'\n` +
        `exit 0\n`
    );
    chmodSync(scodeScript, 0o755);

    const originalPath = process.env.PATH;
    // The ambient PATH stripped to the system directories, which hold no
    // scode; the launch environment below carries binDir, so the ambient
    // and launch lookups disagree unless the spawn reads the launch one.
    process.env.PATH = "/usr/bin:/bin";
    try {
      const workdir = validateWorkingDirectory(workDir) ?? workDir;
      expect(resolveScodeExecutable(workdir)).toBeNull();
      const proc = await spawnSessionChild(
        ["/bin/echo", "resolved"],
        { PATH: `${binDir}:/usr/bin:/bin`, HOME: dir },
        {
          cwd: workDir,
          sandboxed: true,
          autonomy: "high",
          graceMs: 500,
        },
        { onLine: () => {}, onFatal: () => {} }
      );
      try {
        await proc.settled;
      } finally {
        proc.requestStop();
        await proc.settled;
      }
      // The fake scode ran with the command on its argv: the session
      // resolved scode through the launch environment's PATH, where the
      // old ambient lookup threw "scode is not installed".
      expect(existsSync(markerPath)).toBe(true);
      expect(readFileSync(argvPath, "utf8")).toContain("resolved");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SessionProcess signal delivery", () => {
  test("cleanup uses the child handle before its exit continuation runs (al39)", async () => {
    const child = Bun.spawn(["bun", "-e", "process.exit(0)"], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    await child.exited;
    // The subprocess has exited, but the target's continuation cannot
    // run until we yield. This reproduces the stale childExited window.
    const target = createTerminationTarget(child, false);
    const rawSends: number[] = [];
    const rawKill = spyOn(process, "kill").mockImplementation((pid) => {
      rawSends.push(pid);
      return true;
    });
    const handleKill = spyOn(child, "kill");
    try {
      expect(target.childExited).toBe(false);
      signalProcess(target, "SIGTERM", "process");
      signalProcess(target, "SIGKILL", "tree");
      expect(handleKill).toHaveBeenCalledTimes(2);
      expect(rawSends).not.toContain(child.pid);
      expect(child.exitCode).toBe(0);
    } finally {
      handleKill.mockRestore();
      rawKill.mockRestore();
    }
  });

  test.skipIf(process.platform === "win32")(
    "a refused send is reported unless it is ESRCH",
    async () => {
      // signalProcess reports send failures and nothing else (round al37
      // deleted its evidence return value): an EPERM refusal — a process
      // that EXISTS but cannot be signaled — is a signal failure the
      // operator should see, while ESRCH means the pid no longer exists
      // and is silent. The child stays alive throughout (the pid-reuse
      // guard must not fire — the errno arm is the only path under test),
      // and the spy throws before any real send can leak.
      const dir = mkdtempSync(join(tmpdir(), "proc-refusal-"));
      const child = Bun.spawn(["bun", "-e", "setInterval(() => {}, 60_000);"], {
        cwd: dir,
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir },
        detached: true,
      });
      const target = createTerminationTarget(child, true);
      const realKill = process.kill.bind(process);
      const handleKill = spyOn(child, "kill");
      const realErr = console.error;
      const errs: string[] = [];
      const refuses =
        (code: string): typeof process.kill =>
        ((_pid: number): void => {
          const error = new Error(`kill refused: ${code}`) as NodeJS.ErrnoException;
          error.code = code;
          throw error;
        }) as unknown as typeof process.kill;
      try {
        await Bun.sleep(150); // the child is up; its exit is not observed
        console.error = ((msg: string) => errs.push(String(msg))) as typeof console.error;
        process.kill = refuses("EPERM");
        handleKill.mockImplementation(() => { throw Object.assign(new Error("kill refused: EPERM"), { code: "EPERM" }); });
        signalProcess(target, "SIGTERM", "process");
        process.kill = refuses("EPERM");
        signalProcess(target, "SIGKILL", "tree");
        process.kill = refuses("ESRCH");
        handleKill.mockImplementation(() => { throw Object.assign(new Error("kill refused: ESRCH"), { code: "ESRCH" }); });
        signalProcess(target, "SIGTERM", "process");
      } finally {
        process.kill = realKill;
        handleKill.mockRestore();
        console.error = realErr;
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // The expected path already ended it.
        }
        await child.exited;
        rmSync(dir, { recursive: true, force: true });
      }
      // Both EPERM refusals were reported — the operator should see the
      // sends did not fly — and the ESRCH answer needs no report: nobody
      // was reached. The child died only in the finally, by the test's own
      // real kill.
      expect(errs.length).toBe(3);
      expect(errs.some((m) => m.includes("EPERM"))).toBe(true);
      expect(errs.some((m) => m.includes("ESRCH"))).toBe(false);
    }, 5_000
  );


});

describe("signal delivery past an observed exit (al34)", () => {
  test.skipIf(process.platform === "win32")(
    "a child whose exit was observed is never addressed by its own pid again",
    async () => {
      // Security major: the child-directed send goes through raw
      // process.kill(proc.pid, ...) — past Bun's own guard, which does
      // nothing for an exited-and-reaped child — and every end path calls
      // signalProcess after the exit is settled. If the pid wrapped
      // around to an unrelated process in that window, the raw SIGKILL
      // would reach the stranger. The guard returns before the
      // child-pid send once the exit is observed, so a fake process.kill
      // spy must see no send to the child's pid at all: the tree-scoped
      // call may still address the group (negative pid, for the
      // survivors), and the process-scoped call addresses nobody — the
      // pid-reuse rule: a child Bun already reports exited is never
      // signaled.
      const dir = mkdtempSync(join(tmpdir(), "proc-pid-reuse-"));
      const child = Bun.spawn(["bun", "-e", "process.exit(0)"], {
        cwd: dir,
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir },
        detached: true,
      });
      const target = createTerminationTarget(child, true);
      try {
        await child.exited; // markExited ran first: the flag is set
        await Bun.sleep(50); // the reaper collected the corpse
        const calls: number[] = [];
        const realKill = process.kill.bind(process);
        const spy = ((pid: number): void => {
          calls.push(pid);
          // Stand-in delivery: the group send "succeeds" without touching
          // a real process, so the spy itself can never leak a send.
        }) as unknown as typeof process.kill;
        process.kill = spy;
        try {
          signalProcess(target, "SIGTERM", "process");
          signalProcess(target, "SIGKILL", "tree");
        } finally {
          process.kill = realKill;
        }
        // Exactly one send flew — the tree call's group signal, negative —
        // and the child's own pid was never addressed by either scope.
        expect(calls).toEqual([-child.pid]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  test.skipIf(process.platform === "win32")(
    "a tree-scoped send over a dead child with a live group member still reaches the member",
    async () => {
      // The mechanics half of the al36 shape: the child died of its own
      // while a same-group descendant keeps the process group alive, so
      // the OS accepts the group SIGKILL (the member is there) and the
      // member dies with it. The send never consults the table for the
      // child — the group signal addresses survivors.
      const dir = mkdtempSync(join(tmpdir(), "proc-tree-dead-"));
      const grandchildPidFile = join(dir, "grandchild.pid");
      const script =
        `const g = Bun.spawn(["/bin/sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] }); ` +
        `await Bun.write(${JSON.stringify(grandchildPidFile)}, String(g.pid)); ` +
        `process.exit(0);`;
      const child = Bun.spawn(["bun", "-e", script], {
        cwd: dir,
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir },
        detached: true,
      });
      const target = createTerminationTarget(child, true);
      let grandchildPid: number | null = null;
      try {
        await child.exited; // the leader is gone; the member keeps the group
        grandchildPid = Number(readFileSync(grandchildPidFile, "utf8"));
        signalProcess(target, "SIGKILL", "tree");
        // The group send itself still flew: the member is gone too.
        let gone = false;
        for (let i = 0; i < 20 && !gone; i++) {
          await Bun.sleep(50);
          try {
            process.kill(grandchildPid, 0);
          } catch {
            gone = true;
          }
        }
        expect(gone).toBe(true);
      } finally {
        if (grandchildPid !== null) {
          try {
            process.kill(grandchildPid, "SIGKILL");
          } catch {
            // already gone
          }
        }
        rmSync(dir, { recursive: true, force: true });
      }
    }, 5_000
  );
});

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakeBinaryEnv,
  runCli,
} from "./helpers/cli.js";

describe("CLI - Signals", () => {
  test("a SIGTERM to a headless run terminates the agent's process tree", async () => {
    const pidDir = mkdtempSync(join(tmpdir(), "codemux-signal-"));
    const pidFile = join(pidDir, "child.pid");
    const fake = createFakeBinaryEnv({
      // Detached from codemux's process group like a real harness; records
      // its pid so the test can see whether the signal reached it.
      claude: `[ "$1" = --version ] && { echo 2.1.270; exit 0; }; cat >/dev/null; echo $$ > ${pidFile}; sleep 30`,
    });
    try {
      const proc = Bun.spawn(
        [join(import.meta.dir, "..", "bin", "codemux"), "run", "-a", "claude", "--no-sandbox", "--auto", "high", "-p", "test"],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, ...fake.env, CODEMUX_NO_KEYCHAIN_SYNC: "1", HOME: pidDir } as Record<string, string>,
        }
      );
      const deadline = Date.now() + 15_000;
      while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(100);
      expect(existsSync(pidFile)).toBe(true);
      const childPid = Number(readFileSync(pidFile, "utf8").trim());
      proc.kill("SIGTERM");
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(exitCode).toBe(143);
      expect(stderr).toContain("interrupted; the agent's process tree was terminated");
      // The fake agent is gone too, not orphaned.
      let alive = true;
      for (let i = 0; i < 50 && alive; i++) {
        try {
          process.kill(childPid, 0);
          await Bun.sleep(100);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      fake.cleanup();
      rmSync(pidDir, { recursive: true, force: true });
    }
  }, 30_000); // the runner grants the tree its grace period before returning

  // A stand-in codex: writes the --output-last-message file the launch names
  // (model output in this run's scratch directory under the real CODEX_HOME,
  // or its private hermetic home), records the path it wrote so the test can
  // find it, then keeps the run in flight so a signal can arrive after the
  // write -- exactly the leak window.
  const lastMessageWritingCodex = (pidFile: string, pathMarker: string): string =>
    'if [ "$1" = --version ]; then printf "codex-cli 0.159.3\\n"; exit 0; fi\n' +
    "while [ $# -gt 0 ]; do\n" +
    '  if [ "$1" = --output-last-message ]; then\n' +
    `    mkdir -p "$(dirname "$2")"; printf "the interrupted reply\\n" > "$2"; printf '%s' "$2" > ${pathMarker}; shift 2; continue\n` +
    "  fi\n" +
    "  shift\n" +
    "done\n" +
    `echo $$ > ${pidFile}; sleep 30`;

  test("a SIGTERM to a codex --result-json run removes the --output-last-message file", async () => {
    // The round21 major: the process runner ends a signaled run with
    // process.exit(143) from inside the runner, past the launch path's
    // cleanup calls, so the file codex had already written outlived the
    // run. The launch's exit-time backstop now disposes the run's context
    // on that exit too. The file lives in this run's own directory under
    // the real CODEX_HOME's .codemux-scratch/ (round27) -- harness state,
    // which the parent reaches on every platform.
    const home = mkdtempSync(join(tmpdir(), "codemux-signal-lastmsg-"));
    const pidFile = join(home, "child.pid");
    const pathMarker = join(home, "last-message-path");
    const fake = createFakeBinaryEnv({
      codex: lastMessageWritingCodex(pidFile, pathMarker),
    });
    try {
      const proc = Bun.spawn(
        [join(import.meta.dir, "..", "bin", "codemux"), "run", "-a", "codex", "--no-sandbox", "--auto", "high", "--result-json", "-p", "test"],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, ...fake.env, CODEMUX_NO_KEYCHAIN_SYNC: "1", HOME: home } as Record<string, string>,
        }
      );
      const deadline = Date.now() + 15_000;
      while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(100);
      expect(existsSync(pidFile)).toBe(true);
      const lastMessageFile = readFileSync(pathMarker, "utf8");
      expect(lastMessageFile.startsWith(join(home, ".codex", ".codemux-scratch"))).toBe(true);
      expect(existsSync(lastMessageFile)).toBe(true);
      proc.kill("SIGTERM");
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(exitCode).toBe(143);
      expect(stderr).toContain("interrupted; the agent's process tree was terminated");
      // The run never reached processRunResult, where the file is normally
      // read and removed; only the exit backstop can have removed it.
      expect(existsSync(lastMessageFile)).toBe(false);
      expect(readdirSync(join(home, ".codex", ".codemux-scratch"))).toEqual([]);
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000); // the runner grants the tree its grace period before returning

  test("a SIGTERM to a sandboxed hermetic codex run leaves neither scratch nor private home", async () => {
    // The same exit through the sandboxed branch of the launch path, where
    // the finding located the leak "including for hermetic runs": the
    // --output-last-message file -- inside the run's private hermetic home
    // since round25 -- and the home itself must both be gone once the exit
    // handlers have run.
    const home = mkdtempSync(join(tmpdir(), "codemux-signal-hermetic-"));
    const pidFile = join(home, "child.pid");
    const pathMarker = join(home, "last-message-path");
    const fake = createFakeBinaryEnv({
      codex: lastMessageWritingCodex(pidFile, pathMarker),
      scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
    });
    try {
      const proc = Bun.spawn(
        [join(import.meta.dir, "..", "bin", "codemux"), "run", "-a", "codex", "--hermetic", "--result-json", "-p", "test"],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            ...fake.env,
            CODEMUX_NO_KEYCHAIN_SYNC: "1",
            HOME: home,
            CODEX_API_KEY: "sk-test",
          } as Record<string, string>,
        }
      );
      const deadline = Date.now() + 15_000;
      while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(100);
      expect(existsSync(pidFile)).toBe(true);
      const lastMessageFile = readFileSync(pathMarker, "utf8");
      const hermeticParent = join(home, ".codex", ".codemux-hermetic");
      // Round25: the file lives INSIDE the run's private home, which the
      // sandbox keeps writable even where it denies the real CODEX_HOME.
      expect(lastMessageFile.startsWith(hermeticParent)).toBe(true);
      expect(existsSync(lastMessageFile)).toBe(true);
      expect(readdirSync(hermeticParent).length).toBeGreaterThan(0);
      proc.kill("SIGTERM");
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(exitCode).toBe(143);
      expect(stderr).toContain("interrupted; the agent's process tree was terminated");
      expect(existsSync(lastMessageFile)).toBe(false);
      // The hermetic home's own exit handler did this part before the
      // backstop existed; both paths still agree because both are idempotent.
      expect(readdirSync(hermeticParent)).toEqual([]);
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000); // the runner grants the tree its grace period before returning
});

describe("CLI - Signals during the version probe", () => {
  test("a SIGTERM during the harness version probe stops codemux instead of launching", async () => {
    const pidDir = mkdtempSync(join(tmpdir(), "codemux-signal-probe-"));
    const probeFile = join(pidDir, "probe.pid");
    const launched = join(pidDir, "launched");
    const fake = createFakeBinaryEnv({
      claude: `if [ "$1" = --version ]; then echo $$ > ${probeFile}; sleep 30; fi; cat >/dev/null; touch ${launched}; printf 'OK\\n'`,
    });
    try {
      const proc = Bun.spawn(
        [join(import.meta.dir, "..", "bin", "codemux"), "run", "-a", "claude", "--no-sandbox", "--auto", "high", "-p", "test"],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, ...fake.env, CODEMUX_NO_KEYCHAIN_SYNC: "1", HOME: pidDir } as Record<string, string>,
        }
      );
      const deadline = Date.now() + 15_000;
      while (!existsSync(probeFile) && Date.now() < deadline) await Bun.sleep(100);
      expect(existsSync(probeFile)).toBe(true);
      proc.kill("SIGTERM");
      const exitCode = await proc.exited;
      expect(exitCode).toBe(143);
      expect(existsSync(launched)).toBe(false);
    } finally {
      fake.cleanup();
      rmSync(pidDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("CLI - zai effort none (review al11)", () => {
  // 0.11 accepted `--effort none` on zai as the mapper's "no flag"
  // spelling; 0.12's capabilities list omitted it, so the same command
  // failed with "does not support reasoning effort 'none'" — a
  // regression against the mapper and the README both. The list carries
  // it again (src/adapters/zai.ts), and these pin both run kinds end to
  // end: the refusal is gone and no --effort flag reaches the binary.
  const zaiArgvFake = (argvFile: string) =>
    createFakeBinaryEnv({
      claude: `
if [ "$1" = "--version" ]; then printf '2.1.223\\n'; exit 0; fi
printf '%s\\n' "$@" > ${argvFile}
printf 'OK'
`,
    });

  test("run accepts --effort none and sends no flag; a real level still sends it", async () => {
    const argvDir = mkdtempSync(join(tmpdir(), "codemux-zai-effort-"));
    const argvFile = join(argvDir, "argv.txt");
    const fake = zaiArgvFake(argvFile);
    try {
      const none = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "zai", "--effort", "none", "-p", "test"],
        { ...fake.env, ZAI_API_KEY: "zai-effort-key" }
      );
      expect(none.exitCode).toBe(0);
      expect(none.stderr).not.toContain("does not support reasoning effort");
      expect(none.stdout).toBe("OK");
      const noneArgv = readFileSync(argvFile, "utf8").split("\n");
      expect(noneArgv).not.toContain("--effort");

      const low = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "zai", "--effort", "low", "-p", "test"],
        { ...fake.env, ZAI_API_KEY: "zai-effort-key" }
      );
      expect(low.exitCode).toBe(0);
      const lowArgv = readFileSync(argvFile, "utf8").split("\n");
      expect(lowArgv[lowArgv.indexOf("--effort") + 1]).toBe("low");
    } finally {
      fake.cleanup();
      rmSync(argvDir, { recursive: true, force: true });
    }
  });

  test("tui accepts --effort none and sends no flag", async () => {
    const argvDir = mkdtempSync(join(tmpdir(), "codemux-zai-effort-"));
    const argvFile = join(argvDir, "argv.txt");
    const fake = zaiArgvFake(argvFile);
    try {
      const { exitCode, stderr } = await runCli(
        ["tui", "--no-sandbox", "--auto", "high", "-a", "zai", "--effort", "none"],
        { ...fake.env, ZAI_API_KEY: "zai-effort-key" }
      );
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain("does not support reasoning effort");
      const argv = readFileSync(argvFile, "utf8").split("\n");
      expect(argv).not.toContain("--effort");
    } finally {
      fake.cleanup();
      rmSync(argvDir, { recursive: true, force: true });
    }
  });

  test("the same spelling through -a claude still refuses: each adapter keeps its own surface (al21)", async () => {
    // contracts-2 minor 4: same binary, two adapters, two CLI surfaces.
    // zai carries `none` (its 0.11 surface, pinned above); claude never
    // took the spelling, so its effortLevels omit it and the gate
    // refuses. Both adapters' comments name the divergence so neither
    // list "fixes" the other by accident.
    const fake = createFakeBinaryEnv({ claude: "exit 0" });
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "--no-sandbox", "--auto", "high", "-a", "claude", "--effort", "none", "-p", "test"],
        fake.env
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("does not support reasoning effort 'none'");
    } finally {
      fake.cleanup();
    }
  });
});

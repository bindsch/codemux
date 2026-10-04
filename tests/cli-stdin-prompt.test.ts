import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";

// End-to-end `-f -`: the prompt arrives on codemux's stdin, never in argv,
// with the same emptiness and bound rules as a prompt file.

const claudeVersionPreamble =
  'if [ "$1" = --version ]; then printf "2.1.280\\n"; exit 0; fi\n';

describe("CLI - stdin prompt", () => {
  test("a piped prompt reaches the harness's stdin", async () => {
    // The fake claude echoes its stdin, which is where the prompt rides.
    const fake = createFakeBinaryEnv({
      claude: `${claudeVersionPreamble}cat`,
    });
    try {
      const { stdout, exitCode } = await runCli(
        ["run", "-a", "claude", "--no-sandbox", "--auto", "high", "-f", "-"],
        fake.env,
        { stdin: "hello from stdin" }
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("hello from stdin");
    } finally {
      fake.cleanup();
    }
  });

  test("empty stdin is refused", async () => {
    const fake = createFakeBinaryEnv({ claude: "exit 0" });
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "-a", "claude", "--no-sandbox", "--auto", "high", "-f", "-"],
        fake.env,
        { stdin: "" }
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("-f - read an empty prompt from stdin");
    } finally {
      fake.cleanup();
    }
  });

  test("malformed UTF-8 on stdin is refused, not silently replaced", async () => {
    // A prompt file rejects invalid UTF-8 with a fatal decoder; -f - used
    // to decode leniently, so the same bytes became replacement characters
    // and the two "equivalent" paths submitted different prompt text.
    const fake = createFakeBinaryEnv({ claude: "exit 0" });
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "-a", "claude", "--no-sandbox", "--auto", "high", "-f", "-"],
        fake.env,
        // "a", a lone continuation byte, "b": invalid UTF-8.
        { stdin: new Uint8Array([0x61, 0xff, 0x62]) }
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("-f - prompt must contain valid UTF-8");
    } finally {
      fake.cleanup();
    }
  });

  test("whitespace-only stdin is refused too", async () => {
    const fake = createFakeBinaryEnv({ claude: "exit 0" });
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "-a", "claude", "--no-sandbox", "--auto", "high", "-f", "-"],
        fake.env,
        { stdin: "  \n\t\n" }
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("empty prompt from stdin");
    } finally {
      fake.cleanup();
    }
  });

  test("-p and -f - stay mutually exclusive", async () => {
    const fake = createFakeBinaryEnv({ claude: "exit 0" });
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "-a", "claude", "--no-sandbox", "--auto", "high", "-p", "x", "-f", "-"],
        fake.env,
        { stdin: "from stdin" }
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("--prompt and --file cannot be used together");
    } finally {
      fake.cleanup();
    }
  });

  // `script` gives the child a pty, so stdin is a TTY; codemux must refuse
  // instead of blocking until the run's timeout. Skipped where no script
  // binary exists (macOS ships it at /usr/bin/script).
  test.skipIf(!existsSync("/usr/bin/script"))("a terminal stdin is refused rather than read", async () => {
    const fake = createFakeBinaryEnv({ claude: "exit 0" });
    const home = mkdtempSync(join(tmpdir(), "codemux-tty-home-"));
    try {
      const repoRoot = join(import.meta.dir, "..");
      const codemuxCommand = [
        join(repoRoot, "bin", "codemux"),
        "run", "-a", "claude", "--no-sandbox", "--auto", "high", "-f", "-",
      ];
      // `script` gives the child a pty. BSD script (macOS) takes the command
      // after the typescript file and exits with its status; util-linux
      // script (Linux) takes it as one -c shell string and, with -e, exits
      // with the command's status too. Each part is single-quoted for the
      // shell, with embedded quotes escaped, so a checkout path with a
      // quote or spaces still parses.
      const shellQuote = (part: string): string => `'${part.replaceAll("'", `'\\''`)}'`;
      const command = process.platform === "linux"
        ? ["/usr/bin/script", "-q", "-e", "-c", codemuxCommand.map(shellQuote).join(" "), "/dev/null"]
        : ["/usr/bin/script", "-q", "/dev/null", ...codemuxCommand];
      const proc = Bun.spawn(
        command,
        {
          cwd: repoRoot,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            CODEMUX_NO_KEYCHAIN_SYNC: "1",
            HOME: home,
            ...fake.env,
          } as Record<string, string>,
        }
      );
      const [output, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(1);
      expect(output).toContain("stdin is a terminal");
    } finally {
      rmSync(home, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  test("stdin above the prompt-file bound is refused", async () => {
    const fake = createFakeBinaryEnv({ claude: "exit 0" });
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "-a", "claude", "--no-sandbox", "--auto", "high", "-f", "-"],
        fake.env,
        { stdin: "a".repeat(16 * 1024 * 1024 + 1) }
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("exceeds the 16777216-byte limit");
    } finally {
      fake.cleanup();
    }
  });

  test("an argv-prompt harness keeps its 32 KiB cap for stdin prompts", async () => {
    // Stdin is not argv, but a harness that must pass the prompt as an
    // argument still gets the argv bound enforced at validation.
    const fake = createFakeBinaryEnv({ aider: "exit 0" });
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "-a", "aider", "--no-sandbox", "--auto", "high", "-f", "-"],
        fake.env,
        { stdin: "a".repeat(33 * 1024) }
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("prompt exceeds the 32768-byte safe limit");
    } finally {
      fake.cleanup();
    }
  });

  // The finding's reproduction: readSync blocked forever on a pipe that
  // stayed open, so `--timeout 1` never fired and the process needed
  // SIGTERM. The read is bounded by the same timeout the run honors, so a
  // stalled producer fails the run instead of hanging the caller. The
  // explicit timeout keeps a regression (a true hang) failing this test at
  // 10s rather than tripping bun's default 5s on a merely slow machine.
  test("a stdin producer that never closes fails at the run timeout", async () => {
    const fake = createFakeBinaryEnv({ claude: "exit 0" });
    const home = mkdtempSync(join(tmpdir(), "codemux-stall-home-"));
    const repoRoot = join(import.meta.dir, "..");
    let proc: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const startedAt = Date.now();
      proc = Bun.spawn(
        [
          join(repoRoot, "bin", "codemux"),
          "run", "-a", "claude", "--no-sandbox", "--auto", "high",
          "-f", "-", "--timeout", "1",
        ],
        {
          cwd: repoRoot,
          stdout: "pipe",
          stderr: "pipe",
          // stdin stays a pipe and is never written to nor closed: the
          // producer stalls with the pipe open.
          stdin: "pipe",
          env: {
            ...process.env,
            CODEMUX_NO_KEYCHAIN_SYNC: "1",
            HOME: home,
            ...fake.env,
          } as Record<string, string>,
        }
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ]);
      const elapsed = Date.now() - startedAt;
      expect(exitCode).toBe(1);
      expect(stderr).toContain("before --timeout elapsed");
      // It failed at the timeout, not after it: well short of the budget
      // the pre-fix process exceeded (it hung past SIGTERM).
      expect(elapsed).toBeLessThan(8_000);
    } finally {
      // Release the held-open pipe so the test file does not leak it.
      const stdinSink = proc?.stdin;
      if (stdinSink !== undefined && typeof stdinSink !== "number") {
        await stdinSink.end();
      }
      rmSync(home, { recursive: true, force: true });
      fake.cleanup();
    }
  }, 10_000);

  // Round10: `-f -` consumed stdin before adapter validation, so an
  // unsupported combination (-a droid --hermetic -f -) waited on the
  // read -- up to the full timeout for a producer that never closes the
  // pipe -- instead of rejecting the flags at once. Validation now runs
  // before anything consumes stdin.
  test("an unsupported flag combination is rejected before stdin is consumed", async () => {
    const fake = createFakeBinaryEnv({ droid: "exit 0" });
    const home = mkdtempSync(join(tmpdir(), "codemux-order-home-"));
    const repoRoot = join(import.meta.dir, "..");
    let proc: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const startedAt = Date.now();
      proc = Bun.spawn(
        [
          join(repoRoot, "bin", "codemux"),
          "run", "-a", "droid", "--no-sandbox", "--auto", "high",
          "--hermetic", "-f", "-", "--timeout", "30",
        ],
        {
          cwd: repoRoot,
          stdout: "pipe",
          stderr: "pipe",
          // stdin stays a pipe and is never written to nor closed: with
          // the bug, the process blocked on the read for the whole 30s.
          stdin: "pipe",
          env: {
            ...process.env,
            CODEMUX_NO_KEYCHAIN_SYNC: "1",
            HOME: home,
            ...fake.env,
          } as Record<string, string>,
        }
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ]);
      const elapsed = Date.now() - startedAt;
      expect(exitCode).toBe(1);
      expect(stderr).toContain("no verified hermetic mode");
      // It never reached the stdin read, so no timeout fired.
      expect(stderr).not.toContain("before --timeout elapsed");
      expect(elapsed).toBeLessThan(8_000);
    } finally {
      // Release the held-open pipe so the test file does not leak it.
      const stdinSink = proc?.stdin;
      if (stdinSink !== undefined && typeof stdinSink !== "number") {
        await stdinSink.end();
      }
      rmSync(home, { recursive: true, force: true });
      fake.cleanup();
    }
  }, 10_000);
});

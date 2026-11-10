import { describe, expect, spyOn, test } from "bun:test";
import { Command } from "commander";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { getDefaultConfig } from "../src/config.js";
import { registerRunCommand } from "../src/run-command.js";
import { agentsSupporting } from "../src/parity/index.js";
import { createFakeBinaryEnv, READS_PROMPT } from "./helpers/cli.js";
import { ENVELOPE } from "./helpers/call-ledger.js";

/**
 * The in-process side of the run command: registerRunCommand runs inside
 * the coverage process, so every branch the spawned-CLI tests exercise
 * only in a child (prompt resolution, option validation, exit codes, the
 * launch hand-off) is measured too. The harnesses are fakes on a private
 * PATH; `process.exit` throws a sentinel carrying its code, so a refusal
 * that would end the process reports as that code instead.
 */

class ExitSentinel extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

// --version answers inside the claude contract's range; any other
// invocation is a run that reads its prompt (READS_PROMPT) and answers
// with the ledger e2e fixture envelope (unwrapped to "OK\n" on stdout).
const FAKE_CLAUDE = `if [ "$1" = "--version" ]; then printf '2.1.220 (Claude Code)\\n'; exit 0; fi
${READS_PROMPT}printf '%s\\n' '${ENVELOPE}'`;

// A scode that runs what it wraps: after `--` it execs the command the
// launcher built, so a sandboxed run reaches the fake claude for real.
const FAKE_SCODE_EXEC = `while [ "$1" != "--" ]; do shift; done
shift
exec "$@"`;

interface Outcome {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
}

async function runCommand(
  args: string[],
  binaries: Record<string, string> = { claude: FAKE_CLAUDE },
  // Runs after the fake binaries exist, before the parse: the private
  // PATH's own bin directory (its first segment), for tests that need a
  // planted shape on one of the fakes.
  mutate?: (binDir: string) => void
): Promise<Outcome> {
  const fake = createFakeBinaryEnv(binaries);
  if (mutate) mutate((fake.env.PATH ?? "").split(":")[0]!);
  const program = new Command();
  program.exitOverride();
  registerRunCommand(program, getDefaultConfig(), () => {});
  const stderrLines: string[] = [];
  const stdoutChunks: string[] = [];
  const originalPath = process.env.PATH;
  const originalExitCode = process.exitCode;
  const error = spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    stderrLines.push(values.map(String).join(" "));
  });
  const write = spyOn(process.stdout, "write").mockImplementation(((chunk: Uint8Array | string) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write);
  const exit = spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
    throw new ExitSentinel(typeof code === "number" ? code : 0);
  }) as typeof process.exit);
  process.env.PATH = fake.env.PATH;
  try {
    await program.parseAsync(["node", "codemux", ...args]);
    // exitCode is number | undefined in this outcome; the ambient field
    // admits string/null, so narrow it.
    const resolved = process.exitCode;
    return { stdout: stdoutChunks.join(""), stderr: stderrLines.join("\n"), exitCode: typeof resolved === "number" ? resolved : undefined };
  } catch (thrown) {
    if (thrown instanceof ExitSentinel) {
      return { stdout: stdoutChunks.join(""), stderr: stderrLines.join("\n"), exitCode: thrown.code };
    }
    throw thrown;
  } finally {
    process.env.PATH = originalPath;
    process.exitCode = originalExitCode;
    error.mockRestore();
    write.mockRestore();
    exit.mockRestore();
    fake.cleanup();
  }
}

/** Swaps `process.stdin` for `value` until the returned restore. */
function replaceStdin(value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", { value, configurable: true });
  return () => {
    if (descriptor) Object.defineProperty(process, "stdin", descriptor);
  };
}

const RUN = ["run", "--no-sandbox", "--auto", "high", "-a", "claude"];

describe("the run command in process", () => {
  test("a plain -p run unwraps the envelope and exits 0", async () => {
    const outcome = await runCommand([...RUN, "-p", "test"]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("OK\n");
    expect(outcome.stderr).toContain("Running with claude");
  });

  test("the cursor desktop entry without --pass-env refuses with exit 64", async () => {
    // A caller mistake (the missing --pass-env opt-in), so it carries the
    // usage-refusal code every other pre-launch refusal carries. The
    // regression: a plain Error mapped to exit 1, which a script following
    // the docs reads as a launch failure.
    const fakeCursor = `if [ "$1" = "--version" ]; then printf '2026.8.11\\n'; exit 0; fi
exit 0`;
    const original = process.env.CODEMUX_CURSOR_ENTRY;
    process.env.CODEMUX_CURSOR_ENTRY = "cursor";
    try {
      const outcome = await runCommand(
        ["run", "--no-sandbox", "--auto", "high", "-a", "cursor", "-p", "hi"],
        { cursor: fakeCursor }
      );
      expect(outcome.exitCode).toBe(64);
      expect(outcome.stderr).toContain("CODEMUX_CURSOR_ENTRY=cursor selects Cursor's desktop entry");
      expect(outcome.stderr).toContain("add --pass-env CODEMUX_CURSOR_ENTRY");
    } finally {
      if (original === undefined) delete process.env.CODEMUX_CURSOR_ENTRY;
      else process.env.CODEMUX_CURSOR_ENTRY = original;
    }
  });

  test("-f reads the prompt from a file", async () => {
    const file = join(
      mkdtempSync(join(tmpdir(), "codemux-run-cmd-")),
      "prompt.txt"
    );
    try {
      writeFileSync(file, "from the file");
      const outcome = await runCommand([...RUN, "-f", file]);
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toBe("OK\n");
    } finally {
      rmSync(join(file, ".."), { recursive: true, force: true });
    }
  });

  test("--label lands on the run's ledger record", async () => {
    const ledger = process.env.CODEMUX_TEST_LEDGER;
    expect(ledger).toBeString();
    const outcome = await runCommand([...RUN, "--label", "lane=c3", "-p", "test"]);
    expect(outcome.exitCode).toBe(0);
    const last = readFileSync(ledger!, "utf8").trim().split("\n").at(-1)!;
    const record = JSON.parse(last) as { kind: string; agent: string; labels: Record<string, string> | null };
    expect(record.kind).toBe("run");
    expect(record.agent).toBe("claude");
    expect(record.labels).toEqual({ lane: "c3" });
  });

  test("-f - reads the prompt from stdin", async () => {
    const restore = replaceStdin(new PassThrough());
    try {
      const stream = process.stdin as unknown as PassThrough;
      stream.end("prompt over stdin");
      const outcome = await runCommand([...RUN, "-f", "-"]);
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toBe("OK\n");
    } finally {
      restore();
    }
  });

  test("-f - refuses an empty stdin prompt", async () => {
    const restore = replaceStdin(new PassThrough());
    try {
      (process.stdin as unknown as PassThrough).end("");
      const outcome = await runCommand([...RUN, "-f", "-"]);
      expect(outcome.exitCode).toBe(64);
      expect(outcome.stderr).toContain("-f - read an empty prompt from stdin");
    } finally {
      restore();
    }
  });

  test("-f - refuses invalid UTF-8 instead of replacing it", async () => {
    const restore = replaceStdin(new PassThrough());
    try {
      (process.stdin as unknown as PassThrough).end(Buffer.from([0xff, 0xfe, 0x0a]));
      const outcome = await runCommand([...RUN, "-f", "-"]);
      expect(outcome.exitCode).toBe(64);
      expect(outcome.stderr).toContain("-f - prompt must contain valid UTF-8");
    } finally {
      restore();
    }
  });

  test("-f - refuses a terminal stdin", async () => {
    const restore = replaceStdin({ isTTY: true });
    try {
      const outcome = await runCommand([...RUN, "-f", "-"]);
      expect(outcome.exitCode).toBe(64);
      expect(outcome.stderr).toContain("stdin is a terminal");
    } finally {
      restore();
    }
  });

  test("-f - fails a stalled producer at --timeout instead of hanging", async () => {
    // A read bound of 50 ms: the producer below never writes or closes.
    const restore = replaceStdin(new PassThrough());
    try {
      const outcome = await runCommand([...RUN, "--timeout", "0.05", "-f", "-"]);
      expect(outcome.exitCode).toBe(1);
      expect(outcome.stderr).toContain("read no complete prompt from stdin before --timeout elapsed");
    } finally {
      restore();
    }
  });

  test("-f with a missing file names the path", async () => {
    const outcome = await runCommand([...RUN, "-f", "/nonexistent/prompt.txt"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("Could not read file '/nonexistent/prompt.txt'");
  });

  test("-f with an empty file is no prompt", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "codemux-run-cmd-")), "empty.txt");
    try {
      writeFileSync(file, "   \n");
      const outcome = await runCommand([...RUN, "-f", file]);
      expect(outcome.exitCode).toBe(64);
      expect(outcome.stderr).toContain("No prompt provided. Use -p or -f");
    } finally {
      rmSync(join(file, ".."), { recursive: true, force: true });
    }
  });

  test("-p and -f together are refused", async () => {
    const outcome = await runCommand([...RUN, "-p", "x", "-f", "y.txt"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("--prompt and --file cannot be used together");
  });

  test("no prompt at all is refused", async () => {
    const outcome = await runCommand(["run", "--no-sandbox", "--auto", "high", "-a", "claude"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("No prompt provided. Use -p or -f");
  });

  test("an unknown agent is a usage refusal: exit 64", async () => {
    const outcome = await runCommand(["run", "-a", "nope", "-p", "test"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("Unknown agent 'nope'");
    expect(outcome.stderr).toContain("Available agents:");
  });

  test("an invalid autonomy value is refused with its allowed set", async () => {
    // In-process the direct process.exit(64) of failInvalidOption is a
    // thrown sentinel, which the action's own catch re-exits as 1; the
    // spawned CLI pins the real 64 (tests/session-cli-refusals.test.ts).
    const outcome = await runCommand(["run", "--auto", "banana", "-p", "test"]);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("Invalid value 'banana' for --auto");
    expect(outcome.stderr).toContain("Allowed values: read-only, low, medium, high");
  });

  test("an out-of-range --timeout is refused with its bound", async () => {
    const outcome = await runCommand(["run", "--timeout", "100000", "-p", "test"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("--timeout must be a number from 0 (exclusive) to 86400 seconds");
  });

  test("a missing harness is refused with its binary name", async () => {
    const outcome = await runCommand(["run", "--no-sandbox", "--auto", "high", "-a", "goose", "-p", "test"]);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("goose is not installed");
  });

  test("a sandboxed run without scode is refused", async () => {
    const outcome = await runCommand(["run", "-a", "claude", "-p", "test"], { claude: FAKE_CLAUDE });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("scode is not installed (required for --sandbox)");
  });

  test("an untrusted scode reports its refusal, not 'not installed' (review round 381)", async () => {
    // The preflight's unconditional catch folded the trust refusal into
    // false, and the operator read "scode is not installed" for a binary
    // that was present — a world-writable one — and reinstalled it. The
    // refusal now propagates from the availability check: exit 1 with the
    // trust message, the same verdict the launch itself gives the same
    // binary, and the "not installed" misdirection stays with a genuinely
    // absent scode.
    const outcome = await runCommand(
      ["run", "-a", "claude", "-p", "test"],
      { claude: FAKE_CLAUDE, scode: FAKE_SCODE_EXEC },
      // Executable for every user, so Bun.which resolves it — and
      // group/world-writable, so the trust check refuses it.
      (binDir) => chmodSync(join(binDir, "scode"), 0o777)
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("scode binary is not a trusted executable");
    expect(outcome.stderr).not.toContain("scode is not installed");
  });

  test("a sandboxed run execs the harness through scode", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "codemux-run-cmd-cwd-"));
    try {
      const outcome = await runCommand(
        ["run", "-a", "claude", "--cwd", workdir, "-p", "test"],
        { claude: FAKE_CLAUDE, scode: FAKE_SCODE_EXEC }
      );
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toBe("OK\n");
      expect(outcome.stderr).toContain("(sandboxed)");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("--print-sandbox prints the scode argv and runs nothing", async () => {
    const outcome = await runCommand(
      ["run", "-a", "claude", "--print-sandbox", "-p", "test"],
      { claude: FAKE_CLAUDE, scode: "exit 9" }
    );
    expect(outcome.exitCode).toBe(0);
    // One argument per line; the wrapped command is printed as the
    // resolved absolute path, and nothing executed (an exit 9 scode would
    // have failed).
    expect(outcome.stdout).toContain("/claude\n");
    expect(outcome.stdout).toContain("\n-p\n");
    // The reply a run would print is a line of its own; a substring check
    // tripped over a temp directory name that happened to contain "OK"
    // (lane F32, 2026-11-07).
    expect(outcome.stdout.split("\n")).not.toContain("OK");
  });

  test("--print-sandbox prints a multi-line prompt argument as one line", async () => {
    // Review round 6, edges finding 5: the arguments used to be joined
    // raw, so a newline inside one argument (a normal multi-line -p
    // prompt; kimi carries it as --prompt, its only print-mode carrier)
    // printed as several arguments. Each argument is now one line with
    // its control characters escaped.
    const outcome = await runCommand(
      ["run", "-a", "kimi", "--print-sandbox", "-p", "line one\nline two"],
      {
        kimi: `if [ "$1" = "--version" ]; then printf '2.5.2\\n'; exit 0; fi`,
        scode: "exit 9",
      }
    );
    expect(outcome.exitCode, outcome.stderr).toBe(0);
    // The escaped prompt is exactly one line of the output: no raw
    // newline ever splits it into two apparent arguments.
    expect(outcome.stdout.trimEnd().split("\n")).toContain("line one\\nline two");
  });

  test("--print-sandbox with --experiment-mcp is refused with exit 64", async () => {
    // The relay is minted at start — the spec's server command is spawned
    // there — so the dry run cannot show the argv without running it.
    const specDir = mkdtempSync(join(tmpdir(), "codemux-run-cmd-spec-"));
    const spec = join(specDir, "experiment.json");
    writeFileSync(spec, JSON.stringify({ name: "experiment", command: "/bin/echo", args: [], env: [] }));
    try {
      const outcome = await runCommand(
        ["run", "-a", "claude", "--sandbox", "--hermetic", "--tools", "none",
          "--experiment-mcp", spec, "--print-sandbox", "-p", "test"],
        { claude: FAKE_CLAUDE, scode: "exit 9" }
      );
      expect(outcome.exitCode).toBe(64);
      expect(outcome.stderr).toContain(
        "--print-sandbox cannot be combined with --experiment-mcp"
      );
      expect(outcome.stderr).toContain("minted at start");
      // Nothing ran: an exit 9 scode would have failed had the launch begun.
      expect(outcome.stdout).not.toContain("/claude\n");
    } finally {
      rmSync(specDir, { recursive: true, force: true });
    }
  });

  test("--enable-playwright-mcp without --sandbox is refused", async () => {
    const outcome = await runCommand([...RUN, "--enable-playwright-mcp", "-p", "test"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain("--enable-playwright-mcp requires --sandbox");
  });

  test("--no-web on a harness that keeps its own web tools is refused", async () => {
    // agy keeps its web tools (a declared limitation); the list is the table's.
    const outcome = await runCommand(["run", "-a", "agy", "--no-web", "-p", "test"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stderr).toContain(
      `--no-web applies to the ${agentsSupporting("run.no-web").join(", ")} agents only; agy keeps its own web tools`
    );
  });
});

  test("an interrupted run records its receipt before the signal exit", async () => {
    // The fake harness signals codemux itself, which drives the real
    // interruption path in process: the runner's handler terminates the
    // tree and the interrupted receipt is appended before any exit. The
    // signal exit (143) is a thrown sentinel the action's catch re-exits
    // as 1 — the receipt, not the process code, is the contract here.
    const ledger = process.env.CODEMUX_TEST_LEDGER;
    expect(ledger).toBeString();
    const outcome = await runCommand([...RUN, "-p", "test"], {
      claude: `if [ "$1" = "--version" ]; then printf '2.1.220 (Claude Code)\\n'; exit 0; fi
kill -INT $PPID
sleep 5`,
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("codemux: interrupted; the agent's process tree was terminated");
    const last = readFileSync(ledger!, "utf8").trim().split("\n").at(-1)!;
    const record = JSON.parse(last) as {
      kind: string; agent: string; exit_code: number; finish: string | null;
    };
    expect(record.kind).toBe("run");
    expect(record.agent).toBe("claude");
    expect(record.exit_code).toBe(143);
    expect(record.finish).toBeNull();
  }, 15000);

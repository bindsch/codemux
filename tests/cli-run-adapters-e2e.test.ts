// Run-path end-to-end coverage for the eight adapters that had no fake-run
// test (audit finding tests.md #9): gemini, cline, pi, qwen, aider, droid,
// copilot, cursor. Every test drives the real `codemux run` CLI against a
// fake harness binary and pins, end to end: the harness argv the adapter
// builds (prompt transport, model flag, autonomy flags for the level under
// test), the environment it injects, exit 0, and the fake's stdout reaching
// the caller unchanged. The shared style is the goose test in
// tests/cli-run.test.ts (`--no-sandbox --auto high` so no wrapper stands
// between codemux and the harness).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeBinaryEnv, runCli, type CliResult } from "./helpers/cli.js";

const REPO_ROOT = join(import.meta.dir, "..");

// The fake harness. It answers the compatibility gate's version probe when
// the adapter has a version floor (aider, droid, copilot, cursor; gemini,
// cline, pi and qwen carry no contract), then prints its argv, the requested
// environment variables, and whatever arrives on stdin between markers, so
// each test can assert the prompt transport and the delivered environment.
function fakeHarnessBody(
  options: {
    version?: string;
    binaryVersion?: string;
    env?: string[];
    // A harness whose stdin carrier repeats for the child's whole
    // lifetime (aider's decline stream, review round 153) never delivers
    // the EOF `cat` would need; such a harness reads a bounded number of
    // bytes, models a turn that consumed its confirmations, and exits —
    // what a real headless aider does once its turn completes.
    stdinBytes?: number;
  } = {}
): string {
  const lines: string[] = [];
  if (options.version !== undefined) {
    lines.push(
      `if [ "$1" = "--version" ]; then printf '${options.version}\\n'; exit 0; fi`
    );
  }
  if (options.binaryVersion !== undefined) {
    lines.push(
      `if [ "$1" = "--binary-version" ]; then printf '${options.binaryVersion}\\n'; exit 0; fi`
    );
  }
  lines.push(`printf 'ARG:%s\\n' "$@"`);
  for (const name of options.env ?? []) {
    lines.push(`printf 'ENV:${name}=%s\\n' "\${${name}-unset}"`);
  }
  lines.push("printf 'STDIN-START\\n'");
  lines.push(options.stdinBytes !== undefined ? `head -c ${options.stdinBytes}` : "cat");
  lines.push("printf 'STDIN-END\\n'");
  return lines.join("\n");
}

// A passthrough scode for the sandboxed read-only run: it drops its own
// flags and execs the command after "--". createFakeBinaryEnv already
// prepends scode's --version branch (the compatibility probe runs first),
// so it is not repeated here.
const PASSTHROUGH_SCODE = [
  'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
  '[ "$#" -gt 0 ] && shift',
  'exec "$@"',
].join("\n");

function argvLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("ARG:"))
    .map((line) => line.slice("ARG:".length));
}

function envValue(stdout: string, name: string): string | undefined {
  const prefix = `ENV:${name}=`;
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(prefix));
  return line === undefined ? undefined : line.slice(prefix.length);
}

function stdinPayload(stdout: string): string | null {
  const match = stdout.match(/STDIN-START\n([\s\S]*?)STDIN-END/);
  return match === null ? null : match[1]!;
}

interface FakeRun extends CliResult {
  argv: string[];
  stdin: string | null;
}

// One run through `codemux run` with a fake harness on PATH and a scratch
// working directory (the repo root carries .claude/settings.json, which the
// per-adapter project-configuration refusals treat as executable project
// config for copilot, so every run here uses an empty directory instead).
async function runFakeHarness(
  binaries: Record<string, string>,
  agent: string,
  promptArgs: string[],
  options: { auto?: string; sandbox?: boolean } = {}
): Promise<FakeRun> {
  const fake = createFakeBinaryEnv(binaries);
  const cwd = mkdtempSync(join(tmpdir(), "codemux-run-e2e-"));
  try {
    const result = await runCli(
      [
        "run",
        options.sandbox === true ? "--sandbox" : "--no-sandbox",
        "--auto",
        options.auto ?? "high",
        "-a",
        agent,
        "--cwd",
        cwd,
        ...promptArgs,
      ],
      fake.env
    );
    return {
      ...result,
      argv: argvLines(result.stdout),
      stdin: stdinPayload(result.stdout),
    };
  } finally {
    fake.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
}

// None of these adapters post-processes stdout on a plain run (aider's
// processRunResult acts only on the hermetic history file a plain run never
// creates; cursor's rewrites stderr only on a sandboxed auth failure), so
// the caller receives exactly what the fake printed, ending on its last
// marker.
function expectUnmangledOutput(run: FakeRun): void {
  expect(run.exitCode, run.stderr).toBe(0);
  expect(run.stdout.endsWith("STDIN-END\n")).toBe(true);
}

describe("run e2e - gemini", () => {
  const PROMPT = "e2e gemini run path prompt";

  test("high autonomy: stdin prompt, -m model, yolo approval mode, settings env", async () => {
    const run = await runFakeHarness(
      { gemini: fakeHarnessBody({ env: ["GEMINI_CLI_SYSTEM_SETTINGS_PATH"] }) },
      "gemini",
      ["-m", "gemini-3-pro-preview", "-p", PROMPT]
    );
    expectUnmangledOutput(run);
    // --no-sandbox spawns the harness directly, so the argv is exactly the
    // adapter's with nothing in front of it.
    expect(run.argv).toEqual([
      "--sandbox=false",
      "-m",
      "gemini-3-pro-preview",
      "--approval-mode",
      "yolo",
      "-p",
      "",
    ]);
    // The prompt rides stdin; -p "" only selects headless mode.
    expect(run.stdin).toBe(PROMPT);
    // The settings variable is named only where the Gemini CLI would load
    // the file, which needs a root-owned chain; a checkout is user-owned,
    // so the run carries no variable instead of one the CLI would skip
    // with a warning (live matrix 2026-11-07; tests/adapters-gemini.test.ts
    // covers the root-owned case through the host seam).
    expect(envValue(run.stdout, "GEMINI_CLI_SYSTEM_SETTINGS_PATH")).toBe("unset");
  });

  test("read-only under scode: plan approval mode survives the sandbox wrapper", async () => {
    const run = await runFakeHarness(
      {
        gemini: fakeHarnessBody({ env: ["GEMINI_CLI_SYSTEM_SETTINGS_PATH"] }),
        scode: PASSTHROUGH_SCODE,
      },
      "gemini",
      ["-m", "gemini-3-pro-preview", "-p", PROMPT],
      { auto: "read-only", sandbox: true }
    );
    expectUnmangledOutput(run);
    // The passthrough scode drops its own flags, so the printed argv is the
    // harness's: gemini maps read-only to plan, not to yolo.
    expect(run.argv).toEqual([
      "--sandbox=false",
      "-m",
      "gemini-3-pro-preview",
      "--approval-mode",
      "plan",
      "-p",
      "",
    ]);
    expect(run.stdin).toBe(PROMPT);
  });
});

describe("run e2e - cline", () => {
  test("high autonomy: --json wire, --model, auto-approve true, stdin prompt", async () => {
    const PROMPT = "e2e cline run path prompt";
    // Every cline run is a --json run whose answer is the run_result text
    // (src/result-envelope/cline.ts), so this fake reports its argv and
    // stdin inside that text and the plain run unwraps it.
    const reporter = "const a=process.argv.slice(1);const i=require('fs').readFileSync(0,'utf8');" +
      "const t=a.map((x)=>'ARG:'+x).join('\\n')+'\\nSTDIN-START\\n'+i+'STDIN-END';" +
      "console.log(JSON.stringify({type:'run_start',sessionId:'e2e'}));" +
      "console.log(JSON.stringify({type:'run_result',finishReason:'completed',text:t}));";
    const body = `if [ "$1" = "--version" ]; then printf '3.0.74\\n'; exit 0; fi\nexec ${JSON.stringify(process.execPath)} -e "${reporter}" -- "$@"`;
    const run = await runFakeHarness({ cline: body }, "cline", ["-m", "claude-sonnet-4-6", "-p", PROMPT]);
    // The plain run prints the unwrapped run_result text.
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout.trimEnd().endsWith("STDIN-END")).toBe(true);
    expect(run.argv).toEqual([
      "--json",
      "--model",
      "claude-sonnet-4-6",
      "--auto-approve",
      "true",
      "--",
      " ",
    ]);
    // The prompt rides stdin; the positional argument is a placeholder.
    expect(run.stdin).toBe(PROMPT);
  });
});

describe("run e2e - pi", () => {
  test("high autonomy: prompt over stdin, --model, no tool allowlist flags", async () => {
    const PROMPT = "e2e pi run path prompt";
    const run = await runFakeHarness(
      { pi: fakeHarnessBody() },
      "pi",
      ["-m", "grok-code-1", "-p", PROMPT]
    );
    expectUnmangledOutput(run);
    // High maps to no autonomy flags at all (pi has no dedicated high
    // approval mode), so the argv is the headless baseline plus the model.
    expect(run.argv).toEqual([
      "--print",
      "--no-session",
      "--no-approve",
      "--model",
      "grok-code-1",
    ]);
    // The prompt rides stdin, never argv.
    expect(run.stdin).toBe(PROMPT);
  });
});

describe("run e2e - qwen", () => {
  test("high autonomy: current qwen binary, stdin prompt, safe mode, yolo", async () => {
    const PROMPT = "e2e qwen run path prompt";
    const run = await runFakeHarness(
      { qwen: fakeHarnessBody() },
      "qwen",
      ["-m", "qwen3-coder-plus", "-p", PROMPT]
    );
    expectUnmangledOutput(run);
    // The adapter prefers the current `qwen` binary over the legacy
    // `qwen-coder` name; a resolved run of the `qwen` fake proves it (the
    // legacy spelling would build `qwen-coder -- <prompt>` and refuse
    // without a sandbox).
    expect(run.argv).toEqual([
      "--safe-mode",
      "--model",
      "qwen3-coder-plus",
      "--approval-mode",
      "yolo",
    ]);
    expect(run.stdin).toBe(PROMPT);
  });
});

describe("run e2e - aider", () => {
  test("high autonomy: --message-file prompt, pinned config files, canned stdin declines", async () => {
    const PROMPT = "summarize the changes under tests";
    const run = await runFakeHarness(
      { aider: fakeHarnessBody({ version: "aider 0.86.2", stdinBytes: 128 }) },
      "aider",
      ["-m", "gpt-5.2", "-p", PROMPT]
    );
    expectUnmangledOutput(run);
    expect(run.argv).toEqual([
      "--config",
      join(REPO_ROOT, "resources", "aider-empty.yml"),
      "--env-file",
      devNull,
      "--model-settings-file",
      join(REPO_ROOT, "resources", "aider-model-settings.yml"),
      "--model-metadata-file",
      join(REPO_ROOT, "resources", "aider-model-metadata.json"),
      "--input-history-file",
      devNull,
      "--chat-history-file",
      devNull,
      "--no-gitignore",
      "--no-auto-commits",
      "--no-dirty-commits",
      "--no-analytics",
      "--no-suggest-shell-commands",
      "--no-check-update",
      "--no-show-release-notes",
      "--no-show-model-warnings",
      "--disable-playwright",
      "--no-stream",
      "--analytics-log",
      expect.stringMatching(/[/]\.aider[/]\.codemux-hermetic[/]run-[^/]+[/]analytics\.jsonl$/),
      "--model",
      "gpt-5.2",
      "--yes-always",
      "--message-file",
      expect.stringMatching(/[/]\.aider[/]\.codemux-hermetic[/]run-[^/]+[/]prompt\.txt$/),
    ]);
    // The prompt rides a private message file, never argv. Stdin carries the fixed headless declines
    // (aider treats EOF as acceptance for its yes-default prompts), never
    // the prompt. The carrier repeats for the child's whole lifetime
    // (review round 153); the fake models an aider that consumed one
    // decline block and completed its turn, so exactly that block is
    // echoed between the markers (the never-EOF property itself is
    // pinned by tests/aider-stdin-repeat.test.ts).
    expect(run.stdin).toBe("n\n".repeat(64));
  });
});

describe("run e2e - droid", () => {
  test("high autonomy: exec subcommand, -m model, --auto high, stdin prompt", async () => {
    const PROMPT = "e2e droid run path prompt";
    const run = await runFakeHarness(
      { droid: fakeHarnessBody({ version: "0.186.0" }) },
      "droid",
      ["-m", "claude-sonnet-4-6", "-p", PROMPT]
    );
    expectUnmangledOutput(run);
    expect(run.argv).toEqual([
      "exec",
      "-m",
      "claude-sonnet-4-6",
      "--auto",
      "high",
    ]);
    expect(run.stdin).toBe(PROMPT);
  });
});

describe("run e2e - copilot", () => {
  test("high autonomy: stdin prompt, hardening flags, --allow-all", async () => {
    const PROMPT = "e2e copilot run path prompt";
    const run = await runFakeHarness(
      {
        copilot: fakeHarnessBody({
          binaryVersion: "Copilot binary version: 1.0.85",
        }),
      },
      "copilot",
      ["-m", "gpt-5.2", "-p", PROMPT]
    );
    expectUnmangledOutput(run);
    // The gate probes `copilot --binary-version` (not --version) and
    // refuses an unreadable answer, so the fake answers that probe.
    expect(run.argv).toEqual([
      "--no-auto-update",
      "--no-bash-env",
      "--no-remote",
      "--no-remote-export",
      "--no-custom-instructions",
      "--no-experimental",
      "--model",
      "gpt-5.2",
      "--allow-all",
      "--silent",
    ]);
    // --disable-builtin-mcps rides every level below high; at high it is
    // absent.
    expect(run.argv).not.toContain("--disable-builtin-mcps");
    // A piped prompt selects prompt mode (copilot 1.0.103 cli-main.js).
    expect(run.stdin).toBe(PROMPT);
  });
});

describe("run e2e - cursor", () => {
  test("high autonomy: standalone cursor-agent entry, stdin prompt, --force", async () => {
    const PROMPT = "e2e cursor run path prompt";
    const run = await runFakeHarness(
      { "cursor-agent": fakeHarnessBody({ version: "2026.08.11" }) },
      "cursor",
      ["-m", "composer-6", "-p", PROMPT]
    );
    expectUnmangledOutput(run);
    // Only the standalone cursor-agent entry resolves (no `cursor` or
    // `agent` binary on PATH), and the gate probes it with plain
    // --version against the calendar floor.
    expect(run.argv).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--trust",
      "--model",
      "composer-6",
      "--force",
    ]);
    expect(run.stdin).toBe(PROMPT);
  });
});

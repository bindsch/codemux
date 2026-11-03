/**
 * CLI-level tests for `codemux session --hermetic
 * --experiment-project-settings` and `--permission-policy deny`: the
 * refusals before anything spawns, then one synthetic session against
 * the scenario fake through a fake scode — the argv and env the harness
 * receives on the first command and on a `--resume`, the private config
 * directory's lifetime across commands, and `--final`'s removal.
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeBinaryEnv, minimalPath, runCli } from "./helpers/cli.js";
import { readRegistry, sessionRegistryPath } from "../src/session/registry.js";
import { DEFAULT_DENIAL_MESSAGE } from "../src/session/claude-session.js";

const FAKE = fileURLToPath(new URL("./fixtures/live/fake-claude-session.ts", import.meta.url));

/** The fake scode + claude pair: the scode stub answers the version gate
 * (createFakeBinaryEnv's preamble), records its own argv into
 * $CODEMUX_TEST_SCODE_ARGV (BEGIN, then one argument per line) when that
 * variable is passed through, and execs the command unchanged after the
 * `--` separator; the claude wrapper execs the scenario fake. */
function fakeScodeClaudeEnv(): { env: Record<string, string>; cleanup: () => void } {
  return createFakeBinaryEnv({
    scode: `if [ -n "$CODEMUX_TEST_SCODE_ARGV" ]; then { printf 'BEGIN\\n'; printf '%s\\n' "$@"; } >> "$CODEMUX_TEST_SCODE_ARGV"; fi\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"`,
    claude: `exec bun '${FAKE}' "$@"`,
  });
}

/** One session command as a driven child, the session-cli-*.test.ts shape:
 * events collected, waitFor, send, exit. */
async function driveSession(
  args: string[],
  env: Record<string, string>
): Promise<{
  events: Record<string, any>[];
  waitFor: (label: string, pred: (event: Record<string, any>) => boolean) => Promise<Record<string, any>>;
  send: (message: unknown) => void;
  exit: Promise<[number, void]>;
  proc: Bun.Subprocess;
}> {
  const proc = Bun.spawn([join(import.meta.dir, "..", "bin", "codemux"), ...args], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env: { ...process.env, CODEMUX_NO_KEYCHAIN_SYNC: "1", ...env } as Record<string, string>,
  });
  const events: Record<string, any>[] = [];
  const stdoutDone = (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() !== "") events.push(JSON.parse(line) as Record<string, any>);
        newline = buffer.indexOf("\n");
      }
    }
  })();
  const waitFor = async (label: string, pred: (event: Record<string, any>) => boolean) => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const found = events.find(pred);
      if (found !== undefined) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${label}; saw: ${events.map((event) => event.type).join(",")}`
        );
      }
      await Bun.sleep(10);
    }
  };
  return {
    events,
    waitFor,
    send: (message: unknown) => {
      (proc.stdin as { write: (text: string) => unknown }).write(`${JSON.stringify(message)}\n`);
    },
    exit: Promise.all([proc.exited, stdoutDone]),
    proc,
  };
}

/** One synthetic session's stage: an isolated home (config root,
 * registry, and working directory all inside it, no ancestor project
 * memory), the fake scode+claude pair, and a recording state dir shared
 * by every command so each leaves one argv line and one env line. */
function setup(agent: "claude" | "zai" = "claude"): {
  agent: "claude" | "zai";
  home: string;
  workdir: string;
  stateDir: string;
  fake: { env: Record<string, string>; cleanup: () => void };
  cleanup: () => void;
} {
  const home = mkdtempSync(join(tmpdir(), "codemux-pps-e2e-"));
  const workdir = join(home, "work");
  const stateDir = join(home, "fake-state");
  mkdirSync(workdir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const fake = fakeScodeClaudeEnv();
  return {
    agent,
    home,
    workdir,
    stateDir,
    fake,
    cleanup: () => {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
const sessionDir = (s: ReturnType<typeof setup>, id: string): string =>
  join(s.home, ".claude", ".codemux-hermetic", `session-${id}`);
const argvLines = (s: ReturnType<typeof setup>): string[][] =>
  readFileSync(join(s.stateDir, "argv.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => (JSON.parse(line) as { args: string[] }).args);
const envLines = (s: ReturnType<typeof setup>): Record<string, any>[] =>
  readFileSync(join(s.stateDir, "env.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, any>);
/** The scode argv of each session child the fake scode exec'd, one
 * invocation per BEGIN marker (the --version probe never reaches the
 * body). */
const scodeInvocations = (s: ReturnType<typeof setup>): string[][] =>
  readFileSync(join(s.stateDir, "scode-argv.txt"), "utf8")
    .split("BEGIN\n")
    .filter((block) => block.trim() !== "")
    .map((block) => block.trimEnd().split("\n"));
/** The arguments a scode invocation passed right after `flag`. */
const afterFlag = (argv: readonly string[], flag: string): string[] =>
  argv.filter((_, index) => index > 0 && argv[index - 1] === flag);

describe("CLI - project-settings session refusals", () => {
  test("the mode without --hermetic refuses with 64", async () => {
    const { stderr, exitCode } = await runCli(
      ["session", "-a", "claude", "--experiment-project-settings", "--auto", "low"],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain("--experiment-project-settings requires --hermetic");
  });

  test("the mode on another agent refuses with 64", async () => {
    const { stderr, exitCode } = await runCli(
      ["session", "-a", "codex", "--hermetic", "--experiment-project-settings", "--auto", "low"],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain("claude and zai agents only");
  });

  test("--final without the mode refuses with 64", async () => {
    const { stderr, exitCode } = await runCli(
      ["session", "-a", "claude", "--final"],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain("--final requires --hermetic --experiment-project-settings");
  });

  test.each([
    ["read-only (the default)", ["--hermetic", "--experiment-project-settings"]],
    ["medium", ["--hermetic", "--experiment-project-settings", "--auto", "medium"]],
  ])("autonomy %s refuses with 64", async (_name, flags) => {
    const { stderr, exitCode } = await runCli(
      ["session", "-a", "claude", ...flags],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain("requires --auto low or high for sessions");
  });

  test("a passed-through config redirect refuses with 64", async () => {
    const { stderr, exitCode } = await runCli(
      [
        "session", "-a", "claude", "--hermetic", "--experiment-project-settings",
        "--auto", "low", "--pass-env", "CLAUDE_CONFIG_DIR",
      ],
      { PATH: minimalPath() }
    );
    expect(exitCode).toBe(64);
    expect(stderr).toContain("--pass-env CLAUDE_CONFIG_DIR");
  });

  test("an ancestor carrying project memory refuses with 64, naming the path", async () => {
    const root = mkdtempSync(join(tmpdir(), "codemux-pps-cli-"));
    try {
      const cwd = join(root, "parent", "fixture");
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(root, "CLAUDE.md"), "operator memory\n");
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "claude", "--hermetic", "--experiment-project-settings",
          "--auto", "low", "--cwd", cwd,
        ],
        { PATH: minimalPath() }
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain(join(root, "CLAUDE.md"));
      expect(stderr).toContain("project memory");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a bad --permission-policy value refuses with 64; deny belongs to claude and zai", async () => {
    const bogus = await runCli(
      ["session", "-a", "claude", "--permission-policy", "bogus", "--no-sandbox", "--auto", "high"],
      { PATH: minimalPath() }
    );
    expect(bogus.exitCode).toBe(64);
    expect(bogus.stderr).toContain("--permission-policy accepts 'default' or 'deny'");
    const codex = await runCli(
      ["session", "-a", "codex", "--permission-policy", "deny", "--no-sandbox", "--auto", "high"],
      { PATH: minimalPath() }
    );
    expect(codex.exitCode).toBe(64);
    expect(codex.stderr).toContain("claude and zai");
  });
});

describe("CLI - a project-settings session across commands", () => {
  const childEnv = (s: ReturnType<typeof setup>): Record<string, string> => ({
    HOME: s.home,
    XDG_CONFIG_HOME: join(s.home, ".config"),
    XDG_DATA_HOME: join(s.home, ".local", "share"),
    FAKE_STATE_DIR: s.stateDir,
    FAKE_CWD: s.workdir,
    CODEMUX_TEST_SCODE_ARGV: join(s.stateDir, "scode-argv.txt"),
    ...s.fake.env,
    ...(s.agent === "zai" ? { ZAI_API_KEY: "fake-key" } : {}),
  });

  /** Runs one session command to a clean end and returns its events. */
  async function runTurn(
    s: ReturnType<typeof setup>,
    agent: "claude" | "zai",
    flags: string[],
    text: string
  ): Promise<{ events: Record<string, any>[]; exitCode: number }> {
    const session = await driveSession(
      [
        "session", "-a", agent, "--sandbox", "--hermetic",
        "--experiment-project-settings", ...flags,
        "--cwd", s.workdir, "--shutdown-grace", "2",
        "--pass-env", "FAKE_STATE_DIR,FAKE_CWD,CODEMUX_TEST_SCODE_ARGV",
      ],
      childEnv(s)
    );
    let code = -1;
    try {
      session.send({ type: "user", text });
      await session.waitFor("turn_completed", (event) => event.type === "turn_completed");
      session.send({ type: "shutdown" });
      [code] = await session.exit;
    } finally {
      await session.proc.kill();
    }
    return { events: session.events, exitCode: code };
  }

  test("same config directory and setting sources on the first command and every resume; --final removes it", async () => {
    const s = setup();
    try {
      // Turn 1: the fresh session.
      const first = await runTurn(s, "claude", ["--auto", "low"], "scenario:basic one");
      expect(first.exitCode).toBe(0);
      const started = first.events.find((event) => event.type === "session_started")!;
      const id = started.session_id as string;
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      const dir = sessionDir(s, id);

      const argv1 = argvLines(s)[0]!;
      expect(argv1[argv1.indexOf("--session-id") + 1]).toBe(id);
      expect(argv1[argv1.indexOf("--setting-sources") + 1]).toBe("project,local");
      expect(argv1).toContain("--disable-slash-commands");
      expect(argv1).not.toContain("--safe-mode");
      expect(envLines(s)[0]!.claude_config_dir).toBe(dir);

      // The operator's harness state is unreachable from the child: the
      // config root and the ~/.claude.json beside it blocked, only this
      // session's own directory re-allowed after them.
      const scode1 = scodeInvocations(s)[0]!;
      expect(afterFlag(scode1, "--block")).toEqual([
        join(s.home, ".claude"),
        join(s.home, ".claude.json"),
      ]);
      expect(afterFlag(scode1, "--allow")).toEqual([dir]);
      expect(scode1.indexOf("--block")).toBeLessThan(scode1.indexOf("--allow"));

      // The registry recorded the mode and the directory as the harness home.
      const registry = readRegistry(sessionRegistryPath(s.home));
      const entry =
        registry.outcome === "ok"
          ? registry.file.sessions.find((record) => record.id === id)
          : undefined;
      expect(entry?.project_settings).toBe(true);
      expect(entry?.hermetic).toBe(true);
      expect(entry?.harness_home).toBe(dir);

      // The session ended; without --final the directory persists for the
      // next resume, token copy and transcript with it.
      expect(existsSync(dir)).toBe(true);

      // The resume: the same directory, --resume in place of --session-id.
      const resumed = await runTurn(s, "claude", ["--auto", "low", "--resume", id], "scenario:basic two");
      expect(resumed.exitCode).toBe(0);
      const argv2 = argvLines(s)[1]!;
      expect(argv2[argv2.indexOf("--resume") + 1]).toBe(id);
      expect(argv2).not.toContain("--session-id");
      expect(argv2[argv2.indexOf("--setting-sources") + 1]).toBe("project,local");
      expect(argv2).toContain("--disable-slash-commands");
      expect(argv2).not.toContain("--safe-mode");
      expect(envLines(s)[1]!.claude_config_dir).toBe(dir);
      // The resume's sandbox blocks the same operator state.
      expect(afterFlag(scodeInvocations(s)[1]!, "--block")).toEqual([
        join(s.home, ".claude"),
        join(s.home, ".claude.json"),
      ]);
      expect(afterFlag(scodeInvocations(s)[1]!, "--allow")).toEqual([dir]);
      expect(existsSync(dir)).toBe(true);

      // The final command: --final removes the directory at session end.
      const ended = await runTurn(s, "claude", ["--auto", "low", "--resume", id, "--final"], "scenario:basic three");
      expect(ended.exitCode).toBe(0);
      expect(argvLines(s)[2]![argvLines(s)[2]!.indexOf("--resume") + 1]).toBe(id);
      expect(existsSync(dir)).toBe(false);
    } finally {
      s.cleanup();
    }
  }, 45_000);

  test("a resume whose directory is gone is refused as policy, not silently remade", async () => {
    const s = setup();
    try {
      const first = await runTurn(s, "claude", ["--auto", "low"], "scenario:basic one");
      const id = (first.events.find((event) => event.type === "session_started")!).session_id as string;
      rmSync(sessionDir(s, id), { recursive: true, force: true });
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "claude", "--sandbox", "--hermetic",
          "--experiment-project-settings", "--auto", "low",
          "--cwd", s.workdir, "--resume", id,
        ],
        childEnv(s)
      );
      expect(exitCode).toBe(78);
      expect(stderr).toContain("transcript");
      // And it was not remade behind the refusal.
      expect(existsSync(sessionDir(s, id))).toBe(false);
    } finally {
      s.cleanup();
    }
  }, 45_000);

  test("a plain resume of a project-settings session is refused with 78", async () => {
    const s = setup();
    try {
      const first = await runTurn(s, "claude", ["--auto", "low"], "scenario:basic one");
      const id = (first.events.find((event) => event.type === "session_started")!).session_id as string;
      const { stderr, exitCode } = await runCli(
        ["session", "-a", "claude", "--sandbox", "--auto", "high", "--cwd", s.workdir, "--resume", id],
        childEnv(s)
      );
      expect(exitCode).toBe(78);
      expect(stderr).toContain("hermetic");
    } finally {
      s.cleanup();
    }
  }, 45_000);

  test("zai rides the same mode with no credential copy in the directory", async () => {
    const s = setup("zai");
    try {
      const first = await runTurn(s, "zai", ["--auto", "high"], "scenario:basic one");
      expect(first.exitCode).toBe(0);
      const id = (first.events.find((event) => event.type === "session_started")!).session_id as string;
      const dir = sessionDir(s, id);
      const argv = argvLines(s)[0]!;
      expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("project,local");
      expect(argv).not.toContain("--safe-mode");
      expect(envLines(s)[0]!.claude_config_dir).toBe(dir);
      // zai's session blocks the operator's harness state the same way.
      expect(afterFlag(scodeInvocations(s)[0]!, "--block")).toEqual([
        join(s.home, ".claude"),
        join(s.home, ".claude.json"),
      ]);
      expect(afterFlag(scodeInvocations(s)[0]!, "--allow")).toEqual([dir]);
      // The gateway token is the credential: no operator login ever lands
      // in the directory, before or after the turn.
      expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
      const registry = readRegistry(sessionRegistryPath(s.home));
      const entry =
        registry.outcome === "ok"
          ? registry.file.sessions.find((record) => record.id === id)
          : undefined;
      expect(entry?.project_settings).toBe(true);
    } finally {
      s.cleanup();
    }
  }, 45_000);
});

describe("CLI - the deny permission policy", () => {
  test("every permission request is answered deny at once and recorded as permission_denied", async () => {
    const s = setup();
    try {
      // The Self-Grant spelling: the isolation at session high, headless.
      const session = await driveSession(
        [
          "session", "-a", "claude", "--sandbox", "--hermetic",
          "--experiment-project-settings", "--auto", "high",
          "--permission-policy", "deny",
          "--cwd", s.workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        {
          HOME: s.home,
          XDG_CONFIG_HOME: join(s.home, ".config"),
          XDG_DATA_HOME: join(s.home, ".local", "share"),
          FAKE_STATE_DIR: s.stateDir,
          FAKE_CWD: s.workdir,
          ...s.fake.env,
        }
      );
      try {
        session.send({ type: "user", text: "scenario:ask one" });
        const request = await session.waitFor(
          "permission_request",
          (event) => event.type === "permission_request"
        );
        expect(request.tool).toBe("Bash");
        const deniedEvent = await session.waitFor(
          "permission_denied",
          (event) => event.type === "permission_denied"
        );
        expect(deniedEvent.request_id).toBe(request.request_id);
        expect(deniedEvent.tool).toBe("Bash");
        // The request never became pending: no resolved event for it, and
        // a late caller decision answers unknown_request.
        session.send({
          type: "permission_decision",
          request_id: request.request_id,
          decision: "allow",
        });
        const rejected = await session.waitFor(
          "input_rejected",
          (event) => event.type === "input_rejected"
        );
        expect(rejected.reason).toBe("unknown_request");
        await session.waitFor("turn_completed", (event) => event.type === "turn_completed");
        session.send({ type: "shutdown" });
        const [exitCode] = await session.exit;
        expect(exitCode).toBe(0);
        expect(
          session.events.some(
            (event) => event.type === "permission_resolved" && event.request_id === request.request_id
          )
        ).toBe(false);
        // The harness received its deny the moment it asked.
        const answer = readFileSync(join(s.stateDir, "responses.jsonl"), "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as Record<string, unknown>)[0]!;
        expect(answer["behavior"]).toBe("deny");
        // The harness sees Claude Code's own rejection text, so the agent
        // reads the deny as its harness's — no codemux-branded string.
        expect(answer["message"]).toBe(DEFAULT_DENIAL_MESSAGE);
      } finally {
        await session.proc.kill();
      }
    } finally {
      s.cleanup();
    }
  }, 45_000);
});

/**
 * `--experiment-project-settings` must make the operator's harness state
 * unreachable from the sandboxed child: scode `--block` over the real
 * config root and the `~/.claude.json` beside it, `--allow` for the run's
 * or session's own private directory. These tests pin the scode argv the
 * real spawn and `--print-sandbox` build (claude, zai), the extra
 * `--sandbox-block` passthrough, and the OpenCode decision (no blocks: its
 * real data directory holds the run's own storage, so blocking it would
 * deny the run's own writes).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { assertNoCallerBlockOverStateDirs } from "../src/sandbox.js";
import { UsageRefusalError } from "../src/validation.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunFakeBinaryEnv as createFakeBinaryEnv, minimalPath, runCli } from "./helpers/cli.js";
import {
  createProjectSettingsConfigDir,
  openProjectSettingsSessionConfigDir,
  projectSettingsBlockedStatePaths,
  projectSettingsConfigRoot,
} from "../src/claude-project-config.js";

const scratch: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** The fake scode that proves it ran: a marker line, then one argument
 * per line. `--print-sandbox` output must carry the marker's absence. */
const RECORDING_SCODE = `printf 'FAKE-SCODE-RAN\\n'\nprintf '%s\\n' "$@"`;

const runFlags = (agent: string, cwd: string): string[] => [
  "run", "-a", agent, "--sandbox", "--hermetic",
  "--experiment-project-settings", "--auto", "low",
  "--cwd", cwd, "-p", "probe",
];

/** The block and allow arguments of a printed or recorded scode argv. */
const valuesAfter = (argv: readonly string[], flag: string): string[] =>
  argv.filter((_, index) => index > 0 && argv[index - 1] === flag);

const expectOwnTreeOnly = (
  argv: readonly string[],
  home: string,
  expectRunDir: boolean
): string => {
  const blocks = valuesAfter(argv, "--block");
  expect(blocks).toEqual([join(home, ".claude"), join(home, ".claude.json")]);
  const allows = valuesAfter(argv, "--allow");
  expect(allows.length).toBe(1);
  const prefix = expectRunDir ? "run-" : "session-";
  expect(allows[0]!.startsWith(join(home, ".claude", ".codemux-hermetic", prefix))).toBe(true);
  // The blocks come first: scode emits the child allow after the parent
  // block and re-asserts both in its final guards.
  expect(argv.indexOf("--block")).toBeLessThan(argv.indexOf("--allow"));
  return allows[0]!;
};

describe("blocked operator state: unit", () => {
  test("a caller block over the launch's own harness state directory is refused, naming both paths", () => {
    // Review round 9, edges finding 1: scode emits the block first and the
    // child allow after it, so emitting both would re-open exactly the
    // blocked tree. The check is provenance-aware: the launcher's own
    // blocks (an allow child of a block) never pass through it.
    const equal = () =>
      assertNoCallerBlockOverStateDirs(["/local/run/state"], ["/local/run/state"]);
    expect(equal).toThrow(UsageRefusalError);
    expect(equal).toThrow(
      "--sandbox-block /local/run/state covers the launch's own harness state directory /local/run/state"
    );

    const ancestor = () =>
      assertNoCallerBlockOverStateDirs(["/local/run"], ["/local/run/state/data"]);
    expect(ancestor).toThrow(UsageRefusalError);
    expect(ancestor).toThrow(
      "--sandbox-block /local/run covers the launch's own harness state directory /local/run/state/data"
    );

    // A caller block of the root covers every state directory (review
    // round 11, edges 1): the descendant prefix for "/" is "/" itself,
    // never "//", which matched nothing and let the blanket block
    // re-open every state tree.
    const rootBlock = () =>
      assertNoCallerBlockOverStateDirs(["/"], ["/tmp/private-state"]);
    expect(rootBlock).toThrow(UsageRefusalError);
    expect(rootBlock).toThrow(
      "--sandbox-block / covers the launch's own harness state directory /tmp/private-state"
    );

    // A block BENEATH the launcher's state directory is refused too (review
    // round 20, contracts-2 finding 1): scode's recursive allow of the
    // state directory covers its descendants and drops the block from its
    // blocked set, so a block of the session's own `.credentials.json`
    // never reached the child. Only a sibling the launch does not use
    // passes.
    const inside = () =>
      assertNoCallerBlockOverStateDirs(
        ["/local/run/state/data/.credentials.json"],
        ["/local/run/state/data"]
      );
    expect(inside).toThrow(UsageRefusalError);
    expect(inside).toThrow(
      "--sandbox-block /local/run/state/data/.credentials.json sits inside the launch's own harness state directory /local/run/state/data"
    );

    // A block beside the launcher's directory is no contradiction.
    expect(() =>
      assertNoCallerBlockOverStateDirs(["/local/other"], ["/local/run/state/data"])
    ).not.toThrow();
  });

  test("spellings scode collapses still count: trailing slash, .., a symlink alias (round 10, contracts 4 / edges 2)", () => {
    // The old check compared raw spellings, so `/state/`, `/../state`,
    // and a symlink alias of the state directory all slipped past it:
    // scode canonicalizes before applying a block, and the block then
    // covered exactly the tree the later allow re-opened. Both sides now
    // canonicalize with the registry's own rule first.
    const root = tempDir("codemux-sb-canon-");
    const state = join(root, "state");
    mkdirSync(state);
    const alias = join(root, "alias");
    symlinkSync(state, alias);
    try {
      const trailing = () => assertNoCallerBlockOverStateDirs([`${state}/`], [state]);
      expect(trailing).toThrow(UsageRefusalError);
      expect(trailing).toThrow(
        `--sandbox-block ${state}/ covers the launch's own harness state directory ${state}`
      );

      const dotted = `${state}/../state`;
      expect(() => assertNoCallerBlockOverStateDirs([dotted], [state])).toThrow(
        UsageRefusalError
      );

      expect(() => assertNoCallerBlockOverStateDirs([alias], [state])).toThrow(
        UsageRefusalError
      );

      // The state directory's own spelling goes through the alias too:
      // canonicalization runs on both sides.
      expect(() =>
        assertNoCallerBlockOverStateDirs([realpathSync(state)], [alias])
      ).toThrow(UsageRefusalError);

      // A sibling the launch does not use still passes.
      const sibling = join(root, "sibling");
      mkdirSync(sibling);
      expect(() => assertNoCallerBlockOverStateDirs([sibling], [state])).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("projectSettingsBlockedStatePaths names the config root and the .claude.json beside it", () => {
    expect(projectSettingsBlockedStatePaths({ HOME: "/Users/example" })).toEqual([
      "/Users/example/.claude",
      "/Users/example/.claude.json",
    ]);
  });

  test("created run and session directories carry the same blocks as their environment", () => {
    const home = tempDir("codemux-sb-unit-");
    const cwd = tempDir("codemux-sb-cwd-");
    const environment = { HOME: home };
    const run = createProjectSettingsConfigDir(cwd, environment);
    try {
      expect(run.blockedPaths).toEqual(projectSettingsBlockedStatePaths(environment));
      expect(run.dir.startsWith(join(home, ".claude"))).toBe(true);
    } finally {
      run.finalize();
    }
    const session = openProjectSettingsSessionConfigDir(
      "01234567-89ab-cdef-0123-456789abcdef",
      false,
      cwd,
      environment
    );
    expect(session.blockedPaths).toEqual(projectSettingsBlockedStatePaths(environment));
    expect(session.dir.startsWith(join(home, ".claude", ".codemux-hermetic", "session-"))).toBe(true);
  });
});

describe("blocked operator state: run argv", () => {
  test.each([["claude"], ["zai"]])(
    "%s's real spawn blocks the config root and allows only its own directory",
    async (agent) => {
      const home = tempDir("codemux-sb-home-");
      const cwd = tempDir("codemux-sb-cwd-");
      // zai rides the same claude binary (its adapter's binaryName).
      const fake = createFakeBinaryEnv({ scode: RECORDING_SCODE, claude: "exit 0" });
      try {
        const result = await runCli(runFlags(agent, cwd), {
          ...fake.env,
          HOME: home,
          ...(agent === "zai" ? { ZAI_API_KEY: "fake-key" } : {}),
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.split("\n")[0]).toBe("FAKE-SCODE-RAN");
        const argv = result.stdout.trimEnd().split("\n").slice(1);
        const allowed = expectOwnTreeOnly(argv, home, true);
        // The launch cleaned its private directory up.
        expect(readdirSync(join(home, ".claude", ".codemux-hermetic"))).toEqual([]);
        expect(allowed).not.toBe(join(home, ".claude"));
      } finally {
        fake.cleanup();
      }
    },
    30_000
  );

  test("--sandbox-block adds an extra block to the real argv", async () => {
    const home = tempDir("codemux-sb-home-");
    const cwd = tempDir("codemux-sb-cwd-");
    const fake = createFakeBinaryEnv({ scode: RECORDING_SCODE, claude: "exit 0" });
    try {
      const result = await runCli(
        [...runFlags("claude", cwd), "--sandbox-block", "/opt/operator-only"],
        { ...fake.env, HOME: home }
      );
      expect(result.exitCode).toBe(0);
      const argv = result.stdout.trimEnd().split("\n").slice(1);
      expect(valuesAfter(argv, "--block")).toEqual([
        "/opt/operator-only",
        join(home, ".claude"),
        join(home, ".claude.json"),
      ]);
    } finally {
      fake.cleanup();
    }
  }, 30_000);

  test("a --sandbox-block over the run's own private directory is refused with 64", async () => {
    const home = tempDir("codemux-sb-home-");
    const cwd = tempDir("codemux-sb-cwd-");
    const fake = createFakeBinaryEnv({ scode: RECORDING_SCODE, claude: "exit 0" });
    try {
      const result = await runCli(
        [...runFlags("claude", cwd), "--sandbox-block", join(home, ".claude")],
        { ...fake.env, HOME: home }
      );
      expect(result.exitCode).toBe(64);
      expect(result.stderr).toContain(
        // The flag boundary canonicalizes the block (the macOS temp root is a symlink).
        `--sandbox-block ${join(realpathSync(home), ".claude")} covers the launch's own harness state directory`
      );
      // The refused launch leaves no private directory behind.
      const hermetic = join(home, ".claude", ".codemux-hermetic");
      expect(existsSync(hermetic) ? readdirSync(hermetic) : []).toEqual([]);
    } finally {
      fake.cleanup();
    }
  }, 30_000);

  test("--sandbox-block refuses a relative path", async () => {
    const fake = createFakeBinaryEnv({ scode: RECORDING_SCODE, claude: "exit 0" });
    try {
      const result = await runCli(
        [...runFlags("claude", tempDir("codemux-sb-cwd-")), "--sandbox-block", "relative/path"],
        { ...fake.env, HOME: tempDir("codemux-sb-home-") }
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--sandbox-block requires absolute paths");
    } finally {
      fake.cleanup();
    }
  });
});

describe("blocked operator state: run --print-sandbox", () => {
  test("prints the argv without spawning and leaves no private directory", async () => {
    const home = tempDir("codemux-sb-home-");
    const cwd = tempDir("codemux-sb-cwd-");
    const fake = createFakeBinaryEnv({ scode: RECORDING_SCODE, claude: "exit 0" });
    try {
      const result = await runCli([...runFlags("claude", cwd), "--print-sandbox"], {
        ...fake.env,
        HOME: home,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("FAKE-SCODE-RAN");
      const argv = result.stdout.trimEnd().split("\n");
      // One argument per line, the scode executable first.
      expect(argv.length).toBeGreaterThan(4);
      expect(argv[0]!.endsWith("/scode")).toBe(true);
      expect(argv).toContain("--");
      expectOwnTreeOnly(argv, home, true);
      // Nothing spawned and nothing left behind: the private directory
      // was created (the allow names it) and then removed.
      const hermetic = join(home, ".claude", ".codemux-hermetic");
      expect(existsSync(hermetic) ? readdirSync(hermetic) : []).toEqual([]);
    } finally {
      fake.cleanup();
    }
  }, 30_000);

  test("requires --sandbox", async () => {
    const cwd = tempDir("codemux-sb-cwd-");
    const result = await runCli(
      [
        "run", "-a", "claude", "--no-sandbox", "--auto", "high",
        "--cwd", cwd, "-p", "probe", "--print-sandbox",
      ],
      { PATH: minimalPath() }
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--print-sandbox requires --sandbox");
  });

  test("opencode prints no blocks: its real data directory holds the run's own storage", async () => {
    const home = tempDir("codemux-sb-home-");
    const cwd = tempDir("codemux-sb-opencode-");
    const fake = createFakeBinaryEnv({ scode: RECORDING_SCODE, opencode: "exit 0" });
    try {
      const result = await runCli([...runFlags("opencode", cwd), "--print-sandbox"], {
        ...fake.env,
        HOME: home,
      });
      expect(result.exitCode).toBe(0);
      const argv = result.stdout.trimEnd().split("\n");
      expect(valuesAfter(argv, "--block")).toEqual([]);
    } finally {
      fake.cleanup();
    }
  }, 30_000);
});

describe("blocked operator state: session --print-sandbox", () => {
  const sessionStage = (agent: "claude" | "zai") => {
    const home = tempDir("codemux-sb-session-");
    const workdir = join(home, "work");
    mkdirSync(workdir, { recursive: true });
    // The session path gates the claude version at a floor (2.1.280), so
    // the fake binary answers --version above it.
    const fake = createFakeBinaryEnv({
      scode: RECORDING_SCODE,
      claude: `if [ "$1" = "--version" ]; then printf '2.1.300\\n'; exit 0; fi\nexit 0`,
    });
    return {
      home,
      workdir,
      fake,
      env: {
        ...fake.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        ...(agent === "zai" ? { ZAI_API_KEY: "fake-key" } : {}),
      } as Record<string, string>,
    };
  };

  test.each([["claude"], ["zai"]])(
    "%s's session argv blocks the config root and allows only the session directory",
    async (agent) => {
      const s = sessionStage(agent as "claude" | "zai");
      try {
        const result = await runCli(
          [
            "session", "-a", agent, "--sandbox", "--hermetic",
            "--experiment-project-settings", "--auto", "low",
            "--cwd", s.workdir, "--print-sandbox",
          ],
          s.env
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).not.toContain("FAKE-SCODE-RAN");
        const argv = result.stdout.trimEnd().split("\n");
        const sessionDir = expectOwnTreeOnly(argv, s.home, false);
        expect(sessionDir).toMatch(/session-[0-9a-f-]{36}$/);
        // A fresh session that never recorded is abandoned: the printed
        // directory did not survive the command.
        expect(existsSync(sessionDir)).toBe(false);
      } finally {
        s.fake.cleanup();
      }
    },
    30_000
  );

  test("--sandbox-block rides the session argv; a plain session prints none", async () => {
    const s = sessionStage("claude");
    try {
      const blocked = await runCli(
        [
          "session", "-a", "claude", "--sandbox", "--hermetic",
          "--experiment-project-settings", "--auto", "low",
          "--cwd", s.workdir, "--print-sandbox",
          "--sandbox-block", "/opt/operator-only",
        ],
        s.env
      );
      expect(blocked.exitCode).toBe(0);
      const argv = blocked.stdout.trimEnd().split("\n");
      expect(valuesAfter(argv, "--block")).toEqual([
        "/opt/operator-only",
        join(s.home, ".claude"),
        join(s.home, ".claude.json"),
      ]);

      const plain = await runCli(
        [
          "session", "-a", "claude", "--sandbox", "--auto", "high",
          "--cwd", s.workdir, "--print-sandbox",
        ],
        s.env
      );
      expect(plain.exitCode).toBe(0);
      expect(valuesAfter(plain.stdout.trimEnd().split("\n"), "--block")).toEqual([]);
    } finally {
      s.fake.cleanup();
    }
  }, 30_000);

  test("--sandbox-block refuses a relative path with 64", async () => {
    const s = sessionStage("claude");
    try {
      const result = await runCli(
        [
          "session", "-a", "claude", "--sandbox", "--auto", "high",
          "--cwd", s.workdir, "--print-sandbox",
          "--sandbox-block", "relative/path",
        ],
        s.env
      );
      expect(result.exitCode).toBe(64);
      expect(result.stderr).toContain("--sandbox-block requires absolute paths");
    } finally {
      s.fake.cleanup();
    }
  });

  test("a --sandbox-block over the session's own private directory is refused with 64", async () => {
    // Review round 9, edges finding 1: the later --allow would re-open the
    // caller's block, so the launch refuses instead of silently defeating
    // the containment request.
    const s = sessionStage("claude");
    try {
      const result = await runCli(
        [
          "session", "-a", "claude", "--sandbox", "--hermetic",
          "--experiment-project-settings", "--auto", "low",
          "--cwd", s.workdir, "--print-sandbox",
          "--sandbox-block", join(s.home, ".claude"),
        ],
        s.env
      );
      expect(result.exitCode).toBe(64);
      expect(result.stderr).toContain(
        `--sandbox-block ${join(realpathSync(s.home), ".claude")} covers the launch's own harness state directory`
      );
      expect(result.stderr).toContain(join(s.home, ".claude", ".codemux-hermetic"));
    } finally {
      s.fake.cleanup();
    }
  });

  test("the same refusal at launch leaves no private directory behind (round 11, contracts-2 1)", async () => {
    // The conflict check used to run AFTER the private config directory
    // was created, so this refusal (exit 64) left a session-<id>
    // directory under the hermetic parent. The check now runs before
    // creation — the path is deterministic — so a refusal writes nothing.
    const s = sessionStage("claude");
    try {
      const result = await runCli(
        [
          "session", "-a", "claude", "--sandbox", "--hermetic",
          "--experiment-project-settings", "--auto", "low",
          "--cwd", s.workdir,
          "--sandbox-block", join(s.home, ".claude"),
        ],
        s.env
      );
      expect(result.exitCode).toBe(64);
      expect(result.stderr).toContain(
        `--sandbox-block ${join(realpathSync(s.home), ".claude")} covers the launch's own harness state directory`
      );
      // The refusal named the deterministic path and created nothing.
      const parent = join(projectSettingsConfigRoot({ HOME: s.home }), ".codemux-hermetic");
      expect(existsSync(parent)).toBe(false);
    } finally {
      s.fake.cleanup();
    }
  });
});

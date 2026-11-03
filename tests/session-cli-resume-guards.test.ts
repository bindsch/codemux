/**
 * Resume and registry guards (split from tests/session-cli.test.ts):
 * registry containment, the cwd and --pass-env reach of a resume, and
 * the record before a session's first turn.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli } from "./helpers/cli.js";
import { readRegistry, sessionRegistryPath } from "../src/session/registry.js";
import { fakeAgyEnv, fakeClaudeEnv } from "./helpers/session-cli.js";

describe("CLI - session resume guards", () => {
  test("a registry inside the entry's own working directory refuses with 78, not 66", async () => {
    // §4.8's containment rule is a policy refusal (the registry is a
    // file the child could have altered), so it shares `refused`'s exit
    // code — the review caught it reporting 66, the missing-entry code.
    // Review live23: the resume runs in the recorded cwd, so the
    // containment guard itself refuses. The test used to resume in
    // another cwd and passed through the cwd-mismatch guard, while the
    // start-time check (exit 64) made the containment guard unreachable.
    const fake = fakeClaudeEnv();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "codemux-resume-inside-")));
    try {
      const dir = dirname(sessionRegistryPath(home));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(
        sessionRegistryPath(home),
        `${JSON.stringify({
          version: 1,
          sessions: [
            {
              id: "11111111-2222-3333-4444-555555555555",
              agent: "claude",
              created_at: "2026-10-04T10:00:00.000Z",
              last_activity: "2026-10-04T10:05:00.000Z",
              // The registry file sits inside this cwd (under the home),
              // which is exactly the untrusted placement.
              cwd: home,
              hermetic: false,
              harness_home: join(home, ".claude"),
              model: null,
              autonomy: "high",
              sandboxed: false,
              sandbox_trust: "standard",
              sandbox_no_net: false,
              sandbox_scrub_env: false,
              pass_env: [],
              playwright_mcp: false,
              owner_pid: 999999,
              owner_start: null,
              ended: "2026-10-04T10:05:00.000Z",
            },
          ],
        })}\n`,
        { mode: 0o600 }
      );
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", home,
          "--resume", "11111111-2222-3333-4444-555555555555",
        ],
        { ...fake.env, HOME: home }
      );
      expect(exitCode).toBe(78);
      expect(stderr).toContain("cannot resume");
      expect(stderr).toContain("the registry sits inside the session's own cwd");
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a corrupt registry's resume refusal names the registry path", async () => {
    // §4.8's failure policy ("error names the path"): an operator told
    // the registry is unreadable or corrupt needs the file's path to fix
    // it. Review live6, finding 5 — the message used to name only the id
    // and the reason, never the file.
    const fake = fakeClaudeEnv();
    const home = mkdtempSync(join(tmpdir(), "codemux-resume-corrupt-"));
    const workdir = join(home, "elsewhere");
    mkdirSync(workdir);
    try {
      const dir = dirname(sessionRegistryPath(home));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const registryPath = sessionRegistryPath(home);
      writeFileSync(registryPath, "{corrupt", { mode: 0o600 });
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir,
          "--resume", "11111111-2222-3333-4444-555555555555",
        ],
        { ...fake.env, HOME: home }
      );
      expect(exitCode).toBe(78);
      expect(stderr).toContain("cannot resume");
      expect(stderr).toContain("not valid JSON");
      expect(stderr).toContain(registryPath);
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a session created with --sandbox-no-net refuses a resume that drops it, argv or not", async () => {
    // Review live4, security: the guard must judge the containment the
    // resume EFFECTIVELY runs at. `--sandbox-no-net` without --sandbox is
    // a warned-and-ignored argv bit (parseSandboxPolicyOverrides), so a
    // resume passing the raw flag unsandboxed must still refuse — the
    // probe reading the resolved options, not the raw command line, is
    // exactly what this pins.
    const fake = fakeClaudeEnv();
    const home = mkdtempSync(join(tmpdir(), "codemux-resume-nonnet-"));
    const workdir = join(home, "elsewhere");
    mkdirSync(workdir);
    try {
      const dir = dirname(sessionRegistryPath(home));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(
        sessionRegistryPath(home),
        `${JSON.stringify({
          version: 1,
          sessions: [
            {
              id: "11111111-2222-3333-4444-555555555555",
              agent: "claude",
              created_at: "2026-10-04T10:00:00.000Z",
              last_activity: "2026-10-04T10:05:00.000Z",
              cwd: workdir,
              hermetic: false,
              harness_home: join(home, ".claude"),
              model: null,
              autonomy: "high",
              sandboxed: false,
              sandbox_trust: "standard",
              sandbox_no_net: true,
              sandbox_scrub_env: false,
              pass_env: [],
              playwright_mcp: false,
              owner_pid: 999999,
              owner_start: null,
              ended: "2026-10-04T10:05:00.000Z",
            },
          ],
        })}\n`,
        { mode: 0o600 }
      );
      const args = [
        "session", "-a", "claude", "--no-sandbox", "--auto", "high",
        "--cwd", workdir,
        "--resume", "11111111-2222-3333-4444-555555555555",
      ];
      const plain = await runCli(args, { ...fake.env, HOME: home });
      expect(plain.exitCode).toBe(78);
      expect(plain.stderr).toContain("--sandbox-no-net");
      // The raw flag without --sandbox changes nothing: the resume does
      // not run with a network boundary, so it still refuses.
      const flagged = await runCli([...args, "--sandbox-no-net"], { ...fake.env, HOME: home });
      expect(flagged.exitCode).toBe(78);
      expect(flagged.stderr).toContain("--sandbox-no-net");
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("CLI - resume reach (review live16)", () => {
  test("a resume in another --cwd or with an added --pass-env name is refused with 78", async () => {
    // Review live16, security: the finding's trigger — create in one
    // tree, resume with `--cwd ~/repo` — passed every guard, and so did
    // adding `--pass-env GITHUB_TOKEN` to a session created without it.
    const fake = fakeClaudeEnv();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "codemux-resume-reach-")));
    const created = join(home, "created");
    const other = join(home, "other");
    mkdirSync(created);
    mkdirSync(other);
    try {
      const dir = dirname(sessionRegistryPath(home));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(
        sessionRegistryPath(home),
        `${JSON.stringify({
          version: 1,
          sessions: [
            {
              id: "11111111-2222-3333-4444-555555555555",
              agent: "claude",
              created_at: "2026-10-04T10:00:00.000Z",
              last_activity: "2026-10-04T10:05:00.000Z",
              cwd: created,
              hermetic: false,
              harness_home: join(home, ".claude"),
              model: null,
              autonomy: "high",
              sandboxed: false,
              sandbox_trust: "standard",
              sandbox_no_net: false,
              sandbox_scrub_env: false,
              pass_env: [],
              playwright_mcp: false,
              owner_pid: 999999,
              owner_start: null,
              ended: "2026-10-04T10:05:00.000Z",
            },
          ],
        })}\n`,
        { mode: 0o600 }
      );
      const base = [
        "session", "-a", "claude", "--no-sandbox", "--auto", "high",
        "--resume", "11111111-2222-3333-4444-555555555555",
      ];
      const env = { ...fake.env, HOME: home, GITHUB_TOKEN: "not-a-real-token" };
      const moved = await runCli([...base, "--cwd", other], env);
      expect(moved.exitCode).toBe(78);
      expect(moved.stderr).toContain(`cannot resume in ${other}`);
      const secret = await runCli([...base, "--cwd", created, "--pass-env", "GITHUB_TOKEN"], env);
      expect(secret.exitCode).toBe(78);
      expect(secret.stderr).toContain("--pass-env GITHUB_TOKEN");
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("CLI - the registry before the first turn (review live22)", () => {
  /** A registry under `home` the reader refuses: right content, mode 0644. */
  function seedLooseRegistry(home: string): string {
    const registryPath = sessionRegistryPath(home);
    mkdirSync(dirname(registryPath), { recursive: true, mode: 0o700 });
    writeFileSync(registryPath, '{"version":1,"sessions":[]}\n', { mode: 0o644 });
    return registryPath;
  }

  for (const agent of ["claude", "agy"] as const) {
    test(`a fresh ${agent} session with an untrusted registry exits 1 before any input reaches the harness`, async () => {
      // Correctness major 4: a fresh session recorded itself only after
      // the harness named it — for the claude family at the init frame,
      // which follows the caller's first input; for agy at its first
      // result. An untrusted registry let that turn, tool calls included,
      // run before the session failed. The claude family now records
      // before the spawn; agy probes the registry before the spawn.
      const fake = agent === "claude" ? fakeClaudeEnv() : fakeAgyEnv();
      const home = realpathSync(mkdtempSync(join(tmpdir(), `codemux-fresh-${agent}-`)));
      const workdir = join(home, "work");
      mkdirSync(workdir);
      try {
        const registryPath = seedLooseRegistry(home);
        const { stdout, stderr, exitCode } = await runCli(
          [
            "session", "-a", agent, "--no-sandbox", "--auto", "high",
            "--cwd", workdir, "--shutdown-grace", "2",
            ...(agent === "claude" ? ["--pass-env", "FAKE_STATE_DIR,FAKE_CWD"] : []),
          ],
          { ...fake.env, HOME: home, FAKE_CWD: workdir },
          { stdin: `${JSON.stringify({ type: "user", text: "scenario:basic hi" })}\n` }
        );
        expect(exitCode, stderr).toBe(1);
        expect(stderr).toContain("cannot record the session in the registry");
        expect(stderr).toContain(registryPath);
        expect(stdout.trim()).toBe("");
        expect(existsSync(join(fake.stateDir, "input-lines.jsonl"))).toBe(false);
      } finally {
        fake.cleanup();
        rmSync(home, { recursive: true, force: true });
      }
    }, 30_000);
  }

  test("a fresh claude session's pre-spawn record is discarded when the harness never confirms it", async () => {
    // The pre-spawn record is owned from the start. A session that ends
    // before the harness ever confirmed it has no transcript behind it:
    // it is not reported resumable, and the record is removed, so a
    // later `--resume` of the id is the registry's not-found (66) rather
    // than a harness refusal (the audit's minor observation, live22).
    const fake = fakeClaudeEnv();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "codemux-fresh-early-")));
    const workdir = join(home, "work");
    mkdirSync(workdir);
    try {
      const { stdout, stderr, exitCode } = await runCli(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        { ...fake.env, HOME: home, FAKE_CWD: workdir },
        { stdin: "" }
      );
      expect(exitCode, stderr).toBe(0);
      const events = stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
      const ended = events.at(-1);
      expect(ended?.type).toBe("session_ended");
      expect(ended?.resumable).toBe(false);
      const read = readRegistry(sessionRegistryPath(home));
      expect(read.outcome).toBe("ok");
      if (read.outcome === "ok") expect(read.file.sessions).toHaveLength(0);
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});


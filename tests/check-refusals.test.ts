import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";

describe("CLI - check pre-launch usage refusals exit 64", () => {
  // The same class run and tui refuse (review round 2, contracts 1):
  // every refusal decided before a harness spawns is 64. Each row's
  // refusal fires during option validation, so the fake binaries only
  // satisfy the installation gate, and no probe can spend quota.
  const specDir = mkdtempSync(join(tmpdir(), "codemux-check-refusals-"));
  const spec = join(specDir, "spec.json");
  writeFileSync(spec, JSON.stringify({ name: "probe", command: "/bin/true", args: [], env: [], accept_harness_prefix: ["codex-wall-time"] }));
  afterAll(() => rmSync(specDir, { recursive: true, force: true }));
  const refusalCases: {
    label: string;
    binaries: Record<string, string>;
    argv: () => string[];
    message: string;
  }[] = [
    {
      label: "hermetic check with an explicit --cwd",
      binaries: { claude: "exit 0" },
      argv: () => ["check", "-a", "claude", "--hermetic", "--cwd", "/tmp"],
      message: "--hermetic plants its own working directory; drop --cwd",
    },
    {
      // Review round 4, contracts-2 finding 1: a bad model name is 64 on
      // check as well, decided before any probe can spend quota.
      label: "a model name with padding",
      binaries: { claude: "exit 0" },
      argv: () => ["check", "-a", "claude", "-m", " bad "],
      message: "invalid model name",
    },
    {
      // Review round 4, contracts-2 finding 1: an inaccessible --cwd is
      // refused before the version probe runs (assertHarnessSupported
      // validates it first).
      label: "a --cwd that does not exist",
      binaries: { claude: "exit 0" },
      argv: () => ["check", "-a", "claude", "--cwd", "/definitely/not/a/dir", "--no-sandbox", "--auto", "high"],
      message: "cwd is not accessible",
    },
    {
      label: "an agy diagnostic with a competing isolation flag",
      binaries: { agy: "exit 0" },
      argv: () => ["check", "-a", "agy", "--agy-isolation-probe", "login", "--cwd", "/tmp"],
      message: "--agy-isolation-probe requires -a agy --auto read-only with default scode and no other isolation flags",
    },
    {
      label: "an agy canary without the default scode policy",
      binaries: { agy: "exit 0" },
      argv: () => ["check", "-a", "agy", "--hermetic", "--no-sandbox"],
      message: "agy canary checks require default read-only scode and manage their own scratch cwd and HOME",
    },
    {
      // Audit round 2, A8: the run command's refusal, so one request
      // cannot yield three outcomes across the launch commands.
      label: "print-sandbox without --sandbox",
      binaries: { claude: "exit 0" },
      argv: () => ["check", "-a", "claude", "--no-sandbox", "--print-sandbox"],
      message: "--print-sandbox requires --sandbox",
    },
    {
      // The hermetic probes run several different children; there is no
      // single scode argv to print (audit round 2, A8).
      label: "print-sandbox on a hermetic check",
      binaries: { claude: "exit 0" },
      argv: () => ["check", "-a", "claude", "--hermetic", "--print-sandbox"],
      message: "--print-sandbox supports the plain probe only",
    },
  ];
  test.each(refusalCases)("$label", async ({ binaries, argv, message }) => {
    const fake = createFakeBinaryEnv(binaries);
    try {
      const { stderr, exitCode } = await runCli(argv(), fake.env);
      expect(exitCode).toBe(64);
      expect(stderr).toContain(message);
    } finally {
      fake.cleanup();
    }
  });

  test("--sandbox-block rides the printed probe argv and nothing runs", async () => {
    // Audit round 2, A8: --sandbox-block and --print-sandbox used to be
    // run-only flags, a parse error (exit 1) here. Both are carried now:
    // the print shows the probe's scode argv, block path included, and no
    // probe can spend quota.
    const fake = createFakeBinaryEnv({
      claude: `if [ "$1" = "--version" ]; then printf '2.1.220 (Claude Code)\\n'; exit 0; fi
exit 7`,
      scode: "exit 9",
    });
    try {
      const { stdout, exitCode } = await runCli(
        ["check", "-a", "claude", "--print-sandbox", "--sandbox-block", "/secrets"],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("--block");
      expect(stdout).toContain("/secrets");
      expect(stdout).toContain("/claude\n");
    } finally {
      fake.cleanup();
    }
  });

  test("a hermetic kimi check from a repo holding AGENTS.md proceeds past validation (round 14, contracts 1)", async () => {
    // The pre-gate used to validate the hermetic twin against the
    // operator's own cwd, so a hermetic check of kimi — whose hermetic
    // rule refuses project customization files in the cwd's Git tree —
    // was refused from any repo holding AGENTS.md before any probe ran.
    // The hermetic request is validated where it runs, on the canary's
    // planted directory, so the operator's repo is no longer judged.
    const repo = mkdtempSync(join(tmpdir(), "codemux-check-kimi-repo-"));
    const ranRoot = mkdtempSync(join(tmpdir(), "codemux-check-kimi-ran-"));
    const ranMarker = join(ranRoot, "ran");
    try {
      mkdirSync(join(repo, ".git"), { recursive: true });
      writeFileSync(join(repo, "AGENTS.md"), "# operator instructions\n");
      const fake = createFakeBinaryEnv({
        kimi: `if [ "$1" = "--version" ]; then printf '0.31.1\\n'; exit 0; fi
printf 'OK\\n'; printf ran >> ${JSON.stringify(ranMarker)}; exit 0`,
        // A scode that only wraps: the canary's probe runs unwrapped.
        scode: 'while [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"',
      });
      try {
        const { stderr } = await runCli(["check", "-a", "kimi", "--hermetic"], fake.env, { cwd: repo });
        expect(stderr).not.toContain("refuse project customization");
        // The probe itself ran: validation no longer stops it.
        expect(existsSync(ranMarker)).toBe(true);
      } finally {
        fake.cleanup();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(ranRoot, { recursive: true, force: true });
    }
  });

  test("a prefixless codex spec is refused on check before the installation gate (round 381)", async () => {
    // Round 381 removed a codex-only throw that used to hide the spec's own
    // problem: an operator whose spec lacks accept_harness_prefix is sent to
    // fix the spec, not told the harness is missing.
    const dir = mkdtempSync(join(tmpdir(), "codemux-check-codex-order-"));
    const prefixless = join(dir, "spec.json");
    writeFileSync(prefixless, JSON.stringify({ name: "probe", command: "/bin/true", args: [], env: [] }));
    const fake = createFakeBinaryEnv({ codex: "exit 0" });
    try {
      const { stderr, exitCode } = await runCli(
        ["check", "-a", "codex", "--hermetic", "--tools", "none", "--experiment-mcp", prefixless],
        fake.env
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain("requires accept_harness_prefix:");
      expect(stderr).not.toContain("is not installed");
    } finally {
      fake.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an adapter refusal wins over the quota gate (round 12, edges 3)", async () => {
    // check used to run the gate before the request reached the adapter,
    // so a drained account reported the quota refusal and hid opencode's
    // plain --tools none refusal. The request is validated first, as run
    // validates it; the fake usagemux answers a below-ceiling window, so a
    // gate-first order would print the quota text instead.
    const drained = JSON.stringify({
      schemaVersion: "1",
      generatedAt: new Date().toISOString(),
      results: [{
        client: "opencode",
        provider: "opencode",
        status: "ok",
        source: null,
        plan: null,
        account: null,
        windows: [{ kind: "weekly", usedPercent: 100, remainingPercent: 0, windowMinutes: 10_080, resetsAt: "2026-11-07T09:00:00.000Z" }],
        credits: null,
        subscriptionRenewsAt: null,
        subscriptionExpiresAt: null,
        message: null,
      }],
    });
    const fake = createFakeBinaryEnv({
      opencode: "exit 0",
      usagemux: `printf '%s' '${drained}'`,
    });
    try {
      const { stderr, exitCode } = await runCli(
        ["check", "-a", "opencode", "--tools", "none", "--no-sandbox", "--auto", "high"],
        fake.env
      );
      expect(exitCode).toBe(64);
      expect(stderr).toContain("opencode --tools none requires --hermetic");
      expect(stderr).not.toContain("quota gate");
    } finally {
      fake.cleanup();
    }
  });
});

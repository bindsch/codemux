/**
 * The claim-order contract of a project-settings resume (review round 3,
 * edges finding on cli-spawn-prep): nothing may write into the session's
 * private config directory before the resume claim succeeds — a resume
 * that loses the claim, or one that only prints its sandbox argv, leaves
 * the directory byte-identical.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  projectSettingsConfigRoot,
  projectSettingsSessionDirPath,
} from "../src/claude-project-config.js";
import * as registryModule from "../src/session/registry.js";
import * as sweepModule from "../src/hermetic-sweep.js";
import * as configModule from "../src/claude-project-config.js";
import { claudeRecord, runSessionCommand, seedRegistry, tempWorkdir, removeDir } from "./helpers/session-command.js";

const FAKE_CLAUDE = `if [ "$1" = "--version" ]; then printf '2.1.280\\n'; exit 0; fi
exit 7`;

const ACCESS_ONLY = JSON.stringify({
  claudeAiOauth: { accessToken: "at", refreshToken: "", expiresAt: 4102444800, scopes: [] },
}) + "\n";

/** The process-wide signal listeners, by reference: a refused resume
 * must leave none of the driver's behind (the driver is built before the
 * claim). Compared as sets, so another file's driver disposing in the
 * same test process cannot mask or fake a leak. */
const signalListeners = (): Set<unknown> =>
  new Set<unknown>((["SIGINT", "SIGTERM", "SIGHUP"] as const).flatMap((signal) => process.listeners(signal)));

/** One file's recorded state, enough to prove "byte-identical". */
type Snapshot = Record<string, { content: string; mode: number }>;

function snapshotDir(dir: string): Snapshot {
  const shot: Snapshot = {};
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const [name, value] of Object.entries(snapshotDir(path))) {
        shot[`${entry}/${name}`] = value;
      }
    } else {
      shot[entry] = { content: readFileSync(path, "utf8"), mode: stat.mode & 0o777 };
    }
  }
  return shot;
}

/** A staged project-settings session: a redirected HOME holding the
 * credential mirror and the session's private config directory, plus the
 * registry record a resume of it must match. Returns the pieces both
 * tests assert on. */
function stagedSession(): { home: string; dir: string; registry: string; workdir: string; id: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "codemux-claim-home-")));
  const root = join(home, ".claude");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // The operator's access-only mirror: a resume whose environment build
  // ran would copy it into the private directory.
  writeFileSync(join(root, ".credentials.json"), ACCESS_ONLY, { mode: 0o600 });
  const id = randomUUID();
  const dir = projectSettingsSessionDirPath(projectSettingsConfigRoot({ HOME: home }), id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, ".claude.json"), '{"hasCompletedOnboarding":true}\n', { mode: 0o600 });
  const workdir = tempWorkdir("claim-order");
  const registry = join(tempWorkdir("claim-order-reg"), "live-sessions.json");
  return { home, dir, registry, workdir, id };
}

describe("a project-settings resume writes nothing before the claim", () => {
  const scratch: string[] = [];
  const clean = (paths: string[]): void => {
    for (const path of paths) removeDir(path);
  };

  test("a resume that loses the claim leaves the private directory byte-identical", async () => {
    const staged = stagedSession();
    scratch.push(staged.home, staged.workdir, staged.registry);
    const record = claudeRecord(staged.id, staged.workdir, {
      hermetic: true,
      project_settings: true,
      sandboxed: true,
      harness_home: staged.dir,
      autonomy: "low",
      pass_env: [],
    });
    seedRegistry(staged.registry, [record]);
    let after: Snapshot = {};
    const before = snapshotDir(staged.dir);
    const listenersBefore = signalListeners();
    // The claim loses to a concurrent resume (session_busy): the lookup
    // passed, the locked claim refused — the exact window the write used
    // to sit in.
    const claim = spyOn(registryModule, "claimForResume").mockReturnValue({
      outcome: "refused" as const,
      reason: "session_busy: another codemux owns this session",
    });
    try {
      const outcome = await runSessionCommand(
        ["-a", "claude", "--resume", staged.id, "--cwd", staged.workdir, "--auto", "low",
          "--hermetic", "--experiment-project-settings"],
        { claude: FAKE_CLAUDE, scode: "exit 9" },
        {
          registryFile: staged.registry,
          env: { HOME: staged.home, CODEMUX_NO_KEYCHAIN_SYNC: "1" },
        }
      );
      expect(outcome.exitCalls[0]).toBe(78);
      expect(outcome.stderr).toContain("session_busy");
      after = snapshotDir(staged.dir);
      // The refused resume disposed the driver it had built: no signal
      // handler outlives the exit (a later test's synthetic signal would
      // otherwise end the whole test process).
      expect([...signalListeners()].filter((listener) => !listenersBefore.has(listener))).toEqual([]);
    } finally {
      claim.mockRestore();
    }
    expect(after).toEqual(before);
    clean(scratch.splice(0));
  });

  test("a resume --print-sandbox leaves the private directory and the registry byte-identical", async () => {
    const staged = stagedSession();
    scratch.push(staged.home, staged.workdir, staged.registry);
    const { seedRegistry } = await import("./helpers/session-command.js");
    seedRegistry(staged.registry, [
      claudeRecord(staged.id, staged.workdir, {
        hermetic: true,
        project_settings: true,
        sandboxed: true,
        harness_home: staged.dir,
        autonomy: "low",
        pass_env: [],
      }),
    ]);
    let after: Snapshot = {};
    const before = snapshotDir(staged.dir);
    const registryBefore = readFileSync(staged.registry, "utf8");
    // The claim is the write under test: a print-only invocation must
    // never take it (round 17, edges 2 — the claim used to clear `ended`,
    // move the owner, and the print exit stamped a fresh end time).
    const claim = spyOn(registryModule, "claimForResume");
    try {
      const outcome = await runSessionCommand(
        ["-a", "claude", "--resume", staged.id, "--cwd", staged.workdir, "--auto", "low",
          "--hermetic", "--experiment-project-settings", "--print-sandbox"],
        { claude: FAKE_CLAUDE, scode: "exit 9" },
        {
          registryFile: staged.registry,
          env: { HOME: staged.home, CODEMUX_NO_KEYCHAIN_SYNC: "1" },
        }
      );
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toContain("/claude");
      expect(outcome.exitCalls).toEqual([]);
      after = snapshotDir(staged.dir);
      // Never claimed, never released, never stamped: the registry file
      // is byte-identical, and the claim was never even attempted.
      expect(claim).not.toHaveBeenCalled();
      expect(readFileSync(staged.registry, "utf8")).toBe(registryBefore);
    } finally {
      claim.mockRestore();
    }
    expect(after).toEqual(before);
    clean(scratch.splice(0));
  });

  test("a resume --print-sandbox --final removes nothing and stamps no final", async () => {
    // Review round 14, contracts-2 1: the print-only branch used to remove
    // the resumed session's private directory and release the record with
    // a final stamp — a dry run that deleted the transcript and foreclosed
    // every future resume.
    const staged = stagedSession();
    scratch.push(staged.home, staged.workdir, staged.registry);
    seedRegistry(staged.registry, [
      claudeRecord(staged.id, staged.workdir, {
        hermetic: true,
        project_settings: true,
        sandboxed: true,
        harness_home: staged.dir,
        autonomy: "low",
        pass_env: [],
      }),
    ]);
    let after: Snapshot = {};
    const before = snapshotDir(staged.dir);
    const registryBefore = readFileSync(staged.registry, "utf8");
    const outcome = await runSessionCommand(
      ["-a", "claude", "--resume", staged.id, "--cwd", staged.workdir, "--auto", "low",
        "--hermetic", "--experiment-project-settings", "--print-sandbox", "--final"],
      { claude: FAKE_CLAUDE, scode: "exit 9" },
      {
        registryFile: staged.registry,
        env: { HOME: staged.home, CODEMUX_NO_KEYCHAIN_SYNC: "1" },
      }
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toContain("--final ignored: nothing ran");
    after = snapshotDir(staged.dir);
    expect(after).toEqual(before);
    // The record was never claimed or stamped: a later resume is still
    // allowed, and the registry is byte-identical (round 17, edges 2).
    const registry = JSON.parse(readFileSync(staged.registry, "utf8")) as {
      sessions: Array<{ id: string; final?: boolean }>;
    };
    const released = registry.sessions.find((session) => session.id === staged.id)!;
    expect(released.final).toBeFalsy();
    expect(readFileSync(staged.registry, "utf8")).toBe(registryBefore);
    clean(scratch.splice(0));
  });

  test("a sweep arriving at the open cannot remove a directory the claim already holds", async () => {
    const staged = stagedSession();
    scratch.push(staged.home, staged.workdir, staged.registry);
    seedRegistry(staged.registry, [
      claudeRecord(staged.id, staged.workdir, {
        hermetic: true,
        project_settings: true,
        sandboxed: true,
        harness_home: staged.dir,
        autonomy: "low",
        pass_env: [],
      }),
    ]);
    // The sweep's exact removal case: an ended record under a dead pid
    // (`free`) and a directory two-plus days quiet.
    const threeDaysAgo = Date.now() / 1000 - 3 * 86_400;
    utimesSync(join(staged.dir, ".claude.json"), threeDaysAgo, threeDaysAgo);
    utimesSync(staged.dir, threeDaysAgo, threeDaysAgo);
    const order: string[] = [];
    const realClaim = registryModule.claimForResume;
    const claim = spyOn(registryModule, "claimForResume").mockImplementation((
      path: string,
      id: string,
      probe: Parameters<typeof realClaim>[2],
    ) => {
      const verdict = realClaim(path, id, probe);
      if (verdict.outcome === "ok") order.push("claim");
      return verdict;
    });
    // Another codemux process's sweep, fired at the moment this resume
    // opens its directory (review round 13, edges 3): the same public
    // prepareRunDirParent, but with NO spare — the other process spared
    // nothing — consulting the same registry. Under the old order the
    // open ran before the claim, the record still read `free`, and this
    // sweep removed the transcript directory out from under the resume.
    const realOpen = configModule.openProjectSettingsSessionConfigDir;
    const open = spyOn(configModule, "openProjectSettingsSessionConfigDir").mockImplementation((
      sessionId: string,
      resume: boolean,
      cwd: string,
      environment: NodeJS.ProcessEnv,
      holdStateOf?: Parameters<typeof realOpen>[4],
    ) => {
      const root = configModule.projectSettingsConfigRoot(environment);
      const parent = basename(dirname(staged.dir));
      sweepModule.prepareRunDirParent(root, parent, (id: string) =>
        registryModule.sessionHoldState(staged.registry, id));
      order.push("open");
      return realOpen(sessionId, resume, cwd, environment, holdStateOf);
    });
    try {
      const outcome = await runSessionCommand(
        ["-a", "claude", "--resume", staged.id, "--cwd", staged.workdir, "--auto", "low",
          "--hermetic", "--experiment-project-settings"],
        { claude: FAKE_CLAUDE, scode: "exit 9" },
        {
          registryFile: staged.registry,
          env: { HOME: staged.home, CODEMUX_NO_KEYCHAIN_SYNC: "1" },
        }
      );
      expect(outcome.stderr).not.toContain("has no private config directory");
      // The claim is what protects the directory, so it must precede the
      // open that first sweeps the parent.
      expect(order).toEqual(["claim", "open"]);
      // The transcript directory survived the concurrent sweep and the
      // resume that claimed it.
      expect(existsSync(staged.dir)).toBe(true);
      expect(existsSync(join(staged.dir, ".claude.json"))).toBe(true);
    } finally {
      claim.mockRestore();
      open.mockRestore();
      clean(scratch.splice(0));
    }
  });

  test("a successful resume writes the credential copy only after the claim", async () => {
    const staged = stagedSession();
    scratch.push(staged.home, staged.workdir, staged.registry);
    const { seedRegistry } = await import("./helpers/session-command.js");
    seedRegistry(staged.registry, [
      claudeRecord(staged.id, staged.workdir, {
        hermetic: true,
        project_settings: true,
        sandboxed: true,
        harness_home: staged.dir,
        autonomy: "low",
        pass_env: [],
      }),
    ]);
    const claims: string[] = [];
    const realClaim = registryModule.claimForResume;
    const realCopy = configModule.copyClaudeCredentialMirror;
    // The copy is the write under test; the claim is the ownership step.
    // The ordering assertion lives in the copy's wrapper: it may only run
    // once the claim succeeded.
    const claim = spyOn(registryModule, "claimForResume").mockImplementation((
      path: string,
      id: string,
      probe: Parameters<typeof realClaim>[2],
    ) => {
      const verdict = realClaim(path, id, probe);
      if (verdict.outcome === "ok") claims.push(id);
      return verdict;
    });
    const copy = spyOn(configModule, "copyClaudeCredentialMirror").mockImplementation((
      dir: string,
      mirror: string,
    ) => {
      expect(claims).toContain(staged.id);
      return realCopy(dir, mirror);
    });
    try {
      const outcome = await runSessionCommand(
        ["-a", "claude", "--resume", staged.id, "--cwd", staged.workdir, "--auto", "low",
          "--hermetic", "--experiment-project-settings"],
        { claude: FAKE_CLAUDE, scode: "exit 9" },
        {
          registryFile: staged.registry,
          env: { HOME: staged.home, CODEMUX_NO_KEYCHAIN_SYNC: "1" },
        }
      );
      expect(outcome.stderr).not.toContain("session_busy");
      expect(copy).toHaveBeenCalled();
    } finally {
      claim.mockRestore();
      copy.mockRestore();
      clean(scratch.splice(0));
    }
  });
});

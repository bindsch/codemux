/**
 * The --final end ordering (review round 10, edges 4): a final session
 * removes its private config directory BEFORE the end stamp releases the
 * registry record, and the stamp writes the record non-resumable in the
 * same update, so a concurrent resume can never claim the record and run
 * in a directory the original process is about to delete.
 */

import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import * as registryModule from "../src/session/registry.js";
import * as spawnModule from "../src/session/spawn.js";
import {
  projectSettingsConfigRoot,
  projectSettingsSessionDirPath,
} from "../src/claude-project-config.js";
import { claudeRecord, runSessionCommand, seedRegistry, tempWorkdir, waitForEvent } from "./helpers/session-command.js";
import { registerNoLeakedSignals } from "./helpers/signal-listeners.js";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/live/fake-claude-session.ts", import.meta.url));
// A scode that only wraps: the session child runs unwrapped, which is
// all the end ordering needs (the scode argv itself is pinned in
// tests/sandbox-blocks.test.ts).
const SCODE_PASSTHROUGH = 'while [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"';
const userLine = (text: string): string => `${JSON.stringify({ type: "user", text })}\n`;
const shutdownLine = (): string => `${JSON.stringify({ type: "shutdown" })}\n`;

registerNoLeakedSignals();

describe("a --final session leaves nothing claimable", () => {
  test("the private directory is gone before the record reads ended (round 10, edges 4)", async () => {
    const root = tempWorkdir("drive-final");
    const regRoot = tempWorkdir("drive-final-reg");
    const home = tempWorkdir("drive-final-home");
    const registry = join(regRoot, "live-sessions.json");
    const workdir = join(root, "work");
    mkdirSync(workdir, { recursive: true });
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const stdin = new PassThrough();
    const configRoot = projectSettingsConfigRoot({ HOME: home });
    // What the directory looked like at the moment of each release call:
    // the driver's end path must have removed it already.
    const seenAtRelease: boolean[] = [];
    const realRelease = registryModule.releaseSessionRecord;
    const release = spyOn(registryModule, "releaseSessionRecord").mockImplementation((
      path: string,
      id: string,
      final = false
    ) => {
      seenAtRelease.push(existsSync(projectSettingsSessionDirPath(configRoot, id)));
      return realRelease(path, id, final);
    });
    try {
      const outcome = await runSessionCommand(
        [
          "-a", "claude", "--sandbox", "--hermetic",
          "--experiment-project-settings", "--auto", "low", "--final",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        { claude: `exec bun '${FAKE_CLAUDE}' "$@"`, scode: SCODE_PASSTHROUGH },
        {
          registryFile: registry,
          stdin,
          env: { HOME: home, FAKE_STATE_DIR: stateDir, FAKE_CWD: workdir },
          drive: async ({ chunks }) => {
            stdin.write(userLine("scenario:basic hello"));
            const started = await waitForEvent(chunks, "session_started", (event) => event.type === "session_started");
            // The private directory exists while the session runs.
            expect(existsSync(projectSettingsSessionDirPath(configRoot, started.session_id as string))).toBe(true);
            await waitForEvent(chunks, "turn_completed", (event) => event.type === "turn_completed");
            stdin.write(shutdownLine());
          },
        }
      );
      expect(outcome.exitCode).toBe(0);
      // The driver's end path released the record exactly once, and the
      // private directory was already gone at that moment.
      expect(seenAtRelease).toEqual([false]);
      const ended = outcome.stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, any>)
        .at(-1);
      expect(ended?.type).toBe("session_ended");
      expect(ended?.resumable).toBe(false);
      // The end stamp wrote non-resumable with the end: no window in
      // which the record reads ended and claimable.
      const record = JSON.parse(readFileSync(registry, "utf8")) as {
        sessions: Array<{ final?: boolean; ended?: string | null }>;
      };
      expect(record.sessions).toHaveLength(1);
      expect(record.sessions[0]?.final).toBe(true);
      expect(record.sessions[0]?.ended).toBeTruthy();
      // Nothing left on disk under the hermetic parent.
      const parent = join(configRoot, ".codemux-hermetic");
      expect(existsSync(parent) ? readdirSync(parent) : []).toEqual([]);
    } finally {
      release.mockRestore();
      rmSync(root, { recursive: true, force: true });
      rmSync(regRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("a --final removal that fails once is retried inside the end path and ends consistent (round 15, major)", async () => {
    const root = tempWorkdir("drive-final-fail");
    const regRoot = tempWorkdir("drive-final-fail-reg");
    const home = tempWorkdir("drive-final-fail-home");
    const registry = join(regRoot, "live-sessions.json");
    const workdir = join(root, "work");
    mkdirSync(workdir, { recursive: true });
    const stdin = new PassThrough();
    const configRoot = projectSettingsConfigRoot({ HOME: home });
    // The first removal of the private directory fails (an EPERM probe);
    // every later one runs for real, so the driver's in-end-path retry
    // succeeds.
    let failedOnce = false;
    const realRmSync = rmSync;
    const failingRemove = spyOn(fs, "rmSync").mockImplementation(((
      path: string,
      options: Parameters<typeof rmSync>[1]
    ) => {
      if (!failedOnce && String(path).includes(".codemux-hermetic")) {
        failedOnce = true;
        throw new Error("rm: permission denied (probe)");
      }
      return realRmSync(path as never, options as never);
    }) as typeof rmSync);
    try {
      const outcome = await runSessionCommand(
        [
          "-a", "claude", "--sandbox", "--hermetic",
          "--experiment-project-settings", "--auto", "low", "--final",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        { claude: `exec bun '${FAKE_CLAUDE}' "$@"`, scode: SCODE_PASSTHROUGH },
        {
          registryFile: registry,
          stdin,
          env: { HOME: home, FAKE_STATE_DIR: workdir, FAKE_CWD: workdir },
          drive: async ({ chunks }) => {
            stdin.write(userLine("scenario:basic hello"));
            await waitForEvent(chunks, "turn_completed", (event) => event.type === "turn_completed");
            stdin.write(shutdownLine());
          },
        }
      );
      // The whole removal sequence ran inside the driver's end path
      // (round 15, major): the first attempt failed, the in-end-path
      // retry removed the directory for real (remove() records success
      // only after rmSync), and only THEN the record was stamped and the
      // end event emitted — so the record, the event, the directory, and
      // the exit code all agree: final, not resumable, gone, 0. The old
      // shape (the CLI's finally deleting the directory while the record
      // stayed resumable) left the next resume refused on a missing
      // directory.
      expect(outcome.exitCode).toBe(0);
      const ended = outcome.stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, any>)
        .at(-1);
      expect(ended?.type).toBe("session_ended");
      expect(ended?.resumable).toBe(false);
      const record = JSON.parse(readFileSync(registry, "utf8")) as {
        sessions: Array<{ final?: boolean; ended?: string | null }>;
      };
      expect(record.sessions[0]?.final).toBe(true);
      expect(record.sessions[0]?.ended).toBeTruthy();
      // The first failure was reported naming the directory.
      expect(outcome.stderr).toContain("codemux: could not remove the session's private directory");
      expect(outcome.stderr).toContain("rm: permission denied (probe)");
      const parent = join(configRoot, ".codemux-hermetic");
      expect(existsSync(parent) ? readdirSync(parent) : []).toEqual([]);
    } finally {
      failingRemove.mockRestore();
      rmSync(root, { recursive: true, force: true });
      rmSync(regRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("a --final removal that fails twice exits 1 and keeps the record resumable (round 14, edges 3)", async () => {
    const root = tempWorkdir("drive-final-fail2");
    const regRoot = tempWorkdir("drive-final-fail2-reg");
    const home = tempWorkdir("drive-final-fail2-home");
    const registry = join(regRoot, "live-sessions.json");
    const workdir = join(root, "work");
    mkdirSync(workdir, { recursive: true });
    const stdin = new PassThrough();
    const configRoot = projectSettingsConfigRoot({ HOME: home });
    // Every removal of the private directory fails: both attempts of the
    // driver's in-end-path sequence alike; the CLI's finally must not add
    // a third (round 15, major).
    const realRmSync = rmSync;
    const failingRemove = spyOn(fs, "rmSync").mockImplementation(((
      path: string,
      options: Parameters<typeof rmSync>[1]
    ) => {
      if (String(path).includes(".codemux-hermetic")) {
        throw new Error("rm: permission denied (probe)");
      }
      return realRmSync(path as never, options as never);
    }) as typeof rmSync);
    let sessionDir: string | null = null;
    try {
      const outcome = await runSessionCommand(
        [
          "-a", "claude", "--sandbox", "--hermetic",
          "--experiment-project-settings", "--auto", "low", "--final",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        { claude: `exec bun '${FAKE_CLAUDE}' "$@"`, scode: SCODE_PASSTHROUGH },
        {
          registryFile: registry,
          stdin,
          env: { HOME: home, FAKE_STATE_DIR: workdir, FAKE_CWD: workdir },
          drive: async ({ chunks }) => {
            stdin.write(userLine("scenario:basic hello"));
            const started = await waitForEvent(chunks, "session_started", (event) => event.type === "session_started");
            sessionDir = projectSettingsSessionDirPath(configRoot, started.session_id as string);
            await waitForEvent(chunks, "turn_completed", (event) => event.type === "turn_completed");
            stdin.write(shutdownLine());
          },
        }
      );
      // The second failure is the process's last word: exit 1, raised by
      // the driver's end path itself.
      expect(outcome.exitCode).toBe(1);
      const ended = outcome.stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, any>)
        .at(-1);
      expect(ended?.type).toBe("session_ended");
      // The directory survived, so the record never forecloses a retry:
      // no final stamp, and the end event promises a resume.
      expect(ended?.resumable).toBe(true);
      const record = JSON.parse(readFileSync(registry, "utf8")) as {
        sessions: Array<{ final?: boolean; ended?: string | null }>;
      };
      expect(record.sessions[0]?.final).toBeFalsy();
      expect(record.sessions[0]?.ended).toBeTruthy();
      // Both failures were reported naming the kept directory.
      expect(outcome.stderr).toContain("codemux: could not remove the session's private directory");
      expect(outcome.stderr).toContain("the directory was kept");
      expect(existsSync(sessionDir!)).toBe(true);
    } finally {
      failingRemove.mockRestore();
      rmSync(root, { recursive: true, force: true });
      rmSync(regRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("a --resume --final whose spawn fails keeps the directory byte-identical and the record resumable (round 17, edges 1)", async () => {
    // The abort predicate used to honor --final outright, so any failure
    // between the open and the spawn deleted a resumed session's
    // transcript while the release left the record resumable: the next
    // resume was refused on a missing directory. Nothing ran, so --final
    // has nothing to remove; only the end path of a session that ran may.
    const home = realpathSync(mkdtempSync(join(tmpdir(), "codemux-final-spawn-home-")));
    const configRoot = projectSettingsConfigRoot({ HOME: home });
    const id = randomUUID();
    const dir = projectSettingsSessionDirPath(configRoot, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const transcript = join(dir, "transcript.jsonl");
    writeFileSync(transcript, '{"event":"prior turn"}\n', { mode: 0o600 });
    // Every file under the directory, its bytes and mode, before and after.
    const snapshot = (): string =>
      readdirSync(dir)
        .sort()
        .map((name) => `${name} ${statSync(join(dir, name)).mode} ${readFileSync(join(dir, name)).toString("hex")}`)
        .join("\n");
    const before = snapshot();
    const workdir = tempWorkdir("final-spawn");
    const regRoot = tempWorkdir("final-spawn-reg");
    const registry = join(regRoot, "live-sessions.json");
    seedRegistry(registry, [claudeRecord(id, workdir, {
      hermetic: true,
      project_settings: true,
      sandboxed: true,
      harness_home: dir,
      autonomy: "low",
      pass_env: [],
    })]);
    const failSpawn = spyOn(spawnModule, "spawnSessionChild").mockImplementation(() => {
      throw new Error("spawn probe failure");
    });
    try {
      const outcome = await runSessionCommand(
        ["-a", "claude", "--resume", id, "--cwd", workdir, "--auto", "low",
          "--hermetic", "--experiment-project-settings", "--final"],
        {
          claude: 'if [ "$1" = "--version" ]; then printf \'2.1.280\\n\'; exit 0; fi\nexit 7',
          scode: SCODE_PASSTHROUGH,
        },
        {
          registryFile: registry,
          env: { HOME: home, CODEMUX_NO_KEYCHAIN_SYNC: "1" },
        },
      );
      expect(outcome.exitCode).toBe(1);
      expect(outcome.stderr).toContain("spawn probe failure");
      // The transcript this resume exists to continue is untouched.
      expect(existsSync(dir)).toBe(true);
      expect(snapshot()).toBe(before);
      expect(readFileSync(transcript, "utf8")).toBe('{"event":"prior turn"}\n');
      // The released record reads ended and resumable, never final.
      const record = JSON.parse(readFileSync(registry, "utf8")) as {
        sessions: Array<{ final?: boolean; ended?: string | null }>;
      };
      expect(record.sessions).toHaveLength(1);
      expect(record.sessions[0]?.final).toBeFalsy();
      expect(record.sessions[0]?.ended).toBeTruthy();
    } finally {
      failSpawn.mockRestore();
      rmSync(home, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
      rmSync(regRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("a fresh --final session whose spawn fails still removes its directory (round 17, edges 1, symmetric case)", async () => {
    // The fresh arm of the same predicate: a fresh directory's record was
    // never confirmed, so nothing points at it and the abort removes it
    // with or without --final.
    const home = realpathSync(mkdtempSync(join(tmpdir(), "codemux-final-spawn-fresh-")));
    const configRoot = projectSettingsConfigRoot({ HOME: home });
    const workdir = tempWorkdir("final-spawn-fresh");
    const regRoot = tempWorkdir("final-spawn-fresh-reg");
    const registry = join(regRoot, "live-sessions.json");
    const failSpawn = spyOn(spawnModule, "spawnSessionChild").mockImplementation(() => {
      throw new Error("spawn probe failure");
    });
    try {
      const outcome = await runSessionCommand(
        ["-a", "claude", "--sandbox", "--hermetic",
          "--experiment-project-settings", "--auto", "low", "--final",
          "--cwd", workdir],
        {
          claude: 'if [ "$1" = "--version" ]; then printf \'2.1.280\\n\'; exit 0; fi\nexit 7',
          scode: SCODE_PASSTHROUGH,
        },
        {
          registryFile: registry,
          env: { HOME: home, CODEMUX_NO_KEYCHAIN_SYNC: "1" },
        },
      );
      expect(outcome.exitCode).toBe(1);
      // Nothing survives under the hermetic parent, and the unconfirmed
      // record is gone.
      const parent = join(configRoot, ".codemux-hermetic");
      expect(existsSync(parent) ? readdirSync(parent) : []).toEqual([]);
      const record = JSON.parse(readFileSync(registry, "utf8")) as {
        sessions: unknown[];
      };
      expect(record.sessions).toHaveLength(0);
    } finally {
      failSpawn.mockRestore();
      rmSync(home, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
      rmSync(regRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("a fresh session without --final whose spawn fails removes its unreferenced directory (review round 46)", async () => {
    // The record was discarded as unconfirmed, so nothing points at the
    // private directory: keeping it would leave copied credentials on disk
    // for no resume to find.
    const home = realpathSync(mkdtempSync(join(tmpdir(), "codemux-nonfinal-spawn-fresh-")));
    const configRoot = projectSettingsConfigRoot({ HOME: home });
    const workdir = tempWorkdir("nonfinal-spawn-fresh");
    const regRoot = tempWorkdir("nonfinal-spawn-fresh-reg");
    const registry = join(regRoot, "live-sessions.json");
    const failSpawn = spyOn(spawnModule, "spawnSessionChild").mockImplementation(() => {
      throw new Error("spawn probe failure");
    });
    try {
      const outcome = await runSessionCommand(
        ["-a", "claude", "--sandbox", "--hermetic",
          "--experiment-project-settings", "--auto", "low",
          "--cwd", workdir],
        {
          claude: 'if [ "$1" = "--version" ]; then printf \'2.1.280\\n\'; exit 0; fi\nexit 7',
          scode: SCODE_PASSTHROUGH,
        },
        {
          registryFile: registry,
          env: { HOME: home, CODEMUX_NO_KEYCHAIN_SYNC: "1" },
        },
      );
      expect(outcome.exitCode).toBe(1);
      const parent = join(configRoot, ".codemux-hermetic");
      expect(existsSync(parent) ? readdirSync(parent) : []).toEqual([]);
      const record = JSON.parse(readFileSync(registry, "utf8")) as { sessions: unknown[] };
      expect(record.sessions).toHaveLength(0);
    } finally {
      failSpawn.mockRestore();
      rmSync(home, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
      rmSync(regRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("a --resume --final refused at the quota gate stays ended, not final (round 16, edges 1)", async () => {
    // The claim used to record the --final stamp at claim time, so a
    // refusal inside the launch preparation — the quota gate runs after
    // the claim and before anything is opened — released the record as
    // final: every future resume refused as final while the transcript
    // stayed on disk. The abort release never stamps final; only the
    // driver's end path does, after it actually removed the directory.
    const home = realpathSync(mkdtempSync(join(tmpdir(), "codemux-final-quota-home-")));
    const configRoot = join(home, ".claude");
    mkdirSync(configRoot, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const dir = projectSettingsSessionDirPath(projectSettingsConfigRoot({ HOME: home }), id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const transcript = join(dir, "transcript.jsonl");
    writeFileSync(transcript, "{}\n", { mode: 0o600 });
    const workdir = tempWorkdir("final-quota");
    const regRoot = tempWorkdir("final-quota-reg");
    const registry = join(regRoot, "live-sessions.json");
    seedRegistry(registry, [claudeRecord(id, workdir, {
      hermetic: true,
      project_settings: true,
      sandboxed: true,
      harness_home: dir,
      autonomy: "low",
      pass_env: [],
    })]);
    // A usagemux that answers 3 percent left on the primary window: the
    // gate refuses inside the launch preparation, after the claim, before
    // any spawn. (A weekly-named pool alone no longer refuses — audit
    // round 2, B1 — so the refusal window is the primary one.)
    const snapshot = JSON.stringify({
      schemaVersion: "1",
      generatedAt: new Date().toISOString(),
      results: [{
        client: "claude", provider: "claude", status: "ok", source: null, plan: null,
        account: null, credits: null, subscriptionRenewsAt: null, subscriptionExpiresAt: null,
        message: null,
        windows: [{
          kind: "primary", usedPercent: 97, remainingPercent: 3, windowMinutes: 10_080,
          resetsAt: "2026-11-07T09:00:00.000Z",
        }],
      }],
    });
    try {
      const outcome = await runSessionCommand(
        ["-a", "claude", "--resume", id, "--cwd", workdir, "--auto", "low",
          "--hermetic", "--experiment-project-settings", "--final",
          "--quota-ceiling", "10"],
        {
          claude: 'if [ "$1" = "--version" ]; then printf \'2.1.280\\n\'; exit 0; fi\nexit 7',
          scode: SCODE_PASSTHROUGH,
          usagemux: `printf '%s' '${snapshot}'`,
        },
        {
          registryFile: registry,
          quotaGate: true,
          env: { HOME: home, CODEMUX_NO_KEYCHAIN_SYNC: "1" },
        },
      );
      expect(outcome.exitCode).toBe(64);
      expect(outcome.stderr).toContain("quota gate: claude");
      // The record reads ended and claimable, never final: the next
      // --resume is judged on its own merits instead of refused forever.
      const record = JSON.parse(readFileSync(registry, "utf8")) as {
        sessions: Array<{ final?: boolean; ended?: string | null }>;
      };
      expect(record.sessions).toHaveLength(1);
      expect(record.sessions[0]?.final).toBeFalsy();
      expect(record.sessions[0]?.ended).toBeTruthy();
      // The directory the refusal never removed is intact.
      expect(existsSync(dir)).toBe(true);
      expect(readFileSync(transcript, "utf8")).toBe("{}\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
      rmSync(regRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

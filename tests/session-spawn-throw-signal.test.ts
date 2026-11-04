/**
 * The spawn-throw catch once the abort's end path already began (round
 * 20, minor 8): a signal lands while the long-lived spawn is still in
 * its preflight, and the spawn then throws. The catch must hand the
 * ending to the already-begun end path — session_ended emitted, the
 * record released or discarded inside that path's own ordering — instead
 * of releasing the record itself and rethrowing past a still-draining
 * end path, which exits the process hard before session_ended and
 * before a --final removal that was about to run.
 */

import { expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as cliDrivers from "../src/session/cli-drivers.js";
import * as spawnModule from "../src/session/spawn.js";
import { SESSION_SIGNAL_EXIT_CODE } from "../src/session/process.js";
import { runSessionCommand, tempWorkdir, removeDir } from "./helpers/session-command.js";
import { registerNoLeakedSignals } from "./helpers/signal-listeners.js";
import { projectSettingsConfigRoot } from "../src/claude-project-config.js";

registerNoLeakedSignals();

// --version answers the contract's floor; the spawn itself is mocked, so
// no other invocation ever runs.
const FAKE_CLAUDE = `if [ "$1" = "--version" ]; then printf '2.1.280\\n'; exit 0; fi
exit 7`;

/** Stubs the long-lived spawn: the signal is sent while it is "in
 * preflight", the end path's start is confirmed through the driver, and
 * only then does the spawn throw — the ordering the catch must handle. */
const signalThenThrow = (): (() => void) => {
  let built: ReturnType<typeof cliDrivers.createSessionDriver> | null = null;
  const originalCreate = cliDrivers.createSessionDriver;
  const drivers = spyOn(cliDrivers, "createSessionDriver").mockImplementation((...args) => {
    built = originalCreate(...args);
    return built;
  });
  const spawn = spyOn(spawnModule, "spawnSessionChild").mockImplementation(async () => {
    const driver = built?.driver ?? null;
    // The signal the gate routes to finish("signal", 143); the driver is
    // built, so the gate is installed and the signal cannot kill the
    // test process.
    process.kill(process.pid, "SIGTERM");
    // Prove the end path began (its late-child hold is armed) before the
    // spawn fails, so the catch's decision is the one under test. Every
    // long-lived-child driver reports it (round 65), not only claude's.
    const deadline = Date.now() + 5_000;
    while (!(driver?.endPathStarted?.() ?? false) && Date.now() < deadline) {
      await Bun.sleep(5);
    }
    throw new Error("spawn blew up");
  });
  return () => {
    spawn.mockRestore();
    drivers.mockRestore();
  };
};

test("a spawn that throws after a signal ends through the end path, once (round 20, minor 8)", async () => {
  const workdir = tempWorkdir("session-spawn-throw-signal-");
  const registryRoot = tempWorkdir("session-spawn-throw-signal-reg-");
  const registryFile = join(registryRoot, "live-sessions.json");
  try {
    const outcome = await runSessionCommand(
      ["-a", "claude", "--cwd", workdir, "--no-sandbox", "--auto", "high"],
      { claude: FAKE_CLAUDE },
      { registryFile, setup: signalThenThrow }
    );
    // No hard exit: the action returns through the session's own code,
    // so the end path's verdict is the command's verdict.
    expect(outcome.exitCalls).toEqual([]);
    expect(outcome.exitCode).toBe(SESSION_SIGNAL_EXIT_CODE);
    // session_ended was emitted — exactly once, as the final event.
    const events = outcome.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const ended = events.filter((event) => event.type === "session_ended");
    expect(ended).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("session_ended");
    expect(ended[0]?.exit_code).toBe(SESSION_SIGNAL_EXIT_CODE);
    // The spawn failure itself is still reported, on stderr.
    expect(outcome.stderr).toContain("spawn blew up");
    // The fresh record was discarded exactly once, by the end path: the
    // registry holds no session the failed spawn would have run.
    const registry = JSON.parse(readFileSync(registryFile, "utf8")) as {
      sessions: Array<{ id: string; ended?: string | null }>;
    };
    expect(registry.sessions).toHaveLength(0);
  } finally {
    removeDir(workdir);
    removeDir(registryRoot);
  }
}, 20_000);

// The codex and agy drivers gained the late-child hold in round 64, but
// the spawn-throw catch still handed only claude's ending to its end
// path: the codex and agy catch released the record and rethrew while
// the signal's end path was still draining (round 65).
const FAKE_CODEX = `if [ "$1" = "--version" ]; then printf 'codex-cli 0.159.3\\n'; exit 0; fi
exit 7`;
const FAKE_AGY = `if [ "$1" = "--version" ]; then printf '1.2.14\\n'; exit 0; fi
exit 7`;

for (const [agent, fake] of [["codex", FAKE_CODEX], ["agy", FAKE_AGY]] as const) {
  test(`a ${agent} spawn that throws after a signal ends through the end path, once (round 65)`, async () => {
    const workdir = tempWorkdir(`session-spawn-throw-signal-${agent}-`);
    const registryRoot = tempWorkdir(`session-spawn-throw-signal-${agent}-reg-`);
    const registryFile = join(registryRoot, "live-sessions.json");
    try {
      const outcome = await runSessionCommand(
        ["-a", agent, "--cwd", workdir, "--no-sandbox", "--auto", "high"],
        { [agent]: fake },
        { registryFile, setup: signalThenThrow }
      );
      expect(outcome.exitCalls).toEqual([]);
      expect(outcome.exitCode).toBe(SESSION_SIGNAL_EXIT_CODE);
      const events = outcome.stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const ended = events.filter((event) => event.type === "session_ended");
      expect(ended).toHaveLength(1);
      expect(events.at(-1)?.type).toBe("session_ended");
      expect(ended[0]?.exit_code).toBe(SESSION_SIGNAL_EXIT_CODE);
      expect(outcome.stderr).toContain("spawn blew up");
      expect(outcome.stderr).toContain("already-begun end path");
      // codex records its session only once the thread starts, so the
      // registry may not exist; when it does, nothing survived the spawn.
      if (existsSync(registryFile)) {
        const registry = JSON.parse(readFileSync(registryFile, "utf8")) as { sessions: unknown[] };
        expect(registry.sessions).toHaveLength(0);
      }
    } finally {
      removeDir(workdir);
      removeDir(registryRoot);
    }
  }, 20_000);
}

test("a spawn that throws with no end path begun still exits through the refusal (round 20, minor 8, symmetric case)", async () => {
  const workdir = tempWorkdir("session-spawn-throw-quiet-");
  const registryRoot = tempWorkdir("session-spawn-throw-quiet-reg-");
  const registryFile = join(registryRoot, "live-sessions.json");
  try {
    const outcome = await runSessionCommand(
      ["-a", "claude", "--cwd", workdir, "--no-sandbox", "--auto", "high"],
      { claude: FAKE_CLAUDE },
      {
        registryFile,
        setup: () => {
          // No signal this time: the catch's old release-and-rethrow path
          // is the correct one, and it must still work.
          const spawn = spyOn(spawnModule, "spawnSessionChild").mockImplementation(async () => {
            throw new Error("spawn blew up");
          });
          return () => spawn.mockRestore();
        },
      }
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("spawn blew up");
    const events = outcome.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.filter((event) => event.type === "session_ended")).toHaveLength(0);
    const registry = JSON.parse(readFileSync(registryFile, "utf8")) as {
      sessions: Array<{ id: string }>;
    };
    expect(registry.sessions).toHaveLength(0);
  } finally {
    removeDir(workdir);
    removeDir(registryRoot);
  }
}, 20_000);

const SCODE_PASSTHROUGH = 'while [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"';

test("a signal-begun end path after a spawn throw removes a fresh project-settings directory without --final (review round 47)", async () => {
  // The record is discarded as unconfirmed inside that end path, so the
  // private directory with its copied credentials is referenced by nothing.
  const workdir = tempWorkdir("session-spawn-throw-signal-ps-");
  const registryRoot = tempWorkdir("session-spawn-throw-signal-ps-reg-");
  const home = tempWorkdir("session-spawn-throw-signal-ps-home-");
  const registryFile = join(registryRoot, "live-sessions.json");
  try {
    const outcome = await runSessionCommand(
      ["-a", "claude", "--cwd", workdir, "--sandbox", "--auto", "low", "--hermetic", "--experiment-project-settings"],
      { claude: FAKE_CLAUDE, scode: SCODE_PASSTHROUGH },
      { registryFile, setup: signalThenThrow, env: { HOME: home, CODEMUX_NO_KEYCHAIN_SYNC: "1" } }
    );
    expect(outcome.stderr).toContain("spawn blew up");
    const parent = join(projectSettingsConfigRoot({ HOME: home }), ".codemux-hermetic");
    expect(existsSync(parent) ? readdirSync(parent) : []).toEqual([]);
    const registry = JSON.parse(readFileSync(registryFile, "utf8")) as { sessions: unknown[] };
    expect(registry.sessions).toHaveLength(0);
  } finally {
    removeDir(workdir);
    removeDir(registryRoot);
    removeDir(home);
  }
}, 20_000);

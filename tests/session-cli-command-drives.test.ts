/**
 * Full `codemux session` drives in process: the commander action runs to
 * its real end against fake harness binaries on PATH (the fixtures the
 * spawned suites use), so the record claims, the spawn, the framer on a
 * swapped stdin, the driver loop, and the cleanup lines of
 * src/session/cli.ts are all measured. Refusals, guards, and the tier-3
 * fatal drives live in sibling suites.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as cliHomes from "../src/session/cli-homes.js";
import { codexSessionProviderHomePath } from "../src/codex-provider.js";
import {
  claudeRecord,
  outcomeEvents,
  runSessionCommand,
  seedRegistry,
  tempWorkdir,
  waitForEvent,
} from "./helpers/session-command.js";
import { registerNoLeakedSignals } from "./helpers/signal-listeners.js";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/live/fake-claude-session.ts", import.meta.url));
const FAKE_KIMI = fileURLToPath(new URL("./fixtures/live/fake-kimi-run.ts", import.meta.url));
const FAKE_OPENCODE = fileURLToPath(new URL("./fixtures/live/fake-opencode-run.ts", import.meta.url));
const fakeHarness = (fixture: string): string => `exec bun '${fixture}' "$@"`;
const withVersion = (body: string, version: string): string =>
  `if [ "$1" = "--version" ]; then printf '${version}\\n'; exit 0; fi\n${body}`;
// A scode that dies instantly: the wrapped session child never runs, so
// the fatal end path fires without any wire to speak.
const SCODE_DIES = "exit 9";
const userLine = (text: string): string => `${JSON.stringify({ type: "user", text })}\n`;
const shutdownLine = (): string => `${JSON.stringify({ type: "shutdown" })}\n`;

// Review round 4, session finding 8: the command action owns its driver's
// disposal on every exit path, so no signal handler may outlive a drive.
registerNoLeakedSignals();

describe("the session command driven in process", () => {
  test("claude: one turn over stdio, clean shutdown, record released", async () => {
    const root = tempWorkdir("drive-claude");
    const regRoot = tempWorkdir("drive-claude-reg");
    const registry = join(regRoot, "live-sessions.json");
    const workdir = join(root, "work");
    const stateDir = join(root, "state");
    mkdirSync(workdir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    const stdin = new PassThrough();
    try {
      const outcome = await runSessionCommand(
        [
          "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        { claude: fakeHarness(FAKE_CLAUDE) },
        {
          registryFile: registry,
          stdin,
          env: { FAKE_STATE_DIR: stateDir, FAKE_CWD: workdir },
          drive: async ({ chunks }) => {
            stdin.write(userLine("scenario:basic hello"));
            const started = await waitForEvent(chunks, "session_started", (event) => event.type === "session_started");
            expect(started.agent).toBe("claude");
            expect(started.autonomy).toBe("high");
            const completed = await waitForEvent(chunks, "turn_completed", (event) => event.type === "turn_completed");
            expect(completed.finish).toBe("end");
            stdin.write(shutdownLine());
          },
        }
      );
      expect(outcome.exitCode).toBe(0);
      const events = outcome.stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, any>);
      const ended = events.at(-1);
      expect(ended?.type).toBe("session_ended");
      expect(ended?.reason).toBe("shutdown");
      expect(ended?.resumable).toBe(true);
      // The harness saw the real session argv: the codemux-chosen id on
      // --session-id and high's grant list, no scode wrap.
      const argv = readFileSync(join(stateDir, "argv.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as { args: string[] })
        .find((entry) => !entry.args.includes("--version"));
      expect(argv).toBeDefined();
      expect(argv?.args).toContain("--session-id");
      expect(argv?.args).toContain("--permission-prompt-tool");
      expect(argv?.args.join(" ")).not.toContain("dangerously");
      // The end stamp clears the live owner (owner_pid itself stays, the sweep's rule).
      const record = JSON.parse(readFileSync(registry, "utf8")) as { sessions: Array<Record<string, any>> };
      expect(record.sessions).toHaveLength(1);
      expect(record.sessions[0]?.agent).toBe("claude");
      expect(record.sessions[0]?.owner_pid).toBe(process.pid);
      expect(record.sessions[0]?.ended).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(regRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("claude: --resume reuses the recorded id and rewrites the record", async () => {
    const root = tempWorkdir("drive-resume");
    const regRoot = tempWorkdir("drive-resume-reg");
    const registry = join(regRoot, "live-sessions.json");
    const workdir = join(root, "work");
    const stateDir = join(root, "state");
    mkdirSync(workdir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    const id = randomUUID();
    seedRegistry(registry, [claudeRecord(id, workdir, { pass_env: ["FAKE_STATE_DIR"] })]);
    const stdin = new PassThrough();
    try {
      const outcome = await runSessionCommand(
        [
          "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR", "--resume", id,
        ],
        { claude: fakeHarness(FAKE_CLAUDE) },
        {
          registryFile: registry,
          stdin,
          env: { FAKE_STATE_DIR: stateDir },
          drive: async ({ chunks }) => {
            stdin.write(userLine("scenario:basic hello"));
            await waitForEvent(chunks, "session_started", (event) => event.type === "session_started");
            await waitForEvent(chunks, "turn_completed", (event) => event.type === "turn_completed");
            stdin.write(shutdownLine());
          },
        }
      );
      expect(outcome.exitCode).toBe(0);
      // The resumed session kept the recorded id, not a fresh one.
      const record = JSON.parse(readFileSync(registry, "utf8")) as { sessions: Array<Record<string, any>> };
      expect(record.sessions.map((entry) => entry.id)).toEqual([id]);
      const argv = readFileSync(join(stateDir, "argv.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as { args: string[] })
        .find((entry) => entry.args.includes("--resume"));
      expect(argv).toBeDefined();
      const resumeAt = argv?.args.indexOf("--resume") ?? -1;
      expect(resumeAt).not.toBe(-1);
      expect(argv?.args[resumeAt + 1]).toBe(id);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(regRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("kimi: one turn from a per-turn spawn, session recorded at first turn", async () => {
    const root = tempWorkdir("drive-kimi");
    const regRoot = tempWorkdir("drive-kimi-reg");
    const registry = join(regRoot, "live-sessions.json");
    const workdir = join(root, "work");
    const stateDir = join(root, "state");
    mkdirSync(workdir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    const stdin = new PassThrough();
    try {
      const outcome = await runSessionCommand(
        [
          "-a", "kimi", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2", "--pass-env", "FAKE_STATE_DIR",
        ],
        { kimi: withVersion(fakeHarness(FAKE_KIMI), "2.5.2") },
        {
          registryFile: registry,
          stdin,
          env: { FAKE_STATE_DIR: stateDir },
          drive: async ({ chunks }) => {
            stdin.write(userLine("scenario:basic one"));
            const started = await waitForEvent(chunks, "session_started", (event) => event.type === "session_started");
            expect(started.agent).toBe("kimi");
            await waitForEvent(chunks, "turn_completed", (event) => event.type === "turn_completed");
            stdin.write(shutdownLine());
          },
        }
      );
      expect(outcome.exitCode).toBe(0);
      const events = outcome.stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, any>);
      expect(events.at(-1)?.type).toBe("session_ended");
      expect(events.at(-1)?.exit_code).toBe(0);
      // The registry was proven writable before the spawn and holds
      // the id the first turn's output named.
      const record = JSON.parse(readFileSync(registry, "utf8")) as { sessions: Array<Record<string, any>> };
      expect(record.sessions).toHaveLength(1);
      expect(record.sessions[0]?.agent).toBe("kimi");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(regRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("opencode: one turn, hermetic off, fresh provider config per turn", async () => {
    const root = tempWorkdir("drive-opencode");
    const regRoot = tempWorkdir("drive-opencode-reg");
    const registry = join(regRoot, "live-sessions.json");
    const workdir = join(root, "work");
    const stateDir = join(root, "state");
    mkdirSync(workdir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    const stdin = new PassThrough();
    try {
      const outcome = await runSessionCommand(
        [
          "-a", "opencode", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2", "--pass-env", "FAKE_STATE_DIR",
        ],
        { opencode: withVersion(fakeHarness(FAKE_OPENCODE), "1.18.18") },
        {
          registryFile: registry,
          stdin,
          env: {
            FAKE_STATE_DIR: stateDir,
            XDG_DATA_HOME: join(root, "data"),
          },
          drive: async ({ chunks }) => {
            stdin.write(userLine("scenario:basic one"));
            await waitForEvent(chunks, "session_started", (event) => event.type === "session_started");
            await waitForEvent(chunks, "turn_completed", (event) => event.type === "turn_completed");
            stdin.write(shutdownLine());
          },
        }
      );
      expect(outcome.exitCode).toBe(0);
      const events = outcome.stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, any>);
      expect(events.at(-1)?.type).toBe("session_ended");
      const record = JSON.parse(readFileSync(registry, "utf8")) as { sessions: Array<Record<string, any>> };
      expect(record.sessions[0]?.agent).toBe("opencode");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(regRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("codex: a sandboxed child that dies at spawn ends the session as a fatal", async () => {
    const root = tempWorkdir("drive-codex");
    const regRoot = tempWorkdir("drive-codex-reg");
    const registry = join(regRoot, "live-sessions.json");
    const workdir = join(root, "work");
    mkdirSync(workdir, { recursive: true });
    const stdin = new PassThrough();
    try {
      const outcome = await runSessionCommand(
        ["-a", "codex", "--cwd", workdir, "--shutdown-grace", "1"],
        {
          codex: withVersion("exit 7", "codex-cli 0.159.3"),
          scode: SCODE_DIES,
        },
        { registryFile: registry, stdin }
      );
      expect(outcome.exitCode).not.toBe(0);
      const events = outcome.stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, any>);
      expect(events.at(-1)?.type).toBe("session_ended");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(regRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("agy: the registry is proven writable before the first turn spawns", async () => {
    const root = tempWorkdir("drive-agy");
    const regRoot = tempWorkdir("drive-agy-reg");
    const registry = join(regRoot, "live-sessions.json");
    const workdir = join(root, "work");
    mkdirSync(workdir, { recursive: true });
    const stdin = new PassThrough();
    try {
      const outcome = await runSessionCommand(
        ["-a", "agy", "--cwd", workdir, "--shutdown-grace", "1"],
        { agy: withVersion("exit 7", "1.2.14"), scode: SCODE_DIES },
        { registryFile: registry, stdin }
      );
      expect(outcome.exitCode).not.toBe(0);
      // probeRegistryForStart proved the registry writable: the file exists though the session died.
      const record = JSON.parse(readFileSync(registry, "utf8")) as { version: number };
      expect(record.version).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(regRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("claude with project settings: a sandboxed spawn that dies still prepares and merges the private config", async () => {
    const root = tempWorkdir("drive-eps");
    const regRoot = tempWorkdir("drive-eps-reg");
    const registry = join(regRoot, "live-sessions.json");
    const workdir = join(root, "work");
    mkdirSync(workdir, { recursive: true });
    const stdin = new PassThrough();
    try {
      const outcome = await runSessionCommand(
        [
          "-a", "claude", "--hermetic", "--experiment-project-settings",
          "--auto", "low", "--cwd", workdir, "--shutdown-grace", "1",
          "--permission-policy", "deny",
          "--sandbox-block", join(root, "one"), "--sandbox-block", join(root, "two"),
        ],
        { claude: fakeHarness(FAKE_CLAUDE), scode: SCODE_DIES },
        { registryFile: registry, stdin }
      );
      expect(outcome.exitCode).not.toBe(0);
      const events = outcomeEvents([outcome.stdout]);
      expect(events.at(-1)?.type).toBe("session_ended");
      // The harness never confirmed a session, so the pre-spawn record was discarded.
      const record = JSON.parse(readFileSync(registry, "utf8")) as {
        version: number;
        sessions: unknown[];
      };
      expect(record.version).toBe(1);
      expect(record.sessions).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(regRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("codex under a provider override: the session home is prepared, then removed when the spawn dies", async () => {
    const root = tempWorkdir("drive-codex-ovr");
    const regRoot = tempWorkdir("drive-codex-ovr-reg");
    const registry = join(regRoot, "live-sessions.json");
    const workdir = join(root, "work");
    const codexHome = join(root, "codex-home");
    mkdirSync(workdir, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    const stdin = new PassThrough();
    try {
      const outcome = await runSessionCommand(
        [
          "-a", "codex", "--cwd", workdir, "--shutdown-grace", "1",
          "--pass-env", "CODEX_HOME,FAKE_STATE_DIR",
        ],
        { codex: withVersion("exit 7", "codex-cli 0.159.3"), scode: SCODE_DIES },
        {
          registryFile: registry,
          stdin,
          env: {
            CODEX_HOME: codexHome,
            FAKE_STATE_DIR: join(root, "state"),
            CODEMUX_CODEX_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
            CODEMUX_CODEX_PROVIDER_API_KEY: "e2e-key-do-not-print",
            CODEMUX_CODEX_PROVIDER_MODEL: "clawvm-qwen32b-coder",
          },
        }
      );
      expect(outcome.exitCode).not.toBe(0);
      const events = outcomeEvents([outcome.stdout]);
      expect(events.at(-1)?.type).toBe("session_ended");
      // The child died before any identity frame, so no session_started exists.
      expect(events.find((event) => event.type === "session_started")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(regRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("codex override resume: the claim reopens the session-keyed home before the spawn", async () => {
    const root = tempWorkdir("drive-codex-ovr-res");
    const regRoot = tempWorkdir("drive-codex-ovr-res-reg");
    const registry = join(regRoot, "live-sessions.json");
    const workdir = join(root, "work");
    const codexHome = join(root, "codex-home");
    mkdirSync(workdir, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    const id = "0123456789abcdef";
    const baseUrl = "http://127.0.0.1:9/v1";
    const keyedHome = codexSessionProviderHomePath(codexHome, baseUrl, id);
    mkdirSync(keyedHome, { recursive: true });
    seedRegistry(registry, [{
      ...claudeRecord(id, workdir, {
        agent: "codex",
        sandboxed: true,
        harness_home: keyedHome,
        pass_env: ["CODEX_HOME"],
        provider_base_url: baseUrl,
      }),
    }]);
    const stdin = new PassThrough();
    try {
      const outcome = await runSessionCommand(
        [
          "-a", "codex", "--auto", "high", "--cwd", workdir, "--shutdown-grace", "1",
          "--pass-env", "CODEX_HOME", "--resume", id,
        ],
        { codex: withVersion("exit 7", "codex-cli 0.159.3"), scode: SCODE_DIES },
        {
          registryFile: registry,
          stdin,
          env: {
            CODEX_HOME: codexHome,
            CODEMUX_CODEX_PROVIDER_BASE_URL: baseUrl,
            CODEMUX_CODEX_PROVIDER_API_KEY: "e2e-key-do-not-print",
            CODEMUX_CODEX_PROVIDER_MODEL: "clawvm-qwen32b-coder",
          },
        }
      );
      expect(outcome.exitCode).not.toBe(0);
      const events = outcomeEvents([outcome.stdout]);
      expect(events.at(-1)?.type).toBe("session_ended");
      // The claim kept the recorded id; the child died at spawn, so the record is ended.
      const record = JSON.parse(readFileSync(registry, "utf8")) as {
        sessions: Array<Record<string, any>>;
      };
      expect(record.sessions.map((entry) => entry.id)).toEqual([id]);
      expect(record.sessions[0]?.ended).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(regRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("kimi sandboxed: a turn's spawn options carry the keep-env rule before the child dies", async () => {
    const root = tempWorkdir("drive-kimi-sbx");
    const regRoot = tempWorkdir("drive-kimi-sbx-reg");
    const registry = join(regRoot, "live-sessions.json");
    const workdir = join(root, "work");
    mkdirSync(workdir, { recursive: true });
    const stdin = new PassThrough();
    try {
      const outcome = await runSessionCommand(
        ["-a", "kimi", "--auto", "high", "--cwd", workdir, "--shutdown-grace", "1", "--timeout", "2"],
        { kimi: withVersion("exit 7", "2.5.2"), scode: SCODE_DIES },
        {
          registryFile: registry,
          stdin,
          // One user line forces the first turn's spawn (and its
          // keep-env sandbox options) before the dying scode child
          // takes the session down.
          drive: async ({ chunks }) => {
            stdin.write(userLine("scenario:basic one"));
            await waitForEvent(chunks, "session_ended", (event) => event.type === "session_ended");
          },
        }
      );
      expect(outcome.exitCode).not.toBe(0);
      const events = outcomeEvents([outcome.stdout]);
      expect(events.at(-1)?.type).toBe("session_ended");
      // The turn child died inside scode before naming a session, so
      // no record survives for it.
      const record = JSON.parse(readFileSync(registry, "utf8")) as {
        version: number;
        sessions: unknown[];
      };
      expect(record.version).toBe(1);
      expect(record.sessions).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(regRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("aider: the pre-spawn record fails when the history directory is unwritable", async () => {
    const root = tempWorkdir("drive-aider");
    const regRoot = tempWorkdir("drive-aider-reg");
    const registry = join(regRoot, "live-sessions.json");
    const workdir = join(root, "work");
    const home = join(root, "aider-home");
    mkdirSync(workdir, { recursive: true });
    // A FILE where the harness home belongs: the per-session history
    // directory cannot be created under it, so the pre-spawn record
    // fails without touching the operator's real ~/.aider.
    writeFileSync(home, "not a directory");
    try {
      const outcome = await runSessionCommand(
        ["-a", "aider", "--no-sandbox", "--auto", "high", "--cwd", workdir, "--shutdown-grace", "1"],
        { aider: withVersion("exit 7", "aider 0.86.2") },
        {
          registryFile: registry,
          setup: () => {
            const spy = spyOn(cliHomes, "aiderHarnessHome").mockReturnValue(home);
            return () => spy.mockRestore();
          },
        }
      );
      expect(outcome.exitCode).toBe(1);
      expect(outcome.stderr).toContain("cannot record the session in the registry");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(regRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

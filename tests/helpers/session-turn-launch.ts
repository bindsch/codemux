/** The launcher-level rig for the turn-per-process session agents: the
 * seven second-wave drivers (cursor, droid, pi, qwen, gemini, copilot,
 * goose) and hermetic aider, driven through the real `codemux session`
 * command (tests/helpers/session-command.ts) over the scenario fakes
 * (tests/fixtures/live/fake-*-session.ts, fake-aider-run.ts) on a fake
 * PATH. Mirrors tests/helpers/session-cli-hermetic.ts for the codex/kimi/
 * agy family: one fixture home, the scode recording shim, the preloaded
 * observer (session-turn-launch-observe.ts) that proves every turn of a
 * session ran inside the same private home, and the registry the command
 * records into. */

import { spyOn } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { SESSION_AGENTS } from "../../src/session/cli-agents.js";
import { resolveSessionContext } from "../../src/session/cli-resume.js";
import * as cliHomes from "../../src/session/cli-homes.js";
import * as processTable from "../../src/process-table.js";
import { providerOverrideEnvNames, type ProviderOverride } from "../../src/provider-override.js";
import * as registry from "../../src/session/registry.js";
import { TURN_AGENT_PROFILES } from "../../src/session/turn-driver-launch.js";
import {
  outcomeEvents, removeDir, runSessionCommand, tempWorkdir, waitForEvent,
  type SessionRunOptions,
} from "./session-command.js";

export type TurnLaunchAgent =
  | "cursor" | "droid" | "pi" | "qwen" | "gemini" | "copilot" | "goose" | "aider";
export const TURN_LAUNCH_AGENTS: TurnLaunchAgent[] = [
  "cursor", "droid", "pi", "qwen", "gemini", "copilot", "goose", "aider",
];
/** The agents whose hermetic session owns a private home (qwen keeps
 * none — safe mode is its whole hermetic claim; cursor is not
 * hermetic-capable). */
export const HOME_AGENTS: TurnLaunchAgent[] = ["droid", "pi", "gemini", "copilot", "goose", "aider"];
export const PASS_ENV = ["FAKE_STATE_DIR", "CODEMUX_TEST_SCODE_ARGV"];
/** The version probe's reply, in each adapter's contract spelling
 * (src/harness-contracts.ts): copilot answers --binary-version with the
 * "Copilot binary version:" line, aider's pattern wants the name prefix,
 * and the rest print the bare calendar or semver build. */
const versionReplies = {
  cursor: "2026.11.05", droid: "0.221.0", pi: "0.85.1", qwen: "0.24.0",
  gemini: "0.60.0", copilot: "Copilot binary version: 1.0.85", goose: "1.50.1",
  aider: "aider 0.86.2",
};
/** The fake PATH binary's name: cursor resolves through the standalone
 * `cursor-agent` the adapter prefers (adapters/cursor.ts). */
const binaryName = (agent: TurnLaunchAgent): string =>
  agent === "cursor" ? "cursor-agent" : agent;
const fixtures = {
  cursor: "fake-cursor-session.ts", droid: "fake-droid-session.ts",
  pi: "fake-pi-session.ts", qwen: "fake-qwen-session.ts",
  gemini: "fake-gemini-session.ts", copilot: "fake-copilot-session.ts",
  goose: "fake-goose-session.ts", aider: "fake-aider-run.ts",
};
/** The brand state root under the fixture home each agent records as its
 * plain harness home (turn-driver-homes.ts turnAgentStateRoot;
 * cli-homes.ts aiderHarnessHome). */
export const stateRoot = (home: string, agent: TurnLaunchAgent): string => {
  switch (agent) {
    case "cursor": return join(home, ".cursor");
    case "droid": return join(home, ".factory");
    case "pi": return join(home, ".pi", "agent");
    // QWEN_HOME routes qwen's brand home into the fixture (the adapter's
    // own resolver honors the variable; homedir() is never consulted).
    case "qwen": return join(home, ".qwen");
    case "gemini": return join(home, ".gemini");
    case "copilot": return join(home, ".copilot");
    case "goose": return join(home, ".config", "goose");
    case "aider": return join(home, ".aider");
  }
};
const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

export interface TurnHomeObservation {
  home: string;
  piDir: string | null;
  geminiHome: string | null;
  copilotHome: string | null;
  gooseRoot: string | null;
  redirected: string;
  mode: number | null;
  previous: string | null;
  state: string | null;
}

export function turnLaunchFixture(agent: TurnLaunchAgent) {
  const root = tempWorkdir(`turn-launch-${agent}`);
  const home = join(root, "home");
  const workdir = join(root, "work");
  const state = join(root, "state");
  const registryFile = join(home, ".codemux", "live-sessions.json");
  for (const dir of [home, workdir, state, join(home, ".codemux"), join(home, ".factory"),
    join(home, ".pi", "agent"), join(home, ".gemini"), join(home, ".copilot")]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // The login files each agent's home populate links from (the run
  // path's recipes, turn-driver-homes.ts): droid and pi auth.json,
  // gemini's two credential files, copilot's config.json. An agent whose
  // file is missing links nothing, so only the owning agent's rows
  // matter.
  writeFileSync(join(home, ".factory", "auth.json"), '{"token":"synthetic-login"}\n', { mode: 0o600 });
  mkdirSync(join(home, ".pi", "agent"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".pi", "agent", "auth.json"), '{"token":"synthetic-login"}\n', { mode: 0o600 });
  for (const name of ["oauth_creds.json", "google_accounts.json"]) {
    writeFileSync(join(home, ".gemini", name), '{"synthetic":true}\n', { mode: 0o600 });
  }
  writeFileSync(join(home, ".copilot", "config.json"), '{"synthetic":true}\n', { mode: 0o600 });
  const env: Record<string, string | undefined> = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
    QWEN_HOME: join(home, ".qwen"),
    CODEMUX_NO_KEYCHAIN_SYNC: "1",
    FAKE_STATE_DIR: state, CODEMUX_TEST_SCODE_ARGV: join(state, "scode.txt"),
    CODEMUX_ALLOW_UNTESTED_HARNESS: undefined,
    GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined, OPENAI_API_KEY: undefined,
  };
  for (const id of TURN_LAUNCH_AGENTS) {
    for (const name of Object.values(providerOverrideEnvNames(id))) env[name] = undefined;
  }
  const fixture = join(import.meta.dir, "..", "fixtures", "live", fixtures[agent]);
  const observer = join(import.meta.dir, "session-turn-launch-observe.ts");
  const binaries = {
    [binaryName(agent)]: `if [ "$1" = "--version" ] || [ "$1" = "--binary-version" ]; then printf '${versionReplies[agent]}\\n'; exit 0; fi\n` +
      `exec bun --preload ${quote(observer)} ${quote(fixture)} "$@"`,
    scode: `printf 'BEGIN\\n' >> "$CODEMUX_TEST_SCODE_ARGV"\nprintf '%s\\n' "$@" >> "$CODEMUX_TEST_SCODE_ARGV"\n` +
      'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\n' +
      '[ "$#" -gt 0 ] || exit 99\nshift\nexec "$@"',
  };
  const parent = join(stateRoot(home, agent), ".codemux-hermetic");
  // Only aider's resolver reads the account home directly (node:os
  // homedir); the seven route through loginHome, which honors the
  // fixture HOME.
  const setup = () => {
    const mocks: Array<{ mockRestore: () => void }> = [
      spyOn(processTable, "readProcessTable").mockReturnValue(new Map()),
    ];
    if (agent === "aider") {
      mocks.push(spyOn(cliHomes, "aiderHarnessHome").mockReturnValue(stateRoot(home, "aider")));
    }
    return () => { for (const mock of mocks) mock.mockRestore(); };
  };
  const args = (flags: string[]) => [
    "-a", agent, "-s", "--auto", "read-only", "--cwd", workdir,
    "--timeout", "5", "--shutdown-grace", "1", "--pass-env", PASS_ENV.join(","), ...flags,
  ];
  const run = async (flags: string[], options: SessionRunOptions = {}) => {
    const stdin = new PassThrough();
    let driveError: unknown;
    const outcome = await runSessionCommand(args(flags), binaries, {
      registryFile, stdin, env, setup, ...options,
      drive: async ({ chunks }) => {
        try {
          stdin.write(`${JSON.stringify({ type: "user", text: "scenario:basic synthetic turn" })}\n`);
          await waitForEvent(chunks, "turn_completed", (event) =>
            event.type === "turn_completed" || event.type === "session_ended", 3_000);
        } catch (error) {
          // Keep cleanup inside runSessionCommand even when launch fails.
          driveError = error;
        } finally {
          stdin.end(`${JSON.stringify({ type: "shutdown" })}\n`);
        }
      },
    });
    return { ...outcome, events: outcomeEvents([outcome.stdout]), driveError };
  };
  return {
    agent, root, home, workdir, state, parent, registryFile, env, binaries, args, run, setup,
    hermeticCapable: SESSION_AGENTS[agent]!.hermetic,
    deferred: agent !== "aider" && TURN_AGENT_PROFILES[agent as keyof typeof TURN_AGENT_PROFILES]
      .identity === "deferred",
    observations: (): TurnHomeObservation[] => readFileSync(join(state, "homes.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as TurnHomeObservation),
    record: () => {
      const read = registry.readRegistry(registryFile);
      if (read.outcome !== "ok" || read.file.sessions.length !== 1) {
        throw new Error("expected one session record");
      }
      return read.file.sessions[0]!;
    },
    context: (id: string, hermetic = true, override: ProviderOverride | null = null) => {
      const before = { ...process.env };
      const registryMock = spyOn(registry, "sessionRegistryPath").mockReturnValue(registryFile);
      const homeMock = agent === "aider"
        ? spyOn(cliHomes, "aiderHarnessHome").mockReturnValue(stateRoot(home, "aider"))
        : null;
      try {
        for (const [key, value] of Object.entries(env)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        return resolveSessionContext({
          options: { resume: id, sandbox: true }, agentId: agent, sessionSupport: SESSION_AGENTS[agent]!,
          override, autonomy: "read-only", passthroughEnv: PASS_ENV,
          enablePlaywrightMcp: false, hermetic, experimentProjectSettings: false,
          sandboxTrust: "standard", sandboxNoNet: false, sandboxScrubEnv: false, sandboxBlock: [], workdir,
        });
      } finally {
        homeMock?.mockRestore();
        registryMock.mockRestore();
        for (const key of Object.keys(env)) {
          if (before[key] === undefined) delete process.env[key];
          else process.env[key] = before[key]!;
        }
      }
    },
    cleanup: () => removeDir(root),
  };
}

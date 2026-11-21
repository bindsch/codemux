import { spyOn } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { SESSION_AGENTS } from "../../src/session/cli-agents.js";
import { resolveSessionContext } from "../../src/session/cli-resume.js";
import * as cliHomes from "../../src/session/cli-homes.js";
import * as processTable from "../../src/process-table.js";
import { providerOverrideEnvNames } from "../../src/provider-override.js";
import * as registry from "../../src/session/registry.js";
import {
  outcomeEvents, removeDir, runSessionCommand, tempWorkdir, waitForEvent,
  type SessionRunOptions,
} from "./session-command.js";

export type HermeticAgent = "codex" | "kimi" | "agy";
export const HERMETIC_AGENTS: HermeticAgent[] = ["codex", "kimi", "agy"];
export const PASS_ENV = ["FAKE_STATE_DIR", "CODEMUX_TEST_SCODE_ARGV"];
const versions = { codex: "codex-cli 0.159.3", kimi: "2.5.2", agy: "1.3.3" };
const fixtures = {
  codex: "fake-codex-app-server.ts", kimi: "fake-kimi-run.ts", agy: "fake-agy-session.ts",
};
const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

export interface HomeObservation {
  home: string;
  codexHome: string | null;
  kimiHome: string | null;
  mode: number;
  previous: string | null;
  state: string;
  config: string | null;
  hasProviderKey: boolean;
}

export function hermeticFixture(agent: HermeticAgent) {
  const root = tempWorkdir(`hermetic-launch-${agent}`);
  const home = join(root, "home");
  const workdir = join(root, "work");
  const state = join(root, "state");
  const registryFile = join(home, ".codemux", "live-sessions.json");
  for (const dir of [home, workdir, state, join(home, ".codex"), join(home, ".kimi-code", "credentials")]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(join(home, ".codex", "auth.json"), '{"token":"synthetic-login"}\n', { mode: 0o600 });
  writeFileSync(join(home, ".kimi-code", "region"), "synthetic-region", { mode: 0o600 });
  writeFileSync(join(home, ".kimi-code", "device_id"), "synthetic-device", { mode: 0o600 });
  const env: Record<string, string | undefined> = {
    HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
    FAKE_STATE_DIR: state,
    CODEMUX_TEST_SCODE_ARGV: join(state, "scode.txt"),
    CODEX_HOME: undefined, CODEX_API_KEY: undefined, OPENAI_API_KEY: undefined,
    KIMI_CODE_HOME: undefined, GOOGLE_API_KEY: undefined, GEMINI_API_KEY: "synthetic-api-key",
    CODEMUX_CODEX_PROVIDER_MULTI_AGENT: undefined, CODEMUX_CODEX_PROVIDER_STORE: undefined,
    CODEMUX_ALLOW_UNTESTED_HARNESS: undefined,
  };
  for (const id of [...HERMETIC_AGENTS, "claude"] as const) {
    for (const name of Object.values(providerOverrideEnvNames(id))) env[name] = undefined;
  }
  const fixture = join(import.meta.dir, "..", "fixtures", "live", fixtures[agent]);
  const observer = join(import.meta.dir, "session-cli-hermetic-observe.ts");
  const binaries = {
    [agent]: `if [ "$1" = "--version" ]; then printf '${versions[agent]}\\n'; exit 0; fi\n` +
      `exec bun --preload ${quote(observer)} ${quote(fixture)} "$@"`,
    scode: `printf 'BEGIN\\n' >> "$CODEMUX_TEST_SCODE_ARGV"\nprintf '%s\\n' "$@" >> "$CODEMUX_TEST_SCODE_ARGV"\n` +
      'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\n' +
      '[ "$#" -gt 0 ] || exit 99\nshift\nexec "$@"',
  };
  const parent = agent === "agy"
    ? join(home, ".gemini", ".codemux-isolation-probes")
    : join(home, agent === "codex" ? ".codex" : ".kimi-code", ".codemux-hermetic");
  const harnessHome = (privateHome: string): string => agent === "codex" ? privateHome
    : agent === "kimi" ? join(privateHome, ".kimi-code")
    : join(privateHome, ".gemini", "antigravity-cli");
  // Bun can retain the account home after process.env.HOME changes.
  // Keep all three state roots inside the fixture for in-process calls.
  const mockHomes = () => {
    const mocks = [
      spyOn(cliHomes, "codexHarnessHome").mockReturnValue(join(home, ".codex")),
      spyOn(cliHomes, "kimiHarnessHome").mockReturnValue(join(home, ".kimi-code")),
      spyOn(cliHomes, "agyHarnessHome").mockReturnValue(join(home, ".gemini", "antigravity-cli")),
    ];
    return () => { for (const mock of mocks) mock.mockRestore(); };
  };
  const setup = () => {
    const restoreHomes = mockHomes();
    const table = spyOn(processTable, "readProcessTable").mockReturnValue(new Map());
    return () => { table.mockRestore(); restoreHomes(); };
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
    agent, root, home, workdir, state, parent, registryFile, env, binaries, args, run, harnessHome, setup,
    observations: (): HomeObservation[] => readFileSync(join(state, "homes.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as HomeObservation),
    record: () => {
      const read = registry.readRegistry(registryFile);
      if (read.outcome !== "ok" || read.file.sessions.length !== 1) throw new Error("expected one session record");
      return read.file.sessions[0]!;
    },
    context: (id: string, hermetic = true) => {
      const before = { ...process.env };
      const registryMock = spyOn(registry, "sessionRegistryPath").mockReturnValue(registryFile);
      const restoreHomes = mockHomes();
      try {
        for (const [key, value] of Object.entries(env)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        return resolveSessionContext({
          options: { resume: id, sandbox: true }, agentId: agent, sessionSupport: SESSION_AGENTS[agent]!,
          override: null, autonomy: "read-only", passthroughEnv: PASS_ENV,
          enablePlaywrightMcp: false, hermetic, experimentProjectSettings: false,
          sandboxTrust: "standard", sandboxNoNet: false, sandboxScrubEnv: false, sandboxBlock: [], workdir,
        });
      } finally {
        restoreHomes();
        registryMock.mockRestore();
        for (const key of Object.keys(env)) {
          if (before[key] === undefined) delete process.env[key];
          else process.env[key] = before[key];
        }
      }
    },
    cleanup: () => removeDir(root),
  };
}

/** The resolver's usageError and policy refusals exit instead of throwing. */
export function refusingCall<T>(call: () => T): { code: number | null; value: T | undefined; message: string } {
  const errors: string[] = [];
  let code: number | null = null;
  const sentinel = new Error("synthetic process exit");
  const error = spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    errors.push(values.map(String).join(" "));
  });
  const exit = spyOn(process, "exit").mockImplementation(((value?: number) => {
    code = value ?? 0;
    throw sentinel;
  }) as typeof process.exit);
  let value: T | undefined;
  try { value = call(); }
  catch (thrown) { if (thrown !== sentinel) throw thrown; }
  finally { exit.mockRestore(); error.mockRestore(); }
  return { code, value, message: errors.join("\n") };
}

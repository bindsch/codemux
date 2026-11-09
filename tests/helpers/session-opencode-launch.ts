/** Fake-PATH launcher fixture; every native process is a synthetic scenario. */
import { spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import * as processTable from "../../src/process-table.js";
import { providerOverrideEnvNames } from "../../src/provider-override.js";
import { readRegistry } from "../../src/session/registry.js";
import {
  outcomeEvents, removeDir, runSessionCommand, tempWorkdir, waitForEvent,
  type SessionRunOptions,
} from "./session-command.js";

const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
export interface OpenCodeObservation {
  home: string;
  configHome: string;
  dataHome: string;
  stateHome: string;
  config: { permission?: string; mcp?: { playwright: { type: string; command: string[]; enabled: boolean } } } | null;
  permission: string | null;
  providerConfig: string | null;
  provider: Record<string, unknown> | null;
  database: string;
  previous: boolean;
  mode: number;
}

export function opencodeLaunchFixture() {
  const root = tempWorkdir("opencode-launch");
  const home = join(root, "home"), workdir = join(root, "work"), state = join(root, "state");
  const dataDir = join(home, ".local", "share", "opencode");
  const stateDir = join(home, ".local", "state", "opencode");
  const parent = join(dataDir, ".codemux-hermetic");
  const registryFile = join(home, ".codemux", "live-sessions.json");
  for (const dir of [home, workdir, state, dataDir, stateDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, "auth.json"), "{}", { mode: 0o600 });
  writeFileSync(join(stateDir, "model.json"), '{"recent":[]}', { mode: 0o600 });
  const env: Record<string, string | undefined> = {
    HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"), XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    CODEMUX_NO_KEYCHAIN_SYNC: "1", CODEMUX_ALLOW_UNTESTED_HARNESS: undefined,
    FAKE_STATE_DIR: state, CODEMUX_TEST_SCODE_ARGV: join(state, "scode.txt"),
    OPENCODE_CONFIG: undefined, OPENCODE_CONFIG_CONTENT: undefined, OPENCODE_PERMISSION: undefined,
  };
  for (const name of Object.values(providerOverrideEnvNames("opencode"))) env[name] = undefined;
  const fixture = join(import.meta.dir, "..", "fixtures", "live", "fake-opencode-run.ts");
  const observer = join(import.meta.dir, "session-opencode-launch-observe.ts");
  const binaries: Record<string, string> = {
    opencode: "if [ \"$1\" = \"--version\" ]; then printf '1.19.5\\n'; exit 0; fi\n" +
      `exec bun --preload ${quote(observer)} ${quote(fixture)} "$@"`,
    scode: 'if [ "$1" = "--help" ]; then printf "--keep-env\\n"; exit 0; fi\n' +
      'printf \'BEGIN\\n\' >> "$CODEMUX_TEST_SCODE_ARGV"\nprintf \'%s\\n\' "$@" >> "$CODEMUX_TEST_SCODE_ARGV"\n' +
      'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\n' +
      '[ "$#" -gt 0 ] || exit 99\nshift\nexec "$@"',
    "playwright-mcp": "exit 99",
  };
  const setup = () => {
    const mock = spyOn(processTable, "readProcessTable").mockReturnValue(new Map());
    return () => mock.mockRestore();
  };
  const args = (flags: string[]) => [
    "-a", "opencode", "-s", "--auto", "low", "--cwd", workdir,
    "--timeout", "5", "--shutdown-grace", "0.1", "--no-author-prefix",
    "--pass-env", "FAKE_STATE_DIR,CODEMUX_TEST_SCODE_ARGV", ...flags,
  ];
  const launch = (flags: string[], options: SessionRunOptions = {}) =>
    runSessionCommand(args(flags), binaries, { registryFile, env, ...options, setup: () => {
      const teardown = setup(), custom = options.setup?.();
      return () => { custom?.(); teardown(); };
    } });
  const run = async (flags: string[], drive?: SessionRunOptions["drive"], options: SessionRunOptions = {}) => {
    const stdin = new PassThrough();
    let driveError: unknown;
    const outcome = await launch(flags, { ...options, stdin, drive: async (handles) => {
      try {
        if (drive) await drive(handles);
        else {
          stdin.write('{"type":"user","text":"scenario:basic synthetic turn"}\n');
          await waitForEvent(handles.chunks, "turn completion", (event) =>
            event.type === "turn_completed" || event.type === "session_ended", 3_000);
        }
      } catch (error) { driveError = error; }
      finally { stdin.end('{"type":"shutdown"}\n'); }
    } });
    return { ...outcome, events: outcomeEvents([outcome.stdout]), driveError };
  };
  const observations = (): OpenCodeObservation[] =>
    readFileSync(join(state, "observations.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const sandboxes = (): string[][] => existsSync(join(state, "scode.txt"))
    ? readFileSync(join(state, "scode.txt"), "utf8").split("BEGIN\n").filter(Boolean).map((block) => block.trim().split("\n"))
    : [];
  const record = () => {
    const registry = readRegistry(registryFile);
    if (registry.outcome !== "ok" || registry.file.sessions.length !== 1) throw new Error("expected one session record");
    return registry.file.sessions[0]!;
  };
  return { root, home, workdir, state, dataDir, stateDir, parent, registryFile,
    env, binaries, args, launch, run, observations, sandboxes, record, cleanup: () => removeDir(root) };
}

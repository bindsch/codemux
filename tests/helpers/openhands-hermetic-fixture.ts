/** The openhands hermetic session fixture: a synthetic operator HOME, an
 * owned working directory, the fake openhands peer, and a fake scode that
 * records its argv and runs the wrapped command. Nothing here reads the
 * operator's real state. */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spyOn } from "bun:test";
import * as processTable from "../../src/process-table.js";
import { providerOverrideEnvNames } from "../../src/provider-override.js";
import { outcomeEvents, runSessionCommand, tempWorkdir, waitForEvent } from "./session-command.js";

const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

export function openhandsHermeticFixture(label: string) {
  const root = tempWorkdir(label);
  const operator = join(root, "operator");
  const work = join(root, "work");
  const state = join(root, "state");
  const registryFile = join(root, "registry.json");
  for (const path of [operator, work, state]) mkdirSync(path, { recursive: true });
  const env: Record<string, string | undefined> = {
    HOME: operator, USERPROFILE: undefined, XDG_CONFIG_HOME: join(operator, ".config"),
    XDG_DATA_HOME: join(operator, ".local", "share"), XDG_STATE_HOME: join(operator, ".local", "state"),
    XDG_CACHE_HOME: join(operator, ".cache"), OPENHANDS_PERSISTENCE_DIR: undefined,
    OPENHANDS_CONVERSATIONS_DIR: undefined, PERSISTENCE_DIR: undefined, LLM_API_KEY: undefined,
    FAKE_STATE_DIR: state, CODEMUX_TEST_SCODE_ARGV: join(state, "scode.txt"),
    CODEMUX_NO_KEYCHAIN_SYNC: "1", CODEMUX_ALLOW_UNTESTED_HARNESS: undefined,
  };
  for (const key of Object.values(providerOverrideEnvNames("openhands"))) env[key] = undefined;
  const armOverride = () => Object.assign(env, {
    CODEMUX_OPENHANDS_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
    CODEMUX_OPENHANDS_PROVIDER_API_KEY: "synthetic-key", CODEMUX_OPENHANDS_PROVIDER_MODEL: "fixture-model" });
  armOverride();
  const script = join(import.meta.dir, "fake-openhands-hermetic-session.ts");
  const binaries = {
    openhands: 'if [ "$1" = "--version" ]; then printf "OpenHands CLI 1.16.0\\n"; exit 0; fi\n' +
      "exec bun " + quote(script) + ' "$@"',
    scode: 'printf "BEGIN\\n%s\\n" "$HOME" >> "$CODEMUX_TEST_SCODE_ARGV"\n' +
      'printf "%s\\n" "$@" >> "$CODEMUX_TEST_SCODE_ARGV"\n' +
      'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\n' +
      '[ "$#" -gt 0 ] || exit 99\nshift\nexec "$@"',
  };
  const args = (flags: string[], auto = "high") => ["-a", "openhands", "-s", "--auto", auto, "--cwd", work,
    "--timeout", "5", "--shutdown-grace", "1",
    "--pass-env", "FAKE_STATE_DIR,CODEMUX_TEST_SCODE_ARGV", ...flags];
  const run = async (flags: string[], options: { turns?: number; auto?: string } = {}) => {
    const turns = options.turns ?? 2;
    const stdin = new PassThrough();
    let driveError: unknown;
    const result = await runSessionCommand(args(flags, options.auto), binaries, { stdin, env, registryFile,
      setup: () => {
        const table = spyOn(processTable, "readProcessTable").mockReturnValue(new Map());
        return () => table.mockRestore();
      },
      drive: async ({ chunks }) => {
        try {
          for (let turn = 0; turn < turns; turn++) {
            stdin.write(JSON.stringify({ type: "user", text: "synthetic " + turn }) + "\n");
            await waitForEvent(chunks, "OpenHands turn", (event) => event.type === "session_ended" ||
              outcomeEvents(chunks).filter((value) => value.type === "turn_completed").length > turn, 3_000);
          }
        } catch (error) { driveError = error; }
        finally { stdin.end('{"type":"shutdown"}\n'); }
      },
    });
    return { ...result, events: outcomeEvents([result.stdout]), driveError };
  };
  const observations = (): Record<string, unknown>[] => {
    const path = join(state, "observations.jsonl");
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  };
  const parent = join(operator, ".openhands", ".codemux-hermetic");
  return { root, operator, work, state, parent, registryFile, env, binaries, args, run, observations, armOverride };
}

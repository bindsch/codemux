import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import * as processTable from "../src/process-table.js";
import { readRegistry } from "../src/session/registry.js";
import { providerOverrideEnvNames } from "../src/provider-override.js";
import { outcomeEvents, polledEvents, removeDir, runSessionCommand, tempWorkdir, waitForEvent } from "./helpers/session-command.js";

const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

function fixture() {
  const root = tempWorkdir("openhands-caller-cli");
  const operator = join(root, "operator");
  const caller = join(root, "caller");
  const work = join(root, "work");
  const state = join(root, "state");
  const registryFile = join(root, "registry.json");
  for (const path of [operator, join(caller, ".openhands"), work, state]) mkdirSync(path, { recursive: true });
  const settings = '{ "caller_customization": "keep" }\n';
  writeFileSync(join(caller, ".openhands", "agent_settings.json"), settings);
  const env: Record<string, string | undefined> = {
    HOME: operator, USERPROFILE: undefined, XDG_CONFIG_HOME: join(operator, ".config"),
    XDG_DATA_HOME: join(operator, ".local", "share"), XDG_STATE_HOME: join(operator, ".local", "state"),
    XDG_CACHE_HOME: join(operator, ".cache"), OPENHANDS_PERSISTENCE_DIR: undefined,
    OPENHANDS_CONVERSATIONS_DIR: undefined, PERSISTENCE_DIR: undefined, LLM_API_KEY: undefined,
    FAKE_STATE_DIR: state, CODEMUX_TEST_SCODE_ARGV: join(state, "scode.txt"),
    CODEMUX_NO_KEYCHAIN_SYNC: "1", CODEMUX_ALLOW_UNTESTED_HARNESS: undefined,
  };
  for (const key of Object.values(providerOverrideEnvNames("openhands"))) env[key] = undefined;
  Object.assign(env, { CODEMUX_OPENHANDS_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
    CODEMUX_OPENHANDS_PROVIDER_API_KEY: "synthetic-key", CODEMUX_OPENHANDS_PROVIDER_MODEL: "fixture-model" });
  const script = join(import.meta.dir, "fixtures", "live", "fake-openhands-caller-session.ts");
  const binaries = {
    openhands: 'if [ "$1" = "--version" ]; then printf "OpenHands CLI 1.16.0\\n"; exit 0; fi\n' +
      "exec bun " + quote(script) + ' "$@"',
    scode: 'printf "BEGIN\\n%s\\n" "$HOME" >> "$CODEMUX_TEST_SCODE_ARGV"\n' +
      'printf "%s\\n" "$@" >> "$CODEMUX_TEST_SCODE_ARGV"\n' +
      'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\n' +
      '[ "$#" -gt 0 ] || exit 99\nshift\nexec "$@"',
  };
  const args = (flags: string[]) => ["-a", "openhands", "-s", "--auto", "high", "--cwd", work,
    "--harness-home", caller, "--timeout", "5", "--shutdown-grace", "1",
    "--pass-env", "FAKE_STATE_DIR,CODEMUX_TEST_SCODE_ARGV", ...flags];
  const run = async (flags: string[], turns = 2) => {
    const stdin = new PassThrough();
    let driveError: unknown;
    const result = await runSessionCommand(args(flags), binaries, { stdin, env, registryFile,
      setup: () => {
        const table = spyOn(processTable, "readProcessTable").mockReturnValue(new Map());
        return () => table.mockRestore();
      },
      drive: async ({ chunks }) => {
        try {
          for (let turn = 0; turn < turns; turn++) {
            stdin.write(JSON.stringify({ type: "user", text: "synthetic " + turn }) + "\n");
            await waitForEvent(chunks, "OpenHands turn", (event) => event.type === "session_ended" ||
              polledEvents(chunks).filter((value) => value.type === "turn_completed").length > turn, 3_000);
          }
        } catch (error) { driveError = error; }
        finally { stdin.end('{"type":"shutdown"}\n'); }
      },
    });
    return { ...result, events: outcomeEvents([result.stdout]), driveError };
  };
  return { root, operator, caller, state, settings, registryFile, env, args, binaries, run };
}

test("OpenHands CLI keeps caller settings and native conversation through turns, restart and final", async () => {
  const f = fixture();
  try {
    const fresh = await f.run([]);
    expect(fresh.exitCode, fresh.stderr).toBe(0);
    expect(fresh.driveError).toBeUndefined();
    expect(fresh.events.filter((event) => event.type === "turn_completed").map((event) => event.finish)).toEqual(["end", "end"]);
    const started = fresh.events.find((event) => event.type === "session_started")!;
    expect(started.private_home).toBe(f.caller);
    const resumed = await f.run(["--resume", started.session_id as string, "--final"]);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expect(resumed.driveError).toBeUndefined();
    expect(resumed.events.find((event) => event.type === "session_started"))
      .toMatchObject({ session_id: started.session_id, private_home: f.caller });
    expect(resumed.events.at(-1)).toMatchObject({ type: "session_ended", resumable: true });
    const observations = readFileSync(join(f.state, "observations.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(observations).toHaveLength(4);
    expect(observations.map((value) => value.turns)).toEqual([1, 2, 3, 4]);
    for (const entry of observations) {
      expect(entry).toMatchObject({ home: f.caller, persistence: join(f.caller, ".openhands"),
        secondary: join(f.caller, ".openhands"), conversations: join(f.caller, ".openhands", "conversations"),
        settings: f.settings, auth: true, id: started.session_id });
      expect(entry.task.startsWith(join(f.caller, ".openhands"))).toBe(true);
      expect(existsSync(entry.task)).toBe(false);
    }
    expect(readFileSync(join(f.caller, ".openhands", "agent_settings.json"), "utf8")).toBe(f.settings);
    const registry = readRegistry(f.registryFile);
    expect(registry.outcome).toBe("ok");
    if (registry.outcome === "ok") expect(registry.file.sessions[0])
      .toMatchObject({ harness_home: f.caller, caller_owned_home: true, hermetic: false });
    const sandbox = readFileSync(join(f.state, "scode.txt"), "utf8");
    expect(sandbox).toContain("BEGIN\n" + f.operator + "\n");
    expect(sandbox).toContain("--allow\n" + f.caller + "\n");
    expect(sandbox).toContain("--block\n" + join(f.operator, ".openhands") + "\n");
  } finally { removeDir(f.root); }
}, 20_000);

test("OpenHands caller print launches no harness and preserves an absent root", async () => {
  const f = fixture();
  const absent = join(f.root, "absent");
  try {
    const args = f.args(["--print-sandbox"]);
    args[args.indexOf("--harness-home") + 1] = absent;
    const result = await runSessionCommand(args, f.binaries, { env: f.env, registryFile: f.registryFile });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("HOME=" + absent);
    expect(existsSync(absent)).toBe(false);
    expect(existsSync(join(f.state, "observations.jsonl"))).toBe(false);
  } finally { removeDir(f.root); }
});

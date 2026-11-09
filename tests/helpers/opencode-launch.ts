import { spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeBinaryEnv } from "./cli.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const fixture = join(import.meta.dir, "../fixtures/live/fake-opencode-launch.ts");
const server = join(import.meta.dir, "../fixtures/experiment-mcp.ts");

export interface OpenCodeLaunchObservation {
  args: string[];
  stdin: string;
  cwd: string;
  home: string;
  state: string;
  variant: Record<string, unknown> | null;
  config: Record<string, any>;
  projectDisabled: boolean;
  pure: string | null;
  nativeLlm: string | null;
}

export async function withOpenCodeLaunch<T>(
  run: (rig: {
    home: string; cwd: string; spec: string; stdout: string[]; errors: string[];
    observations: () => OpenCodeLaunchObservation[]; recordings: () => Record<string, any>[][];
  }) => Promise<T>,
  options: { mode?: string; version?: string; scode?: string; provider?: boolean } = {},
): Promise<T> {
  const parent = join(import.meta.dir, "../../scratch/fix");
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "opencode-launch-"));
  const cwd = join(home, "work"); mkdirSync(cwd);
  const observation = join(home, "observations.jsonl");
  const recordings = join(home, "recordings");
  const spec = join(home, "spec.json");
  writeFileSync(spec, JSON.stringify({ name: "experiment", command: process.execPath,
    args: ["--no-env-file", "--no-install", server], env: [], recording: recordings }));
  const fake = createFakeBinaryEnv({
    opencode: `if [ "$1" = "--version" ]; then printf '%s\\n' '${options.version ?? "1.19.5"}'; exit 0; fi\n` +
      `exec bun --no-env-file --no-install ${quote(fixture)} ${quote(observation)} ${quote(options.mode ?? "normal")} "$@"`,
    scode: options.scode ?? 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
  });
  const previous = { ...process.env }, previousExit = process.exitCode;
  const stdout: string[] = [], errors: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")); return true;
  }) as typeof process.stdout.write);
  const error = spyOn(console, "error").mockImplementation((...values) => { errors.push(values.map(String).join(" ")); });
  try {
    for (const name of Object.keys(process.env)) {
      if (/^(OPENCODE_|CODEMUX_OPENCODE_|XDG_)/.test(name)) delete process.env[name];
    }
    Object.assign(process.env, fake.env, { HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"),
      CODEMUX_NO_KEYCHAIN_SYNC: "1", CODEMUX_ALLOW_UNTESTED_HARNESS: "" });
    if (options.provider) Object.assign(process.env, {
      CODEMUX_OPENCODE_PROVIDER_BASE_URL: "https://provider.invalid/v1",
      CODEMUX_OPENCODE_PROVIDER_API_KEY: "synthetic-key", CODEMUX_OPENCODE_PROVIDER_MODEL: "model",
    });
    const readLines = (path: string) => existsSync(path)
      ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    return await run({ home, cwd, spec, stdout, errors, observations: () => readLines(observation),
      recordings: () => {
        const files = new Bun.Glob("*.jsonl").scanSync({ cwd: recordings, absolute: true });
        return [...files].map(readLines);
      } });
  } finally {
    error.mockRestore(); write.mockRestore();
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous); process.exitCode = previousExit;
    fake.cleanup(); rmSync(home, { recursive: true, force: true });
  }
}

import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runCli(
  args: string[],
  envOverrides?: Record<string, string>,
  // `holdStdin` writes `stdin` but leaves the pipe open until the process
  // exits, for a session that must end on its own rather than on EOF.
  options?: { stdin?: string | Uint8Array; holdStdin?: boolean }
): Promise<CliResult> {
  const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-cli-home-"));
  try {
    const proc = Bun.spawn(
      envOverrides?.CODEMUX_TEST_AGY_SECURITY
        ? [process.execPath, "--no-env-file", "--no-install", "--config=./bunfig.runtime.toml",
          "--preload", join(import.meta.dir, "../fixtures/agy-host.ts"), "src/index.ts", ...args]
        : [join(import.meta.dir, "..", "..", "bin", "codemux"), ...args],
      {
        cwd: join(import.meta.dir, "..", ".."),
        stdout: "pipe",
        stderr: "pipe",
        // "ignore" keeps a run that reads stdin (-f -) failing fast on EOF
        // rather than inheriting the test runner's terminal.
        stdin: options?.stdin === undefined ? "ignore" : "pipe",
        env: {
          ...process.env,
          // Spawned CLI tests cannot inject the credential seams; disable
          // the keychain sync so no spawned codemux reads the real Keychain
          // and copies the live credential into this throwaway HOME.
          CODEMUX_NO_KEYCHAIN_SYNC: "1",
          HOME: isolatedHome,
          XDG_CONFIG_HOME: join(isolatedHome, ".config"),
          ...envOverrides,
        } as Record<string, string>,
      }
    );
    const stdin = proc.stdin;
    if (options?.stdin !== undefined && stdin !== null && stdin !== undefined) {
      stdin.write(options.stdin);
      if (options.holdStdin === true) stdin.flush();
      else stdin.end();
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
}

// A PATH that provably contains no optional Codemux integration.
//
// This used to expose the real directory holding `bun`, which silently stopped
// being minimal once `bun` and `usagemux` were both installed under the same
// Homebrew prefix: tests asserting "usagemux is absent" then passed or failed
// depending on the machine. Link `bun` into a private directory instead, so
// nothing else on the host can leak in.
let isolatedBunDir: string | null = null;

export function minimalPath(): string {
  if (isolatedBunDir === null) {
    const bunPath =
      Bun.which("bun", { PATH: process.env.PATH }) ?? process.execPath;
    isolatedBunDir = mkdtempSync(join(tmpdir(), "codemux-cli-bin-"));
    symlinkSync(bunPath, join(isolatedBunDir, "bun"));
  }
  return [isolatedBunDir, "/usr/bin", "/bin"].join(":");
}

function fakeSecurityScript(fixtureDir: string): string {
  return String.raw`
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME;
const login = join(home, "Library/Keychains/login.keychain-db");
const statePath = join(${JSON.stringify(fixtureDir)}, "security-" + createHash("sha256").update(home).digest("hex") + ".json");
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : { defaultKeychain: login, keychains: [login] };
const save = () => writeFileSync(statePath, JSON.stringify(state));
const quoted = (paths) => process.stdout.write(paths.map((path) => '    "' + path + '"\n').join(""));

function execute(args) {
  const command = args.shift();
  const last = args.at(-1);
  switch (command) {
    case "create-keychain":
      writeFileSync(last, JSON.stringify({ password: args[args.indexOf("-p") + 1], unlocked: false, items: {} }));
      if (!state.keychains.includes(last)) state.keychains.push(last);
      save();
      return true;
    case "unlock-keychain": {
      if (!existsSync(last)) return false;
      const keychain = JSON.parse(readFileSync(last, "utf8"));
      keychain.unlocked = args[args.indexOf("-p") + 1] === keychain.password;
      writeFileSync(last, JSON.stringify(keychain));
      return keychain.unlocked;
    }
    case "add-generic-password":
    case "delete-generic-password": {
      if (!existsSync(last)) return false;
      const keychain = JSON.parse(readFileSync(last, "utf8"));
      if (!keychain.unlocked) return false;
      const item = JSON.stringify([args[args.indexOf("-s") + 1], args.includes("-a") ? args[args.indexOf("-a") + 1] : ""]);
      if (command === "add-generic-password") {
        if (Object.hasOwn(keychain.items, item)) return false;
        keychain.items[item] = args[args.indexOf("-w") + 1];
      } else {
        if (!Object.hasOwn(keychain.items, item)) return false;
        delete keychain.items[item];
      }
      writeFileSync(last, JSON.stringify(keychain));
      return true;
    }
    case "set-keychain-settings":
      return existsSync(last) && JSON.parse(readFileSync(last, "utf8")).unlocked === true;
    case "show-keychain-info":
      return existsSync(last);
    case "delete-keychain":
      if (existsSync(last)) unlinkSync(last);
      state.keychains = state.keychains.filter((path) => path !== last);
      if (state.defaultKeychain === last) state.defaultKeychain = login;
      save();
      return true;
    case "default-keychain":
      if (args.includes("-s")) {
        state.defaultKeychain = last;
        save();
      } else quoted([state.defaultKeychain]);
      return true;
    case "list-keychains":
      if (args.includes("-s")) {
        state.keychains = args.slice(args.indexOf("-s") + 1);
        save();
      } else quoted(state.keychains);
      return true;
    case "find-generic-password":
      if (!args.includes("-w")) return false;
      process.stdout.write("synthetic-agy-token\n");
      return true;
    default:
      return false;
  }
}

const args = process.argv.slice(2);
if (args[0] === "-i") {
  for (const line of readFileSync(0, "utf8").split("\n").filter((line) => line.trim())) {
    const tokens = Array.from(line.matchAll(/"((?:\\.|[^"\\])*)"|(\S+)/g),
      ([, quoted, bare]) => quoted === undefined ? bare : quoted.replace(/\\(.)/g, "$1"));
    if (!execute(tokens)) process.exit(1);
  }
} else if (!execute(args)) process.exit(1);
`;
}

export function createFakeBinaryEnv(
  binaries: Record<string, string>,
  scodeVersion = "0.6.0"
): { env: Record<string, string>; cleanup: () => void } {
  const binDir = mkdtempSync(join(tmpdir(), "codemux-cli-bin-"));
  const apiKeyLogin = binaries.agy && !binaries.security;
  // Never consult the operator's real Keychain from a synthetic agy launch.
  if (apiKeyLogin) binaries = { ...binaries, security: fakeSecurityScript(binDir) };
  for (const [name, body] of Object.entries(binaries)) {
    const scriptPath = join(binDir, name);
    const versionPreamble = name === "scode"
      ? `if [ "$1" = "--version" ]; then printf 'scode ${scodeVersion}\\n'; exit 0; fi\n`
      : "";
    const interpreter = name === "security" && apiKeyLogin ? process.execPath : "/bin/sh";
    writeFileSync(scriptPath, `#!${interpreter}\n${versionPreamble}${body}\n`);
    chmodSync(scriptPath, 0o755);
  }

  return {
    env: {
      PATH: `${binDir}:${minimalPath()}`,
      ...(apiKeyLogin ? { GEMINI_API_KEY: "synthetic-api-key" } : {}),
      ...(binaries.security ? { CODEMUX_TEST_AGY_SECURITY: join(binDir, "security") } : {}),
    },
    cleanup: () => {
      rmSync(binDir, { recursive: true, force: true });
    },
  };
}

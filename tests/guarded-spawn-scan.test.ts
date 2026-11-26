import { expect, test } from "bun:test";

// By construction: a child that can run a harness is started only through
// src/guarded-spawn.ts, which runs the keychain-home check first
// (src/darwin-keychain-home.ts). This scan fails when another file under
// src/ or scripts/ starts a process, unless the line is listed below with
// the reason it cannot run a harness.

/** A line that starts a process, or imports the functions that do. */
const STARTS_PROCESS = /(?<!typeof )\bBun\.spawn(?:Sync)?\b|\bBun\.\$|child_process|\b(?:spawnSync|execFileSync|execSync|execFile|posix_spawn)\(/;
const GUARDED_MODULE = "src/guarded-spawn.ts";

/** Fixed system tools and code that runs inside a harness. One entry per line. */
const ALLOWED: readonly { file: string; line: RegExp; why: string }[] = [
  { file: "src/account-home.ts", line: /^import \{ spawnSync \} from "node:child_process";$/,
    why: "the two fixed lookups below" },
  { file: "src/account-home.ts", line: /spawnSync\("\/usr\/bin\/id", \["-un"\]/,
    why: "id(1) by absolute path: prints the user name; the keychain-home check itself needs this answer" },
  { file: "src/account-home.ts", line: /spawnSync\("\/usr\/bin\/dscl", \["\.", "-read"/,
    why: "dscl(1) by absolute path: reads the account home from the directory service" },
  { file: "src/darwin-keychain-preferences.ts", line: /^import \{ spawnSync \} from "node:child_process";$/,
    why: "the plutil lookup in the entry below" },
  { file: "src/darwin-keychain-preferences.ts", line: /const result = spawnSync\(tool, args, \{ encoding: "utf8", input, stdio: \[input === undefined \? "ignore" : "pipe", "pipe", "ignore"\] \}\);$/,
    why: "plutil(1), /usr/bin/plutil unless a test names another: prints the type or value of one key of a preference file" },
  { file: "src/verify.ts", line: /Bun\.spawnSync\(\["\/usr\/bin\/getconf", "DARWIN_USER_TEMP_DIR"\]/,
    why: "getconf(1) by absolute path: prints one path" },
  { file: "src/process-table.ts", line: /Bun\.spawnSync\(\["\/bin\/ps", "-A"/,
    why: "ps(1) by absolute path: lists processes" },
  { file: "src/pi-mcp-stdio.ts", line: /^import type \{ spawn as nodeSpawn \} from "node:child_process";$/,
    why: "a type import; the function runs inside Pi as extension code, in a process a guarded spawn started" },
  { file: "src/pi-mcp-launch.ts", line: /^  return `import \{ spawn \} from "node:child_process";\\n` \+$/,
    why: "text of the extension file Pi loads; it runs inside Pi, in a process a guarded spawn started" },
];

/** Files that start harness children, each through the guarded functions. */
const GUARDED_SPAWN_POINTS: Readonly<Record<string, RegExp>> = {
  "src/process-runner.ts": /\(options\.scodeProbe \? spawnScodeProbe : spawnGuarded\)\(command, \{/,
  "src/cli-runtime.ts": /\bspawnGuarded\(scodeCmd, \{/,
  "src/session/process.ts": /\bspawnGuarded\(options\.command, \{/,
  "src/adapters/interactive.ts": /\bspawnGuarded\(command, \{/,
  "src/hermetic-session-canary-driver.ts": /\bspawnGuarded\(\[\.\.\.sessionCanary\.command\(\), \.\.\.argv\], \{/,
  "src/experiment-server.ts": /\bspawnGuarded\(\[command, \.\.\.this\.spec\.args\], \{/,
  "scripts/live-gate/runner.ts": /\bspawnGuarded\(command, \{/,
  "scripts/check-installed-layout.ts": /\bspawnSyncGuarded\(\[binary, \.\.\.command\.args\], \{/,
};

async function sources(): Promise<Map<string, string[]>> {
  const files = new Map<string, string[]>();
  for (const root of ["src", "scripts"]) {
    for await (const path of new Bun.Glob("**/*.{ts,tsx,js,mjs,cjs}").scan({ cwd: root, onlyFiles: true, dot: true })) {
      files.set(`${root}/${path}`, (await Bun.file(`${root}/${path}`).text()).split("\n"));
    }
  }
  return files;
}

const isComment = (line: string): boolean => /^\s*(?:\/\/|\/?\*)/.test(line);

export function unguardedStarts(files: Map<string, string[]>): string[] {
  const offenders: string[] = [];
  for (const [file, lines] of files) {
    if (file === GUARDED_MODULE) continue;
    lines.forEach((line, index) => {
      if (isComment(line) || !STARTS_PROCESS.test(line)) return;
      if (ALLOWED.some((entry) => entry.file === file && entry.line.test(line))) return;
      offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  return offenders;
}

test("no file under src/ or scripts/ starts a process outside the guarded spawn functions", async () => {
  const files = await sources();
  expect(files.size).toBeGreaterThan(200);
  expect(unguardedStarts(files)).toEqual([]);
});

test("every allowlist entry still matches a line, and each states its reason", async () => {
  const files = await sources();
  for (const entry of ALLOWED) {
    expect(entry.why.length).toBeGreaterThan(20);
    expect({ file: entry.file, matches: (files.get(entry.file) ?? []).filter((line) => entry.line.test(line)).length })
      .toEqual({ file: entry.file, matches: 1 });
  }
});

test("each harness spawn point calls a guarded function", async () => {
  const files = await sources();
  for (const [file, call] of Object.entries(GUARDED_SPAWN_POINTS)) {
    expect({ file, guarded: (files.get(file) ?? []).some((line) => call.test(line)) }).toEqual({ file, guarded: true });
  }
});

test("the guarded module checks before it spawns; its one unchecked function starts scode probes only", async () => {
  const text = await Bun.file(GUARDED_MODULE).text();
  const bodies = text.split("export const ").slice(1);
  expect(bodies.map((body) => body.slice(0, body.indexOf(":")))).toEqual(["spawnGuarded", "spawnScodeProbe", "spawnSyncGuarded"]);
  // The probe function refuses every argv but the two scode flags before it spawns.
  const probe = bodies[1]!;
  expect(probe.indexOf("throw new Error")).toBeGreaterThan(-1);
  expect(probe.search(/Bun\.spawn as/)).toBeGreaterThan(probe.indexOf("throw new Error"));
  // Only the process runner reaches it, and only for the option the scode probes set.
  const files = await sources();
  const users = [...files].filter(([file, lines]) => file !== GUARDED_MODULE && lines.some((line) => line.includes("spawnScodeProbe")));
  expect(users.map(([file]) => file)).toEqual(["src/process-runner.ts"]);
  const setters = [...files].filter(([, lines]) => lines.some((line) => /scodeProbe: true/.test(line))).map(([file]) => file);
  // The launch-time probes and the doctor's `scode --version` (review round 23).
  expect(setters.sort()).toEqual(["src/cli-runtime/scode.ts", "src/doctor-environment.ts"]);
  const doctor = files.get("src/doctor-environment.ts") ?? [];
  const at = doctor.findIndex((line) => /scodeProbe: true/.test(line));
  expect(doctor.slice(at - 4, at).join("\n")).toContain('runOutputProbe([trusted, "--version"]');
  for (const body of [bodies[0]!, bodies[2]!]) {
    const check = body.indexOf("check(args);");
    const spawn = body.search(/Bun\.spawn(?:Sync)? as/);
    expect(check).toBeGreaterThan(-1);
    expect(spawn).toBeGreaterThan(check);
  }
});

test("the scan catches each way of starting a process (the test can fail)", () => {
  const offending = [
    'const child = Bun.spawn(["harness"], {});',
    'Bun.spawnSync(["harness"]);',
    'const spawner = Bun.spawn;',
    'import { execFileSync } from "node:child_process";',
    'const { spawn } = require("child_process");',
    'await Bun.$`harness`;',
    'execFileSync("harness", []);',
  ];
  for (const line of offending) {
    expect(unguardedStarts(new Map([["src/new-adapter.ts", [line]]]))).toHaveLength(1);
  }
  // An allowlist entry covers its own file only, and only its own line.
  expect(unguardedStarts(new Map([["src/other.ts", ['Bun.spawnSync(["/bin/ps", "-A"]);']]]))).toHaveLength(1);
  expect(unguardedStarts(new Map([["src/process-table.ts", ['Bun.spawnSync(["harness"]);']]]))).toHaveLength(1);
  const harmless = [
    "let proc: ReturnType<typeof Bun.spawn>;",
    "// Bun.spawn(command) is described in a comment",
    "const match = pattern.exec(text);",
    "proc = spawnGuarded(command, {});",
  ];
  expect(unguardedStarts(new Map([["src/new-adapter.ts", harmless]]))).toEqual([]);
});

// Review finding 2c: the HOME of a child is read from `env` wrappers. A
// shell wrapper (`sh -c '...'`) could set HOME where that parser cannot read
// it, so codemux builds none for a harness. The two matches are the fixed
// sandbox self-test `/bin/sh -c 'exit 0'`, whose script assigns nothing.
test("no file under src/ or scripts/ builds a shell -c wrapper, except the fixed sandbox self-test", async () => {
  const SHELL_C = /["'`](?:\/(?:usr\/)?bin\/)?(?:sh|bash|zsh|dash|ksh)["'`],\s*["'`]-[a-z]*c["'`]/;
  const found: string[] = [];
  for (const [file, lines] of await sources()) {
    lines.forEach((line) => { if (!isComment(line) && SHELL_C.test(line)) found.push(`${file}: ${line.trim()}`); });
  }
  expect(found.map((entry) => entry.split(":")[0]).sort()).toEqual(["scripts/check-scode-version.ts", "src/doctor-environment.ts"]);
  for (const entry of found) expect(entry).toContain('"/bin/sh", "-c", "exit 0"');
  expect(SHELL_C.test('const cmd = ["bash", "-lc", script];')).toBe(true);
  expect(SHELL_C.test('const cmd = ["/bin/sh", script];')).toBe(false);
});

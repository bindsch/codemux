import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountHome } from "../src/account-home.js";
import { assertCompatibleScode, scodeSupportsAllowRo } from "../src/cli-runtime/scode.js";
import { runSandboxed, runSandboxedWithStdin } from "../src/cli-runtime.js";
import { applyHarnessHomeSandboxBlocks } from "../src/launch/harness-home-sandbox.js";
import { buildScodeCommand, type SandboxOptions } from "../src/sandbox.js";
import { resolveSessionSandboxSpawn } from "../src/session/spawn.js";
import { verifiedScodeCommand, verifiedScodeFeatures } from "../src/verify-scode.js";
import { strictLaunchFailureExitCode } from "../src/sandbox-command.js";
import { minimalPath, runCli } from "./helpers/cli.js";

const root = realpathSync(mkdtempSync(join(import.meta.dir, "../scratch/allow-ro-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cwd = join(root, "project"), home = join(root, "operator"), caller = join(root, "caller");
for (const dir of [cwd, home, caller]) mkdirSync(dir);
const binaries = [".opencode/bin/opencode", ".kimi-code/bin/kimi", ".local/bin/agy"].map((name) => {
  const path = join(home, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  return path;
});

function fixture(version: string) {
  const bin = join(root, `scode-${version}`);
  mkdirSync(bin, { recursive: true });
  const scode = join(bin, "scode"), argvFile = join(bin, "argv");
  // Records policy only: no installed scode or real harness is executed.
  writeFileSync(scode, `#!/bin/sh
if [ "$1" = --version ]; then echo 'scode ${version}'; exit 0; fi
printf '%s\\n' "$@" > "$ARGV_FILE"
exit 0
`, { mode: 0o700 });
  return { scode, argvFile, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ARGV_FILE: argvFile } };
}

function options(binary: string): SandboxOptions {
  const opts: SandboxOptions = {};
  applyHarnessHomeSandboxBlocks(opts, caller, [join(binary, "../..")]);
  return opts;
}

function values(argv: string[], flag: string) {
  return argv.slice(0, argv.indexOf("--")).flatMap((arg, i) => arg === flag ? [argv[i + 1]] : []);
}

test.each([
  ["0.6.6", false], ["0.6.7-rc1", false], ["0.6.7", true], ["0.6.7+build.1", true], ["0.7.0", true],
] as const)("scode %s uses the existing version probe for allow-ro=%s", async (version, supported) => {
  const f = fixture(version);
  const actual = await assertCompatibleScode(f.scode, cwd, f.env);
  expect(scodeSupportsAllowRo(actual)).toBe(supported);
});

for (const version of ["0.6.6", "0.6.7"] as const) {
  for (const binary of binaries.slice(0, 2)) {
    test(`${version}: exact blocked-store grants for ${binary.split("/").at(-1)}`, async () => {
      const f = fixture(version), opts = options(binary);
      const allowRo = scodeSupportsAllowRo(await assertCompatibleScode(f.scode, cwd, f.env));
      const command = ["/usr/bin/env", `HOME=${caller}`, binary];
      for (const mode of [{}, { strict: true }, { trust: "untrusted" as const }]) {
        const build = () => buildScodeCommand(command, cwd, "low", { ...opts, ...mode }, f.scode, f.env, allowRo);
        if (!allowRo && ("strict" in mode || "trust" in mode)) {
          expect(build).toThrow("writable executable grant");
          continue;
        }
        const argv = build();
        expect(values(argv, "--allow-ro")).toEqual(allowRo ? [binary] : []);
        expect(values(argv, "--allow")).toEqual(allowRo ? [caller] : [caller, binary]);
        expect(values(argv, "--block")).toContain(join(binary, "../.."));
      }
    });
  }

  test(`${version}: run, TUI, and session resolution use the launch PATH's scode`, async () => {
    const f = fixture(version), binary = binaries[0]!;
    const opts = options(binary);
    const command = ["/usr/bin/env", `HOME=${caller}`, binary];
    const session = await resolveSessionSandboxSpawn(command, f.env, {
      sandboxed: true, autonomy: "low", sandboxOptions: opts,
    }, cwd);
    const result = await runSandboxedWithStdin(command, null, cwd, f.env, "low", opts);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(f.argvFile, "utf8").trimEnd().split("\n")).toEqual(session.scodeCmd.slice(1));
    expect(await runSandboxed(command, cwd, f.env, false, "low", opts)).toBe(0);
    expect(readFileSync(f.argvFile, "utf8").trimEnd().split("\n")).toEqual(session.scodeCmd.slice(1));
    expect(values(session.scodeCmd, version === "0.6.7" ? "--allow-ro" : "--allow")).toContain(binary);
    const strict = { ...opts, strict: true };
    const calls = [
      () => resolveSessionSandboxSpawn(command, f.env, { sandboxed: true, autonomy: "low", sandboxOptions: strict }, cwd),
      () => runSandboxedWithStdin(command, null, cwd, f.env, "low", strict),
      () => runSandboxed(command, cwd, f.env, false, "low", strict),
    ];
    for (const call of calls) {
      if (version === "0.6.6") await expect(call()).rejects.toThrow("writable executable grant");
      else await call();
    }
  });

  test(`${version}: verify probes its resolved scode and handles nested wrapped executables`, async () => {
    const f = fixture(version), savedPath = process.env.PATH;
    process.env.PATH = f.env.PATH;
    try {
      const features = await verifiedScodeFeatures(cwd);
      expect(features).toEqual({ allowRo: version === "0.6.7" });
      for (const policy of [{ strict: true }, { trust: "untrusted" as const }]) {
        const command = ["/usr/bin/env", "A=b", "/usr/bin/env", "C=d", binaries[2]!];
        const row = verifiedScodeCommand(command, cwd, "low", policy, features);
        if (version === "0.6.6") expect(row.error).toContain("env-wrapped executable");
        else {
          expect(row.error).toBeUndefined();
          expect(values(row.command, "--allow-ro")).toEqual([binaries[2]]);
          expect(values(row.command, "--allow")).toEqual([]);
        }
      }
    } finally { process.env.PATH = savedPath; }
  });

  test(`${version}: verify --show-scode forwards detected read-only support`, async () => {
    const f = fixture(version), bin = join(root, `verify-${version}`);
    mkdirSync(bin);
    symlinkSync(binaries[2]!, join(bin, "agy"));
    const result = await runCli(["verify", "-a", "agy", "--show-scode", "--sandbox-strict"], {
      ...f.env, PATH: `${bin}:${f.env.PATH}:${minimalPath()}`,
    }, { cwd });
    expect(result.exitCode, result.stderr).toBe(0);
    if (version === "0.6.6") {
      expect(result.stdout).toContain("Unavailable: strict sandbox cannot read env-wrapped executable");
      expect(result.stdout).not.toContain("--allow-ro");
    } else {
      expect(result.stdout).not.toContain("Unavailable:");
      expect(result.stdout).toContain(`--allow-ro ${binaries[2]}`);
    }
  });
}

test("verify refuses an unreadable scode version without claiming read-only support", async () => {
  const f = fixture("not-a-version"), savedPath = process.env.PATH;
  process.env.PATH = f.env.PATH;
  try {
    const features = await verifiedScodeFeatures(cwd);
    expect(features.allowRo).toBe(false);
    expect(features.error).toContain("could not parse scode version");
    expect(verifiedScodeCommand([binaries[2]!], cwd, "low", {}, features))
      .toEqual({ command: [], error: features.error });
    process.env.PATH = "/usr/bin:/bin";
    expect(await verifiedScodeFeatures(cwd)).toEqual({ allowRo: false });
  } finally { process.env.PATH = savedPath; }
});

test("read-only executable exceptions preserve caller blocks, including symlink aliases", () => {
  const binary = binaries[0]!, opts = options(binary), alias = join(root, "store-alias");
  symlinkSync(join(binary, "../.."), alias);
  for (const callerBlock of [binary, join(binary, "../.."), alias]) {
    for (const mode of [{}, { strict: true }, { trust: "untrusted" as const }]) {
      try {
        buildScodeCommand(["/usr/bin/env", binary], cwd, "low", {
          ...opts, ...mode, callerBlockPaths: [callerBlock],
        }, "scode", { HOME: home }, true);
        throw new Error("expected caller-block refusal");
      } catch (error) {
        expect(strictLaunchFailureExitCode(error)).toBe(64);
        expect((error as Error).message).toContain("--sandbox-block");
      }
    }
  }
  expect(() => buildScodeCommand(["/usr/bin/env", binaries[2]!], cwd, "low", {
    strict: true, blockPaths: [home],
  }, "scode", { HOME: home }, true)).toThrow("--sandbox-block");
});

test("allow-ro never excuses a writable harness state or runtime grant covering executable code", () => {
  const binary = binaries[0]!;
  for (const policy of [{ strict: true }, { trust: "untrusted" as const }]) {
    expect(() => buildScodeCommand(["/usr/bin/env", binary], cwd, "low", {
      ...options(binary), ...policy, harnessStateDirs: [home],
    }, "scode", { HOME: home }, true)).toThrow("writable executable grant");
  }
  expect(() => buildScodeCommand([binary], cwd, "low", { agentId: "opencode", strict: true },
    "scode", { HOME: home }, true)).toThrow("writable executable grant");
});

test.skipIf(accountHome() === null)("synthetic HOME grants exact account-home executables read-only", () => {
  const binary = join(accountHome()!, ".local/bin/harness-fixture");
  for (const policy of [{}, { strict: true }, { trust: "untrusted" as const }]) {
    const argv = buildScodeCommand([binary], cwd, "low", policy, "scode", { HOME: caller }, true);
    expect(values(argv, "--allow-ro")).toEqual([binary]);
    expect(values(argv, "--allow")).toEqual([]);
  }
  const argv = buildScodeCommand([binary], cwd, "low", {}, "scode", { HOME: accountHome()! }, true);
  expect(values(argv, "--allow-ro")).toEqual([]);
});

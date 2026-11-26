import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertCompatibleScode, scodeSupportsAllowRo, scodeSupportsAllowStaged, scodeSupportsNoLoginStore } from "../src/cli-runtime/scode.js";
import { runSandboxed, runSandboxedWithStdin } from "../src/cli-runtime.js";
import { buildScodeCommand, type SandboxOptions } from "../src/sandbox.js";
import { resolveSessionSandboxSpawn } from "../src/session/spawn.js";
import { verifiedScodeCommand, verifiedScodeFeatures } from "../src/verify-scode.js";
import { useLinuxScodeFloors } from "./helpers/scode-platform.js";
import { linkAccountKeychain } from "../src/darwin-keychain-home.js";

// This file exercises scode versions below 0.6.11, which a macOS launch refuses.
useLinuxScodeFloors();

const root = realpathSync(mkdtempSync(join(import.meta.dir, "../scratch/allow-staged-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cwd = join(root, "project"), home = join(root, "operator"), profile = join(home, "profile");
for (const dir of [cwd, home, profile]) mkdirSync(dir);
// The stand-in operator HOME is not the account home, so on macOS the first
// spawn would link the keychain directory into it and the next command
// would then name that path. It is linked up front, so every build agrees.
linkAccountKeychain(home);
const credentials = join(profile, ".credentials.json"), owner = join(profile, ".oauth_refresh.lock.owner");
writeFileSync(credentials, "synthetic login");
const staged = [owner, credentials];
const command = ["/bin/echo", "synthetic"];
const options: SandboxOptions = { agentId: "claude", loginStore: true, blockPaths: [profile], callerBlockPaths: [] };
const values = (argv: string[], flag: string) => argv.filter((_, index) => argv[index - 1] === flag);

function fixture(version: string) {
  const bin = join(root, `scode-${version}`);
  mkdirSync(bin, { recursive: true });
  const scode = join(bin, "scode"), argvFile = join(bin, "argv");
  writeFileSync(scode, `#!/bin/sh
if [ "$1" = --version ]; then echo 'scode ${version}'; exit 0; fi
printf '%s\\n' "$@" > "$ARGV_FILE"
exit 0
`, { mode: 0o700 });
  return { scode, argvFile, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: profile, ARGV_FILE: argvFile } };
}

test.each([
  ["0.6.7", false], ["0.6.8-rc1", false], ["0.6.8", true], ["0.6.8+build.1", true], ["0.7.0", true],
] as const)("scode %s selects staged grants=%s through the version probe", async (version, supported) => {
  const f = fixture(version);
  expect(scodeSupportsAllowStaged(await assertCompatibleScode(f.scode, cwd, f.env))).toBe(supported);
});

for (const version of ["0.6.7", "0.6.8"] as const) {
  test(`${version}: run, TUI, session, and verify agree on bounded login grants`, async () => {
    const f = fixture(version);
    const expected = process.platform === "darwin" && version === "0.6.8" ? staged : [];
    for (const strict of [false, true]) {
      const policy = { ...options, strict };
      const session = await resolveSessionSandboxSpawn(command, f.env, {
        sandboxed: true, autonomy: "low", sandboxOptions: policy,
      }, cwd);
      expect(values(session.scodeCmd, "--allow-staged")).toEqual(expected);
      for (const path of expected) expect(values(session.scodeCmd, "--allow")).not.toContain(path);
      expect(values(session.scodeCmd, "--block")).toContain(profile);
      expect(values(session.scodeCmd, "--allow")).not.toContain(profile);
      expect((await runSandboxedWithStdin(command, null, cwd, f.env, "low", policy)).exitCode).toBe(0);
      expect(readFileSync(f.argvFile, "utf8").trimEnd().split("\n")).toEqual(session.scodeCmd.slice(1));
      expect(await runSandboxed(command, cwd, f.env, false, "low", policy)).toBe(0);
      expect(readFileSync(f.argvFile, "utf8").trimEnd().split("\n")).toEqual(session.scodeCmd.slice(1));
    }
    const saved = { ...process.env };
    Object.assign(process.env, f.env);
    try {
      const features = await verifiedScodeFeatures(cwd);
      expect(features.allowStaged).toBe(version === "0.6.8");
      const preview = verifiedScodeCommand(command, cwd, "low", options, features);
      expect(preview.error).toBeUndefined();
      expect(values(preview.command, "--allow-staged")).toEqual(expected);
    } finally { process.env = saved; }
    expect(readFileSync(credentials, "utf8")).toBe("synthetic login");
  });
}

test("staged grants are macOS Claude login exceptions only and preserve caller blocks", () => {
  const f = fixture("0.6.8");
  for (const policy of [{ trust: "untrusted" as const }, { agentId: "zai" as const }]) {
    expect(values(buildScodeCommand(command, cwd, "low", { ...options, ...policy }, f.scode, f.env, true, true), "--allow-staged")).toEqual([]);
  }
  for (const env of [{ ANTHROPIC_API_KEY: "synthetic" }, { ANTHROPIC_BASE_URL: "http://127.0.0.1:9999" }]) {
    expect(values(buildScodeCommand(command, cwd, "low", options, f.scode, { ...f.env, ...env }, true, true), "--allow-staged")).toEqual([]);
  }
  if (process.platform === "darwin") {
    for (const block of [profile, credentials, owner, `${owner}.tmp.0123abcd`, `${owner}.tmp.0123ABCD`, `${owner}.TMP.AaBb1234/child`]) {
      expect(() => buildScodeCommand(command, cwd, "low", { ...options, callerBlockPaths: [block] }, f.scode, f.env, true, true)).toThrow("--sandbox-block");
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  try {
    expect(values(buildScodeCommand(command, cwd, "low", options, f.scode, f.env, true, true), "--allow-staged")).toEqual([]);
  } finally { Object.defineProperty(process, "platform", descriptor); }
});

test.each([
  ["0.6.6+build.1", false, false], ["0.6.7+build.1", true, false], ["0.6.8-rc1+build.1", true, false],
  ["0.6.8+build.1", true, true], ["0.6.8+20261117.sha-cc76ea3", true, true], ["0.7.0", true, true],
] as const)("every scode gate reads %s the same way", (version, allowRo, current) => {
  // Review round 4, correctness 4: only one gate dropped the build suffix, so the other threw on the same string.
  expect(scodeSupportsAllowRo(version)).toBe(allowRo);
  expect(scodeSupportsAllowStaged(version)).toBe(current);
  expect(scodeSupportsNoLoginStore(version)).toBe(current);
});

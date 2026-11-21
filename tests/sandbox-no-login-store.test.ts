import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildScodeCommand, type SandboxOptions } from "../src/sandbox.js";
import { resolveSandboxOptionsForAgent } from "../src/sandbox-policy.js";
import { parseSandboxPolicyOverrides } from "../src/cli-runtime/options.js";
import { scodeSupportsNoCredentialSync, scodeSupportsNoLoginStore } from "../src/cli-runtime/scode.js";
import { runSandboxed, runSandboxedWithStdin } from "../src/cli-runtime.js";
import { resolveSessionSandboxSpawn } from "../src/session/spawn.js";
import { verifiedScodeCommand, verifiedScodeFeatures } from "../src/verify-scode.js";
import { reportSandboxLoginStore } from "../src/sandbox-login-notice.js";
import { loadConfig } from "../src/config.js";
import { AGENT_IDS } from "../src/types.js";
import { lookupForResume, readRegistry, recordSessionStart } from "../src/session/registry.js";
import { craftEntry, newRecord, probe, seedRegistry } from "./helpers/session-registry.js";

const root = realpathSync(mkdtempSync(join(import.meta.dir, "../scratch/no-login-store-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const home = join(root, "home"), cwd = join(root, "project"), profile = join(home, ".claude");
for (const dir of [cwd, profile, join(home, "Library/Keychains"), join(home, "Library/Preferences"),
  join(home, ".gemini/antigravity-cli")]) mkdirSync(dir, { recursive: true });
for (const path of [join(profile, ".credentials.json"), join(home, "Library/Preferences/com.apple.security.plist"),
  join(home, ".gemini/antigravity-cli/antigravity-oauth-token")]) writeFileSync(path, "synthetic");
const command = ["/bin/echo", "synthetic"];
const values = (argv: string[], flag: string) => argv.filter((_, i) => argv[i - 1] === flag);

test.each([...AGENT_IDS])("%s omits automatic login grants and retains explicit policy", (agentId) => {
  for (const strict of [false, true]) {
    const policy = resolveSandboxOptionsForAgent(agentId, "low", { noLoginStore: true, strict,
      noNet: true, scrubEnv: true, blockPaths: [profile] });
    expect(policy.noLoginStore).toBe(true);
    const argv = buildScodeCommand(command, cwd, "low", policy, "scode", { HOME: home }, true, true, true);
    expect(argv).toContain("--no-login-store");
    expect(argv).toContain("--no-net"); expect(argv).toContain("--scrub-env");
    expect(values(argv, "--block")).toContain(profile);
    expect(values(argv, "--allow-staged")).toEqual([]);
    expect(values(argv, "--allow").some((path) => /Keychains|com\.apple\.security|oauth_refresh|antigravity-oauth-token|credentials\.json/.test(path))).toBe(false);
  }
});

test.each(["claude", "agy"] as const)("%s untrusted grants no login store even without the switch", (agentId) => {
  const argv = buildScodeCommand(command, cwd, "low", { agentId, trust: "untrusted" }, "scode", { HOME: home }, true, true, true);
  expect(values(argv, "--allow")).toEqual([]); expect(values(argv, "--allow-staged")).toEqual([]);
});

test.each(["0.6.7", "0.6.8-rc1", "0.6.8", "0.6.8+build.1", "0.7.0"])("%s gates the flag across runtime and preview paths", async (version) => {
  const bin = join(root, version), argvFile = join(bin, "argv"); mkdirSync(bin);
  writeFileSync(join(bin, "scode"), `#!/bin/sh
if [ "$1" = --version ]; then echo 'scode ${version}'; exit 0; fi
printf '%s\\n' "$@" > "$ARGV_FILE"
exit 0
`, { mode: 0o700 });
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, ARGV_FILE: argvFile };
  const policy: SandboxOptions = { agentId: "claude", noLoginStore: true, blockPaths: [profile] };
  const supported = !["0.6.7", "0.6.8-rc1"].includes(version);
  expect(scodeSupportsNoLoginStore(version)).toBe(supported);
  const session = await resolveSessionSandboxSpawn(command, env, { sandboxed: true, autonomy: "low", sandboxOptions: policy }, cwd);
  expect(session.scodeCmd.includes("--no-login-store")).toBe(supported);
  expect(values(session.scodeCmd, "--allow")).toEqual([]);
  expect(values(session.scodeCmd, "--allow-staged")).toEqual([]);
  expect(await runSandboxed(command, cwd, env, false, "low", policy)).toBe(0);
  expect(readFileSync(argvFile, "utf8").trimEnd().split("\n")).toEqual(session.scodeCmd.slice(1));
  expect((await runSandboxedWithStdin(command, null, cwd, env, "low", policy)).exitCode).toBe(0);
  expect(readFileSync(argvFile, "utf8").trimEnd().split("\n")).toEqual(session.scodeCmd.slice(1));
  const saved = { ...process.env }; Object.assign(process.env, env);
  try {
    const result = verifiedScodeCommand(command, cwd, "low", policy, await verifiedScodeFeatures(cwd));
    expect(result.error).toBeUndefined(); expect(result.command).toEqual(session.scodeCmd.map((v, i) => i === 0 ? "scode" : v));
  } finally { process.env = saved; }
});

test("notices describe enabled grants on TTY and denied native logins on every launch", () => {
  const argv = ["scode", "--allow", join(home, "Library/Keychains"), "--", ...command];
  for (const agentId of ["claude", "agy"] as const) {
    for (const preview of [false, true]) for (const tty of [false, true]) {
      const lines: string[] = [];
      reportSandboxLoginStore(argv, { agentId, loginStore: true }, preview, tty, (line) => lines.push(line), {});
      expect(lines).toHaveLength(tty && !preview ? 1 : 0);
      if (lines.length) expect(lines[0]).toContain("native login-store grant");
      const disabled: string[] = [];
      reportSandboxLoginStore(argv, { agentId, noLoginStore: true }, preview, tty, (line) => disabled.push(line), {});
      expect(disabled).toHaveLength(process.platform === "darwin" ? 1 : 0);
      if (disabled.length) expect(disabled[0]).toContain("the sandbox was not granted the login store");
    }
  }
  const lines: string[] = [];
  reportSandboxLoginStore(["scode", "--", ...command], { agentId: "claude", loginStore: true }, false, true, (line) => lines.push(line));
  reportSandboxLoginStore(argv, { agentId: "codex" }, false, true, (line) => lines.push(line));
  expect(lines).toEqual([]);
});

test("without a writer the grant notice goes to stderr, on every platform", () => {
  const argv = ["scode", "--allow", join(home, "Library/Keychains"), "--", ...command];
  const written: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    reportSandboxLoginStore(argv, { agentId: "claude", loginStore: true }, false, true, undefined, {});
  } finally { process.stderr.write = original; }
  expect(written).toHaveLength(1);
  expect(written[0]).toStartWith("Info: native login-store grant");
  expect(written[0]).toEndWith("\n");
});

test("config accepts booleans only and the CLI ignores policy outside a sandbox with a warning", () => {
  const file = join(root, "config.yaml");
  for (const value of [true, false]) {
    writeFileSync(file, `sandboxNoLoginStore: ${value}\n`);
    expect(loadConfig(file).sandboxNoLoginStore).toBe(value);
  }
  for (const value of ['"true"', "null", "1", "[]", "{}"] ) {
    writeFileSync(file, `sandboxNoLoginStore: ${value}\n`);
    expect(() => loadConfig(file)).toThrow("sandboxNoLoginStore must be a boolean");
  }
  expect(parseSandboxPolicyOverrides({ sandbox: true, sandboxNoLoginStore: true })?.noLoginStore).toBe(true);
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(parseSandboxPolicyOverrides({ sandbox: false, sandboxNoLoginStore: true })).toBeUndefined();
    expect(warning).toHaveBeenCalledTimes(1);
  } finally { warning.mockRestore(); }
});

test("registry retains the off switch and refuses to remove it on resume", () => {
  const path = join(root, "registry/sessions.json");
  expect(recordSessionStart(path, newRecord({ sandboxed: true, sandbox_no_login_store: true })).ok).toBe(true);
  expect(lookupForResume(path, "sess-1", probe({ sandboxed: true, sandboxNoLoginStore: true })).outcome).toBe("ok");
  const result = lookupForResume(path, "sess-1", probe({ sandboxed: true }));
  expect(result.outcome).toBe("refused");
  if (result.outcome === "refused") expect(result.reason).toContain("--sandbox-no-login-store");
  seedRegistry(path, [craftEntry({ sandboxed: true })]);
  const legacy = readRegistry(path);
  expect(legacy.outcome).toBe("ok");
  if (legacy.outcome === "ok") expect(legacy.file.sessions[0]?.sandbox_no_login_store).toBe(false);
  expect(lookupForResume(path, "sess-1", probe({ sandboxed: true, sandboxNoLoginStore: true })).outcome).toBe("ok");
  seedRegistry(path, [craftEntry({ sandbox_no_login_store: "true" as unknown as boolean })]);
  expect(readRegistry(path).outcome).toBe("corrupt");
});

test.each([["0.2.0", false], ["0.3.4", false], ["0.4.0", true], ["0.6.8", true]] as const)(
  "scode %s receives --no-credential-sync=%s: an older scode refuses the unknown option", async (version, supported) => {
    // Review round 4, contracts-2 5: every launch passed the switch, which scode added in 0.4.0; the floor is 0.2.0.
    const bin = join(root, `sync-${version}`); mkdirSync(bin);
    writeFileSync(join(bin, "scode"), `#!/bin/sh\nif [ "$1" = --version ]; then echo 'scode ${version}'; exit 0; fi\nexit 0\n`, { mode: 0o700 });
    const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin` };
    expect(scodeSupportsNoCredentialSync(version)).toBe(supported);
    const session = await resolveSessionSandboxSpawn(command, env, { sandboxed: true, autonomy: "low", sandboxOptions: { agentId: "codex" } }, cwd);
    expect(session.scodeCmd.includes("--no-credential-sync")).toBe(supported);
    expect(buildScodeCommand(command, cwd, "low", { agentId: "codex" }, "scode", env, false, false, false, undefined, supported)
      .includes("--no-credential-sync")).toBe(supported);
    // A builder call that knows no version keeps the switch.
    expect(buildScodeCommand(command, cwd, "low", { agentId: "codex" }, "scode", env)).toContain("--no-credential-sync");
  });

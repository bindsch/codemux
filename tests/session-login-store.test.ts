import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { effectiveLoginStoreGrant } from "../src/sandbox-login-policy.js";
import { resolveSandboxOptionsForAgent } from "../src/sandbox-policy.js";
import { parseSandboxPolicyOverrides } from "../src/cli-runtime/options.js";
import { claimForResume, lookupForResume, readRegistry, resumedLoginStoreGrant } from "../src/session/registry.js";
import { craftEntry, probe, seedRegistry } from "./helpers/session-registry.js";
import { hermeticFixture, HERMETIC_AGENTS } from "./helpers/session-cli-hermetic.js";
import { turnLaunchFixture, TURN_LAUNCH_AGENTS } from "./helpers/session-turn-launch.js";
import * as claude from "./helpers/session-e2e.js";
import * as opencode from "./helpers/session-opencode-e2e.js";

const root = realpathSync(mkdtempSync(join(import.meta.dir, "../scratch/session-login-")));
afterAll(async () => {
  for (const cleanup of [...claude.cleanups, ...opencode.cleanups].reverse()) await cleanup();
  rmSync(root, { recursive: true, force: true });
});

test("user config accepts only booleans and transport requires a sandbox", () => {
  const config = join(root, "config.yaml");
  writeFileSync(config, "{}\n");
  expect(loadConfig(config).sandboxLoginStore).not.toBe(true);
  for (const value of [true, false]) {
    writeFileSync(config, `sandboxLoginStore: ${value}\n`);
    expect(loadConfig(config).sandboxLoginStore).toBe(value);
  }
  for (const value of ['"true"', "null", "1", "[]", "{}"] ) {
    writeFileSync(config, `sandboxLoginStore: ${value}\n`);
    expect(() => loadConfig(config)).toThrow("sandboxLoginStore must be a boolean");
  }
  expect(parseSandboxPolicyOverrides({ sandbox: true, sandboxLoginStore: true })?.loginStore).toBe(true);
  const denied = parseSandboxPolicyOverrides({ sandbox: true, sandboxLoginStore: true, sandboxNoLoginStore: true });
  expect(denied?.loginStore).not.toBe(true);
  expect(denied?.noLoginStore).toBe(true);
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(parseSandboxPolicyOverrides({ sandbox: false, sandboxLoginStore: true })).toBeUndefined();
    expect(warning).toHaveBeenCalledTimes(1);
  } finally { warning.mockRestore(); }
});

test("resume: a recorded --sandbox-no-login-store binds only agents with a native login store", () => {
  // Review round 5, edges 4: a codex session recorded with the restriction
  // refused every resume without it, although its sandbox is the same either way.
  const path = join(root, "registry/no-store.json");
  for (const agent of ["claude", "agy", "codex", "kimi", "zai"]) {
    seedRegistry(path, [craftEntry({ agent, sandboxed: true, sandbox_no_login_store: true })]);
    const dropped = lookupForResume(path, "sess-1", probe({ agent, sandboxed: true }));
    const native = agent === "claude" || agent === "agy";
    expect(dropped.outcome, agent).toBe(native ? "refused" : "ok");
    if (dropped.outcome === "refused") expect(dropped.reason).toContain("created with --sandbox-no-login-store");
    expect(lookupForResume(path, "sess-1", probe({ agent, sandboxed: true, sandboxNoLoginStore: true })).outcome).toBe("ok");
  }
});

test("resume: a configured default never refuses; a typed flag widens only where a native store exists", () => {
  const path = join(root, "registry/sessions.json");
  const configured = { sandboxed: true, sandboxLoginStore: true };
  const typed = { ...configured, sandboxLoginStoreTyped: true };
  for (const agent of ["claude", "agy", "codex"]) for (const recorded of [undefined, false, true]) {
    const entry = craftEntry({ agent, sandboxed: true, ...(recorded === undefined ? {} : { sandbox_login_store: recorded }) });
    seedRegistry(path, [entry]);
    const read = readRegistry(path);
    expect(read.outcome).toBe("ok");
    // Absent stays absent: a 2.0.3 record is not a recorded false.
    if (read.outcome === "ok") expect(read.file.sessions[0]?.sandbox_login_store).toBe(recorded);
    expect(lookupForResume(path, "sess-1", probe({ agent, sandboxed: true })).outcome).toBe("ok");
    expect(lookupForResume(path, "sess-1", probe({ agent, ...configured })).outcome).toBe("ok");
    const flagged = lookupForResume(path, "sess-1", probe({ agent, ...typed }));
    const refuses = recorded === false && agent !== "codex";
    expect(flagged.outcome).toBe(refuses ? "refused" : "ok");
    if (flagged.outcome === "refused") expect(flagged.reason).toContain("created without --sandbox-login-store");
    expect(lookupForResume(path, "sess-1", probe({ agent, ...typed, sandboxNoLoginStore: true })).outcome).toBe("ok");
    // The launch grant: the recorded value, or the request on a legacy record.
    expect(resumedLoginStoreGrant(entry, probe({ agent, sandboxed: true }))).toBe(recorded === true);
    expect(resumedLoginStoreGrant(entry, probe({ agent, ...configured }))).toBe(recorded !== false);
    expect(resumedLoginStoreGrant(entry, probe({ agent, ...configured, sandboxNoLoginStore: true }))).toBe(false);
    expect(resumedLoginStoreGrant(entry, probe({ agent, ...configured, sandboxTrust: "untrusted" }))).toBe(false);
    expect(resumedLoginStoreGrant(entry, probe({ agent, sandboxLoginStore: true }))).toBe(false);
  }
  // A registry write keeps a legacy record's field absent.
  seedRegistry(path, [craftEntry({ sandboxed: true })]);
  expect(claimForResume(path, "sess-1", probe({ sandboxed: true })).outcome).toBe("ok");
  expect(JSON.parse(readFileSync(path, "utf8")).sessions[0]).not.toHaveProperty("sandbox_login_store");
  seedRegistry(path, [craftEntry({ sandbox_login_store: "true" as unknown as boolean })]);
  expect(readRegistry(path).outcome).toBe("corrupt");
});

test.each(HERMETIC_AGENTS)("%s resume keeps the recorded grant under a configured default", async (agent) => {
  const fixture = hermeticFixture(agent);
  try {
    const configFile = join(root, `${agent}-config.yaml`);
    writeFileSync(configFile, "sandboxLoginStore: true\n");
    const config = loadConfig(configFile);
    const granted = await fixture.run(["--sandbox-login-store"], { scodeVersion: "0.6.11" });
    expect(granted.exitCode, granted.stderr).toBe(0);
    expect(fixture.record().sandbox_login_store).toBe(true);
    // No flag and no configured default: the recorded grant is kept.
    const kept = await fixture.run(["--resume", fixture.record().id], { scodeVersion: "0.6.11" });
    expect(kept.exitCode, kept.stderr).toBe(0);
    expect(fixture.record().sandbox_login_store).toBe(true);
    // Rewrite the record as one created without the grant.
    const rewrite = (change: (record: Record<string, unknown>) => void) => {
      const file = JSON.parse(readFileSync(fixture.registryFile, "utf8"));
      change(file.sessions[0]);
      writeFileSync(fixture.registryFile, `${JSON.stringify(file, null, 2)}\n`);
    };
    rewrite((record) => { record.sandbox_login_store = false; });
    const scodeArgs = join(fixture.state, "scode.txt");
    rmSync(scodeArgs, { force: true });
    const configured = await fixture.run(["--resume", fixture.record().id], { scodeVersion: "0.6.11", config });
    expect(configured.exitCalls, configured.stderr).not.toContain(78);
    expect(configured.exitCode, configured.stderr).toBe(0);
    expect(fixture.record().sandbox_login_store).toBe(false);
    expect(readFileSync(scodeArgs, "utf8").split("\n")).not.toContain("--login-store");
    const typed = await fixture.run(["--sandbox-login-store", "--resume", fixture.record().id], { scodeVersion: "0.6.11" });
    if (agent === "agy") {
      expect(typed.exitCalls, typed.stderr).toContain(78);
      expect(typed.stderr).toContain("created without --sandbox-login-store");
    } else {
      // No native login store: the option is a no-op and never refuses.
      expect(typed.exitCalls, typed.stderr).not.toContain(78);
      expect(typed.exitCode, typed.stderr).toBe(0);
    }
    expect(fixture.record().sandbox_login_store).toBe(false);
    // A record written before 2.0.4 has no field: the configured default applies.
    rewrite((record) => { delete record.sandbox_login_store; });
    const legacy = await fixture.run(["--resume", fixture.record().id], { scodeVersion: "0.6.11", config });
    expect(legacy.exitCode, legacy.stderr).toBe(0);
    expect(fixture.record().sandbox_login_store).toBe(true);
    const tightened = await fixture.run(["--sandbox-no-login-store", "--resume", fixture.record().id], { scodeVersion: "0.6.11", config });
    expect(tightened.exitCode, tightened.stderr).toBe(0);
    expect(fixture.record().sandbox_login_store).toBe(false);
  } finally { fixture.cleanup(); }
}, 30_000);

test.each(TURN_LAUNCH_AGENTS)("%s records opt-in for per-turn children", async (agent) => {
  const fixture = turnLaunchFixture(agent);
  try {
    const result = await fixture.run(["--sandbox-login-store"], { scodeVersion: "0.6.11" });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(fixture.record().sandbox_login_store).toBe(true);
  } finally { fixture.cleanup(); }
});

test("Claude and OpenCode writers record explicit permission and denial precedence", async () => {
  for (const harness of [claude, opencode]) for (const denied of [false, true]) {
    const session = await harness.startSession({ sandboxLoginStore: true, sandboxNoLoginStore: denied });
    harness.send(session.driver as never, { type: "user", text: "scenario:basic synthetic" });
    await harness.waitFor(session.events, harness.of("turn_completed"), "turn completed");
    harness.send(session.driver as never, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const read = readRegistry(session.options.registryPath as string);
    expect(read.outcome).toBe("ok");
    if (read.outcome === "ok") expect(read.file.sessions[0]?.sandbox_login_store).toBe(!denied);
  }
});

test("an untrusted request with the login-store option records no grant and resumes with the same flags", () => {
  // The CLI refuses untrusted sessions outright (cli-request.ts), so the
  // create and resume sides are exercised at the record and probe level.
  const path = join(root, "untrusted/sessions.json");
  const flags = { sandbox: true, sandboxLoginStore: true, sandboxTrust: "untrusted" };
  const created = resolveSandboxOptionsForAgent("claude", "low", parseSandboxPolicyOverrides(flags)!);
  // The record's own expression (session/cli-drivers.ts).
  const recorded = created.loginStore === true && !created.noLoginStore;
  expect(recorded).toBe(false);
  seedRegistry(path, [craftEntry({ sandboxed: true, sandbox_trust: "untrusted", sandbox_login_store: recorded })]);
  const same = effectiveLoginStoreGrant({ sandboxed: true, loginStore: true, trust: "untrusted" });
  expect(same).toBe(false);
  const resume = { sandboxed: true, sandboxTrust: "untrusted" as const };
  expect(lookupForResume(path, "sess-1", probe({ ...resume, sandboxLoginStore: same })).outcome).toBe("ok");
  expect(resumedLoginStoreGrant({ sandbox_login_store: true }, probe({ ...resume, sandboxLoginStore: same }))).toBe(false);
  // The raw flag, typed, is the one request that refuses; the refusal says how to resume.
  const raw = lookupForResume(path, "sess-1", probe({ ...resume, sandboxLoginStore: true, sandboxLoginStoreTyped: true }));
  expect(raw.outcome).toBe("refused");
  if (raw.outcome === "refused") expect(raw.reason).toContain("omit the flag to resume it without the grant");
  // Both probe builders derive the value from the one rule.
  for (const file of ["cli-resume.ts", "turn-driver-launch.ts"]) {
    expect(readFileSync(join(import.meta.dir, "../src/session", file), "utf8"))
      .toContain("sandboxLoginStore: effectiveLoginStoreGrant({");
  }
  expect(effectiveLoginStoreGrant({ sandboxed: true, loginStore: true, trust: "standard" })).toBe(true);
  expect(effectiveLoginStoreGrant({ sandboxed: true, loginStore: true, noLoginStore: true })).toBe(false);
  expect(effectiveLoginStoreGrant({ sandboxed: false, loginStore: true })).toBe(false);
});

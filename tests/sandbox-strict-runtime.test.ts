import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { buildScodeCommand } from "../src/sandbox.js";
import { resolveTrustedCommand, trustCheckedCommandPaths } from "../src/executable-security.js";
import { UsageRefusalError } from "../src/validation.js";
import { strictRuntimeGrants } from "../src/sandbox-runtime-grants.js";

const root = realpathSync(mkdtempSync(join(import.meta.dir, "../scratch/strict-runtime-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const home = join(root, "home");
mkdirSync(home);
const env = { HOME: home, PATH: "/opt/homebrew/bin:/usr/bin:/bin" };
const grants = (argv: string[]) => argv.slice(0, argv.indexOf("--"))
  .flatMap((value, index) => value === "--allow" ? [argv[index + 1]!] : []);

test("strict refuses a wrapped executable outside system roots without making it writable", () => {
  const executable = join(root, "bin/agy");
  const command = ["/usr/bin/env", `HOME=${home}`, executable, "--prompt", "/some/unrelated/file"];
  expect(() => buildScodeCommand(command, root, "low", { strict: true })).toThrow(UsageRefusalError);
  expect(grants(buildScodeCommand(command, root, "low"))).toEqual([]);
  expect(() => buildScodeCommand(command, root, "low", { trust: "untrusted" })).toThrow("env-wrapped executable");
  expect(grants(buildScodeCommand(["/usr/bin/env", "A=b", "/bin/echo", "OK"], root, "low", { strict: true }))).toEqual([]);
});

test("a caller block cannot be silently reopened by a wrapped executable grant", () => {
  const executable = join(root, "bin/agy");
  expect(() => buildScodeCommand(["/usr/bin/env", `HOME=${home}`, executable], root, "low",
    { strict: true, blockPaths: [join(root, "bin")] })).toThrow(`env-wrapped executable ${executable}`);
});

test("wrapped system paths retain scode's read-only grant after canonicalization", () => {
  expect(grants(buildScodeCommand(["/usr/bin/env", "A=b", "/usr/../etc/codemux-fixture"], root,
    "low", { strict: true }))).toEqual([]);
  try {
    buildScodeCommand(["/usr/bin/env", join(home, "harness\nname")], root, "low", { strict: true });
    throw new Error("expected refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(UsageRefusalError);
    expect((error as Error).message).toContain("harness\\nname");
    expect((error as Error).message).not.toContain("\n");
  }
});

test("nested wrappers are resolved and checked at every depth", () => {
  const wrapped = ["env", "A=outer", "env", "A=inner", "/bin/echo", "OK"];
  const resolved = resolveTrustedCommand(wrapped, "fixture", root, env.PATH);
  expect(trustCheckedCommandPaths(resolved)).toEqual(["/usr/bin/env", "/usr/bin/env", realpathSync("/bin/echo")]);
  expect(grants(buildScodeCommand(resolved, root, "low", { strict: true }))).toEqual([]);
  expect(() => buildScodeCommand(["/usr/bin/env", "A=b", "/usr/bin/env", "C=d", join(home, "hidden")],
    root, "low", { strict: true })).toThrow(`env-wrapped executable ${join(home, "hidden")}`);
});

test("malformed env prefixes are usage refusals under strict and untrusted", () => {
  for (const options of [{ strict: true }, { trust: "untrusted" as const }]) {
    for (const command of [["/usr/bin/env", "A=b"], ["/usr/bin/env", "/usr/bin/env", "-i", "/bin/echo"]]) {
      expect(() => buildScodeCommand(command, root, "low", options)).toThrow(UsageRefusalError);
      expect(() => buildScodeCommand(command, root, "low", options)).toThrow("env prefix names no program");
    }
  }
});

test("a state grant cannot make any harness executable writable", () => {
  expect(() => buildScodeCommand([join(home, "bin/harness")], root, "low",
    { strict: true, harnessStateDirs: [home] })).toThrow("writable executable grant");
});

test("Claude's hard-coded macOS scratch grant is per-user, not all of tmp", () => {
  expect(strictRuntimeGrants("claude", ["/opt/bin/claude.exe"], env, "darwin", 1234)).toEqual(["/private/tmp/claude-1234"]);
  expect(strictRuntimeGrants("claude", ["/opt/bin/claude"], env, "linux", 1234)).toEqual([]);
  expect(strictRuntimeGrants("codex", ["/opt/bin/codex", "/opt/bin/claude"], env, "darwin", 1234)).toEqual([]);
});

test("OpenCode gets its three missing state roots, not a home grant", () => {
  expect(strictRuntimeGrants("opencode", ["/opt/bin/opencode"], env)).toEqual([
    join(home, ".opencode"), join(home, ".local/state/opencode"), join(home, ".cache/opencode"),
  ]);
});

test("runtime state follows the actual launch environment and transparent wrapper", () => {
  const privateHome = join(root, "private"), state = join(root, "state"), cache = join(root, "cache");
  expect(strictRuntimeGrants("opencode", ["/usr/bin/env", "-u", "XDG_CACHE_HOME", `HOME=${privateHome}`,
    `XDG_STATE_HOME=${state}`, "/opt/bin/opencode"], { ...env, XDG_CACHE_HOME: cache })).toEqual([
    join(privateHome, ".opencode"), join(state, "opencode"), join(privateHome, ".cache/opencode"),
  ]);
});

test("nested runtime wrappers apply inner assignments and unsets last", () => {
  expect(strictRuntimeGrants("opencode", ["/usr/bin/env", `HOME=${root}`, `XDG_CACHE_HOME=${root}/outer`,
    "/usr/bin/env", "-u", "XDG_CACHE_HOME", `HOME=${home}`, "/opt/bin/opencode"], env)).toEqual([
    join(home, ".opencode"), join(home, ".local/state/opencode"), join(home, ".cache/opencode"),
  ]);
});

test("launcher blocks suppress runtime grants while private state remains allowed", () => {
  const privateHome = join(home, "data/opencode/private");
  const options = { agentId: "opencode" as const, strict: true, callerBlockPaths: [], blockPaths: [join(home, "data/opencode")],
    harnessStateDirs: [privateHome] };
  const command = ["/usr/bin/env", `HOME=${privateHome}`, "/usr/bin/env", "A=b", "/opt/bin/opencode"];
  expect(grants(buildScodeCommand(command, root, "low", options, "scode", { HOME: privateHome }))).toEqual([privateHome]);
  expect(() => buildScodeCommand(command, root, "low", {
    ...options, callerBlockPaths: [join(privateHome, ".cache")],
  }, "scode", { HOME: privateHome })).toThrow("--sandbox-block");
});

test("relative XDG roots fail instead of minting a cwd-dependent grant", () => {
  expect(() => strictRuntimeGrants("opencode", ["/opt/bin/opencode"], { ...env, XDG_STATE_HOME: "relative" }))
    .toThrow("absolute path");
});

test("an XDG application root equal to HOME cannot become a blanket grant", () => {
  expect(() => strictRuntimeGrants("opencode", ["/opt/bin/opencode"], {
    ...env, HOME: join(root, "opencode"), XDG_STATE_HOME: root,
  })).toThrow("must not grant HOME or its ancestors");
});

test("redirecting an application state directory to HOME cannot broaden strict", () => {
  const redirected = join(root, "redirected");
  mkdirSync(redirected);
  symlinkSync(home, join(redirected, "opencode"));
  expect(() => strictRuntimeGrants("opencode", ["/opt/bin/opencode"], { ...env, XDG_STATE_HOME: redirected }))
    .toThrow("must not grant HOME or its ancestors");
});

test("canonical parent aliases preserve a narrow application grant", () => {
  const state = join(root, "state-parent"), alias = join(root, "state-alias");
  mkdirSync(state); symlinkSync(state, alias);
  expect(strictRuntimeGrants("opencode", ["/opt/bin/opencode"], { ...env, XDG_STATE_HOME: alias }))
    .toContain(join(state, "opencode"));
});

test("untrusted retains its no-state-grants policy", () => {
  expect(grants(buildScodeCommand(["/opt/bin/opencode"], root, "low", { agentId: "opencode", strict: true, trust: "untrusted" }, "scode", env)))
    .toEqual([]);
});

test("a caller block cannot be silently reopened by runtime state", () => {
  expect(() => buildScodeCommand(["/opt/bin/opencode"], root, "low",
    { agentId: "opencode", strict: true, blockPaths: [join(home, ".cache/opencode")] }, "scode", env)).toThrow("--sandbox-block");
});

const scode = Bun.which("scode");
test.skipIf(process.platform !== "darwin" || scode === null)("scode dry-run keeps isolation blocks and reopens only private state", async () => {
  const project = join(root, "profile-project"), blocked = join(home, "profile-opencode");
  const privateHome = join(blocked, "private"), executable = join(root, "profile-bin/opencode");
  mkdirSync(project); mkdirSync(privateHome, { recursive: true }); mkdirSync(join(root, "profile-bin"));
  writeFileSync(executable, "#!/bin/sh\nexit 99\n"); chmodSync(executable, 0o700);
  const config = join(project, "scode.yaml"); writeFileSync(config, "");
  const argv = buildScodeCommand([executable], project, "low", { agentId: "opencode", strict: true,
    callerBlockPaths: [], blockPaths: [blocked], harnessStateDirs: [privateHome] }, scode!, { HOME: privateHome });
  expect(grants(argv)).toEqual([privateHome]);
  argv.splice(1, 0, "--dry-run", "--no-credential-sync", "--config", config);
  const child = Bun.spawn(argv, { env: { ...env, HOME: homedir() }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, stderr).toBe(0);
  expect(stdout).toContain("(deny default)");
  expect(stdout).toContain(`(subpath "${blocked}")`);
  expect(stdout).toContain(`(subpath "${privateHome}")`);
  expect(stdout).not.toContain(`(subpath "${privateHome}/.opencode")`);
  // Scode's final parent deny precedes its deliberate private-child allow.
  expect(stdout.lastIndexOf(`(subpath "${privateHome}")`)).toBeGreaterThan(stdout.lastIndexOf(`(subpath "${blocked}")`));
  expect(stdout).toContain(`(literal "${executable}")`);
  expect(stdout).not.toContain(`(subpath "${executable}")`);
}, 20_000);

test.skipIf(process.platform !== "darwin" || scode === null)("macOS denies wrapped fixture and keeps bare executable read-only", async () => {
  const project = join(root, "project"), executable = join(home, "bin/fixture-harness"), canary = join(home, "canary");
  mkdirSync(project); mkdirSync(join(home, "bin"));
  writeFileSync(canary, "strict-runtime-canary\n");
  writeFileSync(executable, '#!/bin/sh\nprintf "OK\\n"\n/bin/cat "$1"\nprintf "# write\\n" >> "$0"\n');
  const config = join(root, "scode.yaml");
  writeFileSync(config, "");
  chmodSync(executable, 0o700);
  const command = resolveTrustedCommand(["env", `HOME=${home}`, executable, canary], "fixture", project, env.PATH);
  expect(() => buildScodeCommand(command, project, "low", { strict: true }, scode!, env)).toThrow("env-wrapped executable");
  for (const strict of [false, true]) {
    const original = readFileSync(executable, "utf8");
    const argv = buildScodeCommand([executable, canary], project, "low", { strict, noNet: true }, scode!, env);
    argv.splice(1, 0, "--no-credential-sync", "--config", config);
    // Scode must keep the account HOME so its account-home deny rule does
    // not cover this fixture. Only the child receives the synthetic HOME.
    const child = Bun.spawn(argv, { cwd: project, env: { ...env, HOME: homedir() }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stdout, `strict=${strict}: ${stderr}`).toStartWith("OK\n");
    if (strict) { expect(code).not.toBe(0); expect(readFileSync(executable, "utf8")).toBe(original); expect(stderr).toContain("Operation not permitted"); expect(stdout).not.toContain("strict-runtime-canary"); }
    else { expect(code, stderr).toBe(0); expect(stdout).toContain("strict-runtime-canary"); }
  }
}, 20_000);

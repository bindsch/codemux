import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildScodeCommand, type SandboxOptions } from "../src/sandbox.js";
import { sandboxLoginUnavailable } from "../src/sandbox-login-policy.js";
import { reportSandboxLoginStore } from "../src/sandbox-login-notice.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { AgyAdapter } from "../src/adapters/agy.js";

const root = realpathSync(mkdtempSync(join(import.meta.dir, "../scratch/login-opt-in-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const pref = join(root, "Library/Preferences/com.apple.security.plist");
const keychains = join(root, "Library/Keychains");
for (const path of [keychains, join(root, "Library/Preferences"), join(root, ".claude"), join(root, ".gemini/antigravity-cli")]) mkdirSync(path, { recursive: true });
writeFileSync(pref, "synthetic preferences");
writeFileSync(join(root, ".claude/.credentials.json"), "synthetic fallback");
writeFileSync(join(root, ".gemini/antigravity-cli/antigravity-oauth-token"), "synthetic fallback");
const values = (argv: string[], flag: string) => argv.filter((_, i) => argv[i - 1] === flag);
const build = (options: SandboxOptions, env: NodeJS.ProcessEnv = {}, ro = true, modern = true) =>
  buildScodeCommand(["/bin/echo", "synthetic"], undefined, "low", options, "scode", { HOME: root, ...env }, ro, modern, modern);

test.each(["claude", "agy"] as const)("%s requires opt-in and gives security preferences only read access", (agentId) => {
  for (const options of [{ agentId }, { agentId, loginStore: false },
    { agentId, loginStore: true, noLoginStore: true }, { agentId, loginStore: true, trust: "untrusted" as const }]) {
    const argv = build(options);
    expect(argv).toContain("--no-login-store");
    // agy's own file token needs no opt-in (tests/agy-file-token-grant.test.ts);
    // an explicit no-login-store and untrusted trust withhold it too.
    const fileToken = agentId === "agy" && !("noLoginStore" in options) && !("trust" in options)
      ? [join(root, ".gemini/antigravity-cli/antigravity-oauth-token")] : [];
    expect(values(argv, "--allow")).toEqual(fileToken);
    for (const flag of ["--allow-ro", "--allow-staged"]) expect(values(argv, flag)).toEqual([]);
  }
  const enabled = build({ agentId, loginStore: true });
  expect(enabled).toContain("--login-store");
  expect(enabled).not.toContain("--no-login-store");
  if (process.platform === "darwin") {
    expect(values(enabled, "--allow")).toContain(keychains);
    expect(values(enabled, "--allow-ro")).toEqual([pref]);
    expect(values(enabled, "--allow")).not.toContain(pref);
    expect(() => build({ agentId, loginStore: true }, {}, false)).toThrow("read-only security preferences");
    expect(() => build({ agentId, loginStore: true, blockPaths: [pref] })).toThrow("--sandbox-block");
  }
  const legacy = build({ agentId, loginStore: true }, {}, true, false);
  expect(legacy).not.toContain("--login-store");
  expect(legacy).not.toContain("--no-login-store");
});

test("missing security preferences get no grant and no file creation", () => {
  const home = join(root, "absent");
  mkdirSync(join(home, "Library/Keychains"), { recursive: true });
  const argv = build({ agentId: "agy", loginStore: true }, { HOME: home });
  expect(values(argv, "--allow-ro")).toEqual([]);
  expect(argv.some((arg) => arg.includes("com.apple.security.plist"))).toBe(false);
});

test.each([
  ["claude", { ANTHROPIC_API_KEY: "synthetic" }], ["claude", { ANTHROPIC_BASE_URL: "http://127.0.0.1" }],
  ["claude", { ANTHROPIC_AUTH_TOKEN: "synthetic" }], ["claude", { CLAUDE_CODE_OAUTH_TOKEN: "synthetic" }],
  ["agy", { GEMINI_API_KEY: "synthetic" }], ["agy", { GOOGLE_API_KEY: "synthetic" }],
  ["zai", {}], ["codex", {}],
] as const)("%s alternative authentication never receives native grants", (agentId, env) => {
  const argv = build({ agentId, loginStore: true }, env);
  expect(argv).toContain("--no-login-store");
  expect(values(argv, "--allow")).toEqual([]);
  expect(values(argv, "--allow-ro")).toEqual([]);
  expect(values(argv, "--allow-staged")).toEqual([]);
  expect(sandboxLoginUnavailable({ agentId }, env, "darwin")).toBe(false);
});

test.each([
  ["claude", { ANTHROPIC_API_KEY: "   " }],
  ["agy", { GEMINI_API_KEY: "   " }],
  ["agy", { GOOGLE_API_KEY: "\t" }],
] as const)("%s treats a whitespace-only key as no key and keeps the operator-login route", (agentId, env) => {
  const argv = build({ agentId, loginStore: true }, env);
  expect(argv).toContain("--login-store");
  // No key means operator login: without the opt-in the notice explains
  // the sandbox, exactly as with no key set at all.
  expect(sandboxLoginUnavailable({ agentId }, env, "darwin")).toBe(true);
  expect(sandboxLoginUnavailable({ agentId, loginStore: true }, env, "darwin")).toBe(false);
});

test.each(["claude", "agy"] as const)(
  "%s decides on the post-scrub environment: a scrubbed ambient key is not authentication", (agentId) => {
    const key = agentId === "agy" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY";
    const env = { [key]: "synthetic" };
    const scrub = { agentId, scrubEnv: true as const };
    // The scrub removes the ambient key, so the run is operator-login:
    // the opt-in grants, and without it the notice explains the sandbox.
    expect(build({ ...scrub, loginStore: true }, env)).toContain("--login-store");
    expect(sandboxLoginUnavailable(scrub, env, "darwin")).toBe(true);
    expect(build(scrub, env)).toContain("--no-login-store");
    // A key codemux injected rides the keep-env exemption and still counts.
    const exempt = { ...scrub, keepEnv: [key] };
    expect(build({ ...exempt, loginStore: true }, env)).toContain("--no-login-store");
    expect(sandboxLoginUnavailable(exempt, env, "darwin")).toBe(false);
    // Untrusted trust implies the scrub, with the same post-scrub decision.
    expect(sandboxLoginUnavailable({ agentId, trust: "untrusted" as const }, env, "darwin")).toBe(true);
    // A base URL survives the scrub (configuration, not a credential).
    if (agentId === "claude") {
      expect(sandboxLoginUnavailable(scrub, { ANTHROPIC_BASE_URL: "http://127.0.0.1" }, "darwin")).toBe(false);
    }
  });

test.each(["claude", "agy"] as const)("%s unavailable-login notice is independent of TTY and names the enabling option", (agentId) => {
  for (const tty of [true, false]) for (const noLoginStore of [undefined, true]) {
    const lines: string[] = [];
    reportSandboxLoginStore(["scode", "--", "synthetic"], { agentId, noLoginStore }, false, tty, (line) => lines.push(line), {});
    expect(lines.length).toBe(process.platform === "darwin" ? 1 : 0);
    if (lines.length) {
      expect(lines[0]).toContain("--sandbox-login-store or sandboxLoginStore: true");
      expect(lines[0]).toContain("docs/isolation.md");
      expect(lines[0]).not.toMatch(/logged out|not logged in/i);
    }
  }
  expect(sandboxLoginUnavailable({ agentId }, {}, "linux")).toBe(false);
});

test("native authentication errors repeat the unavailable grant instead of prescribing login", () => {
  const context = { sandboxLoginStoreDenied: true };
  const claude = new ClaudeAdapter({});
  const raw = { stdout: JSON.stringify({ type: "result", is_error: true, result: "Not logged in" }), stderr: "", exitCode: 1, success: false };
  const result = claude.processRunResult(raw, { agent: "claude", prompt: "test", sandboxed: true }, context);
  expect(result.stderr).toContain("the sandbox was not granted the login store");
  expect(result.stderr).not.toContain("claude auth login");
  const agy = new AgyAdapter({});
  const failed = agy.processRunResult({ ...raw, stdout: JSON.stringify({ event: "result", result: {
    status: "ERROR", error: "authentication failed or timed out", response: "" } }) }, { agent: "agy", prompt: "test" }, context);
  expect(failed.stderr).toContain("the sandbox was not granted the login store");
  const other = agy.processRunResult({ ...raw, stdout: JSON.stringify({ event: "result", result: {
    status: "ERROR", error: "provider unavailable", response: "" } }) }, { agent: "agy", prompt: "test" }, context);
  expect(other.stderr).not.toContain("the sandbox was not granted");
});

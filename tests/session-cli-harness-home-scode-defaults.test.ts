// Review R420 M2: --harness-home must never reopen one of scode's default
// blocks (an --allow beneath a default-blocked parent re-allows it), and a
// shared login directory is granted only strictly inside an operator store.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDefaultConfig } from "../src/config.js";
import { SCODE_DEFAULT_BLOCKS, scodeDefaultBlockedPaths } from "../src/launch/scode-default-blocks.js";
import { applyHarnessHomeSandboxBlocks } from "../src/launch/harness-home-sandbox.js";
import type { SandboxOptions } from "../src/sandbox.js";
import { resolveSessionRequest } from "../src/session/cli-request.js";
import { validateHarnessHome } from "../src/session/harness-home.js";
import { sessionRegistryPath } from "../src/session/registry.js";
import { refusingCall } from "./helpers/session-cli-hermetic.js";

const roots: string[] = [];
// The macOS codemux state directory, derived from the registry seam rather
// than spelled by hand (session-cli-happy-path "registry path seam").
const codemuxMacState = (home: string): string => dirname(sessionRegistryPath(home, "darwin"));
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fakeHome(): { home: string; cwd: string } {
  const parent = join(import.meta.dir, "..", "scratch", "fix", "scode-defaults");
  mkdirSync(parent, { recursive: true });
  const home = realpathSync(mkdtempSync(join(parent, "home-")));
  roots.push(home);
  const cwd = join(home, "work");
  mkdirSync(codemuxMacState(home), { recursive: true });
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(cwd);
  return { home, cwd };
}

test.each([
  "Library/Application Support/codemux", "Library/Application Support", "Library", ".ssh/agent-home",
  ".config", ".config/gh/nested", "Documents/agent-home", ".local/share",
])("refuses a caller home overlapping scode default block %s", (relative) => {
  const { home, cwd } = fakeHome();
  expect(() => validateHarnessHome(join(home, relative), cwd, [], scodeDefaultBlockedPaths(home)))
    .toThrow("must not overlap scode's default-blocked path");
});

test("accepts a caller home outside every scode default block", () => {
  const { home, cwd } = fakeHome();
  const dir = join(home, "agent-homes", "job");
  expect(validateHarnessHome(dir, cwd, [], scodeDefaultBlockedPaths(home))).toBe(dir);
});

test("the session CLI refuses a codemux credential-backup directory with exit 64", () => {
  const { home, cwd } = fakeHome();
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    const refusal = refusingCall(() => resolveSessionRequest({
      agent: "codex", cwd, sandbox: true, harnessHome: codemuxMacState(home),
    }, getDefaultConfig()));
    expect(refusal.code).toBe(64);
    expect(refusal.message).toContain(`must not overlap scode's default-blocked path ${join(home, "Library")}`);
  } finally { process.env.HOME = saved; }
});

// The table is a copy of scode's arrays; compare it with an installed scode
// script, read as data, whenever one is present.
test("the default-block table matches an installed scode", () => {
  const scode = Bun.which("scode");
  if (scode === null || !existsSync(scode)) return;
  const text = readFileSync(scode, "utf8");
  const entries: string[] = [];
  for (const name of ["DEFAULT_BLOCKED", "LINUX_EXTRA_BLOCKED", "DARWIN_EXTRA_BLOCKED"]) {
    const start = text.indexOf(`\n${name}=(\n`);
    if (start < 0) return; // Not a scode build this table can be compared with.
    const body = text.slice(start, text.indexOf("\n)\n", start));
    for (const match of body.matchAll(/^\s*"\$HOME\/([^"]+)"/gm)) entries.push(match[1]!);
  }
  expect(([...SCODE_DEFAULT_BLOCKS] as string[]).sort()).toEqual(entries.sort());
});

test("a shared login directory is granted only strictly inside an operator store", () => {
  const { home } = fakeHome();
  const store = join(home, ".kimi-code");
  const credentials = join(store, "credentials");
  const caller = join(home, "agent-homes", "job");
  const options: SandboxOptions = {};
  applyHarnessHomeSandboxBlocks(options, caller, [store], [credentials]);
  expect(options.blockPaths).toEqual([store]);
  expect(options.harnessStateDirs).toEqual([caller, credentials]);
  expect(() => applyHarnessHomeSandboxBlocks({}, caller, [store], [store])).toThrow("strictly inside");
  expect(() => applyHarnessHomeSandboxBlocks({}, caller, [store], [join(home, "elsewhere")])).toThrow("strictly inside");
  expect(() => applyHarnessHomeSandboxBlocks({}, caller, [store], [join(caller, "credentials")])).toThrow("strictly inside");
  expect(() => applyHarnessHomeSandboxBlocks({ blockPaths: [credentials] }, caller, [store], [credentials])).toThrow("--sandbox-block");
});

// A plain sandboxed agy session blocks the operator's real ~/.gemini. Its
// private home reaches shared state through links into that tree, so each
// shared entry needs its own grant (review round 3): the printed sandbox
// argv allows exactly the shared entries and keeps the state root blocked.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { agySharedStateEntries } from "../src/adapters/agy-shared-state.js";
import { prepareAgySessionRunHome } from "../src/session/agy-run-home.js";
import type { SandboxOptions } from "../src/sandbox.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import { cleanup as loginCleanup, setup } from "./helpers/agy-login.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of [...cleanup.splice(0), ...loginCleanup.splice(0)].reverse()) fn(); });

function seed(home: string): void {
  const state = join(home, ".gemini");
  mkdirSync(join(state, "antigravity-cli/conversations"), { recursive: true });
  mkdirSync(join(state, ".codemux-isolation-probes/session-other"), { recursive: true });
  mkdirSync(join(state, "skills"));
  writeFileSync(join(state, "GEMINI.md"), "synthetic instructions");
  writeFileSync(join(state, "antigravity-cli/settings.json"), "{}");
  writeFileSync(join(state, "antigravity-cli/antigravity-oauth-token"), "synthetic token");
}

function fixture() {
  const home = realpathSync(mkdtempSync(resolve("scratch/fix/agy-session-shared-")));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const cwd = join(home, "work");
  mkdirSync(cwd);
  seed(home);
  const fake = createFakeBinaryEnv({
    scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
    agy: `if [ "$1" = "--version" ]; then printf '1.5.9\n'; exit 0; fi\nexit 90`,
  }, "0.6.8");
  cleanup.push(fake.cleanup);
  return { home, cwd, state: join(home, ".gemini"), env: { ...fake.env, HOME: home, GEMINI_API_KEY: "", GOOGLE_API_KEY: "" } };
}

const values = (argv: string[], flag: string) => argv.filter((_, i) => argv[i - 1] === flag);

test.each(["read-only", "medium"] as const)(
  "the printed sandbox of a plain agy session allows the shared entries and blocks the state root: %s", async (auto) => {
    const f = fixture();
    const result = await runCli(["session", "-a", "agy", "--cwd", f.cwd, "--auto", auto, "--print-sandbox"], f.env);
    expect(result.exitCode, result.stderr).toBe(0);
    const argv = result.stdout.trimEnd().split("\n");
    expect(values(argv, "--block")).toContain(f.state);
    const allowed = values(argv, "--allow");
    const shared = [join(f.state, "GEMINI.md"), join(f.state, "skills"),
      join(f.state, "antigravity-cli/conversations"),
      // A medium session writes a private settings.json, so the operator's is not shared.
      ...(auto === "medium" ? [] : [join(f.state, "antigravity-cli/settings.json")])];
    for (const path of shared) expect(allowed).toContain(path);
    // The file token is agy's own login file: granted by exact path.
    expect(allowed).toContain(join(f.state, "antigravity-cli/antigravity-oauth-token"));
    expect(allowed).toContain(join(f.state, ".codemux-isolation-probes/preview"));
    // Never the state root, the antigravity-cli directory, or another launch's home.
    const granted = [...allowed, ...values(argv, "--allow-ro")];
    expect(granted).not.toContain(f.state);
    expect(granted).not.toContain(join(f.state, "antigravity-cli"));
    expect(granted.some((path) => path.includes("session-other"))).toBe(false);
    if (auto === "medium") expect(granted).not.toContain(join(f.state, "antigravity-cli/settings.json"));
    expect(granted.filter((path) => path.startsWith(`${f.state}/`)).length).toBe(shared.length + 2);
  });

test("the grants are the link pass's own list: every shared link target is granted", async () => {
  const f = setup();
  seed(f.home);
  const previousHome = process.env.HOME;
  process.env.HOME = f.home;
  const sandboxOptions: SandboxOptions = { agentId: "agy" };
  const prepared = prepareAgySessionRunHome(f.adapter, f.request, sandboxOptions, false, false);
  try {
    const home = prepared.context!.agyProbe!.home!;
    const entries = agySharedStateEntries(f.home, false);
    expect(entries.map((entry) => entry.relative)).toEqual([".gemini/GEMINI.md", ".gemini/skills",
      ".gemini/antigravity-cli/conversations", ".gemini/antigravity-cli/settings.json"]);
    for (const entry of entries) {
      expect(readlinkSync(join(home, entry.relative))).toBe(entry.source);
      expect(sandboxOptions.harnessStateDirs).toContain(entry.source);
    }
    expect(sandboxOptions.harnessStateDirs).toEqual([home, ...entries.map((entry) => entry.source)]);
  } finally {
    await prepared.cleanup();
    process.env.HOME = previousHome;
  }
});

test("a caller block over a shared entry keeps that entry closed; one inside a shared directory is refused", async () => {
  const f = setup();
  seed(f.home);
  const previousHome = process.env.HOME;
  process.env.HOME = f.home;
  const state = join(f.home, ".gemini");
  const covered: SandboxOptions = { agentId: "agy", blockPaths: [join(state, "skills")] };
  const prepared = prepareAgySessionRunHome(f.adapter, f.request, covered, false, false);
  try {
    expect(covered.harnessStateDirs).not.toContain(join(state, "skills"));
    expect(covered.harnessStateDirs).toContain(join(state, "GEMINI.md"));
    expect(covered.blockPaths).toEqual([join(state, "skills"), state]);
  } finally {
    await prepared.cleanup();
  }
  try {
    const inside: SandboxOptions = { agentId: "agy", blockPaths: [join(state, "antigravity-cli/conversations/one")] };
    expect(() => prepareAgySessionRunHome(f.adapter, f.request, inside, false, false))
      .toThrow(/sits inside the launch's own harness state directory/);
    expect(existsSync(join(state, ".codemux-isolation-probes/session-other"))).toBe(true);
  } finally {
    process.env.HOME = previousHome;
  }
});

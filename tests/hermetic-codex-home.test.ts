import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { RunContext } from "../src/run-context.js";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexHermeticHome } from "../src/hermetic-home.js";
import type { RunRequest } from "../src/types.js";
import { codexAdapter, fakeHome, newSignalListeners, prepare, prepared, scratch, signalListeners } from "./helpers/hermetic-codex.js";

describe("hermetic runs: codex", () => {
  let baseline = signalListeners();
  beforeEach(() => {
    baseline = signalListeners();
  });
  afterEach(() => {
    for (const { adapter, context } of prepared.splice(0)) adapter.cleanupRun(context);
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
    // No home may leave a signal handler behind: a later synthetic signal
    // in another test would otherwise end the whole test process.
    expect(newSignalListeners(baseline)).toBe(0);
  });

  function privateHome(cmd: string[]): { home: string; codexHome: string } {
    return { home: cmd[1]!.slice("HOME=".length), codexHome: cmd[2]!.slice("CODEX_HOME=".length) };
  }

  test("prepareRun creates a private HOME and CODEX_HOME inside the real one, holding only the linked login", () => {
    const home = fakeHome();
    const adapter = codexAdapter({}, home);
    expect(adapter.buildRunCommand({ agent: "codex", prompt: "p" })[0]).toBe("codex");
    const request: RunRequest = { agent: "codex", prompt: "p", hermetic: true };
    const context = prepare(adapter, request);
    const cmd = adapter.buildRunCommand(request, context);
    const priv = privateHome(cmd);
    expect(priv.home.startsWith(join(home, ".codex", ".codemux-hermetic", `run-${process.pid}-`))).toBe(true);
    expect(readdirSync(priv.home)).toEqual([".codex"]);
    expect(readdirSync(priv.codexHome)).toEqual(["auth.json"]);
    expect(priv.codexHome).toBe(join(priv.home, ".codex"));
    const link = join(priv.codexHome, "auth.json");
    expect(statSync(link).ino).toBe(statSync(join(home, ".codex", "auth.json")).ino);
    expect(adapter.getRunEnv(request, context)).toEqual({});
    // Repeated builds for the same prepared run agree.
    expect(adapter.buildRunCommand(request, context).slice(0, 3)).toEqual(cmd.slice(0, 3));
  });

  test("the real login is the one a plain run sees: ~/.codex, or CODEX_HOME only when passed through", () => {
    const home = fakeHome();
    const profile = fakeHome();
    const adapter = codexAdapter({ CODEX_HOME: join(profile, ".codex") }, home);
    // Not passed through: the sanitized child environment drops it.
    const request: RunRequest = { agent: "codex", prompt: "p", hermetic: true };
    const priv = privateHome(adapter.buildRunCommand(request, prepare(adapter, request)));
    expect(priv.home.startsWith(join(home, ".codex", ".codemux-hermetic"))).toBe(true);
    expect(lstatSync(join(priv.codexHome, "auth.json")).isFile()).toBe(true);
    // Passed through: the plain run uses that profile, so the hermetic run
    // links that profile's login.
    const profiledRequest: RunRequest = { agent: "codex", prompt: "p", hermetic: true, passthroughEnv: ["CODEX_HOME"] };
    const profiled = privateHome(
      adapter.buildRunCommand(profiledRequest, prepare(adapter, profiledRequest))
    );
    expect(profiled.home.startsWith(join(profile, ".codex", ".codemux-hermetic"))).toBe(true);
  });

  test("refuses a missing file login and explains the Keychain case", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-nologin-"));
    scratch.push(home);
    expect(() => codexAdapter({}, home).prepareRun({ agent: "codex", prompt: "p", hermetic: true }))
      .toThrow(/need a file login.*Keychain.*CODEX_API_KEY/s);
  });

  test("CODEX_API_KEY makes the run API-key-only: no login is linked, with or without a login file", () => {
    const withoutLogin = mkdtempSync(join(tmpdir(), "codemux-codex-apikey-"));
    scratch.push(withoutLogin);
    mkdirSync(join(withoutLogin, ".codex"));
    for (const home of [withoutLogin, fakeHome()]) {
      const adapter = codexAdapter({ CODEX_API_KEY: "sk-test" }, home);
      const request: RunRequest = { agent: "codex", prompt: "p", hermetic: true };
      const context = prepare(adapter, request);
      const priv = privateHome(adapter.buildRunCommand(request, context));
      expect(readdirSync(priv.codexHome)).toEqual([]);
      expect(adapter.getRunEnv(request, context)).toEqual({});
    }
  });

  test("a stray OPENAI_API_KEY does not switch a hermetic run away from the account login", () => {
    // Codex 0.154 ignores OPENAI_API_KEY, so a plain run uses the file
    // login; the hermetic run must use the very same credential.
    const home = fakeHome();
    const adapter = codexAdapter({ OPENAI_API_KEY: "sk-old" }, home);
    const request: RunRequest = { agent: "codex", prompt: "p", hermetic: true };
    const context = prepare(adapter, request);
    const priv = privateHome(adapter.buildRunCommand(request, context));
    expect(readdirSync(priv.codexHome)).toEqual(["auth.json"]);
    expect(adapter.getRunEnv(request, context)).toEqual({});
  });

  test("every hermetic run gets a fresh home; an earlier run's home stays until its context is cleaned up", () => {
    const adapter = codexAdapter({}, fakeHome());
    const firstRequest: RunRequest = { agent: "codex", prompt: "p", hermetic: true };
    const first = privateHome(
      adapter.buildRunCommand(firstRequest, prepare(adapter, firstRequest))
    );
    writeFileSync(join(first.home, "leftover"), "x");
    const secondRequest: RunRequest = { agent: "codex", prompt: "p", hermetic: true };
    const second = privateHome(
      adapter.buildRunCommand(secondRequest, prepare(adapter, secondRequest))
    );
    expect(second.home).not.toBe(first.home);
    // Still there: the first run's context has not been cleaned up, and a
    // run started earlier may still be using its home.
    expect(statSync(join(first.home, "leftover")).isFile()).toBe(true);
    expect(readdirSync(second.home)).toEqual([".codex"]);
  });

  test("two concurrent hermetic runs each launch in their own home", () => {
    // The round6 finding: the prepared home was a shared adapter field, so
    // run B's prepareRun overwrote run A's and A's command would have
    // pointed at B's home. The home is this run's own context now, so an
    // in-flight run keeps its own.
    const adapter = codexAdapter({}, fakeHome());
    const first: RunRequest = { agent: "codex", prompt: "p", hermetic: true };
    const firstContext = prepare(adapter, first);
    const firstHome = privateHome(adapter.buildRunCommand(first, firstContext));
    writeFileSync(join(firstHome.home, "marker"), "first");
    const second: RunRequest = { agent: "codex", prompt: "q", hermetic: true };
    const secondHome = privateHome(
      adapter.buildRunCommand(second, prepare(adapter, second))
    );
    expect(secondHome.home).not.toBe(firstHome.home);
    // A's command still names A's home after B prepared its own, and A's
    // launch path still finds its prepared home.
    expect(adapter.buildRunCommand(first, firstContext)[1]).toBe(`HOME=${firstHome.home}`);
    expect(adapter.getRunEnv(first, firstContext)).toEqual({});
    expect(statSync(join(firstHome.home, "marker")).isFile()).toBe(true);
  });

  test("a symlinked hermetic parent directory is refused", () => {
    const home = fakeHome();
    const elsewhere = mkdtempSync(join(tmpdir(), "codemux-elsewhere-"));
    scratch.push(elsewhere);
    symlinkSync(elsewhere, join(home, ".codex", ".codemux-hermetic"));
    expect(() => createCodexHermeticHome(join(home, ".codex")))
      .toThrow("must be a directory owned by the current user");
  });

  test("a login file that is a symlink or not a regular file is refused", () => {
    const home = fakeHome();
    const real = join(home, ".codex", "auth.json");
    const target = mkdtempSync(join(tmpdir(), "codemux-login-target-"));
    scratch.push(target);
    rmSync(real);
    symlinkSync(target, real);
    expect(() => createCodexHermeticHome(join(home, ".codex")))
      .toThrow("must be a regular file");
    rmSync(real);
    mkdirSync(real);
    expect(() => createCodexHermeticHome(join(home, ".codex")))
      .toThrow("must be a regular file");
  });

  test("a login file owned by another user is refused", () => {
    const home = fakeHome();
    const uid = statSync(join(home, ".codex", "auth.json")).uid;
    const getuid = spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      expect(() => createCodexHermeticHome(join(home, ".codex")))
        .toThrow("must be owned by the current user");
    } finally {
      getuid.mockRestore();
    }
  });

  test("a replaced symlink login warns that the rotation was discarded", () => {
    const home = fakeHome();
    // A filesystem without hard links shares the login as a symlink.
    const fail = (): never => {
      throw new Error("no hard links");
    };
    const hermetic = createCodexHermeticHome(join(home, ".codex"), false, {
      hard: fail,
      symlink: symlinkSync,
    });
    const link = join(hermetic.codexHome, "auth.json");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    rmSync(link);
    writeFileSync(link, '{"tokens":{"access_token":"replaced"}}');
    const warnings: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => void warnings.push(String(message));
    try {
      hermetic.finalize();
    } finally {
      console.error = original;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("replaced its login file");
    expect(() => statSync(hermetic.home)).toThrow();
  });

  test("a rotated symlink login (unlink plus a new symlink) warns too (review round 361)", () => {
    // The old check only detected replacement by a non-symlink: a rotation
    // that unlinks and re-symlinks kept isSymbolicLink() true, the warning
    // never fired, and a stale token persisted silently. The link must
    // still name the real login file.
    const home = fakeHome();
    const fail = (): never => {
      throw new Error("no hard links");
    };
    const hermetic = createCodexHermeticHome(join(home, ".codex"), false, {
      hard: fail,
      symlink: symlinkSync,
    });
    const link = join(hermetic.codexHome, "auth.json");
    rmSync(link);
    const rotated = join(home, ".codex", "auth.json.rotated");
    writeFileSync(rotated, '{"tokens":{"access_token":"rotated"}}');
    symlinkSync(rotated, link);
    const warnings: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => void warnings.push(String(message));
    try {
      hermetic.finalize();
    } finally {
      console.error = original;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("replaced its login file");
    expect(() => statSync(hermetic.home)).toThrow();
  });

  test("an untouched symlink login finalizes with no warning", () => {
    // The readlink comparison must not misfire on the healthy path: a link
    // still naming the real login file rotates in place and diverges not.
    const home = fakeHome();
    const fail = (): never => {
      throw new Error("no hard links");
    };
    const hermetic = createCodexHermeticHome(join(home, ".codex"), false, {
      hard: fail,
      symlink: symlinkSync,
    });
    const warnings: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => void warnings.push(String(message));
    try {
      hermetic.finalize();
    } finally {
      console.error = original;
    }
    expect(warnings).toEqual([]);
    expect(() => statSync(hermetic.home)).toThrow();
  });

  test("finalize reports a login it could not inspect and still removes the home", () => {
    const home = fakeHome();
    const fail = (): never => {
      throw new Error("no hard links");
    };
    const hermetic = createCodexHermeticHome(join(home, ".codex"), false, {
      hard: fail,
      symlink: symlinkSync,
    });
    // The symlink the divergence check reads is gone; the catch must warn
    // and the finally must still sweep the home.
    rmSync(join(hermetic.codexHome, "auth.json"));
    const warnings: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => void warnings.push(String(message));
    try {
      hermetic.finalize();
    } finally {
      console.error = original;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not inspect the hermetic login");
    expect(() => statSync(hermetic.home)).toThrow();
  });

  test("a login link that fails both ways removes the half-built run directory", () => {
    const home = fakeHome();
    const fail = (): never => {
      throw new Error("injected link failure");
    };
    expect(() => createCodexHermeticHome(join(home, ".codex"), false, { hard: fail, symlink: fail }))
      .toThrow("injected link failure");
    // The exit backstop was registered before the link, so the rejection
    // leaves no run directory behind and no signal handler installed.
    const parent = join(home, ".codex", ".codemux-hermetic");
    expect(readdirSync(parent).filter((entry) => entry.startsWith("run-"))).toEqual([]);
    expect(newSignalListeners(baseline)).toBe(0);
  });

  test("a cleanup failure reaches the caller instead of a printed line (round 307)", () => {
    const home = fakeHome();
    const adapter = codexAdapter({}, home);
    const request: RunRequest = { agent: "codex", prompt: "p", hermetic: true };
    // prepareRun directly, not the prepare() helper: this context's cleanup
    // is the test's own business and must not hit the afterEach sweep.
    const context = adapter.prepareRun(request);
    // An unwritable parent keeps the home: the finalizer refuses, and that
    // refusal must leave cleanupRunSync as a throw the launcher appends to
    // the run's result (base.ts's contract) — not a console line the
    // launcher never sees.
    const parent = join(home, ".codex", ".codemux-hermetic");
    chmodSync(parent, 0o500);
    try {
      expect(() => adapter.cleanupRunSync(context)).toThrow(/could not remove the private hermetic home/);
    } finally {
      chmodSync(parent, 0o700);
      // The retry the kept home still allows: it succeeds, removes the
      // home, and unregisters the home's exit hook.
      adapter.cleanupRunSync(context);
    }
    expect(() => statSync(context.hermeticHome!.home)).toThrow();
  });

  test("a cleanup failure during experiment setup rides the setup error, never replaces it (round 313)", () => {
    // The experiment path's catch cleaned up and rethrew; with the cleanup
    // throwing since round 307, its failure replaced the actionable setup
    // error. Both now arrive in one message.
    const home = fakeHome();
    // A valid model cache, so setup reaches the experiment branch, where
    // the missing spec is the setup error.
    writeFileSync(join(home, ".codex", "models_cache.json"), JSON.stringify({
      client_version: "0.165.0", fetched_at: "2026-10-29T00:00:00Z", models: [{ slug: "gpt-5.5", tool_mode: "direct" }],
    }));
    const adapter = codexAdapter({}, home);
    // The real cleanup runs first, so the home and its signal handlers go;
    // the throw stands in for a finalizer that kept the home.
    const realCleanup = adapter.cleanupRunSync.bind(adapter);
    const failing = spyOn(adapter, "cleanupRunSync").mockImplementation(((context: RunContext) => {
      realCleanup(context);
      throw new Error("the private home was kept");
    }) as typeof adapter.cleanupRunSync);
    try {
      let caught: unknown;
      try {
        adapter.prepareRun({
          agent: "codex", prompt: "p", hermetic: true, model: "gpt-5.5",
          experimentMcp: join(home, "no-such-spec.json"),
        });
      } catch (error) {
        caught = error;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).toContain("no-such-spec.json");
      expect(message).toContain("; cleanup failed: the private home was kept");
      expect(message.startsWith("cleanup failed")).toBe(false);
    } finally {
      failing.mockRestore();
    }
  });

  test("launching without prepareRun is refused on the codemux side", () => {
    const adapter = codexAdapter({}, fakeHome());
    expect(() => adapter.getRunEnv({ agent: "codex", prompt: "p", hermetic: true }))
      .toThrow("was not prepared before launch");
    expect(adapter.getRunEnv({ agent: "codex", prompt: "p" })).toEqual({});
  });

  test("an in-place token rewrite reaches the real login; a replaced private file is discarded", () => {
    const home = fakeHome();
    const real = join(home, ".codex", "auth.json");
    const hermetic = createCodexHermeticHome(join(home, ".codex"));
    const link = join(hermetic.codexHome, "auth.json");
    writeFileSync(link, '{"tokens":{"access_token":"rotated"}}');
    expect(readFileSync(real, "utf8")).toContain("rotated");
    // A rename-style replacement breaks the link; nothing is ever written
    // back over the real file.
    rmSync(link);
    writeFileSync(link, '{"tokens":{"access_token":"replaced"}}');
    hermetic.finalize();
    expect(readFileSync(real, "utf8")).toContain("rotated");
    expect(() => statSync(hermetic.home)).toThrow();
  });

  test("finalize never restores a login the operator removed or replaced", () => {
    const home = fakeHome();
    const real = join(home, ".codex", "auth.json");
    const removed = createCodexHermeticHome(join(home, ".codex"));
    rmSync(real); // codex logout while the run is in flight
    removed.finalize();
    expect(() => statSync(real)).toThrow();

    writeFileSync(real, '{"tokens":{"access_token":"a"}}', { mode: 0o600 });
    const replaced = createCodexHermeticHome(join(home, ".codex"));
    rmSync(real);
    writeFileSync(real, '{"tokens":{"access_token":"fresh-login"}}', { mode: 0o600 });
    writeFileSync(join(replaced.codexHome, "auth.json"), '{"tokens":{"access_token":"stale-session"}}');
    replaced.finalize();
    expect(readFileSync(real, "utf8")).toContain("fresh-login");
  });

  test("old homes of dead codemux processes are swept; recent ones may still host a child", () => {
    const home = fakeHome();
    const parent = join(home, ".codex", ".codemux-hermetic");
    const old = join(parent, "run-999999999-old");
    const recent = join(parent, "run-999999998-recent");
    mkdirSync(join(old, ".codex"), { recursive: true });
    mkdirSync(join(recent, ".codex"), { recursive: true });
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    // Age the whole tree (review D2, security 2): the sweep measures the
    // NEWEST write anywhere inside, so seeding an old top directory alone
    // no longer makes a home stale.
    utimesSync(join(old, ".codex"), threeDaysAgo, threeDaysAgo);
    utimesSync(old, threeDaysAgo, threeDaysAgo);
    const hermetic = createCodexHermeticHome(join(home, ".codex"));
    const left = readdirSync(parent).filter((entry) => entry.startsWith("run-9999"));
    expect(left).toEqual(["run-999999998-recent"]);
    hermetic.finalize();
  });

  test("hermetic runs refuse repository skills found in HOME itself, but not from a directory below it", () => {
    const home = fakeHome();
    mkdirSync(join(home, ".agents", "skills", "x"), { recursive: true });
    const below = join(home, "Downloads", "work");
    mkdirSync(below, { recursive: true });
    // The adapter's effective home (seam, else $HOME) is the user home for
    // the skills walk.
    const adapter = codexAdapter({ HOME: home });
    expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd: home }))
      .not.toThrow();
    expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd: home, hermetic: true }))
      .toThrow("refuses repository skills in a hermetic run");
    // User-level skills under HOME are hidden by the private home; only
    // HOME as the working directory makes them repository skills.
    expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd: below, hermetic: true }))
      .not.toThrow();
    expect(() => codexAdapter({}, home).validateRunRequest({ agent: "codex", prompt: "p", cwd: home, hermetic: true }))
      .toThrow("refuses repository skills in a hermetic run");
    // A HOME that is itself a Git root is Codex's project root for any
    // directory below it without another root in between.
    mkdirSync(join(home, ".git"));
    expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd: below, hermetic: true }))
      .toThrow("refuses repository skills in a hermetic run");
  });

  test("hermetic runs refuse repository skills", () => {
    const home = fakeHome();
    const repo = mkdtempSync(join(tmpdir(), "codemux-codex-repo-"));
    scratch.push(repo);
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, ".agents", "skills", "x"), { recursive: true });
    const adapter = codexAdapter({}, home);
    expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd: repo }))
      .not.toThrow();
    expect(() => adapter.validateRunRequest({ agent: "codex", prompt: "p", cwd: repo, hermetic: true }))
      .toThrow("refuses repository skills in a hermetic run");
  });
});

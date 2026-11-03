import { afterEach, describe, expect, test } from "bun:test";
import {
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
import type { RunContext } from "../src/adapters/base.js";
import { KimiAdapter } from "../src/adapters/kimi.js";
import { writeKimiNoToolsFile } from "../src/kimi-no-tools.js";
import type { RunRequest } from "../src/types.js";

// The per-harness --hermetic / --tools none mappings. OpenCode claims both;
// droid, kimi, pi and goose claim --tools none (all verified live through
// provider overrides). Aider refuses both — its --tools none has nothing to
// map onto, and its --hermetic refusal (2026-10-04 review) rides aider's
// own .aider.conf.yml/.env/.aider.model.settings.yml searches having no
// switch. Copilot refuses both on live evidence; the mechanisms the branch
// had implemented behind its refusals are removed as dead surface in 0.7.0
// (docs/isolation.md).

describe("hermetic runs: kimi", () => {
  const scratch: string[] = [];
  // Every context this describe prepares, disposed per launch -- the same
  // ownership rule the launcher follows, never a whole-adapter sweep.
  const prepared: { adapter: KimiAdapter; context: RunContext }[] = [];
  afterEach(() => {
    for (const { adapter, context } of prepared.splice(0)) adapter.cleanupRun(context);
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const kimiAdapter = (env: NodeJS.ProcessEnv = {}): KimiAdapter => {
    const home = mkdtempSync(join(tmpdir(), "codemux-kimi-home-"));
    scratch.push(home);
    return new KimiAdapter(env, home);
  };
  const prepare = (adapter: KimiAdapter, request: RunRequest): RunContext => {
    const context = adapter.prepareRun(request);
    prepared.push({ adapter, context });
    return context;
  };
  const agentFileOf = (cmd: string[]): string =>
    cmd[cmd.indexOf("--agent-file") + 1]!;

  test("--tools none selects a generated agent file whose allowlist is empty and whose body is the base prompt", () => {
    const adapter = kimiAdapter();
    const request: RunRequest = { agent: "kimi", prompt: "p", tools: "none" };
    const cmd = adapter.buildRunCommand(request, prepare(adapter, request));
    const path = agentFileOf(cmd);
    expect(path).toContain(join(".kimi-code", ".codemux", `no-tools-${process.pid}-`));
    const text = readFileSync(path, "utf8");
    expect(text).toContain("tools: []");
    expect(text.trimEnd().endsWith("${base_prompt}")).toBe(true);
    expect(cmd[cmd.indexOf("--agent-file") + 2]).toBe("--output-format");
    expect(cmd[cmd.indexOf("--agent-file") + 4]).toBe("--prompt");
    // Every run asks for the stream-json wire (the plain path unwraps the
    // reply and wire-log usage off it), not only --result-json ones.
    expect(adapter.buildRunCommand({ agent: "kimi", prompt: "p" }))
      .toEqual(["kimi", "--output-format", "stream-json", "--prompt", "p"]);
    expect(adapter.buildRunCommand({ agent: "kimi", prompt: "p", tools: "default" }))
      .toEqual(["kimi", "--output-format", "stream-json", "--prompt", "p"]);
  });

  test("kimi claims --tools none (verified live) and --hermetic (private homes)", () => {
    const adapter = kimiAdapter();
    const cwd = mkdtempSync(join(tmpdir(), "codemux-kimi-claim-"));
    scratch.push(cwd);
    try {
      mkdirSync(join(cwd, ".git"));
      // The capability probes ran live on 2026-09-17 through a provider
      // override (GLM-5.3 via Z.AI): under --tools none neither the read
      // probe nor the shell probe could produce its secret, while a plain
      // run produced both. Hermetic is claimed since the private HOME and
      // KIMI_CODE_HOME homes (src/kimi-hermetic.ts): the ~/.agents/AGENTS.md
      // and brand AGENTS.md channels the 2026-09-17 control leaked through
      // are empty there, and a project instruction file refuses the run.
      expect(adapter.capabilities().supportsToolSelection ?? false).toBe(true);
      expect(() => adapter.validateRunRequest({ agent: "kimi", prompt: "p", cwd, tools: "none" }))
        .not.toThrow();
      expect(adapter.capabilities().supportsHermetic ?? false).toBe(true);
      expect(() => adapter.validateRunRequest({ agent: "kimi", prompt: "p", cwd, hermetic: true }))
        .not.toThrow();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("the brand home follows a passed-through KIMI_CODE_HOME, never a stray one", () => {
    const profile = mkdtempSync(join(tmpdir(), "codemux-kimi-profile-"));
    scratch.push(profile);
    const droppedAdapter = kimiAdapter({ KIMI_CODE_HOME: profile });
    const droppedRequest: RunRequest = { agent: "kimi", prompt: "p", tools: "none" };
    const dropped = agentFileOf(
      droppedAdapter.buildRunCommand(droppedRequest, prepare(droppedAdapter, droppedRequest))
    );
    expect(dropped).not.toContain(profile);
    const passedAdapter = kimiAdapter({ KIMI_CODE_HOME: profile });
    const request: RunRequest = { agent: "kimi", prompt: "p", tools: "none", passthroughEnv: ["KIMI_CODE_HOME"] };
    expect(agentFileOf(passedAdapter.buildRunCommand(request, prepare(passedAdapter, request))))
      .toContain(profile);
  });

  test("a padded or empty passed-through KIMI_CODE_HOME is used exactly as the child reads it (al21)", () => {
    // Round al21, contracts-2 minor 7: the run adapter trimmed the value
    // before the absolute check and treated all-padding as unset, while the
    // session boundary records exactly the bytes the child receives (round
    // al11) and refuses an empty value outright (round al16). kimi reads
    // the variable without trimming, so the trimmed run path placed the
    // generated agent file under a spelling the child never reads. The run
    // path follows the session's belief now; round al29 widened the
    // refusals from --tools none to every passthrough run (see the test
    // that follows) and added the existing-directory rule, so the padded
    // spelling below is created for real — it must exist to pass.
    const cwd = mkdtempSync(join(tmpdir(), "codemux-kimi-cwd-"));
    scratch.push(cwd);
    mkdirSync(join(cwd, ".git"));
    const profile = mkdtempSync(join(tmpdir(), "codemux-kimi-profile-"));
    scratch.push(profile);
    const paddedHome = `${profile} `;
    mkdirSync(paddedHome); // the padded spelling is a directory that exists
    scratch.push(paddedHome);

    // A padded absolute value names the directory literally: the agent
    // file lands under the padded spelling, the one the child reads --
    // not under a trimmed normalization of it.
    const paddedAdapter = kimiAdapter({ KIMI_CODE_HOME: paddedHome });
    const request: RunRequest = {
      agent: "kimi",
      prompt: "p",
      tools: "none",
      cwd,
      passthroughEnv: ["KIMI_CODE_HOME"],
    };
    expect(() => paddedAdapter.validateRunRequest(request)).not.toThrow();
    const context = prepare(paddedAdapter, request);
    const agentFile = agentFileOf(paddedAdapter.buildRunCommand(request, context));
    expect(agentFile.startsWith(`${paddedHome}/.codemux/`)).toBe(true);
    expect(agentFile.startsWith(join(profile, ".codemux"))).toBe(false);
    expect(statSync(agentFile).isFile()).toBe(true);

    // Empty and padding-relative values are refused at validation, before
    // prepareRun writes anything -- the session's al16 rule and the
    // relative-path rule, neither of which a trim may wave through.
    const empty = kimiAdapter({ KIMI_CODE_HOME: "" });
    expect(() => empty.validateRunRequest(request))
      .toThrow("KIMI_CODE_HOME must not be empty");
    const spaces = kimiAdapter({ KIMI_CODE_HOME: "   " });
    expect(() => spaces.validateRunRequest(request))
      .toThrow("KIMI_CODE_HOME must be an absolute path");
    const relative = kimiAdapter({ KIMI_CODE_HOME: ` ${profile}` });
    expect(() => relative.validateRunRequest(request))
      .toThrow("KIMI_CODE_HOME must be an absolute path");
  });

  test("a passed-through KIMI_CODE_HOME is validated on every run, not only --tools none (al29)", () => {
    // Round al29, correctness major 5: the empty/absolute/existing
    // refusals used to fire only under --tools none — the one kind whose
    // agent file codemux writes under the brand home — so a plain run
    // passed the variable through unvalidated, and a typo'd or empty value
    // reached the child, whose resolver happily placed a fresh, empty
    // store under it. The child reads that directory whatever the run
    // kind, so every run that passes the variable through is validated
    // now. The default home (no passthrough) stays exempt: it does not
    // exist before kimi's own first run.
    const cwd = mkdtempSync(join(tmpdir(), "codemux-kimi-cwd-"));
    scratch.push(cwd);
    mkdirSync(join(cwd, ".git"));
    const home = mkdtempSync(join(tmpdir(), "codemux-kimi-home-"));
    scratch.push(home);
    const plain: RunRequest = {
      agent: "kimi",
      prompt: "p",
      cwd,
      passthroughEnv: ["KIMI_CODE_HOME"],
    };

    // The three refusals, each on a PLAIN run this time.
    expect(() => kimiAdapter({ KIMI_CODE_HOME: "" }).validateRunRequest(plain))
      .toThrow("KIMI_CODE_HOME must not be empty");
    expect(() => kimiAdapter({ KIMI_CODE_HOME: "relative/home" }).validateRunRequest(plain))
      .toThrow("KIMI_CODE_HOME must be an absolute path");
    expect(() =>
      kimiAdapter({ KIMI_CODE_HOME: join(home, "no-such-directory") }).validateRunRequest(plain)
    ).toThrow("KIMI_CODE_HOME must be an existing directory");
    // A value naming a file is refused by the same rule: a file is not a
    // directory, whatever it is named.
    const file = join(home, "not-a-directory");
    writeFileSync(file, "x");
    expect(() => kimiAdapter({ KIMI_CODE_HOME: file }).validateRunRequest(plain))
      .toThrow("KIMI_CODE_HOME must be an existing directory");

    // An existing directory passes on a plain run, and a stray value the
    // operator never passes through is not read at all.
    expect(() => kimiAdapter({ KIMI_CODE_HOME: home }).validateRunRequest(plain)).not.toThrow();
    const stray: RunRequest = { agent: "kimi", prompt: "p", cwd };
    expect(() =>
      kimiAdapter({ KIMI_CODE_HOME: join(home, "no-such-directory") }).validateRunRequest(stray)
    ).not.toThrow();
  });

  test("a passed-through KIMI_CODE_HOME is validated on the TUI path too (al30)", () => {
    // Round al30, contracts minor: validateTuiRequest ran the model and
    // project checks but not realBrandHome, so `codemux tui -a kimi`
    // launched with a typo'd, empty, or relative home where the same
    // operator's run was refused — and the interactive child is the one
    // that reads config.toml, skills, and the store from that directory
    // for its whole session. The three run-path refusals fire on the TUI
    // request unchanged, the same UsageRefusalError class.
    const cwd = mkdtempSync(join(tmpdir(), "codemux-kimi-cwd-"));
    scratch.push(cwd);
    mkdirSync(join(cwd, ".git"));
    const home = mkdtempSync(join(tmpdir(), "codemux-kimi-home-"));
    scratch.push(home);
    const tui = (env: NodeJS.ProcessEnv) =>
      kimiAdapter(env).validateTuiRequest(
        undefined,
        cwd,
        "high",
        undefined,
        ["KIMI_CODE_HOME"]
      );
    expect(() => tui({ KIMI_CODE_HOME: "" }))
      .toThrow("KIMI_CODE_HOME must not be empty");
    expect(() => tui({ KIMI_CODE_HOME: "relative/home" }))
      .toThrow("KIMI_CODE_HOME must be an absolute path");
    expect(() => tui({ KIMI_CODE_HOME: join(home, "no-such-directory") }))
      .toThrow("KIMI_CODE_HOME must be an existing directory");
    // An existing directory passes, and no passthrough reads nothing.
    expect(() => tui({ KIMI_CODE_HOME: home })).not.toThrow();
    expect(() =>
      kimiAdapter({ KIMI_CODE_HOME: join(home, "no-such-directory") }).validateTuiRequest(
        undefined,
        cwd,
        "high"
      )
    ).not.toThrow();
  });

  test("every prepared run gets a fresh file; cleanupRun removes each launch's own only", () => {
    const adapter = kimiAdapter();
    const request: RunRequest = { agent: "kimi", prompt: "p", tools: "none" };
    const firstContext = prepare(adapter, request);
    const first = agentFileOf(adapter.buildRunCommand(request, firstContext));
    expect(statSync(first).isFile()).toBe(true);
    const secondContext = prepare(adapter, request);
    const second = agentFileOf(adapter.buildRunCommand(request, secondContext));
    expect(second).not.toBe(first);
    // The earlier file stays until its own launch ends: an earlier run may
    // still read it.
    expect(statSync(first).isFile()).toBe(true);
    adapter.cleanupRun(firstContext);
    expect(() => statSync(first)).toThrow();
    expect(statSync(second).isFile()).toBe(true);
  });

  test("a static --tools none command without prepareRun points at a file that does not exist", () => {
    const adapter = kimiAdapter();
    const cmd = adapter.buildRunCommand({ agent: "kimi", prompt: "p", tools: "none" });
    expect(agentFileOf(cmd)).toMatch(/\.codemux\/unprepared$/);
    expect(() => statSync(agentFileOf(cmd))).toThrow();
  });

  test("stale files of dead codemux processes are swept", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-kimi-sweep-"));
    scratch.push(home);
    const brand = join(home, ".kimi-code");
    const parent = join(brand, ".codemux");
    mkdirSync(parent, { recursive: true });
    const old = join(parent, "no-tools-999999999-old.md");
    writeFileSync(old, "x");
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(old, threeDaysAgo, threeDaysAgo);
    // A fresh file of a dead pid stays: the sweep is age-gated, not a
    // wholesale delete of every dead process's artifact.
    const fresh = join(parent, "no-tools-999999998-fresh.md");
    writeFileSync(fresh, "x");
    const file = writeKimiNoToolsFile(brand);
    expect(readdirSync(parent).filter((entry) => entry.startsWith("no-tools-9999")))
      .toEqual(["no-tools-999999998-fresh.md"]);
    expect(statSync(fresh).isFile()).toBe(true);
    file.finalize();
  });

  test("a stale entry the sweep cannot remove neither throws nor blocks later sweeps", () => {
    // Regression (h4 review): a directory named like the no-tools file is
    // beyond a non-recursive rm, and one such entry used to throw out of
    // the sweep and fail every later run; the sweep now warns and moves on.
    const home = mkdtempSync(join(tmpdir(), "codemux-kimi-bad-sweep-"));
    scratch.push(home);
    const brand = join(home, ".kimi-code");
    const parent = join(brand, ".codemux");
    mkdirSync(parent, { recursive: true });
    const bad = join(parent, "no-tools-999999997-bad.md");
    mkdirSync(bad);
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(bad, threeDaysAgo, threeDaysAgo);
    const old = join(parent, "no-tools-999999999-old.md");
    writeFileSync(old, "x");
    utimesSync(old, threeDaysAgo, threeDaysAgo);
    const file = writeKimiNoToolsFile(brand);
    expect(statSync(bad).isDirectory()).toBe(true);
    expect(() => statSync(old)).toThrow();
    file.finalize();
  });

  test("a symlinked .codemux parent is refused", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-kimi-symlink-"));
    scratch.push(home);
    const elsewhere = mkdtempSync(join(tmpdir(), "codemux-kimi-elsewhere-"));
    scratch.push(elsewhere);
    const brand = join(home, ".kimi-code");
    mkdirSync(join(brand, ".codemux"), { recursive: true });
    rmSync(join(brand, ".codemux"), { recursive: true });
    symlinkSync(elsewhere, join(brand, ".codemux"));
    expect(() => writeKimiNoToolsFile(brand))
      .toThrow("must be a directory owned by the current user");
  });

});


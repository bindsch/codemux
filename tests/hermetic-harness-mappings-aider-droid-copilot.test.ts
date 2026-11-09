import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAdapter } from "../src/adapters/index.js";

// The per-harness --hermetic / --tools none mappings. OpenCode claims both;
// droid, kimi, pi and goose claim --tools none (all verified live through
// provider overrides). Since the parity round aider and copilot claim
// --hermetic too: aider through a private HOME plus the clean-working-
// directory rule (its --tools none still has nothing to map onto), copilot
// through a private COPILOT_HOME plus the --available-tools sentinel
// allowlist (docs/isolation.md).

describe("hermetic runs: aider", () => {
  const adapter = () => getAdapter("aider");

  test("--hermetic disables the repository map; everything else is pinned in every run", () => {
    const plain = adapter().buildRunCommand({ agent: "aider", prompt: "p" });
    const hermetic = adapter().buildRunCommand({ agent: "aider", prompt: "p", hermetic: true });
    // The hermetic command is the plain one inside `env HOME=<private>`,
    // with the repo-map budget zeroed ahead of the prompt.
    expect(hermetic[0]).toBe("env");
    expect(hermetic[1]).toMatch(/^HOME=/);
    expect(hermetic.slice(2)).toEqual([...plain.slice(0, -2), "--map-tokens", "0", ...plain.slice(-2)]);
    expect(hermetic).toContain("--map-tokens");
    expect(hermetic.indexOf("0")).toBe(hermetic.indexOf("--map-tokens") + 1);
  });

  test("instruction directories become --read files in plain runs only", () => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-aider-read-"));
    try {
      writeFileSync(join(dir, "AGENTS.md"), "# agents\n");
      writeFileSync(join(dir, "CLAUDE.md"), "# claude\n");
      const cmd = adapter().buildRunCommand({
        agent: "aider",
        prompt: "p",
        instructionDirs: [dir],
      });
      expect(cmd).toContain("--read");
      expect(cmd[cmd.indexOf("--read") + 1]).toBe(join(dir, "AGENTS.md"));
      expect(cmd).toContain(join(dir, "CLAUDE.md"));
      // Under --hermetic the channel codemux controls is simply not passed:
      // aider would load anything it is handed.
      const hermetic = adapter().buildRunCommand({
        agent: "aider",
        prompt: "p",
        hermetic: true,
        instructionDirs: [dir],
      });
      expect(hermetic).not.toContain("--read");
      expect(hermetic).toContain("--map-tokens");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--read carries only the instruction files that exist (review round 391, item 9)", () => {
    // Aider 0.86.2 exits 1 at argv parse when a --read file is missing,
    // so an unconditional AGENTS.md + CLAUDE.md pair made an instruction
    // directory holding only one of the two a validated request whose
    // command was guaranteed to die. Only files that exist ride the argv.
    const one = mkdtempSync(join(tmpdir(), "codemux-aider-one-"));
    const none = mkdtempSync(join(tmpdir(), "codemux-aider-none-"));
    try {
      writeFileSync(join(one, "AGENTS.md"), "# agents\n");
      const cmdOne = adapter().buildRunCommand({
        agent: "aider",
        prompt: "p",
        instructionDirs: [one],
      });
      expect(cmdOne).toContain("--read");
      expect(cmdOne[cmdOne.indexOf("--read") + 1]).toBe(join(one, "AGENTS.md"));
      expect(cmdOne).not.toContain(join(one, "CLAUDE.md"));
      const cmdNone = adapter().buildRunCommand({
        agent: "aider",
        prompt: "p",
        instructionDirs: [none],
      });
      expect(cmdNone).not.toContain("--read");
    } finally {
      rmSync(one, { recursive: true, force: true });
      rmSync(none, { recursive: true, force: true });
    }
  });

  test("aider supports --hermetic and removes tools through ask mode without Git", () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-aider-claim-"));
    try {
      mkdirSync(join(cwd, ".git"));
      // The 2026-10-04 refusal is closed: the private HOME empties aider's
      // home config layers at once and the clean-working-directory rule
      // refuses the four names from the working directory up to the project
      // root, the same range aider searches (main.py at 0.86.2; read
      // 2026-11-09). Ask mode without Git removes model-driven tools.
      expect(adapter().capabilities().supportsHermetic ?? false).toBe(true);
      expect(() => adapter().validateRunRequest({ agent: "aider", prompt: "p", cwd, hermetic: true }))
        .not.toThrow();
      expect(adapter().capabilities().supportsToolSelection ?? false).toBe(true);
      expect(() => adapter().validateRunRequest({ agent: "aider", prompt: "p", cwd, tools: "none" }))
        .not.toThrow();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("hermetic runs: droid", () => {
  test("--tools none allowlists the one tool droid pins; the autonomy mapping is untouched", () => {
    const adapter = getAdapter("droid");
    const plain = adapter.buildRunCommand({ agent: "droid", prompt: "p", autonomy: "low" });
    const none = adapter.buildRunCommand({ agent: "droid", prompt: "p", autonomy: "low", tools: "none" });
    expect(none).toEqual([...plain, "--only-tools", "ToolSearch"]);
    expect(adapter.buildRunCommand({ agent: "droid", prompt: "p", tools: "default" }))
      .toEqual(["droid", "exec"]);
  });

  test("droid claims --tools none (verified live) and --hermetic (home redirect)", () => {
    const adapter = getAdapter("droid");
    const cwd = mkdtempSync(join(tmpdir(), "codemux-droid-claim-"));
    try {
      mkdirSync(join(cwd, ".git"));
      // The --tools none capability probe ran live on 2026-09-17 through a
      // provider override (GLM-5.3 via Z.AI riding a per-run BYOK settings
      // file, so no Factory login was needed): under --tools none neither
      // the read probe nor the shell probe could produce its secret, while
      // a plain run produced both. --hermetic is claimed through the home
      // redirect: every root droid reads (settings.json, skills, hooks,
      // login, the guideline directories) resolves from
      // FACTORY_HOME_OVERRIDE ?? HOME ?? USERPROFILE ?? cwd, so a private
      // HOME with the override unset removes them all at once
      // (src/droid-hermetic.ts, docs/isolation.md).
      expect(adapter.capabilities().supportsToolSelection ?? false).toBe(true);
      expect(() => adapter.validateRunRequest({ agent: "droid", prompt: "p", cwd, tools: "none" }))
        .not.toThrow();
      expect(adapter.capabilities().supportsHermetic ?? false).toBe(true);
      expect(() => adapter.validateRunRequest({ agent: "droid", prompt: "p", cwd, hermetic: true }))
        .not.toThrow();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("hermetic runs: copilot", () => {
  test("copilot claims --hermetic and --tools none at the installed 1.0.85", () => {
    const adapter = getAdapter("copilot");
    const cwd = mkdtempSync(join(tmpdir(), "codemux-copilot-claim-"));
    try {
      mkdirSync(join(cwd, ".git"));
      // The 2026-09-17 refusals are closed. --hermetic rides a private
      // COPILOT_HOME with the login hard-linked in (config, custom
      // instructions, plugins, and session state all resolve under it);
      // --tools none rides a NON-empty --available-tools value that is no
      // tool's name — the CLI's own normalizer collapses every empty
      // spelling to "no filter", which is why the live probes left the
      // tools armed, and a sentinel name empties the registry through the
      // filter (docs/isolation.md).
      expect(adapter.capabilities().supportsHermetic ?? false).toBe(true);
      expect(adapter.capabilities().supportsToolSelection ?? false).toBe(true);
      expect(() => adapter.validateRunRequest({ agent: "copilot", prompt: "p", cwd, hermetic: true }))
        .not.toThrow();
      expect(() => adapter.validateRunRequest({ agent: "copilot", prompt: "p", cwd, tools: "none" }))
        .not.toThrow();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

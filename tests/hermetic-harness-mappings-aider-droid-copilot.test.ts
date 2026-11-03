import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAdapter } from "../src/adapters/index.js";

// The per-harness --hermetic / --tools none mappings. OpenCode claims both;
// droid, kimi, pi and goose claim --tools none (all verified live through
// provider overrides). Aider refuses both — its --tools none has nothing to
// map onto, and its --hermetic refusal (2026-10-04 review) rides aider's
// own .aider.conf.yml/.env/.aider.model.settings.yml searches having no
// switch. Copilot refuses both on live evidence; the mechanisms the branch
// had implemented behind its refusals are removed as dead surface in 0.7.0
// (docs/isolation.md).

describe("hermetic runs: aider", () => {
  const adapter = () => getAdapter("aider");

  test("--hermetic disables the repository map; everything else is pinned in every run", () => {
    const plain = adapter().buildRunCommand({ agent: "aider", prompt: "p" });
    const hermetic = adapter().buildRunCommand({ agent: "aider", prompt: "p", hermetic: true });
    expect(hermetic).toEqual([...plain.slice(0, -1), "--map-tokens", "0", plain.at(-1)!]);
    expect(hermetic).toContain("--map-tokens");
    expect(hermetic.indexOf("0")).toBe(hermetic.indexOf("--map-tokens") + 1);
  });

  test("instruction directories become --read files in plain runs only", () => {
    const cmd = adapter().buildRunCommand({
      agent: "aider",
      prompt: "p",
      instructionDirs: ["/tmp/canary"],
    });
    expect(cmd).toContain("--read");
    expect(cmd[cmd.indexOf("--read") + 1]).toBe("/tmp/canary/AGENTS.md");
    expect(cmd).toContain("/tmp/canary/CLAUDE.md");
    // Under --hermetic the channel codemux controls is simply not passed:
    // aider would load anything it is handed.
    const hermetic = adapter().buildRunCommand({
      agent: "aider",
      prompt: "p",
      hermetic: true,
      instructionDirs: ["/tmp/canary"],
    });
    expect(hermetic).not.toContain("--read");
    expect(hermetic).toContain("--map-tokens");
  });

  test("aider refuses --hermetic on its config layers and --tools none on its empty tool set", () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-aider-claim-"));
    try {
      mkdirSync(join(cwd, ".git"));
      // --hermetic is refused (2026-10-04 review): the pinned flags close
      // only what codemux hands aider, while aider itself loads
      // .aider.conf.yml, .env and .aider.model.settings.yml from the home,
      // git root and working directory with no switch to stop it — the
      // check's canary never rode those channels, so the 2026-09-17 pass
      // certified what the flags do not close (docs/isolation.md). The
      // --map-tokens mapping above stays for the day that changes.
      expect(adapter().capabilities().supportsHermetic ?? false).toBe(false);
      expect(() => adapter().validateRunRequest({ agent: "aider", prompt: "p", cwd, hermetic: true }))
        .toThrow("no verified hermetic mode");
      expect(adapter().capabilities().supportsToolSelection ?? false).toBe(false);
      expect(() => adapter().validateRunRequest({ agent: "aider", prompt: "p", cwd, tools: "none" }))
        .toThrow("cannot remove its built-in tools");
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

  test("droid claims --tools none (verified live); --hermetic stays refused", () => {
    const adapter = getAdapter("droid");
    const cwd = mkdtempSync(join(tmpdir(), "codemux-droid-claim-"));
    try {
      mkdirSync(join(cwd, ".git"));
      // The capability probes ran live on 2026-09-17 through a provider
      // override (GLM-5.3 via Z.AI riding a per-run BYOK settings file, so
      // no Factory login was needed): under --tools none neither the read
      // probe nor the shell probe could produce its secret, while a plain
      // run produced both. Hermetic stays refused — instruction files load
      // from the working directory up to the git root with no switch, and
      // skills load from both ~/.factory and ~/.agents (docs/isolation.md).
      expect(adapter.capabilities().supportsToolSelection ?? false).toBe(true);
      expect(() => adapter.validateRunRequest({ agent: "droid", prompt: "p", cwd, tools: "none" }))
        .not.toThrow();
      expect(adapter.capabilities().supportsHermetic ?? false).toBe(false);
      expect(() => adapter.validateRunRequest({ agent: "droid", prompt: "p", cwd, hermetic: true }))
        .toThrow("no verified hermetic mode");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("hermetic runs: copilot", () => {
  test("copilot refuses --hermetic and --tools none on live evidence at the installed 1.0.85", () => {
    const adapter = getAdapter("copilot");
    const cwd = mkdtempSync(join(tmpdir(), "codemux-copilot-refuse-"));
    try {
      mkdirSync(join(cwd, ".git"));
      // Both capabilities are refused on the 2026-09-17 live pass: no argv
      // spelling of an empty --available-tools allowlist disarms the
      // tools, and the check's control probe cannot leak the planted code
      // word because --no-custom-instructions rides every run
      // (docs/isolation.md). The mechanisms the branch had implemented
      // behind the refusals (the private COPILOT_HOME, the BYOK provider
      // override) are removed as dead surface in 0.7.0; the refusals and
      // their evidence stay.
      expect(adapter.capabilities().supportsHermetic ?? false).toBe(false);
      expect(adapter.capabilities().supportsToolSelection ?? false).toBe(false);
      expect(() => adapter.validateRunRequest({ agent: "copilot", prompt: "p", cwd, hermetic: true }))
        .toThrow("no verified hermetic mode");
      expect(() => adapter.validateRunRequest({ agent: "copilot", prompt: "p", cwd, tools: "none" }))
        .toThrow("cannot remove its built-in tools");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

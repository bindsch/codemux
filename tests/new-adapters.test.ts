import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AiderAdapter } from "../src/adapters/aider.js";
import { AgyAdapter } from "../src/adapters/agy.js";
import { ClineAdapter } from "../src/adapters/cline.js";
import { CopilotAdapter } from "../src/adapters/copilot.js";
import { CursorAdapter } from "../src/adapters/cursor.js";
import { AGENT_IDS, getAdapter } from "../src/adapters/index.js";

describe("new harness registry entries", () => {
  test("registers agy, aider, cline, copilot, and cursor", () => {
    expect(AGENT_IDS).toContain("agy");
    expect(AGENT_IDS).toContain("aider");
    expect(AGENT_IDS).toContain("cline");
    expect(AGENT_IDS).toContain("copilot");
    expect(AGENT_IDS).toContain("cursor");
    expect(getAdapter("agy")).toBeInstanceOf(AgyAdapter);
    expect(getAdapter("aider")).toBeInstanceOf(AiderAdapter);
    expect(getAdapter("cline")).toBeInstanceOf(ClineAdapter);
    expect(getAdapter("copilot")).toBeInstanceOf(CopilotAdapter);
    expect(getAdapter("cursor")).toBeInstanceOf(CursorAdapter);
  });
});

describe("AgyAdapter", () => {
  const adapter = new AgyAdapter();

  test("describes its supported capabilities", () => {
    expect(adapter.id).toBe("agy");
    expect(adapter.binaryName).toBe("agy");
    expect(adapter.capabilities()).toEqual({
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: true,
      effortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsResultJson: true,
      supportsHermetic: true,
      supportsToolSelection: true,
      isolationRequiresReadOnly: true,
    });
    // VERIFIED by Round 11 live checks: private HOME and a login mirror isolate
    // configuration; deny settings and native attempt checks enforce tools-none.
    expect(adapter.capabilities().supportsHermetic).toBe(true);
    expect(adapter.capabilities().supportsToolSelection).toBe(true);
  });

  test("builds a headless command with the value flags in = form and the prompt last", () => {
    // 1.2.14 rejects the space form of its pre-parsed value flags outright
    // (--effort, --mode), and --model's space form was never exercised
    // against the pinned release, so every value flag rides as a single
    // argument.
    expect(adapter.buildRunCommand({
      agent: "agy",
      prompt: "fix the tests",
      model: "gemini-3-pro",
      autonomy: "medium",
      effort: "high",
    })).toEqual([
      "agy",
      "--disable-slash-commands",
      "--model=gemini-3-pro",
      "--effort=high",
      "--mode=accept-edits",
      "--output-format=json",
      "--print=fix the tests",
    ]);
  });

  test("keeps leading-dash prompts inside the print option", () => {
    expect(adapter.buildRunCommand({
      agent: "agy",
      prompt: "--dangerous-looking-prompt",
    })).toContain("--print=--dangerous-looking-prompt");
  });

  test("maps autonomy levels onto agy's mode flags", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual(["--mode=plan"]);
    expect(adapter.mapAutonomy("low")).toEqual([]);
    expect(adapter.mapAutonomy("medium")).toEqual(["--mode=accept-edits"]);
    expect(adapter.mapAutonomy("high")).toEqual(["--dangerously-skip-permissions"]);
  });

  test("refuses effort levels agy does not accept", () => {
    expect(() => adapter.validateRunRequest({
      agent: "agy",
      prompt: "t",
      effort: "ultra",
    })).toThrow("does not support reasoning effort 'ultra'");
  });

  test("--result-json asks for the JSON envelope", () => {
    const cmd = adapter.buildRunCommand({ agent: "agy", prompt: "t", resultJson: true });
    expect(cmd).toContain("--output-format=json");
    expect(adapter.getStdinInput({ agent: "agy", prompt: "t" })).toBeNull();
  });

  test("the envelope is always on, so --result-json adds no flag", () => {
    // Plain runs ask for the envelope too (it is what the plain-run
    // unwrap consumes for the ledger's usage); --result-json only stops
    // the unwrap.
    const plain = adapter.buildRunCommand({ agent: "agy", prompt: "t" });
    expect(plain).toContain("--output-format=json");
    expect(adapter.buildRunCommand({ agent: "agy", prompt: "t", resultJson: true }))
      .toEqual(plain);
  });

  test("builds interactive commands", () => {
    expect(adapter.buildTuiCommand("gemini-3-pro", "read-only", "low"))
      .toEqual(["agy", "--model=gemini-3-pro", "--effort=low", "--mode=plan"]);
  });

  test("rejects Antigravity project manifests before launch", () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-agy-project-"));
    mkdirSync(join(cwd, ".git"));
    mkdirSync(join(cwd, ".agents"));
    writeFileSync(
      join(cwd, ".agents", "skills.json"),
      JSON.stringify({ skills: [{ path: "../shared" }] })
    );
    try {
      expect(() => adapter.validateRunRequest({
        agent: "agy",
        prompt: "inspect",
        cwd,
      })).toThrow("refuses repository executable configuration");
      expect(() => adapter.validateTuiRequest(undefined, cwd))
        .toThrow("refuses repository executable configuration");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("rejects the Antigravity config roots the binary names beyond the manifests", () => {
    // The round-2 finding: the refusal list was narrower than its own
    // justification. The binary's strings read `.agents/` directories
    // (rules, plugins, agents, workflows) and `.agents/hooks.json` side by
    // side with the four manifests, plus a whole `.gemini/config/` tree
    // (plugins, skills, hooks.json, mcp_config.json, workflows), so a
    // repository could ship any of them and supply the prompts, hooks, and
    // tools a session runs with.
    const directoryRoots = [
      join(".agents", "rules"),
      join(".agents", "plugins"),
      join(".agents", "agents"),
      join(".agents", "workflows"),
      join(".gemini", "config"),
    ];
    for (const root of [...directoryRoots, join(".agents", "hooks.json")]) {
      const cwd = mkdtempSync(join(tmpdir(), "codemux-agy-config-"));
      try {
        mkdirSync(join(cwd, ".git"));
        // The walker refuses a directory only when it holds an entry.
        if (root.endsWith(".json")) {
          mkdirSync(join(cwd, dirname(root)), { recursive: true });
          writeFileSync(join(cwd, root), "{}");
        } else {
          mkdirSync(join(cwd, root, "supplied"), { recursive: true });
        }
        expect(() => adapter.validateRunRequest({
          agent: "agy",
          prompt: "inspect",
          cwd,
        })).toThrow("refuses repository executable configuration");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  });
});

import { describe, test, expect } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { AgyAdapter } from "../src/adapters/agy.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { DroidAdapter } from "../src/adapters/droid.js";
import { GooseAdapter } from "../src/adapters/goose.js";
import { GeminiAdapter } from "../src/adapters/gemini.js";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import { PiAdapter } from "../src/adapters/pi.js";
import { QwenAdapter } from "../src/adapters/qwen.js";
import { ZaiAdapter } from "../src/adapters/zai.js";
import {
  AGENT_IDS,
  getAdapter,
  getAllAdapters,
  getAvailableAdapters,
} from "../src/adapters/index.js";

describe("Adapter Registry", () => {
  test("AGENT_IDS contains all expected agents", () => {
    expect(AGENT_IDS).toContain("claude");
    expect(AGENT_IDS).toContain("codex");
    expect(AGENT_IDS).toContain("droid");
    expect(AGENT_IDS).toContain("goose");
    expect(AGENT_IDS).toContain("gemini");
    expect(AGENT_IDS).toContain("opencode");
    expect(AGENT_IDS).toContain("pi");
    expect(AGENT_IDS).toContain("qwen");
    expect(AGENT_IDS).toContain("zai");
    expect(AGENT_IDS).toContain("kimi");
    expect(AGENT_IDS).toContain("openhands");
    expect(AGENT_IDS).toContain("agy");
    expect(AGENT_IDS.length).toBe(16);
  });

  test("every agent id resolves to an adapter that reports that id", () => {
    // The per-class assertions below cover a subset by hand; this one closes
    // the gap for the whole set, so a new agent cannot be registered without
    // a working adapter behind it.
    for (const id of AGENT_IDS) {
      expect(getAdapter(id).id, id).toBe(id);
    }
  });

  test("getAdapter returns correct adapter for each agent", () => {
    expect(getAdapter("agy")).toBeInstanceOf(AgyAdapter);
    expect(getAdapter("claude")).toBeInstanceOf(ClaudeAdapter);
    expect(getAdapter("codex")).toBeInstanceOf(CodexAdapter);
    expect(getAdapter("droid")).toBeInstanceOf(DroidAdapter);
    expect(getAdapter("goose")).toBeInstanceOf(GooseAdapter);
    expect(getAdapter("gemini")).toBeInstanceOf(GeminiAdapter);
    expect(getAdapter("opencode")).toBeInstanceOf(OpencodeAdapter);
    expect(getAdapter("pi")).toBeInstanceOf(PiAdapter);
    expect(getAdapter("qwen")).toBeInstanceOf(QwenAdapter);
    expect(getAdapter("zai")).toBeInstanceOf(ZaiAdapter);
  });

  test("an explicit environment view hides exported provider overrides", () => {
    // Regression (h2 review): the factories used to construct every adapter
    // against process.env regardless of the view getAdapter was handed, so an
    // exported CODEMUX_*_PROVIDER_* override leaked into `verify`'s empty
    // view — a configured adapter then failed verify's static wiring for a
    // working setup (observed through cline's per-run data directory; that
    // override left with the 0.7.0 dead-surface cut, so the regression
    // rides droid's per-run settings file now). The factory must forward
    // the view it is given.
    process.env.CODEMUX_DROID_PROVIDER_BASE_URL = "https://override.example/v1";
    process.env.CODEMUX_DROID_PROVIDER_API_KEY = "override-key";
    process.env.CODEMUX_DROID_PROVIDER_MODEL = "override-model";
    try {
      const adapter = getAdapter("droid", {});
      expect(adapter.getRunEnv({ agent: "droid", prompt: "p" })).toEqual({});
      expect(adapter.buildRunCommand({ agent: "droid", prompt: "p" }))
        .toEqual(["droid", "exec"]);
      // The launch path (no view) still sees the override and keeps failing
      // closed without prepared per-run settings.
      expect(() => getAdapter("droid").getRunEnv({ agent: "droid", prompt: "p" }))
        .toThrow("were not prepared before launch");
    } finally {
      delete process.env.CODEMUX_DROID_PROVIDER_BASE_URL;
      delete process.env.CODEMUX_DROID_PROVIDER_API_KEY;
      delete process.env.CODEMUX_DROID_PROVIDER_MODEL;
    }
  });

  test("the round-2 adapters' factories forward the view", () => {
    // Regression (round-5 review): the claude, codex, and openhands
    // factories dropped the factory's env argument, so an exported
    // CODEMUX_*_PROVIDER_* override leaked into `verify`'s empty view — the
    // same class the droid test above pins. Codex was the loudest: its TUI
    // refusal ("headless runs only") fired inside verifyTuiBuilds and every
    // `codemux verify` reported codex as broken; claude and openhands failed
    // the same way on a modelless override.
    const trio = (agent: string): Record<string, string> => ({
      [`CODEMUX_${agent.toUpperCase()}_PROVIDER_BASE_URL`]: "https://override.example",
      [`CODEMUX_${agent.toUpperCase()}_PROVIDER_API_KEY`]: "override-key",
      [`CODEMUX_${agent.toUpperCase()}_PROVIDER_MODEL`]: "override-model",
    });
    const vars = { ...trio("claude"), ...trio("codex"), ...trio("openhands") };
    for (const [name, value] of Object.entries(vars)) process.env[name] = value;
    try {
      // The empty view (verify's) hides all three overrides.
      expect(getAdapter("claude", {}).getEnv()).toEqual({
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      });
      const codexPlain = getAdapter("codex", {}).buildRunCommand({ agent: "codex", prompt: "p" });
      // Every run asks for the event stream and names a fallback file
      // whose static no-context shape is the fail-closed placeholder
      // (round al29: the plain verdict reads the file for the Plan-only
      // turn's messageless stream alone, so plain and --result-json argv
      // are one shape again).
      expect(codexPlain).toEqual([
        "codex",
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-rules",
        "--json",
        "--output-last-message",
        join(homedir(), ".codex", ".codemux-scratch", "unprepared", "last-message"),
        "-",
      ]);
      expect(
        getAdapter("codex", {}).buildRunCommand({ agent: "codex", prompt: "p", resultJson: true })
      ).toEqual(codexPlain);
      expect(getAdapter("openhands", {}).getRunEnv({ agent: "openhands", prompt: "p" }))
        .toEqual({});
      expect(getAdapter("openhands", {}).buildRunCommand({ agent: "openhands", prompt: "p" }))
        .toEqual(["openhands", "--headless", "--task", "p"]);
      // The launch view (no explicit view) still sees them.
      expect(getAdapter("claude").getEnv().ANTHROPIC_BASE_URL)
        .toBe("https://override.example");
      expect(
        getAdapter("codex").buildRunCommand({ agent: "codex", prompt: "p" })
          .some((argument) => argument.includes(".codemux-provider"))
      ).toBe(true);
      expect(getAdapter("openhands").getRunEnv({ agent: "openhands", prompt: "p" }).LLM_BASE_URL)
        .toBe("https://override.example");
    } finally {
      for (const name of Object.keys(vars)) delete process.env[name];
    }
  });

  test("getAdapter throws for unknown agent", () => {
    expect(() => getAdapter("unknown" as any)).toThrow("Unknown agent: unknown");
  });

  test("getAllAdapters returns all 16 adapters", () => {
    const adapters = getAllAdapters();
    expect(adapters.length).toBe(16);
  });

  test("getAvailableAdapters filters by executable availability", () => {
    const available = getAvailableAdapters();
    expect(available.every((adapter) => adapter.isAvailable())).toBe(true);
  });
});

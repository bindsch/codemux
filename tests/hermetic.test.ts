import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAdapter } from "../src/adapters/index.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { ZaiAdapter } from "../src/adapters/zai.js";
import { createCodexHermeticHome } from "../src/hermetic-home.js";
import { evaluateCanary, plantCanary } from "../src/hermetic-canary.js";
import { agentsSupporting } from "../src/parity/index.js";
import { AGENT_IDS, type RunRequest } from "../src/types.js";

// The verified harnesses (claude, zai, codex, opencode) and the shared
// refusal, canary and env-prefix machinery live here. The harnesses that
// claim --tools none only — droid, kimi, pi and goose, each verified live
// through a provider override — are in the hermetic-harness-mappings-*.test.ts
// files; the per-harness provider-override suites in their own files.

// --output-format stream-json --verbose rides on every run: the stream is
// what the plain-run unwrap consumes, hermetic or not.
const PLAIN_CLAUDE = ["claude", "-p", "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence", "--output-format", "stream-json", "--verbose"];

describe("hermetic runs: claude and zai", () => {
  const HERMETIC_CLAUDE = ["claude", "-p", "--safe-mode", "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence", "--output-format", "stream-json", "--verbose"];

  test("--hermetic adds --safe-mode, keeps the user setting source and the tools", () => {
    const cmd = new ClaudeAdapter().buildRunCommand({ agent: "claude", prompt: "p", model: "haiku", hermetic: true });
    expect(cmd).toEqual([...HERMETIC_CLAUDE, "--model", "haiku"]);
  });

  test("--tools none removes the built-in tools independently of --hermetic", () => {
    expect(new ClaudeAdapter().buildRunCommand({ agent: "claude", prompt: "p", tools: "none" }))
      .toEqual([...PLAIN_CLAUDE, "--tools", ""]);
    expect(new ClaudeAdapter().buildRunCommand({ agent: "claude", prompt: "p", hermetic: true, tools: "none" }))
      .toEqual([...HERMETIC_CLAUDE, "--tools", ""]);
    expect(new ClaudeAdapter().buildRunCommand({ agent: "claude", prompt: "p", tools: "default" }))
      .toEqual(PLAIN_CLAUDE);
  });

  test("zai follows the same mapping", () => {
    const cmd = new ZaiAdapter().buildRunCommand({ agent: "zai", prompt: "p", hermetic: true, tools: "none" });
    expect(cmd).toEqual([...HERMETIC_CLAUDE, "--tools", "", "--model", "opus"]);
  });

  test("plain commands are unchanged", () => {
    expect(new ClaudeAdapter().buildRunCommand({ agent: "claude", prompt: "p" })).toEqual(PLAIN_CLAUDE);
  });

  test("instruction directories become --add-dir; the project source turns on only for the working directory itself", () => {
    expect(new ClaudeAdapter().buildRunCommand({ agent: "claude", prompt: "p", cwd: "/tmp/a", instructionDirs: ["/tmp/a", "/tmp/b"] }))
      .toEqual(["claude", "-p", "--setting-sources", "user,project", "--strict-mcp-config", "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--add-dir", "/tmp/a", "--add-dir", "/tmp/b"]);
    expect(new ClaudeAdapter().buildRunCommand({ agent: "claude", prompt: "p", cwd: "/tmp/a", hermetic: true, instructionDirs: ["/tmp/a"] }))
      .toEqual(["claude", "-p", "--safe-mode", "--setting-sources", "user,project", "--strict-mcp-config", "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--add-dir", "/tmp/a"]);
    // An instruction directory elsewhere never enables the working
    // directory's own settings file.
    expect(new ClaudeAdapter().buildRunCommand({ agent: "claude", prompt: "p", cwd: "/tmp/repo", instructionDirs: ["/tmp/a"] }))
      .toEqual([...PLAIN_CLAUDE, "--add-dir", "/tmp/a"]);
  });

  test("equivalent spellings of the working directory keep the project source enabled (review round 87)", () => {
    // Raw-string comparison made `/tmp/repo` and `/tmp/repo/.` compare
    // unequal, silently disabling project instructions for a run whose
    // working directory IS an instruction directory. Both sides of the
    // comparison are canonicalized now (resolve, then realpath where the
    // path exists). The temp root is realized first: on macOS it is a
    // symlink, and an unrealized spelling would compare unequal for real.
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "codemux-instr-")));
    try {
      const sources = (adapter: ClaudeAdapter | ZaiAdapter, cwd: string, instructionDirs: readonly string[]): string => {
        const cmd = adapter.buildRunCommand({ agent: adapter.id, prompt: "p", cwd, instructionDirs });
        return cmd[cmd.indexOf("--setting-sources") + 1]!;
      };
      const dotted = join(repo, ".");
      mkdirSync(join(repo, "sub"));
      const link = join(repo, "link");
      symlinkSync(join(repo, "sub"), link);
      for (const adapter of [new ClaudeAdapter(), new ZaiAdapter()]) {
        expect(sources(adapter, repo, [dotted])).toBe("user,project");
        expect(sources(adapter, dotted, [repo])).toBe("user,project");
        expect(sources(adapter, repo, [join(tmpdir(), "codemux-elsewhere-")])).toBe("user");
        // A relative instruction directory resolves against the run's
        // working directory, where the harness resolves it, not against
        // codemux's own process directory (review rounds 232 and 238).
        expect(sources(adapter, repo, ["."])).toBe("user,project");
        expect(sources(adapter, repo, ["elsewhere"])).toBe("user");
        // A relative path climbs the real tree, as the child's `..` does:
        // through a symlinked working directory the lexical parent would
        // be the link's directory, not the target's (review round 244).
        expect(sources(adapter, link, ["../sub"])).toBe("user,project");
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// Restored from the pre-merge tree (h1 review finding): the merge dropped
// this describe while src/hermetic-home.ts stayed byte-identical, losing
// its signal-registration coverage.
describe("hermetic home signal handling", () => {
  test("handlers exist only while a home is live, and finalize on a signal outside a run", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-signals-"));
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "auth.json"), "{}", { mode: 0o600 });
    const before = process.listenerCount("SIGHUP");
    const first = createCodexHermeticHome(join(home, ".codex"));
    const second = createCodexHermeticHome(join(home, ".codex"));
    try {
      expect(process.listenerCount("SIGHUP")).toBe(before + 1);
      first.finalize();
      expect(process.listenerCount("SIGHUP")).toBe(before + 1);
      second.finalize();
      expect(process.listenerCount("SIGHUP")).toBe(before);
      expect(() => statSync(first.home)).toThrow();
      expect(() => statSync(second.home)).toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("hermetic runs: the other harnesses refuse", () => {
  // The sets come from the parity declarations, so a harness that gains
  // either feature drops out of the refusal arm here only when its
  // declaration says so. Agy keeps its explicit read-only arm below.
  const supportedHermetic = new Set<string>(agentsSupporting("run.hermetic"));
  const supportedTools = new Set<string>(agentsSupporting("run.tools-none"));
  test("at least one harness still refuses each feature", () => {
    expect(AGENT_IDS.filter((id) => !supportedHermetic.has(id)).length).toBeGreaterThan(0);
    expect(AGENT_IDS.filter((id) => !supportedTools.has(id)).length).toBeGreaterThan(0);
  });
  for (const agentId of AGENT_IDS) {
    if (agentId !== "agy" && supportedHermetic.has(agentId) && supportedTools.has(agentId)) continue;
    test(`${agentId} refuses what it cannot do but accepts --tools default`, () => {
      const adapter = getAdapter(agentId);
      const cwd = mkdtempSync(join(tmpdir(), "codemux-hermetic-refuse-"));
      mkdirSync(join(cwd, ".git"));
      try {
        const base: RunRequest = { agent: agentId, prompt: "p", cwd, sandboxed: true, autonomy: "high" };
        if (agentId === "agy") {
          expect(adapter.capabilities().supportsHermetic).toBe(true);
          expect(adapter.capabilities().supportsToolSelection).toBe(true);
          expect(() => adapter.validateRunRequest({ ...base, autonomy: "read-only", hermetic: true, tools: "none" }))
            .not.toThrow();
          return;
        }
        if (!supportedHermetic.has(agentId)) {
          expect(adapter.capabilities().supportsHermetic ?? false).toBe(false);
          expect(() => adapter.validateRunRequest({ ...base, hermetic: true }))
            .toThrow("no verified hermetic mode");
        }
        if (!supportedTools.has(agentId)) {
          expect(adapter.capabilities().supportsToolSelection ?? false).toBe(false);
          expect(() => adapter.validateRunRequest({ ...base, tools: "none" }))
            .toThrow("cannot remove its built-in tools");
        }
        expect(() => adapter.validateRunRequest({ ...base, tools: "default" })).not.toThrow();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }

  test("an unknown tools value is rejected", () => {
    expect(() => getAdapter("claude").validateRunRequest({ agent: "claude", prompt: "p", tools: "all" as never }))
      .toThrow("tools must be one of");
  });
});

describe("hermetic canary", () => {
  test("plants the code word in every instruction file the harnesses read", () => {
    const canary = plantCanary();
    try {
      for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        expect(readFileSync(join(canary.cwd, name), "utf8")).toContain(canary.marker);
      }
      expect(statSync(join(canary.cwd, ".git")).isDirectory()).toBe(true);
    } finally {
      canary.cleanup();
    }
    expect(() => statSync(canary.cwd)).toThrow();
  });

  test("judges the model's answer: only a bare OK is clean", () => {
    expect(evaluateCanary("OK\n", "CODEMUX-CANARY-1")).toEqual({ kind: "clean" });
    expect(evaluateCanary("`OK.`\n", "CODEMUX-CANARY-1")).toEqual({ kind: "clean" });
    expect(evaluateCanary("```\nOK\n```\n", "CODEMUX-CANARY-1")).toEqual({ kind: "clean" });
    expect(evaluateCanary("CODEMUX-CANARY-1 OK", "CODEMUX-CANARY-1"))
      .toEqual({ kind: "leak", what: "marker", answer: "CODEMUX-CANARY-1" });
    expect(evaluateCanary("Laurent\n", "CODEMUX-CANARY-1"))
      .toEqual({ kind: "leak", what: "other", answer: "Laurent" });
    // An OK line beside a name is not a pass.
    expect(evaluateCanary("Some Owner\nOK\n", "CODEMUX-CANARY-1"))
      .toEqual({ kind: "leak", what: "other", answer: "Some Owner\nOK" });
  });

  test("a marker the capture fold shed still reports a leak (round 17, contracts-2 1)", async () => {
    // The full-output scan contract covers output a bounded fold drops:
    // a kimi plain run sheds tool results to hold the capture bound, so
    // the scan surface is the kept bytes plus the fold's evidence of
    // what it shed. A marker only in a tool result must fail the check.
    const { KimiPlainFold } = await import("../src/plain-unwrap/kimi-fold.js");
    const { mintCanaryMarker } = await import("../src/hermetic-canary.js");
    const marker = mintCanaryMarker();
    expect(marker).toMatch(/^CODEMUX-CANARY-[0-9A-F]{8}$/);
    const fold = new KimiPlainFold();
    fold.push(
      `${JSON.stringify({ role: "tool", tool_call_id: "call_1", content: `code word ${marker}` })}\n` +
      `${JSON.stringify({ role: "assistant", content: "OK" })}\n`
    );
    const kept = fold.finish();
    expect(kept).not.toContain(marker);
    // The kept bytes alone would pass — the leak lives only in what was
    // shed, which is exactly the case the evidence channel exists for.
    // (The model's answer "OK" is what the plain unwrap extracts from the
    // kept wire; the scan runs on the whole surface.)
    expect(evaluateCanary(kept, marker, "OK")).toEqual({ kind: "clean" });
    expect(evaluateCanary(kept + fold.droppedMarkerEvidence(), marker, "OK"))
      .toEqual({ kind: "leak", what: "marker", answer: marker });
  });
});

describe("env-prefixed commands", () => {
  // The program slot holds the validated realpath of the shell Bun.which
  // finds — whatever /bin/sh resolves to on this machine (dash, bash, …),
  // so the expectation is computed, not spelled out.
  const shRealpath = () => realpathSync(Bun.which("sh")!);

  test("both env and the program it launches are resolved and validated", () => {
    const { resolveTrustedCommand } = require("../src/executable-security.js") as typeof import("../src/executable-security.js");
    const resolved = resolveTrustedCommand(["env", "HOME=/x", "CODEX_HOME=/x/.codex", "sh", "-c", "true"], "test");
    expect(resolved[0]).toMatch(/\/env$/);
    expect(resolveTrustedCommand(["/usr/bin/env", "HOME=/x", "sh"], "test")[2]).toBe(shRealpath());
    // env keeps the name it was found under (a multi-call binary reads argv[0]).
    expect(resolveTrustedCommand(["/usr/bin/env", "HOME=/x", "sh"], "test")[0]).toBe("/usr/bin/env");
    expect(resolved.slice(1, 3)).toEqual(["HOME=/x", "CODEX_HOME=/x/.codex"]);
    // The program slot is the validated realpath, not the bare name it was found under.
    expect(resolved[3]).toBe(shRealpath());
    expect(resolved.slice(4)).toEqual(["-c", "true"]);
  });

  test("a program the env prefix cannot resolve is refused", () => {
    const { resolveTrustedCommand } = require("../src/executable-security.js") as typeof import("../src/executable-security.js");
    expect(() => resolveTrustedCommand(["env", "HOME=/x", "codemux-no-such-binary"], "test"))
      .toThrow("executable 'codemux-no-such-binary' was not found");
    expect(() => resolveTrustedCommand(["env", "HOME=/x"], "test")).toThrow("names no program");
  });

  test("-u pairs before the assignments only unset a plain variable name", () => {
    const { resolveTrustedCommand } = require("../src/executable-security.js") as typeof import("../src/executable-security.js");
    const resolved = resolveTrustedCommand(
      ["env", "-u", "OPENCODE_CONFIG_DIR", "-u", "OPENCODE_CONFIG_CONTENT", "HOME=/x", "sh", "-c", "true"],
      "test"
    );
    expect(resolved.slice(1, 6)).toEqual(["-u", "OPENCODE_CONFIG_DIR", "-u", "OPENCODE_CONFIG_CONTENT", "HOME=/x"]);
    expect(resolved[6]).toBe(shRealpath());
    expect(() => resolveTrustedCommand(["env", "-u", "PATH2=x", "sh"], "test"))
      .toThrow("env prefix unsets an invalid variable name");
    expect(() => resolveTrustedCommand(["env", "-u"], "test")).toThrow("unsets an invalid variable name");
    // Every other option stays refused: -i and -S reinterpret the prefix.
    expect(() => resolveTrustedCommand(["env", "-i", "HOME=/x", "sh"], "test")).toThrow("names no program");
    expect(() => resolveTrustedCommand(["env", "-S", "HOME=/x", "sh"], "test")).toThrow("names no program");
  });

  test("an option after an assignment names no program, it is not honored", () => {
    const { resolveTrustedCommand } = require("../src/executable-security.js") as typeof import("../src/executable-security.js");
    // Regression: the scan used to keep honoring -u NAME past an
    // assignment, so ["env", "A=1", "-u", "X", "opencode"] validated
    // opencode — but options must precede assignments, and env (BSD env,
    // and POSIX env generally) would instead try to execute "-u" from
    // PATH. The validated binary must be the one that runs.
    expect(() => resolveTrustedCommand(["env", "A=1", "-u", "X", "sh"], "test"))
      .toThrow("names no program");
    expect(() => resolveTrustedCommand(["env", "A=1", "--unset", "X", "sh"], "test"))
      .toThrow("names no program");
  });

  test("a hermetic codex run refuses a repository-planted codex binary", () => {
    const { resolveTrustedCommand } = require("../src/executable-security.js") as typeof import("../src/executable-security.js");
    const repo = mkdtempSync(join(tmpdir(), "codemux-planted-"));
    try {
      writeFileSync(join(repo, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      expect(() => resolveTrustedCommand(["env", "HOME=/x", "codex"], "codex", repo, `${repo}:/usr/bin:/bin`))
        .toThrow("must not be inside the execution working directory");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

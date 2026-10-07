import { describe, test, expect } from "bun:test";
import { AGENT_IDS } from "../src/adapters/index.js";
import { CURSOR_ENTRY_ENV, CursorAdapter } from "../src/adapters/cursor.js";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEffectiveScodeCommands,
  verificationCwd,
  verifyAgentWiring,
  verifyAgentsWiring,
} from "../src/verify.js";
import { assertNoCopilotProjectExecutionConfig } from "../src/project-safety.js";

describe("Verifier", () => {
  test("verification cwd ends the project-configuration walk at itself", () => {
    // The scratch dir must be a walk root: a harness configuration file in an
    // ancestor (the user's temp root, say) must not reach the adapters.
    const cwd = verificationCwd();
    expect(existsSync(join(cwd, ".git"))).toBe(true);
    expect(() => assertNoCopilotProjectExecutionConfig(cwd)).not.toThrow();

    // Same shape, reproduced in a private tree: planted config one level up
    // is invisible once the child carries the marker, visible without it.
    const root = mkdtempSync(join(tmpdir(), "codemux-verify-root-"));
    try {
      mkdirSync(join(root, ".claude"));
      writeFileSync(join(root, ".claude", "settings.local.json"), "{}");
      const bare = join(root, "bare");
      mkdirSync(bare);
      expect(() => assertNoCopilotProjectExecutionConfig(bare)).toThrow();
      const marked = join(root, "marked");
      mkdirSync(join(marked, ".git"), { recursive: true });
      expect(() => assertNoCopilotProjectExecutionConfig(marked)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("verifyAgentsWiring returns one result per agent", () => {
    // Building every adapter's real command is spawn-free (see the
    // CursorEntry comment in src/adapters/cursor.ts), so this stays in
    // the default timeout.
    const rows = verifyAgentsWiring(AGENT_IDS);
    expect(rows.length).toBe(AGENT_IDS.length);
  });

  test("verifyAgentsWiring has no FAIL rows for current adapters", () => {
    const rows = verifyAgentsWiring(AGENT_IDS);
    for (const row of rows) {
      expect(row.mappingOk).toBe(true);
      expect(row.runBuildOk).toBe(true);
      expect(row.tuiBuildOk).toBe(true);
      expect(row.status).not.toBe("FAIL");
    }
  });

  test("verifyAgentWiring supports single-agent validation", () => {
    const row = verifyAgentWiring("codex");
    expect(row.agentId).toBe("codex");
    expect(row.mappingOk).toBe(true);
    expect(row.runBuildOk).toBe(true);
    expect(row.tuiBuildOk).toBe(true);
  });

  test("an exported CODEMUX_CURSOR_ENTRY never fails the static wiring check", () => {
    // Round-5 regression: `codemux verify` in a shell with the desktop
    // opt-in exported built cursor's commands through the launch-path
    // adapter -- the variable selected the desktop entry, the empty
    // passthrough could not authorize it, and the wiring check recorded
    // the refusal as "run command generation failed" and reported FAIL.
    // Verify is static, so its result must not depend on the operator's
    // shell: it builds against an explicitly empty environment view
    // (STATIC_WIRING_ENV in src/verify.ts), never the exported one.
    const saved = process.env[CURSOR_ENTRY_ENV];
    process.env[CURSOR_ENTRY_ENV] = "cursor";
    try {
      // The launch view really does refuse in this exact environment
      // (wherever `cursor` resolves, the default finder's own rule): this
      // pins the premise, so the test bites instead of passing vacuously
      // on machines without the desktop binary.
      if (Bun.which("cursor", { PATH: process.env.PATH }) !== null) {
        const launchView = new CursorAdapter(undefined, process.env);
        expect(() =>
          launchView.validateRunRequest({
            agent: "cursor",
            prompt: "verify",
            cwd: verificationCwd(),
          })
        ).toThrow(/CODEMUX_CURSOR_ENTRY/);
      }
      const row = verifyAgentWiring("cursor");
      expect(row.runBuildOk).toBe(true);
      expect(row.tuiBuildOk).toBe(true);
      expect(row.status).not.toBe("FAIL");
      expect(row.issues).toEqual([]);
    } finally {
      if (saved === undefined) {
        delete process.env[CURSOR_ENTRY_ENV];
      } else {
        process.env[CURSOR_ENTRY_ENV] = saved;
      }
    }
  });

  test("exported provider overrides never change the static wiring result", () => {
    // Round-5 regression: an exported CODEMUX_<AGENT>_PROVIDER_* trio made
    // `codemux verify` FAIL the agents it named — the factories dropped the
    // view for claude/codex/openhands (codex's "headless runs only" TUI
    // refusal fired inside verifyTuiBuilds; claude and openhands failed the
    // same way on a modelless override), and the base unsupported-override
    // check read process.env directly, failing every non-supporting harness
    // (zai pinned here). Verify is static: its rows must be identical
    // whatever the operator exported.
    const clean = verifyAgentsWiring(AGENT_IDS);
    const vars: Record<string, string> = {};
    // Supporting and non-supporting harnesses alike: a non-supporting one
    // (gemini, qwen) must not turn FAIL because the operator exported an
    // override for it — verify reads the empty view, not the shell.
    for (const agent of ["claude", "codex", "openhands", "zai", "gemini", "qwen", "agy"]) {
      vars[`CODEMUX_${agent.toUpperCase()}_PROVIDER_BASE_URL`] = "https://override.example";
      vars[`CODEMUX_${agent.toUpperCase()}_PROVIDER_API_KEY`] = "k";
      vars[`CODEMUX_${agent.toUpperCase()}_PROVIDER_MODEL`] = "m";
    }
    for (const [name, value] of Object.entries(vars)) process.env[name] = value;
    try {
      const withOverrides = verifyAgentsWiring(AGENT_IDS);
      expect(withOverrides.every((row) => row.status !== "FAIL")).toBe(true);
      expect(withOverrides).toEqual(clean);
    } finally {
      for (const name of Object.keys(vars)) delete process.env[name];
    }
  });

  test("buildEffectiveScodeCommands returns run+tui rows for each autonomy level", () => {
    const rows = buildEffectiveScodeCommands(["codex"]);
    expect(rows.length).toBe(8);
    expect(new Set(rows.map(
      (row) => `${row.agentId}:${row.autonomy}:${row.mode}`
    ))).toEqual(new Set([
      "codex:read-only:run",
      "codex:read-only:tui",
      "codex:low:run",
      "codex:low:tui",
      "codex:medium:run",
      "codex:medium:tui",
      "codex:high:run",
      "codex:high:tui",
    ]));
    expect(rows.every((row) => row.command[0] === "scode")).toBe(true);
  });

  test("buildEffectiveScodeCommands applies override options", () => {
    const rows = buildEffectiveScodeCommands(["codex"], {
      trust: "trusted",
      noNet: true,
      scrubEnv: true,
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.command).toContain("--trust");
      expect(row.command).toContain("trusted");
      expect(row.command).toContain("--no-net");
      expect(row.command).toContain("--scrub-env");
    }
  });

  test("untrusted previews remain read-only at every autonomy level", () => {
    const rows = buildEffectiveScodeCommands(["codex"], { trust: "untrusted" });
    for (const row of rows) {
      expect(row.command).toContain("--ro");
      expect(row.command).not.toContain("--rw");
    }
  });

  test("buildEffectiveScodeCommands keeps API access while enforcing filesystem modes", () => {
    const rows = buildEffectiveScodeCommands(["codex", "opencode"]);
    const codexLowRun = rows.find(
      (row) => row.agentId === "codex" && row.autonomy === "low" && row.mode === "run"
    );
    const opencodeMediumRun = rows.find(
      (row) => row.agentId === "opencode" && row.autonomy === "medium" && row.mode === "run"
    );

    expect(codexLowRun).toBeDefined();
    expect(codexLowRun?.command).toContain("--trust");
    expect(codexLowRun?.command).toContain("standard");

    expect(opencodeMediumRun).toBeDefined();
    expect(opencodeMediumRun?.command).toContain("--trust");
    expect(opencodeMediumRun?.command).toContain("standard");
  });
});

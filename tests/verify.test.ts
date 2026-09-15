import { describe, test, expect } from "bun:test";
import { AGENT_IDS } from "../src/adapters/index.js";
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

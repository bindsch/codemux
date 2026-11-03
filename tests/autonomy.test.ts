import { describe, test, expect } from "bun:test";
import { AGENT_IDS, getAdapter } from "../src/adapters/index.js";
import { AUTONOMY_EQUIVALENCE } from "../src/autonomy.js";
import {
  AUTONOMY_LEVELS,
  type AgentId,
  type AutonomyLevel,
  isAutonomyLevel,
  isReasoningEffort,
} from "../src/types.js";

/** The exact argv mapAutonomy builds per agent and level, generated once
 * from the adapters and committed. Any single-cell change — a flag added,
 * dropped, renamed, or reordered — fails the toEqual below, so a review
 * sees the drift instead of a display table quietly going stale (the
 * codex row named `-a` flags codex no longer builds). */
const GOLDEN_MAP_AUTONOMY: Record<AgentId, Record<AutonomyLevel, string[]>> = {
  agy: {
    "read-only": ["--mode=plan"],
    low: [],
    medium: ["--mode=accept-edits"],
    high: ["--dangerously-skip-permissions"],
  },
  aider: {
    "read-only": ["--dry-run"],
    low: [],
    medium: ["--yes-always"],
    high: ["--yes-always"],
  },
  claude: {
    "read-only": ["--permission-mode", "plan"],
    low: ["--permission-mode", "manual"],
    medium: ["--permission-mode", "acceptEdits"],
    high: ["--dangerously-skip-permissions"],
  },
  cline: {
    "read-only": ["--plan"],
    low: ["--auto-approve", "false"],
    medium: ["--auto-approve", "true"],
    high: ["--auto-approve", "true"],
  },
  codex: {
    "read-only": ["-s", "read-only", "-c", 'approval_policy="never"'],
    low: ["-s", "workspace-write", "-c", 'approval_policy="untrusted"'],
    medium: ["-s", "workspace-write", "-c", 'approval_policy="never"'],
    high: ["-s", "danger-full-access", "-c", 'approval_policy="never"'],
  },
  copilot: {
    "read-only": ["--plan"],
    low: ["--allow-tool", "read"],
    medium: ["--allow-all-tools"],
    high: ["--allow-all"],
  },
  cursor: {
    "read-only": ["--mode", "plan"],
    low: [],
    medium: ["--auto-review"],
    high: ["--force"],
  },
  droid: {
    "read-only": [],
    low: ["--auto", "low"],
    medium: ["--auto", "medium"],
    high: ["--auto", "high"],
  },
  gemini: {
    "read-only": ["--approval-mode", "plan"],
    low: ["--approval-mode", "default"],
    medium: ["--approval-mode", "yolo"],
    high: ["--approval-mode", "yolo"],
  },
  goose: {
    "read-only": [],
    low: [],
    medium: [],
    high: [],
  },
  kimi: {
    "read-only": ["--plan"],
    low: [],
    medium: ["--yolo"],
    high: ["--auto"],
  },
  openhands: {
    "read-only": [],
    low: [],
    medium: [],
    high: ["--always-approve"],
  },
  opencode: {
    "read-only": ["--agent", "plan"],
    low: ["--agent", "build"],
    medium: ["--agent", "build"],
    high: ["--agent", "build", "--auto"],
  },
  pi: {
    "read-only": ["--no-extensions", "--tools", "read,grep,find,ls"],
    low: ["--no-extensions", "--tools", "read,grep,find,ls,edit,write"],
    medium: [],
    high: [],
  },
  qwen: {
    "read-only": ["--approval-mode", "plan"],
    low: ["--approval-mode", "default"],
    medium: ["--approval-mode", "auto"],
    high: ["--approval-mode", "yolo"],
  },
  zai: {
    "read-only": ["--permission-mode", "plan"],
    low: ["--permission-mode", "manual"],
    medium: ["--permission-mode", "acceptEdits"],
    high: ["--dangerously-skip-permissions"],
  },
};

/** Flag-shaped tokens: a "-x"/"--xx" at a cell or space boundary, so
 * hyphenated words ("always-ask", "soft-denies") and "=value" halves of
 * "--flag=value" tokens are handled by the callers. */
const flags = (text: string): string[] =>
  [...text.matchAll(/(?<=^|[\s(+])--?[A-Za-z][A-Za-z0-9_-]*/g)].map((m) => m[0]!);

describe("Autonomy equivalence matrix", () => {
  test("runtime type guards reject unsupported values", () => {
    expect(isAutonomyLevel("read-only")).toBe(true);
    expect(isAutonomyLevel("root")).toBe(false);
    expect(isReasoningEffort("high")).toBe(true);
    expect(isReasoningEffort("extreme")).toBe(false);
  });

  test("covers every registered agent", () => {
    const matrixAgents = Object.keys(AUTONOMY_EQUIVALENCE).sort();
    const registeredAgents = [...AGENT_IDS].sort();
    expect(matrixAgents).toEqual(registeredAgents);
  });

  test("mapAutonomy matches the committed golden argv table", () => {
    // Adapter construction only resolves names; it launches nothing.
    for (const agentId of AGENT_IDS) {
      const adapter = getAdapter(agentId, { PATH: "" });
      for (const level of AUTONOMY_LEVELS) {
        expect(adapter.mapAutonomy(level), `${agentId} ${level}`)
          .toEqual(GOLDEN_MAP_AUTONOMY[agentId][level]);
      }
    }
  });

  test("the display table names the flags the adapters build", () => {
    // scode owns two flags the display names where a level rests on the
    // sandbox (cursor's read-only row); no harness launch argv carries
    // them, so they are explained by the sandbox, not the harness.
    const explained = new Set(["--ro", "--rw"]);
    for (const agentId of AGENT_IDS) {
      const adapter = getAdapter(agentId, { PATH: "" });
      // goose builds no autonomy argv at all; its levels ride GOOSE_MODE.
      if (agentId === "goose") continue;
      for (const level of AUTONOMY_LEVELS) {
        for (const token of adapter.mapAutonomy(level)) {
          for (const flag of flags(token)) explained.add(flag);
        }
        // The launch command can carry more than mapAutonomy (claude's
        // --allowedTools grants, kimi's TUI-only flags), so the whole
        // command across levels is the vocabulary a cell may name.
        for (const token of adapter.buildRunCommand({ agent: agentId, prompt: "t", autonomy: level })) {
          for (const flag of flags(token)) explained.add(flag);
        }
      }
      for (const level of AUTONOMY_LEVELS) {
        const cell = AUTONOMY_EQUIVALENCE[agentId].byLevel[level];
        // Positive: every flag this level's argv builds is named.
        for (const token of getAdapter(agentId, { PATH: "" }).mapAutonomy(level)) {
          for (const flag of flags(token)) {
            expect(cell, `${agentId} ${level} names ${flag}`).toContain(flag);
          }
        }
        // Negative: no flag the adapters never build is named either
        // (the codex row once advertised `-a never` after the adapter
        // had moved to the `-c approval_policy` override).
        for (const flag of flags(cell)) {
          expect(explained, `${agentId} ${level} names unbuilt ${flag}`).toContain(flag);
        }
      }
    }
  });

  test("goose's levels ride GOOSE_MODE and the display names each value", () => {
    const adapter = getAdapter("goose", { PATH: "" });
    for (const level of AUTONOMY_LEVELS) {
      const env = adapter.getRunEnv({ agent: "goose", prompt: "t", autonomy: level });
      expect(AUTONOMY_EQUIVALENCE.goose.byLevel[level])
        .toBe(`GOOSE_MODE=${env.GOOSE_MODE}`);
    }
  });

  test.each([
    ["gemini", "yolo"],
    ["qwen", "auto"],
  ] as const)("%s medium lists its command approval mode", (agent, mode) => {
    expect(AUTONOMY_EQUIVALENCE[agent].byLevel.medium).toBe(`--approval-mode ${mode}`);
  });

  test("the cursor note names the 0.12.0 entry order: cursor-agent first, agent its alias (al25)", () => {
    // The contracts major: the note still described the 0.11.0 entry
    // (agent first, cursor-agent unnamed), but 0.12.0 resolves and runs
    // cursor-agent as the standalone entry with agent as its alias — and
    // `codemux autonomy` prints this note in its equivalence matrix, so
    // an operator reading the old order would reach for the alias first.
    const note = AUTONOMY_EQUIVALENCE.cursor.notes ?? "";
    expect(note).toContain("cursor-agent is the standalone entry; agent is its alias");
  });
});

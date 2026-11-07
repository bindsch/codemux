// Base-adapter request validation for the experiment-project-settings
// flag: it is a boolean like web, sandboxed, and hermetic, and the
// unmapped-agent refusal reads the validated value (review round 9,
// edges). Also the instruction-directory base: a relative directory is
// resolved by the harness against the run's working directory, so that
// is the tree it is validated against (review round 232).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";

describe("experimentProjectSettings request validation", () => {
  test("a non-boolean value is refused on an unmapped agent, not skipped", () => {
    const adapter = new CodexAdapter({});
    for (const value of ["yes", "true", 1, null, {}, []]) {
      expect(() =>
        adapter.validateRunRequest({
          agent: "codex",
          prompt: "p",
          experimentProjectSettings: value as unknown as boolean,
        })
      ).toThrow("experimentProjectSettings must be a boolean");
    }
  });

  test("a mapped agent hits the same type check", () => {
    const adapter = new ClaudeAdapter({});
    expect(() =>
      adapter.validateRunRequest({
        agent: "claude",
        prompt: "p",
        hermetic: true,
        experimentProjectSettings: "yes" as unknown as boolean,
      })
    ).toThrow("experimentProjectSettings must be a boolean");
  });

  test("boolean and omitted values pass the type check", () => {
    const adapter = new CodexAdapter({});
    for (const value of [false, undefined]) {
      expect(() =>
        adapter.validateRunRequest({
          agent: "codex",
          prompt: "p",
          experimentProjectSettings: value,
        })
      ).not.toThrow();
    }
  });
});

describe("instruction directory validation", () => {
  test("relative instruction directories validate against the run's working directory (review round 232)", () => {
    // The harness receives the relative directory unchanged (--add-dir)
    // and resolves it against the run's working directory, so a
    // directory that exists only where codemux itself runs is a false
    // pass, and one that exists only under the run's cwd a false
    // refusal. "docs" is the repository's own, present under the
    // process directory the old check read.
    const adapter = new ClaudeAdapter({});
    const base = mkdtempSync(join(tmpdir(), "codemux-instructions-"));
    mkdirSync(join(base, "present-here"));
    try {
      expect(() =>
        adapter.validateRunRequest({
          agent: "claude",
          prompt: "p",
          cwd: base,
          instructionDirs: ["docs"],
        })
      ).toThrow("cwd is not accessible");
      expect(() =>
        adapter.validateRunRequest({
          agent: "claude",
          prompt: "p",
          cwd: base,
          instructionDirs: ["present-here"],
        })
      ).not.toThrow();
      // The raw entry is judged before it is resolved (review round 241):
      // an empty string would resolve to the working directory itself and
      // pass, then reach the harness as an empty --add-dir argument.
      for (const entry of ["", "a\0b", 7 as unknown as string]) {
        expect(() =>
          adapter.validateRunRequest({ agent: "claude", prompt: "p", cwd: base, instructionDirs: [entry] })
        ).toThrow("instructionDirs entries must be non-empty paths without NUL bytes");
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

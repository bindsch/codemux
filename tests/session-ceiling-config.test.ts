import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { claudeCeiling, foldForProtectedLookup, pathInsideScope } from "../src/session/ceiling.js";
import { tempDir } from "./helpers/session-ceiling.js";

describe("medium executable-configuration refusal (review live17)", () => {
  test("medium denies the harness, editor, hook, and shell config paths", () => {
    // Review live17, security major: medium blocked only `.git`, so a
    // caller `allow` let an injected turn write `<cwd>/.claude/settings.json`
    // with a SessionStart hook — the next interactive claude in that
    // directory runs it outside scode. Every path below runs code without
    // anyone running it on purpose; each must deny at medium.
    const dir = tempDir();
    const protectedTargets = [
      join(dir, ".claude", "settings.json"),
      join(dir, ".claude", "settings.local.json"),
      join(dir, ".codex", "config.toml"),
      join(dir, ".gemini", "settings.json"),
      join(dir, ".cursor", "mcp.json"),
      join(dir, ".vscode", "tasks.json"),
      join(dir, ".idea", "workspace.xml"),
      join(dir, ".husky", "pre-commit"),
      join(dir, "pkg", ".envrc"),
      join(dir, ".mcp.json"),
      join(dir, ".gitmodules"),
      join(dir, ".zshrc"),
      join(dir, ".Claude", "Settings.json"),
      join(dir, ".ENVRC"),
    ];
    for (const target of protectedTargets) {
      const verdict = claudeCeiling("medium", "Write", { file_path: target, content: "x" }, dir);
      expect({ target, allowable: verdict.allowable }).toEqual({ target, allowable: false });
      expect(verdict.reason).toContain("executable configuration");
    }
    // The codex fileChange ceiling shares the predicate.
    expect(pathInsideScope(join(dir, ".claude", "settings.json"), dir).allowable).toBe(false);
    // Ordinary files whose names merely resemble the set still allow.
    for (const target of [
      join(dir, "claude", "settings.json"),
      join(dir, "docs", "envrc.md"),
      join(dir, "src", "vscode.ts"),
    ]) {
      expect(
        claudeCeiling("medium", "Write", { file_path: target, content: "x" }, dir).allowable
      ).toBe(true);
    }
    // Only the part below the launch directory is judged: an operator who
    // launched inside such a directory granted its tree.
    const inner = join(dir, ".claude", "skills", "demo");
    mkdirSync(inner, { recursive: true });
    expect(
      claudeCeiling("medium", "Write", { file_path: join(inner, "SKILL.md"), content: "x" }, inner)
        .allowable
    ).toBe(true);
    // High keeps the bare grant; low leaves the answer to the caller.
    const settings = { file_path: join(dir, ".claude", "settings.json"), content: "x" };
    expect(claudeCeiling("high", "Write", settings, dir).allowable).toBe(true);
    expect(claudeCeiling("low", "Write", settings, dir).allowable).toBe(true);
  });

  test("the protected-name fold is Unicode's: long s, Kelvin, and ligatures deny", () => {
    // Review live22, security minor: `toLowerCase` left `ſ` (U+017F) as is,
    // so `.vſcode/tasks.json` passed the check while APFS's case-insensitive
    // lookup opens the real `.vscode`. Every spelling below folds to a
    // protected name and must deny at medium.
    const dir = tempDir();
    for (const target of [
      join(dir, ".vſcode", "tasks.json"),
      join(dir, ".huſky", "pre-commit"),
      join(dir, ".mcp.jſon"),
      join(dir, ".zſhrc"),
      join(dir, ".gitmoduleſ"),
      join(dir, ".claude.jſon"),
      join(dir, ".bash_proﬁle"),
    ]) {
      const verdict = claudeCeiling("medium", "Write", { file_path: target, content: "x" }, dir);
      expect({ target, allowable: verdict.allowable }).toEqual({ target, allowable: false });
    }
    expect(foldForProtectedLookup(".vſcode")).toBe(".vscode");
    expect(foldForProtectedLookup("K")).toBe("k");
    expect(foldForProtectedLookup(".zſhrc")).toBe(".zshrc");
  });
});

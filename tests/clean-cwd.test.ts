import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCleanInstructionFiles, cleanCwdHost } from "../src/clean-cwd.js";
import { UsageRefusalError } from "../src/validation.js";

describe("assertCleanInstructionFiles", () => {
  let root: string;
  const makeTree = (): void => {
    root = mkdtempSync(join(tmpdir(), "clean-cwd-"));
    mkdirSync(join(root, "repo"), { recursive: true });
    mkdirSync(join(root, "repo", "pkg"), { recursive: true });
    writeFileSync(join(root, "repo", ".git"), "");
  };
  const cleanUp = (): void => rmSync(root, { recursive: true, force: true });

  test("passes a clean tree and stops at the git root", () => {
    makeTree();
    try {
      // A planted file ABOVE the repo root is outside the walk: the rule
      // covers the working directory up to the project root, the same
      // range the harnesses search.
      writeFileSync(join(root, "GEMINI.md"), "operator text");
      expect(() =>
        assertCleanInstructionFiles("gemini", join(root, "repo", "pkg"), ["GEMINI.md"])
      ).not.toThrow();
    } finally {
      cleanUp();
    }
  });

  test("refuses a named file in the starting directory", () => {
    makeTree();
    try {
      writeFileSync(join(root, "repo", "pkg", "GEMINI.md"), "operator text");
      expect(() =>
        assertCleanInstructionFiles("gemini", join(root, "repo", "pkg"), ["GEMINI.md"])
      ).toThrow(UsageRefusalError);
    } finally {
      cleanUp();
    }
  });

  test("refuses a named file in an ancestor up to the git root, naming the path", () => {
    makeTree();
    try {
      writeFileSync(join(root, "repo", ".goosehints"), "operator text");
      try {
        assertCleanInstructionFiles("goose", join(root, "repo", "pkg"), [".goosehints"]);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(UsageRefusalError);
        expect((error as UsageRefusalError).message).toContain(join(root, "repo", ".goosehints"));
        expect((error as UsageRefusalError).message).toContain("goose --hermetic");
      }
    } finally {
      cleanUp();
    }
  });

  test("refuses a dangling symlink (lstat, not exists)", () => {
    makeTree();
    try {
      symlinkSync("/nowhere/at/all", join(root, "repo", "pkg", "GEMINI.md"));
      expect(() =>
        assertCleanInstructionFiles("gemini", join(root, "repo", "pkg"), ["GEMINI.md"])
      ).toThrow(UsageRefusalError);
    } finally {
      cleanUp();
    }
  });

  test("checks every name in every directory of the walk", () => {
    makeTree();
    try {
      writeFileSync(join(root, "repo", ".aider.conf.yml"), "model: opus");
      writeFileSync(join(root, "repo", "pkg", ".env"), "KEY=1");
      // The first name hit (.aider.conf.yml at the repo root) is the one
      // the message names, but either refusal proves both names walked.
      expect(() =>
        assertCleanInstructionFiles("aider", join(root, "repo", "pkg"), [
          ".aider.conf.yml",
          ".aider.model.settings.yml",
          ".aider.model.metadata.json",
          ".env",
        ])
      ).toThrow(UsageRefusalError);
      rmSync(join(root, "repo", ".aider.conf.yml"));
      expect(() =>
        assertCleanInstructionFiles("aider", join(root, "repo", "pkg"), [
          ".aider.conf.yml",
          ".aider.model.settings.yml",
          ".aider.model.metadata.json",
          ".env",
        ])
      ).toThrow(UsageRefusalError);
    } finally {
      cleanUp();
    }
  });

  test("walks to the filesystem root when no git repository encloses the run", () => {
    // The host is injected, so the walk can be observed without planting
    // files across the real root: a tree with no .git walks until dirname
    // stops moving, and the planted file two levels up is caught.
    const base = mkdtempSync(join(tmpdir(), "clean-cwd-nogit-"));
    try {
      mkdirSync(join(base, "a", "b"), { recursive: true });
      writeFileSync(join(base, "offender.txt"), "x");
      expect(() =>
        assertCleanInstructionFiles("agent", join(base, "a", "b"), ["offender.txt"])
      ).toThrow(UsageRefusalError);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("the injected host drives the walk (no filesystem reads escape it)", () => {
    const seen: string[] = [];
    let directories = 0;
    const host = {
      lstatSync: (path: string) => {
        seen.push(path);
        return undefined;
      },
      existsSync: (path: string) => {
        directories += 1;
        // One .git two levels up ends the walk.
        return path.endsWith("proj/.git");
      },
      dirname: cleanCwdHost.dirname,
    };
    expect(() =>
      assertCleanInstructionFiles("gemini", "/x/proj/deep/leaf", ["GEMINI.md"], host)
    ).not.toThrow();
    expect(directories).toBe(3);
    expect(seen).toContain("/x/proj/deep/leaf/GEMINI.md");
    expect(seen).toContain("/x/proj/deep/GEMINI.md");
    expect(seen).toContain("/x/proj/GEMINI.md");
  });
});

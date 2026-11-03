import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCeiling } from "../src/session/ceiling.js";
import { tempDir } from "./helpers/session-ceiling.js";

describe("claude ceiling by level", () => {
  test("read-only denies everything, including the editing tools", () => {
    const dir = tempDir();
    for (const [tool, input] of [
      ["Edit", { file_path: join(dir, "a.ts"), old_string: "x", new_string: "y" }],
      ["Write", { file_path: join(dir, "a.ts"), content: "x" }],
      ["Bash", { command: "ls" }],
      ["Read", { file_path: join(dir, "a.ts") }],
      ["mcp__x__y", {}],
      ["NeverHeardOf", {}],
    ] as const) {
      const verdict = claudeCeiling("read-only", tool, input as Record<string, unknown>, dir);
      expect(verdict.allowable).toBe(false);
      expect(verdict.reason.length).toBeGreaterThan(0);
    }
  });

  test("low allows everything, unknown tools included (the caller answers)", () => {
    const dir = tempDir();
    expect(claudeCeiling("low", "Bash", { command: "rm -rf /" }, dir).allowable).toBe(true);
    expect(claudeCeiling("low", "mcp__x__y", {}, dir).allowable).toBe(true);
    expect(claudeCeiling("low", "Whatever", { odd: true }, dir).allowable).toBe(true);
    expect(claudeCeiling("low", "WebFetch", { url: "https://x" }, dir).allowable).toBe(true);
  });

  test("low still denies a known tool whose arguments codemux cannot read", () => {
    const dir = tempDir();
    const verdict = claudeCeiling("low", "Bash", { command: "ls", sneaky: 1 }, dir);
    expect(verdict.allowable).toBe(false);
    expect(verdict.reason).toContain("known schema");
  });

  test("medium allows the editing tools inside the launch directory", () => {
    const dir = tempDir();
    expect(
      claudeCeiling("medium", "Edit", { file_path: join(dir, "a.ts"), old_string: "x", new_string: "y" }, dir).allowable
    ).toBe(true);
    expect(
      claudeCeiling("medium", "Write", { file_path: join(dir, "sub", "new.ts"), content: "x" }, dir).allowable
    ).toBe(true);
    expect(
      claudeCeiling("medium", "NotebookEdit", { notebook_path: `${dir}/nb.ipynb`, new_source: "x" }, dir).allowable
    ).toBe(true);
    // A relative target resolves against the launch directory.
    expect(
      claudeCeiling("medium", "Edit", { file_path: "notes/x.txt", old_string: "x", new_string: "y" }, dir).allowable
    ).toBe(true);
  });

  test("medium denies targets outside the launch directory", () => {
    const dir = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "victim.ts"), "x");
    expect(
      claudeCeiling("medium", "Edit", { file_path: join(outside, "victim.ts"), old_string: "x", new_string: "y" }, dir).allowable
    ).toBe(false);
    expect(
      claudeCeiling("medium", "Write", { file_path: "/etc/passwd", content: "x" }, dir).allowable
    ).toBe(false);
    // `..` cannot walk out of the scope.
    expect(
      claudeCeiling("medium", "Write", { file_path: join(dir, "..", "escape.ts"), content: "x" }, dir).allowable
    ).toBe(false);
  });

  test("medium denies Bash, reads, and ungranted tools", () => {
    const dir = tempDir();
    expect(claudeCeiling("medium", "Bash", { command: "ls" }, dir).allowable).toBe(false);
    expect(claudeCeiling("medium", "Read", { file_path: join(dir, "a.ts") }, dir).allowable).toBe(false);
    expect(claudeCeiling("medium", "WebFetch", { url: "https://x" }, dir).allowable).toBe(false);
    expect(claudeCeiling("medium", "mcp__x__y", {}, dir).allowable).toBe(false);
    expect(claudeCeiling("medium", "NeverHeardOf", {}, dir).allowable).toBe(false);
  });

  test("high grants the mapping's list and denies the rest", () => {
    const dir = tempDir();
    const outside = tempDir();
    expect(
      claudeCeiling("high", "Edit", { file_path: join(outside, "anywhere.ts"), old_string: "x", new_string: "y" }, dir).allowable
    ).toBe(true);
    expect(claudeCeiling("high", "Write", { file_path: "/etc/hosts", content: "x" }, dir).allowable).toBe(true);
    expect(claudeCeiling("high", "NotebookEdit", { notebook_path: "/tmp/n.ipynb", new_source: "x" }, dir).allowable).toBe(true);
    expect(claudeCeiling("high", "Bash", { command: "ls" }, dir).allowable).toBe(true);
    expect(claudeCeiling("high", "Read", { file_path: join(dir, "a.ts") }, dir).allowable).toBe(false);
    expect(claudeCeiling("high", "WebFetch", { url: "https://x" }, dir).allowable).toBe(false);
    expect(claudeCeiling("high", "NeverHeardOf", {}, dir).allowable).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCeiling, pathInsideScope } from "../src/session/ceiling.js";
import { tempDir } from "./helpers/session-ceiling.js";

describe("claude ceiling argument checks", () => {
  test("missing or non-string target path denies", () => {
    const dir = tempDir();
    expect(claudeCeiling("medium", "Edit", { old_string: "x", new_string: "y" }, dir).allowable).toBe(false);
    expect(claudeCeiling("medium", "Edit", { file_path: 42, old_string: "x", new_string: "y" }, dir).allowable).toBe(false);
    expect(claudeCeiling("medium", "Edit", { file_path: "", old_string: "x", new_string: "y" }, dir).allowable).toBe(false);
    expect(claudeCeiling("medium", "NotebookEdit", { new_source: "x" }, dir).allowable).toBe(false);
  });

  test("an argument outside the tool's schema denies at every judgeable level", () => {
    const dir = tempDir();
    const input = { file_path: join(dir, "a.ts"), old_string: "x", new_string: "y", extra: true };
    // read-only already denies with its own reason; the schema rule is
    // what gates the levels that could otherwise allow.
    expect(claudeCeiling("read-only", "Edit", input, dir).allowable).toBe(false);
    for (const level of ["low", "medium", "high"] as const) {
      expect(claudeCeiling(level, "Edit", input, dir).reason).toContain("known schema");
    }
  });

  test("a symlink pointing outside the scope denies; one staying inside allows", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "real"));
    const outsideTarget = tempDir();
    writeFileSync(join(dir, "real", "stay.ts"), "x");
    writeFileSync(join(outsideTarget, "flee.ts"), "x");
    symlinkSync(join(dir, "real"), join(dir, "stay-link"));
    symlinkSync(outsideTarget, join(dir, "flee-link"));
    expect(
      claudeCeiling("medium", "Edit", { file_path: join(dir, "stay-link", "stay.ts"), old_string: "x", new_string: "y" }, dir).allowable
    ).toBe(true);
    expect(
      claudeCeiling("medium", "Edit", { file_path: join(dir, "flee-link", "flee.ts"), old_string: "x", new_string: "y" }, dir).allowable
    ).toBe(false);
  });

  test("a dangling symlink denies, even though its name sits inside the scope", () => {
    // Review live3, security 1: `repo/notes -> <outside>/not-there-yet`
    // made realpathSync throw ENOENT, and the resolver used to glue the
    // link's name back onto the resolved parent — an in-scope verdict for
    // a Write that follows the link and creates the target OUTSIDE the
    // launch directory. A link whose destination cannot be resolved is
    // unjudgeable: deny (the codex fileChange ceiling shares
    // pathInsideScope, so the same verdict covers patch approvals).
    const dir = tempDir();
    const outsideTarget = tempDir();
    symlinkSync(
      join(outsideTarget, "not-there-yet"),
      join(dir, "notes")
    );
    const verdict = claudeCeiling("medium", "Write", { file_path: join(dir, "notes"), content: "x" }, dir);
    expect(verdict.allowable).toBe(false);
    expect(verdict.reason).toContain("cannot resolve target path");
    expect(pathInsideScope(join(dir, "notes"), dir).allowable).toBe(false);
    // The control: an ordinary missing file inside the scope still
    // allows — a Write creating a new file is the normal case.
    expect(
      claudeCeiling("medium", "Write", { file_path: join(dir, "brand-new.ts"), content: "x" }, dir).allowable
    ).toBe(true);
  });

  test("a launch directory whose grammar cannot carry a grant denies instead of throwing", () => {
    const hostile = mkdtempSync(join(tmpdir(), "cmx-star-*-"));
    const verdict = claudeCeiling(
      "medium",
      "Edit",
      { file_path: join(hostile, "a.ts"), old_string: "x", new_string: "y" },
      hostile
    );
    expect(verdict.allowable).toBe(false);
    expect(verdict.reason).toContain("safe grant");
  });
});

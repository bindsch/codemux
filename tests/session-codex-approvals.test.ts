/**
 * Unit tests for the codex app-server approval ceiling and the decision
 * picker. Split from the former tests/session-codex.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { codexApprovalCeiling, pickApprovalDecision } from "../src/session/codex-session.js";
import { CWD } from "./helpers/session-codex.js";

describe("codex session - approval ceiling", () => {
  const commandInput = { command: "rm -rf /", cwd: CWD };

  test("read-only denies everything", () => {
    expect(codexApprovalCeiling("read-only", "commandExecution", commandInput, CWD).allowable).toBe(false);
    expect(
      codexApprovalCeiling("read-only", "fileChange", { changes: [{ path: join(CWD, "f") }] }, CWD).allowable
    ).toBe(false);
    expect(codexApprovalCeiling("read-only", "permissions", { permissions: {} }, CWD).allowable).toBe(false);
  });

  test("low allows every kind: the caller is the approval", () => {
    expect(codexApprovalCeiling("low", "commandExecution", commandInput, CWD).allowable).toBe(true);
    expect(
      codexApprovalCeiling("low", "fileChange", { changes: [{ path: "/etc/passwd" }] }, CWD).allowable
    ).toBe(true);
    expect(codexApprovalCeiling("low", "permissions", { permissions: { network: true } }, CWD).allowable).toBe(true);
  });

  test("medium denies commands and turn-scoped permissions, allows in-scope patches only", () => {
    expect(codexApprovalCeiling("medium", "commandExecution", commandInput, CWD).allowable).toBe(false);
    expect(
      codexApprovalCeiling("medium", "permissions", { permissions: { network: true } }, CWD).allowable
    ).toBe(false);
    expect(
      codexApprovalCeiling("medium", "fileChange", { changes: [{ path: join(CWD, "f.txt") }] }, CWD).allowable
    ).toBe(true);
    expect(
      codexApprovalCeiling("medium", "fileChange", { changes: [{ path: "/etc/passwd" }] }, CWD).allowable
    ).toBe(false);
  });

  test("high's mapping is full access for commands and patches, still no turn-scoped permissions", () => {
    expect(codexApprovalCeiling("high", "commandExecution", commandInput, CWD).allowable).toBe(true);
    expect(
      codexApprovalCeiling("high", "fileChange", { changes: [{ path: "/etc/passwd" }] }, CWD).allowable
    ).toBe(true);
    expect(
      codexApprovalCeiling("high", "permissions", { permissions: { network: true } }, CWD).allowable
    ).toBe(false);
  });

  test("a patch with no parsable paths denies fail-closed", () => {
    expect(codexApprovalCeiling("medium", "fileChange", {}, CWD).allowable).toBe(false);
    expect(
      codexApprovalCeiling("medium", "fileChange", { changes: "nope" }, CWD).allowable
    ).toBe(false);
    expect(
      codexApprovalCeiling("medium", "fileChange", { changes: [{ diff: "x" }] }, CWD).allowable
    ).toBe(false);
  });

  test("an update's move destination is judged with its source", () => {
    // Review live3, security 3: an update entry that moves a file names
    // its destination in kind.move_path (openclaw's PatchChangeKind) —
    // a move from inside the workspace to outside it is not an in-scope
    // patch, so the destination goes through pathInsideScope too.
    const moveInside = {
      changes: [
        {
          diff: "*** x",
          kind: { type: "update", move_path: join(CWD, "moved", "f.txt") },
          path: join(CWD, "f.txt"),
        },
      ],
    };
    expect(codexApprovalCeiling("medium", "fileChange", moveInside, CWD).allowable).toBe(true);
    const moveOutside = {
      changes: [
        {
          diff: "*** x",
          kind: { type: "update", move_path: "/etc/codemux-outside.txt" },
          path: join(CWD, "f.txt"),
        },
      ],
    };
    const verdict = codexApprovalCeiling("medium", "fileChange", moveOutside, CWD);
    expect(verdict.allowable).toBe(false);
    expect(verdict.reason).toContain("resolves outside the launch directory");
    // null means no move (the ordinary update); a non-string destination
    // is an opaque action — unparsable denies.
    const noMove = { changes: [{ diff: "*** x", kind: { type: "update", move_path: null }, path: join(CWD, "f.txt") }] };
    expect(codexApprovalCeiling("medium", "fileChange", noMove, CWD).allowable).toBe(true);
    const badMove = { changes: [{ diff: "*** x", kind: { type: "update", move_path: 7 }, path: join(CWD, "f.txt") }] };
    expect(codexApprovalCeiling("medium", "fileChange", badMove, CWD).allowable).toBe(false);
  });

  test("the verdict carries a reason every time", () => {
    for (const level of ["read-only", "low", "medium", "high"] as const) {
      for (const kind of ["commandExecution", "fileChange", "permissions"] as const) {
        const verdict = codexApprovalCeiling(level, kind, commandInput, CWD);
        expect(verdict.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("codex session - decision picking", () => {
  test("an absent availableDecisions list means everything is allowed", () => {
    expect(pickApprovalDecision(undefined, "accept")).toBe("accept");
    expect(pickApprovalDecision("not-a-list", "decline")).toBe("decline");
  });

  test("the preferred decision wins when available", () => {
    expect(pickApprovalDecision(["accept", "decline"], "accept")).toBe("accept");
    expect(pickApprovalDecision(["decline", "cancel"], "decline")).toBe("decline");
  });

  test("an unavailable preference falls to the other refusal, never acceptForSession", () => {
    expect(pickApprovalDecision(["decline", "cancel"], "accept")).toBe("decline");
    expect(pickApprovalDecision(["cancel"], "decline")).toBe("cancel");
    expect(pickApprovalDecision(["acceptForSession"], "accept")).toBe("decline");
  });
});

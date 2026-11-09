// Unit coverage for the session command's two non-session exits
// (src/session/cli-exit.ts). The subprocess-level tests exercise these
// paths end to end; these run them in-process so every branch — the
// --final note, the fresh-directory removal, and a cleanup that itself
// throws — is on the coverage floor.
import { expect, spyOn, test } from "bun:test";
import { exitPrintedSandbox, handleSessionAbort } from "../src/session/cli-exit.js";
import type { ProjectSettingsSessionDir } from "../src/claude-project-config.js";
import type { CodexSessionProviderHome } from "../src/codex-provider.js";
import type { SessionDriver } from "../src/session/stdin-frame.js";

const errors: string[] = [];
const realError = console.error;

test("exitPrintedSandbox removes only a fresh directory and never stamps final", () => {
  const note = spyOn(console, "error").mockImplementation(((message?: unknown) => {
    errors.push(String(message));
  }) as typeof console.error);
  const removed: string[] = [];
  // The release closure takes no final argument at all (review round 16,
  // edges 1): a print-only exit cannot stamp final, and the stub records
  // the one value the new contract allows.
  const releases: boolean[] = [];
  const abandon: string[] = [];
  const sessionDir = (fresh: boolean): ProjectSettingsSessionDir => ({
    dir: fresh ? "/fresh/session-dir" : "/resumed/session-dir",
    blockedPaths: [],
    remove: (): boolean => {
      removed.push(fresh ? "fresh" : "resumed");
      return true;
    },
  });
  const home = (calls: string[]): CodexSessionProviderHome =>
    ({ abandon: () => calls.push("abandon") }) as unknown as CodexSessionProviderHome;
  try {
    // --final with a resumed directory: the note prints, the directory
    // survives, and the claim is released WITHOUT the final stamp.
    exitPrintedSandbox({
      codexSessionHome: home(abandon),
      finalFlag: true,
      sessionProjectDir: sessionDir(false),
      sessionProjectDirResumed: true,
      releaseOwnedRecord: () => releases.push(false),
    });
    expect(errors.join("\n")).toContain("codemux: --final ignored: nothing ran");
    expect(removed).toEqual([]);
    expect(releases).toEqual([false]);
    expect(process.exitCode).toBe(0);
    // A fresh directory with no --final: removed, no note, no stamp.
    errors.length = 0;
    exitPrintedSandbox({
      codexSessionHome: null,
      finalFlag: false,
      sessionProjectDir: sessionDir(true),
      sessionProjectDirResumed: false,
      releaseOwnedRecord: () => releases.push(false),
    });
    expect(errors.join("\n")).not.toContain("--final ignored");
    expect(removed).toEqual(["fresh"]);
    expect(releases).toEqual([false, false]);
    expect(abandon).toEqual(["abandon"]);
  } finally {
    note.mockRestore();
    process.exitCode = 0;
  }
});

test("handleSessionAbort abandons the un-spawned state and still reports the error", () => {
  const exit = spyOn(process, "exit").mockImplementation((() => undefined) as never) as ReturnType<typeof spyOn>;
  const note = spyOn(console, "error").mockImplementation(((message?: unknown) => {
    errors.push(String(message));
  }) as typeof console.error);
  const disposed: string[] = [];
  const driver = { dispose: () => disposed.push("dispose") } as unknown as SessionDriver;
  try {
    let abandoned = 0;
    handleSessionAbort(new Error("launch died"), {
      spawnBegan: false,
      codexSessionHome: null,
      abandonSessionProjectDir: () => { abandoned++; },
      releaseOwnedRecord: () => disposed.push("release"),
      builtDriver: driver,
    });
    expect(abandoned).toBe(1);
    expect(disposed).toEqual(["release", "dispose"]);
    expect(errors.join("\n")).toContain("launch died");
    // Once the spawn began, the abort path owns neither the home nor the
    // directory: only the driver disposal and the error report run.
    errors.length = 0;
    handleSessionAbort(new Error("later failure"), {
      spawnBegan: true,
      codexSessionHome: null,
      abandonSessionProjectDir: () => { throw new Error("must not run"); },
      releaseOwnedRecord: () => { throw new Error("must not run"); },
      builtDriver: null,
    });
    expect(errors.join("\n")).toContain("later failure");
    expect(exit).toHaveBeenCalled();
  } finally {
    note.mockRestore();
    exit.mockRestore();
    process.exitCode = 0;
  }
});

test("handleSessionAbort reports a cleanup failure without masking the original error", () => {
  // Review round 14, edges 6: a directory cleanup that itself threw must
  // not replace the error the catch holds; the release still runs first.
  const exit = spyOn(process, "exit").mockImplementation((() => undefined) as never) as ReturnType<typeof spyOn>;
  const note = spyOn(console, "error").mockImplementation(((message?: unknown) => {
    errors.push(String(message));
  }) as typeof console.error);
  const order: string[] = [];
  try {
    handleSessionAbort(new Error("original failure"), {
      spawnBegan: false,
      codexSessionHome: null,
      abandonSessionProjectDir: () => { order.push("abandon"); throw new Error("rm: busy"); },
      releaseOwnedRecord: () => order.push("release"),
      builtDriver: null,
    });
    expect(order).toEqual(["abandon", "release"]);
    const text = errors.join("\n");
    expect(text).toContain("codemux: could not clean up the session's private directory: rm: busy");
    expect(text).toContain("original failure");
    expect(exit).toHaveBeenCalled();
  } finally {
    note.mockRestore();
    exit.mockRestore();
    process.exitCode = 0;
    void realError;
  }
});

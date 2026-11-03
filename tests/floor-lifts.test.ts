import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rememberDescendants,
  signalDescendant,
  signalDescendants,
  type TerminationTarget,
} from "../src/process-tree.js";
import type { ProcessEntry, ProcessTable } from "../src/process-table.js";
import * as processTable from "../src/process-table.js";
import { OutputLimitError, MAX_CAPTURE_BYTES, readBounded } from "../src/process-capture.js";
import { writePiProviderAgentDir } from "../src/pi-provider.js";
import { writeDroidProviderSettings } from "../src/droid-provider.js";
import { matchesCodexResourceResult } from "../src/experiment-codex-resource.js";
import type { CodexNativeCall } from "../src/experiment-codex-parser.js";

/**
 * Unit lifts for modules the suite exercises only through spawned children
 * or never with data: the process-tree walks over a synthetic table, the
 * capture bound against fake sinks, the provider-directory sweeps over
 * crafted stale entries, and resource-result matching by direct call. The
 * behaviors are the real contracts; only the process table is synthetic,
 * because the test sandbox denies the ps read the walk otherwise needs.
 */

function entry(ppid: number, pgid: number, start = "s0"): ProcessEntry {
  return { ppid, pgid, start };
}

function target(pid: number, descendants: Map<number, ProcessEntry>): TerminationTarget {
  return {
    proc: { pid } as TerminationTarget["proc"],
    processGroup: true,
    descendants,
    childExited: false,
  };
}

describe("the process-tree walk over a synthetic table", () => {
  test("rememberDescendants records the tree under a live child and on reuse", () => {
    const table: ProcessTable = new Map([
      [100, entry(1, 100)],
      [101, entry(100, 100)],
      [102, entry(101, 200)],
    ]);
    const live = target(100, new Map());
    rememberDescendants(live, table);
    expect([...live.descendants.keys()].sort((a, b) => a - b)).toEqual([101, 102]);

    // A remembered pid reused by a new descendant (different start token)
    // is re-recorded with the process that is there now.
    const reused = new Map([[101, entry(100, 100, "old")]]);
    rememberDescendants(target(100, reused), table);
    expect(reused.get(101)!.start).toBe("s0");

    // An exited child is never a root: its pid may already be reaped.
    const exited = target(100, new Map());
    exited.childExited = true;
    rememberDescendants(exited, table);
    expect(exited.descendants.size).toBe(0);
  });

  test("signalDescendant bounds the blast radius and reports real failures", () => {
    const kill = spyOn(process, "kill").mockImplementation(() => true);
    const errors: string[] = [];
    const error = spyOn(console, "error").mockImplementation((...values: unknown[]) => {
      errors.push(values.map(String).join(" "));
    });
    try {
      // pid 0 would signal codemux's own group: never sent.
      signalDescendant(0, "SIGTERM");
      expect(kill).not.toHaveBeenCalled();

      signalDescendant(4321, "SIGTERM");
      expect(kill).toHaveBeenCalledWith(4321, "SIGTERM");

      // ESRCH is a silent exit; anything else is reported.
      kill.mockImplementation((() => {
        const e = new Error("no such process") as NodeJS.ErrnoException;
        e.code = "ESRCH";
        throw e;
      }) as typeof process.kill);
      signalDescendant(4321, "SIGTERM");
      expect(errors).toHaveLength(0);

      kill.mockImplementation((() => {
        const e = new Error("not permitted") as NodeJS.ErrnoException;
        e.code = "EPERM";
        throw e;
      }) as typeof process.kill);
      signalDescendant(4321, "SIGTERM");
      expect(errors.join("\n")).toContain("could not send SIGTERM to descendant 4321");
    } finally {
      kill.mockRestore();
      error.mockRestore();
    }
  });

  test("signalDescendants leaves group members to the group signal at SIGTERM", () => {
    const kill = spyOn(process, "kill").mockImplementation(() => true);
    // An unreadable table (the walk's unknown-table mode): remembered
    // descendants are signaled unverified. Stubbed, not observed, so the
    // test holds on a host where /bin/ps works as well as in a sandbox
    // where it does not.
    const table = spyOn(processTable, "readProcessTable").mockImplementation(() => new Map());
    try {
      const descendants = new Map<number, ProcessEntry>([
        [101, entry(100, 100)],
        [102, entry(100, 200)],
      ]);
      const left = signalDescendants(target(100, descendants), "SIGTERM", 100);
      expect(left).toEqual([101]); // still in the signaled group
      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith(102, "SIGTERM");

      // At SIGKILL every remembered descendant is signaled individually.
      kill.mockClear();
      const leftKill = signalDescendants(target(100, descendants), "SIGKILL", 100);
      expect(leftKill).toEqual([]);
      expect(kill).toHaveBeenCalledWith(101, "SIGKILL");
      expect(kill).toHaveBeenCalledWith(102, "SIGKILL");
    } finally {
      table.mockRestore();
      kill.mockRestore();
    }
  });
});

describe("the bounded stream capture", () => {
  function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
  }

  test("a rejected give-up promise cancels the read and returns what arrived", async () => {
    const neverEnds = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
      },
    });
    const captured = await readBounded(neverEnds, "stdout", Promise.reject(new Error("timed out")));
    expect(captured).toBe("partial");
  });

  test("a natural end past the kept bound fails the run at the limit", async () => {
    const sink = {
      push: () => {},
      finish: () => "folded",
      keptBytes: () => MAX_CAPTURE_BYTES + 1,
    };
    await expect(
      readBounded(streamOf(["x"]), "stdout", undefined, sink)
    ).rejects.toBeInstanceOf(OutputLimitError);
  });
});

describe("the provider directory sweeps", () => {
  const override = { baseUrl: "https://override.example/v1", apiKey: "lift-key" };

  function craftedParent(parent: string): void {
    mkdirSync(parent, { recursive: true });
    // A stale entry: a dead pid (past the pid space) with an old mtime.
    const stale = join(parent, "provider-999999-dead");
    mkdirSync(stale);
    utimesSync(stale, new Date(0), new Date(0));
    // Alive (this process), fresh (recent mtime), and not a sweep name.
    mkdirSync(join(parent, `provider-${process.pid}-alive`));
    const fresh = join(parent, "provider-999998-fresh");
    mkdirSync(fresh);
    mkdirSync(join(parent, "unrelated"));
  }

  test("pi's sweep removes only stale directories of dead processes", () => {
    const agent = mkdtempSync(join(tmpdir(), "codemux-pi-sweep-"));
    try {
      craftedParent(join(agent, ".codemux"));
      writePiProviderAgentDir(agent, override, "lift-model");
      const names = readdirSync(join(agent, ".codemux"));
      expect(names.some((name) => name === "provider-999999-dead")).toBe(false);
      expect(names.some((name) => name.startsWith(`provider-${process.pid}-`))).toBe(true);
      expect(names.some((name) => name === "provider-999998-fresh")).toBe(true);
      expect(names.some((name) => name === "unrelated")).toBe(true);
    } finally {
      rmSync(agent, { recursive: true, force: true });
    }
  });

  test("droid's sweep removes only stale directories of dead processes", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-droid-sweep-"));
    try {
      craftedParent(join(home, ".codemux"));
      writeDroidProviderSettings(home, override, "lift-model");
      const names = readdirSync(join(home, ".codemux"));
      expect(names.some((name) => name === "provider-999999-dead")).toBe(false);
      expect(names.some((name) => name === "provider-999998-fresh")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a parent that is not a directory owned by the user is refused", () => {
    const agent = mkdtempSync(join(tmpdir(), "codemux-pi-sweep-"));
    try {
      // mkdirSync would throw EEXIST on a plain file; a symlink to a
      // directory is what survives it and still fails the lstat check.
      const real = join(agent, "real");
      mkdirSync(real);
      symlinkSync(real, join(agent, ".codemux"));
      expect(() => writePiProviderAgentDir(agent, override, "lift-model")).toThrow(
        "must be a directory owned by the current user"
      );
    } finally {
      rmSync(agent, { recursive: true, force: true });
    }
  });
});

describe("codex resource-result matching", () => {
  const call = {
    name: "functions.bash",
    callId: "call-1",
    input: { command: "marker" },
    output: { value: "boom", item: { tool: "bash" } },
  } as unknown as CodexNativeCall;

  test("a failed completion matches its error text", () => {
    const item = { tool: "bash", server: "codex", arguments: { command: "marker" },
      status: "failed", result: null, error: "boom" };
    expect(matchesCodexResourceResult(call, item as never)).toBe(true);
    expect(
      matchesCodexResourceResult(call, { ...item, error: "other" } as never)
    ).toBe(false);
  });

  test("a segmented output value matches its joined text", () => {
    const segmented = {
      ...call,
      output: {
        value: [{ type: "input_text", text: "bo" }, { type: "input_text", text: "om" }],
        item: { tool: "bash" },
      },
    } as unknown as CodexNativeCall;
    const item = { tool: "bash", server: "codex", arguments: { command: "marker" },
      status: "completed", result: { content: [{ type: "text", text: "boom" }] } };
    expect(matchesCodexResourceResult(segmented, item as never)).toBe(true);
  });
});

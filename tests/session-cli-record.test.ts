/** Direct coverage for the pre-spawn registry record steps
 * (src/session/cli-record.ts): the writable-registry probe for the
 * first-turn-id agents (fresh only), the claude-family and aider
 * recordBeforeSpawn writes, their exit-1 failure arms through the
 * caller's release paths, and the fresh id each success hands back. */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSessionBeforeSpawn } from "../src/session/cli-record.js";

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

const exits: ReturnType<typeof spyOn>[] = [];
const errors: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of exits) spy.mockRestore();
  for (const spy of errors) spy.mockRestore();
  exits.length = 0;
  errors.length = 0;
});

/** exitWithCode logs then exits; both are stubbed so the failure arms
 * return to the test instead of ending the process. */
function stubExit(): (number | undefined)[] {
  const calls: (number | undefined)[] = [];
  exits.push(spyOn(process, "exit").mockImplementation(((code?: number) => {
    calls.push(code);
    throw new ExitError(code ?? 0);
  }) as never));
  errors.push(spyOn(console, "error").mockImplementation(() => {}));
  return calls;
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "cli-record-"));
}

/** A registry path whose parent directory is read-only, so every
 * registry write fails (the same failure shape the command tests use). */
function readOnlyRegistry(root: string): string {
  const dir = join(root, "ro");
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o500);
  return join(dir, "live-sessions.json");
}

describe("recordSessionBeforeSpawn - the first-turn-id probe", () => {
  test("a fresh agy/opencode/kimi session probes a writable registry and owns nothing", () => {
    const root = tempRoot();
    try {
      const exitCalls = stubExit();
      const released: string[] = [];
      for (const agentId of ["agy", "opencode", "kimi"] as const) {
        const { freshOwnedId } = recordSessionBeforeSpawn({
          registryPath: join(root, "registry.json"),
          agentId,
          resumeId: undefined,
          claudeDriver: null,
          claudeSessionId: null,
          aiderDriver: null,
          aiderSessionId: null,
          releaseOwnedRecord: () => released.push(agentId),
          abandonSessionProjectDir: () => {},
        });
        expect(freshOwnedId).toBeNull();
      }
      expect(exitCalls).toEqual([]);
      expect(released).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an unwritable registry releases the claim and exits 1", () => {
    const root = tempRoot();
    try {
      const exitCalls = stubExit();
      const released: number[] = [];
      expect(() =>
        recordSessionBeforeSpawn({
          registryPath: readOnlyRegistry(root),
          agentId: "agy",
          resumeId: undefined,
          claudeDriver: null,
          claudeSessionId: null,
          aiderDriver: null,
          aiderSessionId: null,
          releaseOwnedRecord: () => released.push(1),
          abandonSessionProjectDir: () => {},
        })
      ).toThrow(ExitError);
      expect(exitCalls).toEqual([1]);
      expect(released).toEqual([1]);
    } finally {
      chmodSync(join(root, "ro"), 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a resume skips the probe: its claim just wrote the registry", () => {
    const root = tempRoot();
    try {
      const exitCalls = stubExit();
      const { freshOwnedId } = recordSessionBeforeSpawn({
        registryPath: readOnlyRegistry(root),
        agentId: "opencode",
        resumeId: "sess-resumed",
        claudeDriver: null,
        claudeSessionId: null,
        aiderDriver: null,
        aiderSessionId: null,
        releaseOwnedRecord: () => {},
        abandonSessionProjectDir: () => {},
      });
      expect(freshOwnedId).toBeNull();
      expect(exitCalls).toEqual([]);
    } finally {
      chmodSync(join(root, "ro"), 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("recordSessionBeforeSpawn - the claude family record", () => {
  test("a successful record hands back the session id to own", () => {
    const root = tempRoot();
    try {
      stubExit();
      const { freshOwnedId } = recordSessionBeforeSpawn({
        registryPath: join(root, "registry.json"),
        agentId: "claude",
        resumeId: undefined,
        claudeDriver: { recordBeforeSpawn: () => null },
        claudeSessionId: "sess-claude-1",
        aiderDriver: null,
        aiderSessionId: null,
        releaseOwnedRecord: () => {},
        abandonSessionProjectDir: () => {},
      });
      expect(freshOwnedId).toBe("sess-claude-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a failed record abandons the fresh directory, releases, and exits 1", () => {
    const root = tempRoot();
    try {
      const exitCalls = stubExit();
      const calls: string[] = [];
      expect(() =>
        recordSessionBeforeSpawn({
          registryPath: join(root, "registry.json"),
          agentId: "zai",
          resumeId: undefined,
          claudeDriver: { recordBeforeSpawn: () => "lock busy" },
          claudeSessionId: "sess-zai-1",
          aiderDriver: null,
          aiderSessionId: null,
          releaseOwnedRecord: () => calls.push("release"),
          abandonSessionProjectDir: () => calls.push("abandon"),
        })
      ).toThrow(ExitError);
      expect(exitCalls).toEqual([1]);
      expect(calls).toEqual(["abandon", "release"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("recordSessionBeforeSpawn - the aider record", () => {
  test("a successful record hands back the aider id; a failure removes the fresh history first", () => {
    const root = tempRoot();
    try {
      stubExit();
      const ok = recordSessionBeforeSpawn({
        registryPath: join(root, "registry.json"),
        agentId: "aider",
        resumeId: undefined,
        claudeDriver: null,
        claudeSessionId: null,
        aiderDriver: { recordBeforeSpawn: () => null, removeFreshHistory: () => {} },
        aiderSessionId: "sess-aider-1",
        releaseOwnedRecord: () => {},
        abandonSessionProjectDir: () => {},
      });
      expect(ok.freshOwnedId).toBe("sess-aider-1");

      const exitCalls = stubExit();
      const calls: string[] = [];
      expect(() =>
        recordSessionBeforeSpawn({
          registryPath: join(root, "registry.json"),
          agentId: "aider",
          resumeId: undefined,
          claudeDriver: null,
          claudeSessionId: null,
          aiderDriver: {
            recordBeforeSpawn: () => "disk full",
            removeFreshHistory: () => calls.push("history"),
          },
          aiderSessionId: "sess-aider-2",
          releaseOwnedRecord: () => calls.push("release"),
          abandonSessionProjectDir: () => {},
        })
      ).toThrow(ExitError);
      expect(exitCalls).toEqual([1]);
      expect(calls).toEqual(["release", "history"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

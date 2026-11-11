import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiderAdapter } from "../src/adapters/aider.js";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import type { RunRequest } from "../src/types.js";

// Review round 153, finding 4: the shared argv rules key on the adapter's
// promptInArgv, not on `getStdinInput(request) === null`. Aider's stdin
// carries canned declines and its prompt rides --message-file, so aider
// reports false and is exempt from the NUL refusal and the argv byte bound,
// like an adapter whose prompt rides stdin.

describe("the argv prompt rules follow promptInArgv", () => {
  const scratch: string[] = [];
  afterEach(() => {
    while (scratch.length > 0) {
      const dir = scratch.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const cwdOf = (): string => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-prompt-argv-"));
    scratch.push(cwd);
    return cwd;
  };

  test("aider keeps its prompt in a private file while stdin carries the declines", () => {
    const aider = new AiderAdapter();
    const request = { agent: "aider", prompt: "p" } as RunRequest;
    expect(aider.getStdinInput(request)).not.toBeNull();
    expect(aider.promptInArgv(request)).toBe(false);
    // The private message file has the ordinary prompt bound, not argv limits.
    expect(() =>
      aider.validateRunRequest({
        agent: "aider",
        prompt: "x".repeat(40_000),
        cwd: cwdOf(),
      })
    ).not.toThrow();
  });

  test("a stdin-transport adapter accepts a NUL-free prompt past the argv bound", () => {
    const opencode = new OpencodeAdapter();
    const request = { agent: "opencode", prompt: "p" } as RunRequest;
    expect(opencode.getStdinInput(request)).not.toBeNull();
    expect(opencode.promptInArgv(request)).toBe(false);
    // 40_000 bytes is past the 32 KiB argv bound but under the universal
    // 16 MiB prompt bound: a prompt that rides stdin validates clean,
    // exactly as it did before the shared rule read promptInArgv.
    expect(() =>
      opencode.validateRunRequest({
        agent: "opencode",
        prompt: "x".repeat(40_000),
        cwd: cwdOf(),
      })
    ).not.toThrow();
  });
});

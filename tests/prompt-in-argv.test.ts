import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiderAdapter } from "../src/adapters/aider.js";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import type { RunRequest } from "../src/types.js";

// Review round 153, finding 4: the shared argv rules key on the adapter's
// promptInArgv, not on `getStdinInput(request) === null` — an adapter whose
// stdin carries something other than the prompt (aider's canned declines)
// still puts the prompt itself in argv, so the NUL refusal and the argv
// byte bound must apply there; an adapter whose prompt rides stdin is
// exempt from the argv bound exactly as before.

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

  test("aider reports its prompt in argv while stdin carries the declines", () => {
    const aider = new AiderAdapter();
    const request = { agent: "aider", prompt: "p" } as RunRequest;
    expect(aider.getStdinInput(request)).not.toBeNull();
    expect(aider.promptInArgv(request)).toBe(true);
    // The argv byte bound applies through the shared validator: the local
    // copy is gone and the shared wording refuses.
    expect(() =>
      aider.validateRunRequest({
        agent: "aider",
        prompt: "x".repeat(40_000),
        cwd: cwdOf(),
      })
    ).toThrow("passes prompts in argv");
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

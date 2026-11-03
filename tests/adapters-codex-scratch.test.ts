import { describe, test, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import type { RunContext } from "../src/adapters/base.js";
import type { RunRequest } from "../src/types.js";

describe("CodexAdapter", () => {
  test("a plan-only turn succeeds through the recorded final message", () => {
    // The finding's reproduction at the adapter seam: the stream carries a
    // complete turn with no agent_message (codex's mapper drops the Plan
    // item), and the file the launch told codex to write
    // (--output-last-message, in this run's own scratch directory under the
    // real CODEX_HOME) carries the message. Without it this valid completed
    // run exited 1.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    try {
      const codexHome = join(home, ".codex");
      mkdirSync(codexHome);
      const prepared = new CodexAdapter({}, home);
      const request: RunRequest = {
        agent: "codex",
        prompt: "t",
        resultJson: true,
      };
      const context = prepared.prepareRun(request);
      // The argv names this run's own file under the CODEX_HOME scratch
      // root -- never the unprepared placeholder -- and the directory is
      // unique to this run.
      const argv = prepared.buildRunCommand(request, context);
      const flag = argv.indexOf("--output-last-message");
      expect(flag).toBeGreaterThanOrEqual(0);
      const lastMessageFile = argv[flag + 1]!;
      expect(lastMessageFile.startsWith(join(codexHome, ".codemux-scratch"))).toBe(true);
      expect(lastMessageFile).not.toContain("unprepared");
      const other = new CodexAdapter({}, home);
      const otherContext = other.prepareRun(request);
      const otherArgv = other.buildRunCommand(request, otherContext);
      expect(
        otherArgv[otherArgv.indexOf("--output-last-message") + 1]
      ).not.toBe(lastMessageFile);
      // What codex would have written: the Plan it treats as the final
      // message even though the JSONL stream never carries it.
      writeFileSync(lastMessageFile, "1. Inspect the tree.\n2. Plan the change.");
      const stream = [
        { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
        { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
      ].map((line) => JSON.stringify(line)).join("\n") + "\n";
      const out = prepared.processRunResult(
        { stdout: stream, stderr: "", exitCode: 0, success: true },
        request,
        context
      );
      expect(out.success).toBe(true);
      expect(out.exitCode).toBe(0);
      expect(JSON.parse(out.stdout).result).toBe("1. Inspect the tree.\n2. Plan the change.");
      expect(out.stderr).toContain("final message codex recorded itself");
      // The file is consumed, not left behind.
      expect(existsSync(lastMessageFile)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a plain run's fallback file lives in a per-run scratch directory under the real CODEX_HOME", () => {
    // The round27 major: with the file under the OS temp root, scode's
    // Linux sandbox mounted a fresh /tmp over the parent's, so a sandboxed
    // run's fallback never surfaced and a successful Plan-only
    // --result-json run exited 1 with a null result. The file now lives
    // under the real CODEX_HOME (.codemux-scratch/), harness state scode
    // keeps writable on every platform and never shadows.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    const scratchDirs: string[] = [];
    try {
      mkdirSync(join(home, ".codex"));
      const adapter = new CodexAdapter({ CODEX_API_KEY: "sk-test" }, home);
      const request: RunRequest = { agent: "codex", prompt: "t", resultJson: true };
      // A direct launch passes no trust and a standard-trust sandboxed one
      // resolves "standard": both are the plain branch and both land in the
      // scratch root, each in its own per-run directory.
      const direct = adapter.prepareRun(request);
      scratchDirs.push(direct.lastMessageDir!);
      const directArgv = adapter.buildRunCommand(request, direct);
      const directFile = directArgv[directArgv.indexOf("--output-last-message") + 1]!;
      expect(directFile.startsWith(join(home, ".codex", ".codemux-scratch", "run-"))).toBe(true);
      expect(directFile).not.toContain("unprepared");
      expect(dirname(directFile)).toBe(direct.lastMessageDir!);
      const sandboxed = adapter.prepareRun(request, "standard");
      scratchDirs.push(sandboxed.lastMessageDir!);
      const sandboxedArgv = adapter.buildRunCommand(request, sandboxed);
      expect(
        sandboxedArgv[sandboxedArgv.indexOf("--output-last-message") + 1]
      ).not.toBe(directFile);
      // The parent reads the file back at the same path the child wrote --
      // the property the temp-root placement lost under scode's Linux /tmp.
      writeFileSync(directFile, "the plan");
      expect(existsSync(directFile)).toBe(true);
      adapter.cleanupRun(direct);
      adapter.cleanupRun(sandboxed);
      expect(existsSync(direct.lastMessageDir!)).toBe(false);
      // The scratch root itself stays for the next run; only per-run
      // directories go.
      expect(readdirSync(join(home, ".codex", ".codemux-scratch"))).toEqual([]);
    } finally {
      for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a scratch step that throws after the provider home was created cleans the home (al24)", () => {
    // The edges minor: the override home was created first and the caller
    // never received the context when the scratch step threw, so cleanupRun
    // could not finalize it — the home and its process-exit listener sat
    // until termination, one per failed launch. The failing scratch step
    // here is a file standing at the `.codemux-scratch` parent's name, so
    // prepareRunDirParent refuses while `.codemux-provider` (made earlier
    // in the same prepareRun) already holds the run's home. Round al29
    // restored the scratch step to every launch that can name a fallback
    // file (all of them but an untrusted sandbox's), so a plain run hits
    // the same throw; this launch is a --result-json one.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    try {
      const codexHome = join(home, ".codex");
      mkdirSync(codexHome);
      writeFileSync(join(codexHome, ".codemux-scratch"), "not a directory");
      const adapter = new CodexAdapter(
        {
          CODEMUX_CODEX_PROVIDER_BASE_URL: "https://override.example/v1",
          CODEMUX_CODEX_PROVIDER_API_KEY: "sk-override-test-key",
          CODEMUX_CODEX_PROVIDER_MODEL: "gpt-test",
        },
        home
      );
      expect(() =>
        adapter.prepareRun({ agent: "codex", prompt: "t", resultJson: true })
      ).toThrow();
      // The provider home is gone: the throw cleaned up what the context
      // held, instead of leaving a run directory under `.codemux-provider`.
      const providerParent = join(codexHome, ".codemux-provider");
      expect(readdirSync(providerParent)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a hermetic run's fallback file lives inside the private home", () => {
    // The hermetic branch of the placement rule: the private home is itself
    // under the real CODEX_HOME, so it follows the same harness-state
    // writability, and finalize removes the file with the home.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    try {
      mkdirSync(join(home, ".codex"));
      const adapter = new CodexAdapter({ CODEX_API_KEY: "sk-test" }, home);
      const request: RunRequest = {
        agent: "codex",
        prompt: "t",
        resultJson: true,
        hermetic: true,
      };
      const hermetic = adapter.prepareRun(request);
      const hermeticArgv = adapter.buildRunCommand(request, hermetic);
      const hermeticFile = hermeticArgv[hermeticArgv.indexOf("--output-last-message") + 1]!;
      expect(hermeticFile.startsWith(join(home, ".codex", ".codemux-hermetic"))).toBe(true);
      writeFileSync(hermeticFile, "the plan");
      adapter.cleanupRun(hermetic);
      expect(existsSync(hermeticFile)).toBe(false);
      expect(readdirSync(join(home, ".codex", ".codemux-hermetic"))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an untrusted sandbox run passes no fallback file: the stream is the only source", () => {
    // The untrusted branch: that preset denies harness state (and scode's
    // Linux sandbox shadows the temp root), so no location is both writable
    // by the child and readable by the parent. The launch names no
    // --output-last-message file at all, and a Plan-only turn -- the one
    // case the file existed for -- reports a null result, the documented
    // cost (README), instead of silently losing a fallback.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    try {
      mkdirSync(join(home, ".codex"));
      const adapter = new CodexAdapter({ CODEX_API_KEY: "sk-test" }, home);
      const request: RunRequest = { agent: "codex", prompt: "t", resultJson: true };
      const context = adapter.prepareRun(request, "untrusted");
      expect(context.lastMessagePath).toBeUndefined();
      expect(context.lastMessageDir).toBeUndefined();
      const argv = adapter.buildRunCommand(request, context);
      expect(argv).toContain("--json");
      expect(argv).not.toContain("--output-last-message");
      // Nothing was created on disk: an untrusted run touches no scratch.
      expect(readdirSync(join(home, ".codex"))).toEqual([]);
      // The Plan-only turn without a fallback: a complete stream whose turn
      // ended messageless fails with no result, not a silent success.
      const stream = [
        { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
        { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
      ].map((line) => JSON.stringify(line)).join("\n") + "\n";
      const out = adapter.processRunResult(
        { stdout: stream, stderr: "", exitCode: 0, success: true },
        request,
        context
      );
      expect(out.success).toBe(false);
      expect(out.exitCode).toBe(1);
      expect(JSON.parse(out.stdout).result).toBeNull();
      expect(out.stderr).toContain("ended without a final assistant message");
      // Cleanup of a context with no scratch is a no-op, not an error.
      adapter.cleanupRun(context);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("two concurrent runs keep their own --output-last-message fallback", () => {
    // The round6 finding: the fallback path was a shared adapter field, so
    // run B's prepareRun overwrote run A's; A's completion read and removed
    // B's file (returning B's message) and left B without its fallback, to
    // fail a successful Plan-only turn. The path is this run's own context
    // now, carried by the caller from prepareRun to processRunResult.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    const scratchDirs: string[] = [];
    try {
      mkdirSync(join(home, ".codex"));
      const adapter = new CodexAdapter({}, home);
      const planOnlyStream = (threadId: string): string =>
        [
          { type: "thread.started", thread_id: threadId },
          { type: "turn.started" },
          { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
          { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
        ].map((line) => JSON.stringify(line)).join("\n") + "\n";
      const runOutcome = (
        result: { stdout: string; stderr: string; exitCode: number; success: boolean },
        request: RunRequest,
        context: RunContext
      ) => adapter.processRunResult(result, request, context);

      const requestA: RunRequest = {
        agent: "codex",
        prompt: "a",
        resultJson: true,
      };
      const contextA = adapter.prepareRun(requestA);
      scratchDirs.push(contextA.lastMessageDir!);
      const argvA = adapter.buildRunCommand(requestA, contextA);
      const fileA = argvA[argvA.indexOf("--output-last-message") + 1]!;
      writeFileSync(fileA, "A's plan");

      const requestB: RunRequest = {
        agent: "codex",
        prompt: "b",
        resultJson: true,
      };
      const contextB = adapter.prepareRun(requestB);
      scratchDirs.push(contextB.lastMessageDir!);
      const argvB = adapter.buildRunCommand(requestB, contextB);
      const fileB = argvB[argvB.indexOf("--output-last-message") + 1]!;
      expect(fileB).not.toBe(fileA);
      writeFileSync(fileB, "B's plan");

      // A finishes first: it must read its own file, and B's must still be
      // standing for B's own completion -- A's completion must not consume
      // it the way the shared pointer let it.
      const outA = runOutcome(
        { stdout: planOnlyStream("0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e"), stderr: "", exitCode: 0, success: true },
        requestA,
        contextA
      );
      expect(outA.success).toBe(true);
      expect(JSON.parse(outA.stdout).result).toBe("A's plan");
      expect(existsSync(fileA)).toBe(false);
      expect(existsSync(fileB)).toBe(true);

      const outB = runOutcome(
        { stdout: planOnlyStream("6f9619ff-8ba7-4c95-9d9b-ac905e48cfd7"), stderr: "", exitCode: 0, success: true },
        requestB,
        contextB
      );
      expect(outB.success).toBe(true);
      expect(JSON.parse(outB.stdout).result).toBe("B's plan");
      expect(existsSync(fileB)).toBe(false);
    } finally {
      for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("two overlapping launches through one request object each carry their own context", () => {
    // Round13 refused the second launch because per-run state was keyed by
    // the request object; the round15 restructure made the context a value
    // the launcher owns, so the SAME request object may launch twice
    // concurrently and each launch reads and removes only its own file.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    const scratchDirs: string[] = [];
    try {
      mkdirSync(join(home, ".codex"));
      const adapter = new CodexAdapter({}, home);
      const request: RunRequest = {
        agent: "codex",
        prompt: "t",
        resultJson: true,
      };
      const planOnlyStream = (threadId: string): string =>
        [
          { type: "thread.started", thread_id: threadId },
          { type: "turn.started" },
          { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
          { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
        ].map((line) => JSON.stringify(line)).join("\n") + "\n";

      // Two overlapping launches of the SAME object: two contexts, two files.
      const contextA = adapter.prepareRun(request);
      scratchDirs.push(contextA.lastMessageDir!);
      const argvA = adapter.buildRunCommand(request, contextA);
      const fileA = argvA[argvA.indexOf("--output-last-message") + 1]!;
      writeFileSync(fileA, "A's plan");
      const contextB = adapter.prepareRun(request);
      scratchDirs.push(contextB.lastMessageDir!);
      const argvB = adapter.buildRunCommand(request, contextB);
      const fileB = argvB[argvB.indexOf("--output-last-message") + 1]!;
      expect(fileB).not.toBe(fileA);
      writeFileSync(fileB, "B's plan");

      // B completes first and consumes only its own file; A's still stands.
      const outB = adapter.processRunResult(
        { stdout: planOnlyStream("6f9619ff-8ba7-4c95-9d9b-ac905e48cfd7"), stderr: "", exitCode: 0, success: true },
        request,
        contextB
      );
      expect(outB.success).toBe(true);
      expect(JSON.parse(outB.stdout).result).toBe("B's plan");
      expect(existsSync(fileB)).toBe(false);
      expect(existsSync(fileA)).toBe(true);

      // A completes on its own context, whole.
      const outA = adapter.processRunResult(
        { stdout: planOnlyStream("0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e"), stderr: "", exitCode: 0, success: true },
        request,
        contextA
      );
      expect(outA.success).toBe(true);
      expect(JSON.parse(outA.stdout).result).toBe("A's plan");
      expect(existsSync(fileA)).toBe(false);
    } finally {
      for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

});

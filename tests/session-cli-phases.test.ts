/**
 * The session command's pure phase functions, tested directly where no
 * child is needed: the harness-home resolvers, the SESSION_AGENTS
 * table, and the caller-stdin framer on a swapped stream. The command
 * level (refusals, guards, drives) lives in
 * tests/session-cli-command.test.ts and its -drives peer.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import * as cliHomes from "../src/session/cli-homes.js";
import { SESSION_AGENTS } from "../src/session/cli-agents.js";
import { frameCallerStdin } from "../src/session/stdin-frame.js";
import { MAX_INPUT_LINE_BYTES } from "../src/session/process.js";
import { prepareSessionChild } from "../src/session/cli-spawn-prep.js";
import { createFakeBinaryEnv } from "./helpers/cli.js";

describe("the harness-home resolvers", () => {
  test("every agent home resolver names its documented default", () => {
    expect(cliHomes.agyHarnessHome()).toBe(join(homedir(), ".gemini", "antigravity-cli"));
    expect(cliHomes.aiderHarnessHome()).toBe(join(homedir(), ".aider"));
    expect(cliHomes.opencodeHarnessHome()).toBe(join(homedir(), ".local", "share", "opencode"));
  });

  test("kimiHarnessHome honors a passed-through absolute redirect only", () => {
    expect(cliHomes.kimiHarnessHome(["OTHER"])).toBe(join(homedir(), ".kimi-code"));
    expect(cliHomes.kimiHarnessHome(["KIMI_CODE_HOME"])).toBe(join(homedir(), ".kimi-code"));
  });

  test("codexHarnessHome refuses an empty passed-through CODEX_HOME like the adapter (round 381)", () => {
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "";
    try {
      const empty = refusingCall(() => cliHomes.codexHarnessHome(["CODEX_HOME"]));
      expect(empty.code).toBe(64);
      expect(empty.message).toContain("CODEX_HOME must not be empty when passed through");
      // Not passed through, the empty value is the operator's own shell state: the default home.
      expect(cliHomes.codexHarnessHome(["OTHER"])).toBe(join(homedir(), ".codex"));
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
    }
  });

  test("codexHarnessHome returns the default without a passthrough", () => {
    expect(cliHomes.codexHarnessHome(["OTHER"])).toBe(join(homedir(), ".codex"));
  });

  // The redirect arms need KIMI_CODE_HOME/CODEX_HOME set in the
  // process env (the resolvers read them at call time), so each case
  // sets and restores its variable. The refusal arm prints and calls
  // process.exit(64) (usageError), so the direct call runs under the
  // same exit-and-stderr spies the command-level harness uses.
  const refusingCall = (call: () => string): { code: number; message: string } => {
    const errors: string[] = [];
    const error = spyOn(console, "error").mockImplementation((...values: unknown[]) => {
      errors.push(values.map(String).join(" "));
    });
    let code: number | null = null;
    const exit = spyOn(process, "exit").mockImplementation(((value?: string | number | null) => {
      code = typeof value === "number" ? value : 0;
      throw new Error(`process.exit(${value})`);
    }) as typeof process.exit);
    try {
      call();
      throw new Error("the resolver returned instead of refusing");
    } catch (thrown) {
      if (code === null) throw thrown;
      return { code, message: errors.join("\n") };
    } finally {
      error.mockRestore();
      exit.mockRestore();
    }
  };

  test("kimiHarnessHome refuses an empty or relative redirect", () => {
    const previous = process.env.KIMI_CODE_HOME;
    try {
      process.env.KIMI_CODE_HOME = "";
      const empty = refusingCall(() => cliHomes.kimiHarnessHome(["KIMI_CODE_HOME"]));
      expect(empty.code).toBe(64);
      expect(empty.message).toContain("KIMI_CODE_HOME must not be empty");
      process.env.KIMI_CODE_HOME = "relative/path";
      const relative = refusingCall(() => cliHomes.kimiHarnessHome(["KIMI_CODE_HOME"]));
      expect(relative.code).toBe(64);
      expect(relative.message).toContain("KIMI_CODE_HOME must be an absolute path");
      process.env.KIMI_CODE_HOME = "/tmp/kimi-home";
      expect(cliHomes.kimiHarnessHome(["KIMI_CODE_HOME"])).toBe("/tmp/kimi-home");
    } finally {
      if (previous === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = previous;
    }
  });

  test("codexHarnessHome refuses padded or relative redirects, keeps the absolute one", () => {
    const previous = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = "/tmp/codex-home";
      expect(cliHomes.codexHarnessHome(["CODEX_HOME"])).toBe("/tmp/codex-home");
      process.env.CODEX_HOME = "relative/path";
      const relative = refusingCall(() => cliHomes.codexHarnessHome(["CODEX_HOME"]));
      expect(relative.code).toBe(64);
      expect(relative.message).toContain("CODEX_HOME must be an absolute path");
      process.env.CODEX_HOME = "/tmp/codex-home ";
      const padded = refusingCall(() => cliHomes.codexHarnessHome(["CODEX_HOME"]));
      expect(padded.code).toBe(64);
      expect(padded.message).toContain("CODEX_HOME must not be whitespace-padded");
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });

  test("the session agent table's id shapes reject a foreign id", () => {
    const claude = SESSION_AGENTS.claude;
    const codex = SESSION_AGENTS.codex;
    expect(claude && claude.resumePattern.test(randomUUID())).toBe(true);
    expect(claude && claude.resumePattern.test("0123456789abcdef")).toBe(false);
    expect(codex && codex.resumePattern.test("0123456789abcdef")).toBe(true);
    expect(Object.keys(SESSION_AGENTS).sort()).toEqual(
      ["agy", "aider", "claude", "cline", "codex", "copilot", "cursor", "droid", "gemini",
        "goose", "kimi", "opencode", "openhands", "pi", "qwen", "zai"]
    );
  });
});

describe("the caller-stdin framer in process", () => {
  class FakeInput extends EventEmitter {
    feed(chunk: Uint8Array | string): void {
      this.emit("data", typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    }
    end(): void {
      this.emit("end");
    }
    fail(error: unknown): void {
      this.emit("error", error);
    }
  }

  test("delivers whole and split frames and drops blank lines", () => {
    const lines: string[] = [];
    const ends: unknown[] = [];
    const input = new FakeInput();
    frameCallerStdin(
      { handleCallerLine: (line) => lines.push(line), handleCallerEnd: (error) => ends.push(error) },
      input
    );
    input.feed('{"type":"user"}\n\n{"type":"user');
    input.feed('2"}\r\n');
    input.end();
    expect(lines).toEqual(['{"type":"user"}', '{"type":"user2"}']);
    expect(ends).toHaveLength(1);
  });

  test("rejects an oversize line once and resyncs at its newline", () => {
    const lines: string[] = [];
    const input = new FakeInput();
    frameCallerStdin({ handleCallerLine: (line) => lines.push(line), handleCallerEnd: () => {} }, input);
    const oversize = "a".repeat(MAX_INPUT_LINE_BYTES + 5);
    input.feed(`${oversize}\n{"type":"next"}\n`);
    expect(lines).toEqual(["oversize", '{"type":"next"}']);
  });

  test("rejects an unterminated run past the cap and discards to the newline", () => {
    const lines: string[] = [];
    const input = new FakeInput();
    frameCallerStdin({ handleCallerLine: (line) => lines.push(line), handleCallerEnd: () => {} }, input);
    const filler = "a".repeat(MAX_INPUT_LINE_BYTES + 1);
    input.feed(filler);
    expect(lines).toEqual(["oversize"]);
    input.feed("still inside the rejected line\n");
    input.feed('{"type":"after"}\n');
    expect(lines).toEqual(["oversize", '{"type":"after"}']);
  });

  test("rejects a line that is not valid UTF-8", () => {
    const lines: string[] = [];
    const input = new FakeInput();
    frameCallerStdin({ handleCallerLine: (line) => lines.push(line), handleCallerEnd: () => {} }, input);
    input.feed(Buffer.from([0xff, 0x0a]));
    expect(lines).toEqual(["invalid-utf8"]);
  });

  test("a read error ends the driver with that error and no partial line", () => {
    const ends: unknown[] = [];
    const input = new FakeInput();
    frameCallerStdin({ handleCallerLine: () => {}, handleCallerEnd: (error) => ends.push(error) }, input);
    const failure = new Error("broken pipe");
    input.feed('{"type":"partial');
    input.fail(failure);
    expect(ends).toEqual([failure]);
  });
});

describe("prepareSessionChild called directly", () => {
  // The two run contexts the phase builds carry no-op finalize arrows by
  // design (the codex session home and the project-settings directory are
  // per-session state no run-scoped cleanup may own), so no drive through
  // the command can execute them. Called directly, the phase hands its
  // builder the context and the test runs the arrows itself.
  const KEEPENV_SCODE =
    "printf 'Usage: scode [options] command\\n  --keep-env NAME[,NAME...]  keep named variables under --scrub-env\\n'; exit 0";

  const baseCall = {
    options: { printSandbox: false, sandbox: true },
    agentId: "codex",
    adapter: {
      getEnv: (): Record<string, string> => ({}),
      getEnvOmissions: (): string[] => [],
      // The codex Playwright MCP check reads the adapter's execution PATH
      // on every codex launch (src/session/cli-spawn-prep.ts).
      executionPathEnv: (): string => process.env.PATH ?? "",
    },
    override: null,
    runLike: {},
    resumeId: undefined,
    model: undefined,
    autonomy: "high",
    effort: undefined,
    workdir: process.cwd(),
    requestedAutonomy: "high",
    sandboxOptions: undefined,
    claudeBuilt: null,
    turnPerProcess: false,
    needsKeepEnvPreflight: false,
    sessionPrivateHome: null,
    abandonSessionProjectDir: (): void => {},
  } as unknown as Parameters<typeof prepareSessionChild>[0];

  test("a codex override launch builds the session-home context and its finalize runs", async () => {
    const fake = createFakeBinaryEnv({ scode: KEEPENV_SCODE });
    const contexts: unknown[] = [];
    try {
      const outcome = await prepareSessionChild({
        ...baseCall,
        codexSessionHome: { codexHome: "/tmp/session-home" },
        needsKeepEnvPreflight: true,
        buildSessionEnvironment: (context: unknown): { runEnv: Record<string, string>; env: Record<string, string> } => {
          contexts.push(context);
          return { runEnv: {}, env: fake.env };
        },
      } as unknown as Parameters<typeof prepareSessionChild>[0]);
      expect(outcome.argv).toBeDefined();
      // The keep-env preflight's probe build runs inside the phase and
      // carries the session provider home (getRunEnv refuses an override
      // launch without it — review round 3: the probe once dropped the
      // context and the print path died).
      expect(contexts).toHaveLength(1);
      const home = (contexts[0] as { codexProviderHome: { codexHome: string; finalize: () => void } }).codexProviderHome;
      expect(home.codexHome).toBe("/tmp/session-home");
      expect(() => home.finalize()).not.toThrow();
      // The long-lived environment is built lazily, after the resume
      // claim, from the same context.
      const built = outcome.buildLongLivedEnvironment();
      expect(contexts).toHaveLength(2);
      expect((contexts[1] as { codexProviderHome: { codexHome: string } }).codexProviderHome.codexHome)
        .toBe("/tmp/session-home");
      expect(built.env).toBe(fake.env);
    } finally {
      fake.cleanup();
    }
  });

  test("a project-settings launch builds the private-config context and its finalize runs", async () => {
    const fake = createFakeBinaryEnv({ scode: KEEPENV_SCODE });
    const contexts: unknown[] = [];
    try {
      const outcome = await prepareSessionChild({
        ...baseCall,
        codexSessionHome: null,
        sessionProjectDir: { dir: "/tmp/private-config", blockedPaths: [] },
        buildSessionEnvironment: (context: unknown): { runEnv: Record<string, string>; env: Record<string, string> } => {
          contexts.push(context);
          return { runEnv: {}, env: fake.env };
        },
      } as unknown as Parameters<typeof prepareSessionChild>[0]);
      expect(outcome.argv).toBeDefined();
      // Nothing is built before the resume claim: the long-lived
      // environment is the first build, and it carries the private-config
      // directory.
      expect(contexts).toHaveLength(0);
      const built = outcome.buildLongLivedEnvironment();
      expect(contexts).toHaveLength(1);
      const config = (contexts[0] as { claudeProjectConfigDir: { dir: string; finalize: () => void } }).claudeProjectConfigDir;
      expect(config.dir).toBe("/tmp/private-config");
      expect(() => config.finalize()).not.toThrow();
      expect(built.env).toBe(fake.env);
    } finally {
      fake.cleanup();
    }
  });

  test("a codex session home's run-context finalize is a no-op: the session owns its removal", async () => {
    // Both codex private homes (hermetic and caller-owned) reach the
    // adapter through run-context entries whose finalize must not remove
    // per-session state: --final and the sweep own that lifetime.
    const fake = createFakeBinaryEnv({ scode: KEEPENV_SCODE });
    const root = mkdtempSync(join(tmpdir(), "codemux-codex-session-home-"));
    try {
      for (const callerOwned of [false, true]) {
        const dir = join(root, callerOwned ? "caller" : "private");
        mkdirSync(join(dir, ".codex"), { recursive: true });
        const contexts: unknown[] = [];
        const outcome = await prepareSessionChild({
          ...baseCall,
          codexSessionHome: null,
          sessionProjectDir: null,
          sessionPrivateHome: { dir, ...(callerOwned ? { callerOwned: true, environment: {}, environmentOmissions: [] } : {}) },
          buildSessionEnvironment: (context: unknown): { runEnv: Record<string, string>; env: Record<string, string> } => {
            contexts.push(context);
            return { runEnv: {}, env: fake.env };
          },
        } as unknown as Parameters<typeof prepareSessionChild>[0]);
        outcome.buildLongLivedEnvironment();
        const context = contexts[0] as {
          hermeticHome: { codexHome: string; finalize: () => void };
          codexProviderHome?: { codexHome: string; finalize: () => void };
        };
        expect(context.hermeticHome.codexHome).toBe(join(dir, ".codex"));
        context.hermeticHome.finalize();
        if (callerOwned) {
          expect(context.codexProviderHome!.codexHome).toBe(join(dir, ".codex"));
          context.codexProviderHome!.finalize();
        } else {
          expect(context.codexProviderHome).toBeUndefined();
        }
        expect(existsSync(join(dir, ".codex"))).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      fake.cleanup();
    }
  });
});

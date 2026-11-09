/**
 * The per-agent profile units the engine tests cannot reach (the minted
 * identities' build/parse guards) and the shared spawn closure
 * (turn-driver-spawn.ts) over stub adapters: the opencode per-turn
 * refresh, the kimi hermetic context, the keep-env exemption, and the
 * adapter's per-turn validation gate.
 */

import { describe, expect, spyOn, test } from "bun:test";
import type { BaseAdapter, RunContext } from "../src/adapters/base.js";
import { withKeepEnvExemption, type SandboxOptions } from "../src/sandbox.js";
import { CURSOR_DRIVER_PROFILE } from "../src/session/cursor-driver.js";
import { GEMINI_DRIVER_PROFILE } from "../src/session/gemini-driver.js";
import type { TurnCommandInput } from "../src/session/turn-driver-types.js";
import { buildSessionTurnSpawn } from "../src/session/turn-driver-spawn.js";
import * as spawnModule from "../src/session/spawn.js";
import type { SessionPrivateHome } from "../src/session/private-home-types.js";
import { fakeTurnProcess } from "./helpers/session-turn-engine.js";

const COMMAND: TurnCommandInput = {
  text: "the prompt",
  sessionId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  firstTurn: true,
  hermeticHome: null,
  autonomy: "read-only",
};

describe("the minted identities' guards", () => {
  test("cursor's builder refuses a null id; its parse reports the broken contract", () => {
    expect(() =>
      CURSOR_DRIVER_PROFILE.buildTurnCommand!({ ...COMMAND, sessionId: null })
    ).toThrow("the minted cursor identity names its id before any turn");
    // A null known id is the driver's own contract broken, not a wire
    // verdict: the no-session-id shape, for the shared fatal.
    expect(CURSOR_DRIVER_PROFILE.parseTurnOutput!("{}", null)).toMatchObject({
      noSessionId: true,
      sessionId: null,
      failed: true,
    });
  });

  test("gemini's builder refuses a null id; every stream arm maps", () => {
    expect(() =>
      GEMINI_DRIVER_PROFILE.buildTurnCommand!({ ...COMMAND, sessionId: null })
    ).toThrow("the minted gemini identity names its id before any turn");
    const parse = GEMINI_DRIVER_PROFILE.parseStreamLine!;
    const id = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    const line = (event: Record<string, unknown>): string => JSON.stringify(event);
    expect(parse(line({ type: "init", session_id: id, model: "m" }), id)).toEqual({
      kind: "confirmed",
      sessionId: id,
      model: "m",
    });
    expect(parse(line({ type: "message", role: "assistant", content: "hi", delta: true }), id)).toEqual({
      kind: "assistant",
      text: "hi",
      delta: true,
    });
    expect(
      parse(line({ type: "tool_use", tool_id: "t1", tool_name: "read", parameters: { a: 1 } }), id)
    ).toEqual({ kind: "tool_use", callId: "t1", name: "read", input: { a: 1 } });
    expect(
      parse(line({ type: "tool_result", tool_id: "t1", status: "error", output: "bad" }), id)
    ).toEqual({ kind: "tool_result", callId: "t1", output: "bad", isError: true });
    expect(parse(line({ type: "error", severity: "error", message: "quota" }), id)).toEqual({
      kind: "error",
      message: "quota",
      failsTurn: true,
    });
    expect(parse(line({ type: "error", severity: "warning", message: "note" }), id)).toEqual({
      kind: "error",
      message: "note",
      failsTurn: false,
    });
    const result = parse(
      line({ type: "result", status: "error", error: { type: "other", message: "quota" }, stats: { input_tokens: 1, output_tokens: 1 } }),
      id
    );
    expect(result).toMatchObject({ kind: "result", failed: true, failureReason: "quota" });
    expect(parse(line({ type: "message", role: "user", content: "echo" }), id)).toEqual({ kind: "unknown" });
    expect(parse(line({ type: "init", session_id: "2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d" }), id)).toMatchObject({
      kind: "grammar_error",
    });
    expect(parse("not json", id)).toMatchObject({ kind: "unusable" });
  });
});

describe("the shared spawn closure", () => {
  const stubAdapter = (extra: Partial<BaseAdapter> = {}): BaseAdapter =>
    ({
      getEnv: (): Record<string, string> => ({ BRAND_ENV: "1" }),
      getEnvOmissions: (): string[] => ["OMITTED_ENV"],
      validateRunRequest: (): void => {},
      ...extra,
    }) as unknown as BaseAdapter;

  const spawnHarness = (
    adapter: BaseAdapter,
    agentId: "opencode" | "kimi" | "droid" = "droid",
    extra: { hermetic?: boolean; sessionPrivateHome?: SessionPrivateHome | null } = {}
  ) => {
    const spawned: { argv: string[]; env: Record<string, string>; options: unknown; handlers: unknown }[] = [];
    const contexts: unknown[] = [];
    const prepared: RunContext[] = [];
    const cleaned: RunContext[] = [];
    const child = fakeTurnProcess();
    const spawnSpy = spyOn(spawnModule, "spawnSessionChild").mockImplementation(((
      argv: string[],
      env: Record<string, string>,
      options: unknown,
      handlers: unknown
    ) => {
      spawned.push({ argv, env, options, handlers });
      return Promise.resolve(child);
    }) as unknown as typeof spawnModule.spawnSessionChild);
    const lines: string[] = [];
    const driver = { handleHarnessLine: (line: string): void => void lines.push(line) };
    const sandboxOptions: SandboxOptions = { scrubEnv: false } as SandboxOptions;
    const built = buildSessionTurnSpawn({
      agentId,
      adapter,
      options: { sandbox: true } as never,
      runLike: {} as never,
      override: null,
      hermetic: extra.hermetic ?? false,
      experimentProjectSettings: false,
      buildSessionEnvironment: (context?: unknown): { runEnv: Record<string, string>; env: Record<string, string> } => {
        contexts.push(context);
        return { runEnv: { TURN_ENV: "turn" }, env: { CHILD_ENV: "child" } };
      },
      sandboxOptions,
      workdir: "/tmp/work",
      requestedAutonomy: "read-only",
      shutdownGraceMs: 100,
      sessionPrivateHome: extra.sessionPrivateHome ?? null,
      driverRef: () => driver as never,
    });
    return { built, spawned, contexts, prepared, cleaned, spawnSpy, lines, driver, sandboxOptions, child };
  };

  test("the plain arm builds the environment once, reuses it, and routes lines to the driver", async () => {
    const harness = spawnHarness(stubAdapter());
    try {
      await harness.built.spawnTurn(["droid", "--turn", "one"]);
      await harness.built.spawnTurn(["droid", "--turn", "two"]);
      // One cached launch for both turns (the non-opencode arm).
      expect(harness.contexts).toHaveLength(1);
      expect(harness.spawned).toHaveLength(2);
      expect(harness.spawned[0]!.env).toEqual({ CHILD_ENV: "child" });
      expect(harness.spawned[0]!.argv).toEqual(["droid", "--turn", "one"]);
      expect(harness.spawned[1]!.argv).toEqual(["droid", "--turn", "two"]);
      const options = harness.spawned[0]!.options as {
        cwd: string; envOmissions: string[]; sandboxOptions: SandboxOptions | undefined;
      };
      expect(options.cwd).toBe("/tmp/work");
      expect(options.envOmissions).toEqual(["OMITTED_ENV"]);
      expect(options.sandboxOptions).toEqual(
        withKeepEnvExemption(harness.sandboxOptions, { BRAND_ENV: "1", TURN_ENV: "turn" }, false)
      );
      (harness.spawned[0]!.handlers as { onLine: (line: string) => void }).onLine("a line");
      expect(harness.lines).toEqual(["a line"]);
    } finally {
      harness.spawnSpy.mockRestore();
    }
  });

  test("the opencode arm refreshes the provider context before every turn and prefixes env(1)", async () => {
    let preparations = 0;
    const contexts: RunContext[] = [];
    const adapter = stubAdapter({
      prepareRun: (): RunContext => {
        preparations += 1;
        return {
          opencodeHermeticHome: { home: "/tmp/oc-home", finalize: () => {} },
          opencodeProviderConfig: { path: "/tmp/oc-config.json", finalize: () => {} },
        } as unknown as RunContext;
      },
      cleanupRun: (context: RunContext): void => {
        contexts.push(context);
      },
    });
    const harness = spawnHarness(adapter, "opencode");
    try {
      await harness.built.spawnTurn(["opencode", "--turn", "one"]);
      await harness.built.spawnTurn(["opencode", "--turn", "two"]);
      expect(preparations).toBe(2);
      // The previous turn's context is cleaned before the next prepare.
      expect(contexts).toHaveLength(1);
      expect((contexts[0] as { opencodeHermeticHome?: { home: string } }).opencodeHermeticHome?.home).toBe(
        "/tmp/oc-home"
      );
      // Hermetic false: no env(1) prefix rides the argv.
      expect(harness.spawned[0]!.argv).toEqual(["opencode", "--turn", "one"]);
    } finally {
      harness.spawnSpy.mockRestore();
    }
  });

  test("a hermetic opencode turn rides the env(1) prefix from its fresh home", async () => {
    const adapter = stubAdapter({
      prepareRun: (): RunContext =>
        ({
          opencodeHermeticHome: { home: "/tmp/oc-home-2", finalize: () => {} },
          opencodeProviderConfig: { path: "/tmp/oc-config-2.json", finalize: () => {} },
        }) as unknown as RunContext,
      cleanupRun: (): void => {},
    });
    const harness = spawnHarness(adapter, "opencode", { hermetic: true });
    try {
      await harness.built.spawnTurn(["opencode", "--turn", "one"]);
      expect(harness.spawned[0]!.argv[0]).toBe("env");
      // The prefix names the turn's fresh home and its fresh config.
      expect(harness.spawned[0]!.argv.join(" ")).toContain("HOME=/tmp/oc-home-2");
      expect(harness.spawned[0]!.argv.join(" ")).toContain("OPENCODE_CONFIG=/tmp/oc-config-2.json");
      expect(harness.spawned[0]!.argv.at(-1)).toBe("one");
    } finally {
      harness.spawnSpy.mockRestore();
    }
  });

  test("the kimi arm threads the private home's context to the env assembly", async () => {
    const home = {
      dir: "/tmp/kimi-home",
      resumed: false,
      settled: true,
      settle: (): void => {},
      remove: (): boolean => true,
      blockedPaths: [],
    } as SessionPrivateHome;
    const plain = spawnHarness(stubAdapter(), "kimi");
    const hermetic = spawnHarness(stubAdapter(), "kimi", { sessionPrivateHome: home });
    try {
      await plain.built.spawnTurn(["kimi", "--session-id", "s"]);
      // Without a private home the context is undefined (the plain rule).
      expect(plain.contexts[0]).toBeUndefined();
      await hermetic.built.spawnTurn(["kimi", "--session-id", "s"]);
      const context = hermetic.contexts[0] as { kimiHermeticHome?: { home: string } };
      expect(context.kimiHermeticHome?.home).toBe("/tmp/kimi-home");
    } finally {
      plain.spawnSpy.mockRestore();
      hermetic.spawnSpy.mockRestore();
    }
  });

  test("a turn whose adapter validation refuses never spawns", async () => {
    const adapter = stubAdapter({
      validateRunRequest: (): void => {
        throw new Error("the worktree grew a wider autonomy grant");
      },
    });
    const harness = spawnHarness(adapter);
    try {
      expect(() => harness.built.spawnTurn(["droid"])).toThrow("wider autonomy grant");
      expect(harness.spawned).toHaveLength(0);
    } finally {
      harness.spawnSpy.mockRestore();
    }
  });

  test("no sandbox options means no per-turn exemption to compute", () => {
    const adapter = stubAdapter();
    const driver = { handleHarnessLine: (): void => {} };
    const built = buildSessionTurnSpawn({
      agentId: "droid",
      adapter,
      options: { sandbox: true } as never,
      runLike: {} as never,
      override: null,
      hermetic: false,
      experimentProjectSettings: false,
      buildSessionEnvironment: (): { runEnv: Record<string, string>; env: Record<string, string> } => ({
        runEnv: {},
        env: {},
      }),
      sandboxOptions: undefined,
      workdir: "/tmp/work",
      requestedAutonomy: "read-only",
      shutdownGraceMs: 100,
      sessionPrivateHome: null,
      driverRef: () => driver as never,
    });
    expect(built.turnSandboxOptions({ ANY: "1" })).toBeUndefined();
  });
});

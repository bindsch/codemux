/** The driver-level rig for the shared turn engine (turn-driver.ts and
 * its core/turns/record layers): the real TurnAgentSessionDriver run
 * against a synthetic profile and a fake turn process, so every verdict
 * arm, stream arm, and end-path interleaving is driven without a child.
 * Mirrors what tests/helpers/session-kimi-e2e.ts does for kimi, minus
 * the process: the fake process's resolvers are the test's hands. */

import { emptyUsage } from "../../src/result-envelope.js";
import type { SessionCapabilities } from "../../src/session/protocol.js";
import type { SessionProcess } from "../../src/session/process.js";
import { TurnAgentSessionDriver } from "../../src/session/turn-driver.js";
import type {
  TurnAgentDriverOptions,
  TurnAgentId,
  TurnAgentProfile,
  TurnAgentTurnVerdict,
} from "../../src/session/turn-driver-types.js";
import type { SessionPrivateHome } from "../../src/session/private-home-types.js";

/** The honest matrix every synthetic profile carries: live input and
 * resume only — the seven's shape. */
const CAPS: SessionCapabilities = {
  live_input: true,
  user_during_turn: false,
  steer: false,
  interrupt: false,
  permissions: false,
  deltas: false,
  file_changes: false,
  usage_stream: false,
  resume: true,
};

const GOOD_VERDICT: TurnAgentTurnVerdict = {
  answer: "Done",
  usage: emptyUsage(),
  modelEffective: null,
  sessionId: "s-1",
  noSessionId: false,
  wrongSession: false,
  noWire: false,
  failed: false,
  failureReason: null,
};

/** A whole-stdout profile whose parse always answers the given verdict —
 * the engine is agent-agnostic, so a synthetic profile pins the arm
 * under test without any agent's wire in the way. */
export function wireProfile(
  verdict: Partial<TurnAgentTurnVerdict> = {},
  profile: Partial<TurnAgentProfile> = {}
): TurnAgentProfile {
  return {
    agent: "droid" as TurnAgentId,
    capabilities: CAPS,
    identity: "minted",
    promptCarrier: "stdin",
    buildTurnCommand: (input) => ["droid", input.text],
    parseTurnOutput: () => ({ ...GOOD_VERDICT, ...verdict }),
    ...profile,
  };
}

/** A line-stream profile that maps every line to `unknown` — a wire that
 * never names the session, for the stream-side untrackable rule. */
export function silentStreamProfile(
  profile: Partial<TurnAgentProfile> = {}
): TurnAgentProfile {
  return {
    ...wireProfile({}, profile),
    promptCarrier: "argv",
    parseTurnOutput: undefined,
    parseStreamLine: () => ({ kind: "unknown" }),
  };
}

/** The fake turn process: resolvers in the test's hands. `exit` resolves
 * the child outcome, `settle` the tree settlement; `failWrites` makes
 * every write refuse. */
export interface FakeTurnProcess extends SessionProcess {
  exit(code: number | null, signal?: string | null): void;
  settle(): void;
  wrote: string[];
  failWrites: boolean;
}

export function fakeTurnProcess(): FakeTurnProcess {
  const exited = Promise.withResolvers<{ code: number | null; signal: string | null }>();
  const settled = Promise.withResolvers<void>();
  const fake = {
    exited: exited.promise,
    settled: settled.promise,
    wrote: [] as string[],
    failWrites: false,
    writeRaw: (text: string): { ok: true } | { ok: false; reason: "closed" } => {
      if (fake.failWrites) return { ok: false, reason: "closed" };
      fake.wrote.push(text);
      return { ok: true };
    },
    endInput: (): void => {},
    requestStop: (): void => {},
    escalateStop: (): void => {},
    awaitEndAnswer: async (): Promise<void> => {},
    exit: (code: number | null, signal: string | null = null): void => {
      exited.resolve({ code, signal });
      // An exited fake has no tree left to settle (the rig's rule: a
      // test that needs the exit and the settlement apart calls settle()
      // first and gates the exit instead).
      settled.resolve();
    },
    settle: (): void => {
      settled.resolve();
    },
  };
  return fake as unknown as FakeTurnProcess;
}

export interface EngineSession {
  driver: TurnAgentSessionDriver;
  /** Parsed event objects, in order. */
  events: Record<string, unknown>[];
  send(text: string): void;
  user(text?: string): void;
  shutdown(): void;
  close(error?: unknown): void;
  line(text: string): void;
  fatal(payload: unknown): void;
  code(): Promise<number>;
  wait(type: string, ms?: number): Promise<Record<string, unknown>>;
  until(predicate: (event: Record<string, unknown>) => boolean, ms?: number): Promise<Record<string, unknown>>;
  dispose(): void;
}

type EngineOverrides = {
  options?: Partial<TurnAgentDriverOptions>;
  /** null leaves the driver's own default sink (process.stdout) in
   * place, so a test can spy the real writes. */
  sink?: TurnAgentDriverOptions["sink"] | null;
};

export function engineSession(overrides: EngineOverrides = {}): EngineSession {
  const events: Record<string, unknown>[] = [];
  const capture = (line: string): void => {
    events.push(JSON.parse(line) as Record<string, unknown>);
  };
  // An explicit null means "no sink override": the driver's default.
  const sink = "sink" in overrides ? (overrides.sink ?? undefined) : capture;
  const spawn: TurnAgentDriverOptions["spawnTurn"] =
    overrides.options?.spawnTurn ?? (async () => fakeTurnProcess());
  const options: TurnAgentDriverOptions = {
    profile: wireProfile(),
    resumeSessionId: null,
    mintedSessionId: "m-1",
    autonomy: "read-only",
    cwd: "/tmp",
    hermetic: false,
    sandboxed: true,
    sandboxTrust: "standard",
    sandboxNoNet: false,
    sandboxScrubEnv: false,
    passEnv: [],
    authorPrefix: false,
    sessionTimeoutMs: null,
    registryPath: null,
    harnessHome: "/tmp/harness-home",
    providerBaseUrl: null,
    spawnTurn: spawn,
    privateHome: null,
    final: false,
    ...overrides.options,
    ...(sink === undefined ? {} : { sink }),
  };
  const driver = new TurnAgentSessionDriver(options);
  const run = driver.run();
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (
    predicate: (event: Record<string, unknown>) => boolean,
    ms = 3_000
  ): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = events.find(predicate);
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`no event matched before ${ms} ms`);
      await sleep(5);
    }
  };
  return {
    driver,
    events,
    send: (text) => driver.handleCallerLine(text),
    user: (text = "the prompt") =>
      driver.handleCallerLine(JSON.stringify({ type: "user", text })),
    shutdown: () => driver.handleCallerLine(JSON.stringify({ type: "shutdown" })),
    close: (error) => driver.handleCallerEnd(error),
    line: (text) => driver.handleHarnessLine(text),
    fatal: (payload) => driver.handleFatal(payload as never),
    code: () => run,
    wait: (type, ms) => until((event) => event.type === type, ms),
    until,
    dispose: () => driver.dispose(),
  };
}

/** A private home the test watches: the settle/remove calls are
 * recorded, and every method is steerable through the fields. */
export function watchingHome(
  overrides: Partial<{
    resumed: boolean;
    settled: boolean;
    settleThrows: boolean;
    removeThrows: number;
  }> = {}
): SessionPrivateHome & { settles: string[]; removals: number } {
  let { settled = false } = overrides;
  let removals = 0;
  let removeThrows = overrides.removeThrows ?? 0;
  const home: SessionPrivateHome & { settles: string[]; removals: number } = {
    dir: "/tmp/private-home/run-1",
    resumed: overrides.resumed ?? false,
    get settled(): boolean {
      return settled;
    },
    blockedPaths: [],
    settles: [],
    get removals(): number {
      return removals;
    },
    settle(sessionId: string): void {
      if (overrides.settleThrows) throw new Error("settle refused (synthetic)");
      settled = true;
      home.settles.push(sessionId);
    },
    remove(): boolean {
      removals += 1;
      if (removeThrows > 0) {
        removeThrows -= 1;
        throw new Error("removal refused (synthetic)");
      }
      return true;
    },
  };
  return home;
}

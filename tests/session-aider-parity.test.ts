import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIDER_MODEL_SETTINGS_PATH } from "../src/adapters/aider.js";
import { AiderSessionDriver, type AiderDriverOptions } from "../src/session/aider-driver.js";
import { rollbackAiderInterruptedTurn } from "../src/session/aider-cancel.js";
import { aiderSessionHistoryPath, buildAiderSessionCommand, createAiderSessionHistory } from "../src/session/aider-session.js";
import type { SessionChildOutcome, SessionProcess } from "../src/session/process.js";
import { aiderSessionAnalyticsPath, prepareAiderSessionAnalytics, readAiderSessionUsage } from "../src/session/aider-analytics.js";
import { aiderSessionModelSettingsPath, prepareAiderSessionModelSettings } from "../src/session/aider-model-settings.js";

type Event = Record<string, any>;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function child() {
  let end!: (value: SessionChildOutcome) => void;
  let settle!: () => void;
  const exited = new Promise<SessionChildOutcome>((resolve) => { end = resolve; });
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  let stopped = 0;
  const complete = (outcome: SessionChildOutcome = { code: 0, signal: null }) => {
    end(outcome); settle();
  };
  const process = {
    exited, settled,
    repeatRawUntilExit: () => ({ ok: true }),
    requestStop: () => { stopped++; complete({ code: null, signal: "SIGTERM" }); },
    awaitEndAnswer: async () => { await exited; },
  } as unknown as SessionProcess;
  return { process, complete, stopped: () => stopped };
}

function fixture(overrides: Partial<AiderDriverOptions> = {}) {
  const root = mkdtempSync(join(import.meta.dir, "../scratch/fix/aider-session-"));
  const historyPath = aiderSessionHistoryPath(root, crypto.randomUUID());
  const events: Event[] = [];
  const children: ReturnType<typeof child>[] = [];
  const commands: string[][] = [];
  const driver = new AiderSessionDriver({
    sessionId: crypto.randomUUID(), resume: false, autonomy: "high", cwd: root,
    hermetic: false, sandboxed: false, sandboxTrust: "standard", sandboxNoNet: false,
    sandboxScrubEnv: false, passEnv: [], authorPrefix: false, sessionTimeoutMs: null,
    registryPath: null, harnessHome: root, providerBaseUrl: null, historyPath,
    spawnTurn: async (argv) => {
      commands.push(argv);
      const spawned = child(); children.push(spawned); return spawned.process;
    },
    sink: (line) => { events.push(JSON.parse(line)); }, ...overrides,
  });
  expect(driver.recordBeforeSpawn()).toBeNull();
  const code = driver.run();
  cleanups.push(() => driver.dispose());
  const send = (message: unknown) => driver.handleCallerLine(JSON.stringify(message));
  return { driver, events, children, commands, historyPath: overrides.historyPath ?? historyPath, send, code };
}

async function flushed() { for (let turn = 0; turn < 15; turn++) await Promise.resolve(); }

describe("aider session cancellation", () => {
  test("a stopped turn discards only its delta, then a new turn succeeds", async () => {
    const s = fixture();
    s.send({ type: "user", text: "first" }); await flushed();
    appendFileSync(s.historyPath, "#### first\n\nFirst answer.\n");
    s.children[0]!.complete(); await flushed();
    const previous = readFileSync(s.historyPath, "utf8");
    s.send({ type: "user", text: "interrupted" }); await flushed();
    appendFileSync(s.historyPath, "#### interrupted\n\n");
    s.send({ type: "interrupt" }); await flushed();
    expect(s.children[1]!.stopped()).toBe(1);
    expect(readFileSync(s.historyPath, "utf8")).toBe(previous);
    expect(s.events.filter((e) => e.type === "turn_completed").map((e) => e.finish))
      .toEqual(["end", "interrupted"]);
    s.send({ type: "user", text: "third" }); await flushed();
    appendFileSync(s.historyPath, "#### third\n\nThird answer.\n");
    s.children[2]!.complete(); await flushed();
    s.send({ type: "shutdown" });
    expect(await s.code).toBe(0);
    expect(s.events.at(-1)?.reason).toBe("shutdown");
  });

  test("shutdown after interruption retains the raw expected signal and succeeds", async () => {
    const s = fixture();
    s.send({ type: "user", text: "cancel" }); await flushed();
    appendFileSync(s.historyPath, "#### cancel\n\n");
    s.send({ type: "interrupt" });
    s.send({ type: "shutdown" });
    expect(await s.code).toBe(0);
    expect(s.events.at(-1)?.harness_exit).toEqual({ code: null, signal: "SIGTERM" });
    expect(s.events.at(-1)?.reason).toBe("shutdown");
    expect(readFileSync(s.historyPath, "utf8")).toBe("");
  });

  test("an interrupted recorded session remains resumable", async () => {
    const root = mkdtempSync(join(import.meta.dir, "../scratch/fix/aider-resumable-"));
    const s = fixture({ registryPath: join(root, "sessions.json") });
    s.send({ type: "user", text: "cancel" }); await flushed();
    appendFileSync(s.historyPath, "#### cancel\n\n");
    s.send({ type: "interrupt" }); await flushed();
    s.send({ type: "shutdown" });
    expect(await s.code).toBe(0);
    expect(s.events.at(-1)?.resumable).toBe(true);
    expect(readFileSync(s.historyPath, "utf8")).toBe("");
  });

  test("interrupt arriving during spawn stops the late child", async () => {
    const p = child();
    let spawn!: (process: SessionProcess) => void;
    const s = fixture({ spawnTurn: () => new Promise((resolve) => { spawn = resolve; }) });
    s.send({ type: "user", text: "pending" });
    s.send({ type: "interrupt" });
    spawn(p.process); await flushed();
    expect(p.stopped()).toBe(1);
    expect(s.events.find((e) => e.type === "turn_completed")?.finish).toBe("interrupted");
    s.send({ type: "shutdown" }); expect(await s.code).toBe(0);
  });

  test("turn timeout interrupts and clears its timer before the next turn", async () => {
    const s = fixture({ turnTimeoutMs: 1 });
    s.send({ type: "user", text: "timeout" });
    await Bun.sleep(10); await flushed();
    expect(s.events.find((e) => e.type === "turn_completed")?.finish).toBe("interrupted");
    s.send({ type: "shutdown" }); expect(await s.code).toBe(0);
  });

  test("a failed child after cancellation still fails the session", async () => {
    const s = fixture();
    s.send({ type: "user", text: "cancel" }); await flushed();
    s.send({ type: "interrupt" }); await flushed();
    s.send({ type: "user", text: "fail" }); await flushed();
    s.children[1]!.complete({ code: 2, signal: null }); await flushed();
    s.send({ type: "shutdown" });
    expect(await s.code).toBe(1);
    expect(s.events.at(-1)?.reason).toBe("harness_failed");
    expect(s.events.at(-1)?.harness_exit).toEqual({ code: 2, signal: null });
  });

  test("rollback failure ends the session instead of reusing damaged history", async () => {
    const s = fixture();
    s.send({ type: "user", text: "cancel" }); await flushed();
    chmodSync(s.historyPath, 0o644);
    s.send({ type: "interrupt" });
    expect(await s.code).toBe(1);
    expect(s.events.find((e) => e.type === "turn_completed")?.finish).toBe("failed");
    expect(s.events.at(-1)?.resumable).toBe(false);
  });

  test("rollback refuses symlinks, truncated history, and invalid offsets", () => {
    const root = mkdtempSync(join(import.meta.dir, "../scratch/fix/aider-rollback-"));
    const path = aiderSessionHistoryPath(root, crypto.randomUUID());
    createAiderSessionHistory(path);
    writeFileSync(path, "previous", { mode: 0o600 });
    expect(() => rollbackAiderInterruptedTurn(path, 50)).toThrow("changed before rollback");
    expect(() => rollbackAiderInterruptedTurn(path, -1)).toThrow("nonnegative");
    const link = join(root, "links", "session", "turn", "history.md");
    mkdirSync(join(root, "links", "session", "turn"), { recursive: true });
    symlinkSync(path, link);
    expect(() => rollbackAiderInterruptedTurn(link, 0)).toThrow("regular file");
    expect(readFileSync(path, "utf8")).toBe("previous");
  });
});

test("native deny overrides the yes flag at every autonomy level", () => {
  for (const autonomy of ["read-only", "low", "medium", "high"] as const) {
    const argv = buildAiderSessionCommand({
      autonomy, permissionPolicy: "deny", historyPath: "/state/history.md", prompt: "p",
    });
    expect(argv).toContain("AIDER_YES_ALWAYS=false");
    expect(argv).not.toContain("--yes-always");
  }
});

test("session tool removal applies the complete native carrier each turn", async () => {
  const s = fixture({ tools: "none" });
  for (const turn of [0, 1]) {
    s.send({ type: "user", text: `ask ${turn}` }); await flushed();
    const argv = s.commands[turn]!;
    expect(argv[argv.indexOf("--chat-mode") + 1]).toBe("ask");
    for (const flag of ["--no-git", "--no-detect-urls", "--no-auto-lint", "--no-auto-test",
      "--no-suggest-shell-commands"]) expect(argv).toContain(flag);
    expect(argv[argv.indexOf("--map-tokens") + 1]).toBe("0");
    appendFileSync(s.historyPath, `#### ask ${turn}\n\nAnswer.\n`);
    s.children[turn]!.complete(); await flushed();
  }
  s.send({ type: "shutdown" }); expect(await s.code).toBe(0);
  const restored = buildAiderSessionCommand({
    tools: "default", autonomy: "high", historyPath: s.historyPath, prompt: "restore tools",
  });
  expect(restored).toContain("--restore-chat-history");
  expect(restored).not.toContain("--no-git");
  expect(restored).not.toContain("--chat-mode");
});

test("analytics output counts and per-process costs sum across turns", async () => {
  const s = fixture();
  for (const [index, output, cost] of [[0, 37, 0.25], [1, 51, 0.5]] as const) {
    s.send({ type: "user", text: `turn ${index}` }); await flushed();
    const argv = s.commands[index]!;
    expect(argv).toContain("--no-stream");
    expect(argv[argv.indexOf("--analytics-log") + 1]).toBe(aiderSessionAnalyticsPath(s.historyPath));
    expect(readFileSync(aiderSessionAnalyticsPath(s.historyPath), "utf8")).toBe("");
    appendFileSync(aiderSessionAnalyticsPath(s.historyPath), JSON.stringify({
      event: "message_send", properties: { completion_tokens: output, total_cost: cost },
    }) + "\n");
    appendFileSync(s.historyPath, `#### turn ${index}\n\nAnswer.\n`);
    s.children[index]!.complete(); await flushed();
    expect(s.events.filter((e) => e.type === "turn_completed")[index]?.usage).toEqual({
      input_tokens: null, cached_input_tokens: null, output_tokens: output,
      total_tokens: null, cost_usd: cost,
    });
  }
  s.send({ type: "shutdown" }); expect(await s.code).toBe(0);
  expect(s.events.at(-1)?.usage.output_tokens).toBe(88);
  expect(s.events.at(-1)?.usage.cost_usd).toBe(0.75);
});

test("a refused turn cannot reuse the previous turn's analytics", async () => {
  const s = fixture();
  s.send({ type: "user", text: "first" }); await flushed();
  appendFileSync(aiderSessionAnalyticsPath(s.historyPath), JSON.stringify({
    event: "message_send", properties: { completion_tokens: 11, total_cost: 0.5 },
  }) + "\n");
  appendFileSync(s.historyPath, "#### first\n\nAnswer.\n");
  s.children[0]!.complete(); await flushed();
  chmodSync(s.historyPath, 0o644);
  s.send({ type: "user", text: "refused" }); await flushed();
  expect(s.events.filter((e) => e.type === "turn_completed")[1]?.usage.output_tokens).toBeNull();
  s.send({ type: "shutdown" }); expect(await s.code).toBe(0);
  expect(s.events.at(-1)?.usage.cost_usd).toBe(0.5);
});

test("analytics preparation refuses widened files and absent reports stay unknown", () => {
  const root = mkdtempSync(join(import.meta.dir, "../scratch/fix/aider-analytics-"));
  const path = aiderSessionHistoryPath(root, crypto.randomUUID());
  createAiderSessionHistory(path);
  expect(readAiderSessionUsage(path).output_tokens).toBeNull();
  const analytics = prepareAiderSessionAnalytics(path);
  chmodSync(analytics, 0o644);
  expect(() => prepareAiderSessionAnalytics(path)).toThrow("mode 0600");
  chmodSync(analytics, 0o600);
  writeFileSync(analytics, "not JSON\n");
  expect(readAiderSessionUsage(path).output_tokens).toBeNull();
});

function settingsFixture() {
  const root = mkdtempSync(join(import.meta.dir, "../scratch/fix/aider-settings-"));
  const historyPath = aiderSessionHistoryPath(root, crypto.randomUUID());
  createAiderSessionHistory(historyPath);
  return { root, historyPath, path: aiderSessionModelSettingsPath(historyPath) };
}

const capSettings = (cap: number) => [{ name: "aider/extra_params", extra_params: { max_tokens: cap } }];

test("uncapped sessions retain the base settings and do not prepare a file", () => {
  const s = settingsFixture();
  expect(prepareAiderSessionModelSettings(s.historyPath, undefined)).toBeUndefined();
  expect(existsSync(s.path)).toBe(false);
  const argv = buildAiderSessionCommand({ autonomy: "high", historyPath: s.historyPath, prompt: "p" });
  expect(argv[argv.indexOf("--model-settings-file") + 1]).toBe(AIDER_MODEL_SETTINGS_PATH);
});

test("owned model settings rewrite the complete global cap with mode 0600", () => {
  const s = settingsFixture();
  expect(prepareAiderSessionModelSettings(s.historyPath, 4096)).toBe(s.path);
  expect(JSON.parse(readFileSync(s.path, "utf8"))).toEqual(capSettings(4096));
  expect(lstatSync(s.path).mode & 0o777).toBe(0o600);
  writeFileSync(s.path, "stale settings that must not survive".repeat(20));
  expect(prepareAiderSessionModelSettings(s.historyPath, 7)).toBe(s.path);
  expect(JSON.parse(readFileSync(s.path, "utf8"))).toEqual(capSettings(7));
});

test("invalid output caps fail before creating model settings", () => {
  const s = settingsFixture();
  for (const cap of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => prepareAiderSessionModelSettings(s.historyPath, cap)).toThrow("positive safe integer");
  }
  expect(existsSync(s.path)).toBe(false);
});

test("model settings refuse widened files before truncation", () => {
  const s = settingsFixture();
  writeFileSync(s.path, "preserve", { mode: 0o644 });
  expect(() => prepareAiderSessionModelSettings(s.historyPath, 5)).toThrow("mode 0600");
  expect(readFileSync(s.path, "utf8")).toBe("preserve");
});

test("model settings refuse symlinks and hard links without modifying their targets", () => {
  for (const link of [symlinkSync, linkSync]) {
    const s = settingsFixture();
    const target = join(s.root, "target.yml");
    writeFileSync(target, "preserve", { mode: 0o600 });
    link(target, s.path);
    expect(() => prepareAiderSessionModelSettings(s.historyPath, 5)).toThrow();
    expect(readFileSync(target, "utf8")).toBe("preserve");
  }
});

test("model settings require trusted history and a regular destination", () => {
  const s = settingsFixture();
  chmodSync(s.historyPath, 0o644);
  expect(() => prepareAiderSessionModelSettings(s.historyPath, 5)).toThrow("mode 0600");
  expect(existsSync(s.path)).toBe(false);
  chmodSync(s.historyPath, 0o600);
  mkdirSync(s.path, { mode: 0o700 });
  expect(() => prepareAiderSessionModelSettings(s.historyPath, 5)).toThrow();
});

test("the driver replaces base settings and rewrites its cap before every turn", async () => {
  const s = fixture({ model: "openai/test", weakModel: "openai/test", maxOutputTokens: 512 });
  const path = aiderSessionModelSettingsPath(s.historyPath);
  for (const turn of [0, 1]) {
    s.send({ type: "user", text: `cap ${turn}` }); await flushed();
    const argv = s.commands[turn]!;
    expect(argv.filter((arg) => arg === "--model-settings-file")).toHaveLength(1);
    expect(argv[argv.indexOf("--model-settings-file") + 1]).toBe(path);
    expect(argv).not.toContain(AIDER_MODEL_SETTINGS_PATH);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(capSettings(512));
    appendFileSync(s.historyPath, `#### cap ${turn}\n\nAnswer.\n`);
    s.children[turn]!.complete(); await flushed();
    writeFileSync(path, JSON.stringify(capSettings(999999)));
  }
  s.send({ type: "shutdown" }); expect(await s.code).toBe(0);

  const resumed = fixture({ resume: true, historyPath: s.historyPath, maxOutputTokens: 32 });
  resumed.send({ type: "user", text: "resumed" }); await flushed();
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(capSettings(32));
  expect(resumed.commands[0]).toContain("--restore-chat-history");
  appendFileSync(s.historyPath, "#### resumed\n\nAnswer.\n");
  resumed.children[0]!.complete(); await flushed();
  resumed.send({ type: "shutdown" }); expect(await resumed.code).toBe(0);
});

test("a replaced settings file refuses the turn before spawn or stale usage", async () => {
  const s = fixture({ maxOutputTokens: 512 });
  s.send({ type: "user", text: "first" }); await flushed();
  appendFileSync(s.historyPath, "#### first\n\nAnswer.\n");
  appendFileSync(aiderSessionAnalyticsPath(s.historyPath), JSON.stringify({
    event: "message_send", properties: { completion_tokens: 10, total_cost: 0.25 },
  }) + "\n");
  s.children[0]!.complete(); await flushed();
  chmodSync(aiderSessionModelSettingsPath(s.historyPath), 0o644);
  s.send({ type: "user", text: "refused" }); await flushed();
  expect(s.commands).toHaveLength(1);
  const failed = s.events.filter((event) => event.type === "turn_completed")[1];
  expect(failed?.finish).toBe("failed");
  expect(failed?.usage.output_tokens).toBeNull();
  expect(s.events.some((event) => event.type === "error" && event.message.includes("model settings"))).toBe(true);
  s.send({ type: "shutdown" }); expect(await s.code).toBe(0);
  expect(s.events.at(-1)?.usage.cost_usd).toBe(0.25);
});

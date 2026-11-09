import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotAdapter } from "../src/adapters/copilot.js";
import { parseCopilotUsageMetrics, type CopilotRunContext } from "../src/copilot-usage.js";
import { createCopilotSessionProfile, readCopilotSessionBaseline, copilotUsageDelta } from "../src/session/copilot-profile.js";

const id = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const metrics = (tokens: number) => ({ modelMetrics: { actual: { usage: {
  inputTokens: tokens, outputTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0,
} } } });
const wire = [
  { type: "assistant.message", data: { content: "done", model: "actual" } },
  { type: "result", sessionId: id, exitCode: 0 },
].map((value) => JSON.stringify(value)).join("\n");

test("Copilot profile carries run options and subtracts cumulative usage on later turns", () => {
  const home = mkdtempSync(join(tmpdir(), "copilot-profile-"));
  const adapter = new CopilotAdapter({ HOME: home });
  const request = { agent: "copilot" as const, prompt: "turn", resultJson: true, tools: "none" as const };
  let context: CopilotRunContext | undefined = adapter.prepareRun(request);
  try {
    const profile = createCopilotSessionProfile({ adapter, request, harnessHome: join(home, ".copilot"), context: () => context });
    const turn = { text: "turn", sessionId: id, firstTurn: true, hermeticHome: join(home, "private"), autonomy: "high" as const };
    const argv = profile.buildTurnCommand(turn);
    expect(argv).toContain("codemux-no-tools");
    expect(argv).toContain(context.copilotUsageFile!.path);
    expect(argv).toContain("--session-id");
    writeFileSync(context.copilotUsageFile!.path, JSON.stringify(metrics(5)));
    expect(profile.parseTurnOutput!(wire, id).usage.total_tokens).toBe(10);
    adapter.cleanupRunSync(context);
    context = adapter.prepareRun(request);
    expect(profile.buildTurnCommand({ ...turn, firstTurn: false, hermeticHome: null })).toContain("--resume");
    writeFileSync(context.copilotUsageFile!.path, JSON.stringify(metrics(8)));
    expect(profile.parseTurnOutput!(wire, id).usage.total_tokens).toBe(6);
    expect(() => profile.buildTurnCommand({ ...turn, sessionId: null })).toThrow("identity");
    adapter.cleanupRunSync(context);
    context = undefined;
    expect(profile.parseTurnOutput!(wire, id).failed).toBe(true);
    expect(profile.parseTurnOutput!(wire, id).failureReason).toContain("not prepared");
  } finally {
    adapter.cleanupRunSync(context);
    rmSync(home, { recursive: true, force: true });
  }
});

test("Copilot resumes subtract the last persisted shutdown and reject missing baselines", () => {
  const home = mkdtempSync(join(tmpdir(), "copilot-profile-"));
  const adapter = new CopilotAdapter({ HOME: home });
  const request = { agent: "copilot" as const, prompt: "turn", resultJson: true };
  const context = adapter.prepareRun(request);
  try {
    const brand = join(home, ".copilot");
    const state = join(brand, "session-state", id);
    mkdirSync(state, { recursive: true });
    const path = join(state, "events.jsonl");
    writeFileSync(path, ["null", JSON.stringify({ type: "session.shutdown", data: metrics(3) }), "{}", ""].join("\n"));
    expect(readCopilotSessionBaseline(brand, id).total_tokens).toBe(6);
    const profile = createCopilotSessionProfile({ adapter, request, harnessHome: brand, context: () => context });
    expect(profile.buildTurnCommand({ text: "turn", sessionId: id, firstTurn: false, hermeticHome: null, autonomy: "high" }))
      .toContain("--resume");
    writeFileSync(context.copilotUsageFile!.path, JSON.stringify(metrics(7)));
    expect(profile.parseTurnOutput!(wire, id).usage.total_tokens).toBe(8);
    writeFileSync(path, "null\n{}\n");
    expect(() => readCopilotSessionBaseline(brand, id)).toThrow("no completed usage snapshot");
    expect(() => readCopilotSessionBaseline(brand, "../outside")).toThrow("invalid");
  } finally {
    adapter.cleanupRunSync(context);
    rmSync(home, { recursive: true, force: true });
  }
});

test("Copilot usage delta refuses counter resets and unknown prior counts", () => {
  const before = parseCopilotUsageMetrics(metrics(5));
  expect(() => copilotUsageDelta(parseCopilotUsageMetrics(metrics(3)), before)).toThrow("decreased");
  expect(() => copilotUsageDelta({ ...before, input_tokens: null }, before)).toThrow("incomplete");
});

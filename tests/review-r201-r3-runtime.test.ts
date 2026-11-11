import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTrustedExecutable } from "../src/executable-security.js";
import { openhandsPlainResult, openhandsResult } from "../src/result-envelope/openhands.js";
import { parseOpenhandsSessionTurn } from "../src/session/openhands-session.js";
import { OPENHANDS_DRIVER_PROFILE } from "../src/session/openhands-driver.js";
import { engineSession, fakeTurnProcess } from "./helpers/session-turn-engine.js";
import { geminiResult } from "../src/result-envelope/gemini.js";
import { copilotResult } from "../src/result-envelope/copilot.js";
import { turnCleanup } from "../src/session/turn-cleanup.js";

const root = () => mkdtempSync(join(import.meta.dir, "../scratch/r201-r3-"));
const id = "11111111-1111-4111-8111-111111111111";
const answer = { kind: "MessageEvent", source: "agent", llm_message: { content: [{ type: "text", text: "answer" }] } };
const wire = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");
const result = (stdout: string, exitCode = 0) => ({ stdout, stderr: "", exitCode, success: exitCode === 0 });

test("executable trust rejects dot-prefixed descendants and symlinks but permits siblings", () => {
  const dir = root(); const repo = join(dir, "repo"); mkdirSync(repo);
  for (const name of ["control", "..foo", "..."]) {
    const subdir = join(repo, name); mkdirSync(subdir);
    const executable = join(subdir, "probe"); writeFileSync(executable, "inert", { mode: 0o700 });
    expect(() => resolveTrustedExecutable(executable, "probe", repo)).toThrow("inside the execution");
  }
  const outside = join(dir, "probe"); writeFileSync(outside, "inert", { mode: 0o700 });
  expect(resolveTrustedExecutable(outside, "probe", repo)).toBe(outside);
  const alias = join(dir, "alias"); symlinkSync(join(repo, "..foo", "probe"), alias);
  expect(() => resolveTrustedExecutable(alias, "probe", repo)).toThrow("inside the execution");
});

for (const failure of [
  { code: "MaxIterationsReached", detail: "iteration budget exhausted" },
  { code: "Failure" }, {}, { detail: "" },
]) {
  test(`OpenHands conversation failure is terminal: ${JSON.stringify(failure)}`, () => {
    const stdout = wire([answer, { kind: "ConversationErrorEvent", ...failure }]);
    const json = openhandsResult(result(stdout), { agent: "openhands", prompt: "p" });
    expect(json.success).toBe(false); expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stdout).codemux.failure_code).toBe("harness-error");
    expect(openhandsPlainResult(result(stdout))?.success).toBe(false);
    expect(parseOpenhandsSessionTurn(stdout, { knownConversationId: id }).failed).toBe(true);
    if ("detail" in failure && failure.detail) expect(json.stderr).toContain(failure.detail);
  });
}

test("OpenHands recovered tool errors do not fail successful runs or sessions", () => {
  const stdout = wire([{ kind: "AgentErrorEvent", tool_name: "terminal", tool_call_id: "t", error: "bad arguments" }, answer]);
  expect(openhandsResult(result(stdout), { agent: "openhands", prompt: "p" }).success).toBe(true);
  expect(openhandsPlainResult(result(stdout))?.success).toBe(true);
  expect(parseOpenhandsSessionTurn(stdout, { knownConversationId: id }).failed).toBe(false);
  expect(openhandsResult(result(stdout, 2), { agent: "openhands", prompt: "p" }).success).toBe(false);
});

test.each(["gemini", "copilot"] as const)("%s terminal errors fail even without a readable diagnostic", (agent) => {
  const output = agent === "gemini"
    ? geminiResult(result(JSON.stringify({ response: "partial", error: { code: 429 } })), { agent, prompt: "p" })
    : copilotResult(result(wire([{ type: "assistant.message", data: { content: "partial" } },
      { type: "session.error", data: { errorType: "quota" } }])), { agent, prompt: "p" });
  expect(output.success).toBe(false); expect(output.exitCode).toBe(1);
});

test("turn cleanup is idempotent and a refused removal does not skip other resources", () => {
  const cleanup = turnCleanup(); let finalized = 0;
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  try {
    cleanup.register(() => { throw new Error("refused removal"); });
    cleanup.register(() => { throw "second refusal"; });
    cleanup.register(() => { finalized++; });
    cleanup.finalize(); cleanup.finalize();
    expect(finalized).toBe(1); expect(diagnostic).toHaveBeenCalledTimes(2);
  } finally { diagnostic.mockRestore(); }
});

test("OpenHands turns own prompt cleanup across concurrent sessions and a rejected spawn", async () => {
  const home = root();
  const privateHome = { dir: home, callerOwned: true, resumed: true, settled: true, blockedPaths: [],
    environment: {}, verify() {}, settle() {}, remove: () => false };
  const make = (reject = false) => {
    const child = fakeTurnProcess(); let path = "";
    const h = engineSession({ options: { profile: OPENHANDS_DRIVER_PROFILE, resumeSessionId: id,
      privateHome,
      spawnTurn: async (build) => {
        const argv = build({}); path = argv[argv.indexOf("--file") + 1]!;
        if (reject) throw new Error("synthetic spawn rejection");
        return child;
      } } });
    return { h, child, path: () => path };
  };
  const a = make(), b = make(), failed = make(true);
  try {
    a.h.user("A"); b.h.user("B"); failed.h.user("failed");
    await a.h.wait("turn_started"); await b.h.wait("turn_started");
    b.h.line(wire([answer])); b.child.exit(0); await b.h.wait("turn_completed");
    expect(readFileSync(a.path(), "utf8")).toBe("A"); expect(existsSync(b.path())).toBe(false);
    expect(await failed.h.code()).toBe(1);
    expect(existsSync(failed.path())).toBe(false);
    a.h.line(wire([answer])); a.child.exit(0); await a.h.wait("turn_completed");
    expect(existsSync(a.path())).toBe(false);
  } finally {
    for (const run of [a, b, failed]) { run.child.exit(0); run.h.close(); await run.h.code(); run.h.dispose(); }
  }
});

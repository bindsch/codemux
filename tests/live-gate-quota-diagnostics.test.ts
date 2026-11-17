import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ProbeRunner, quotaRefusalIn, parseOptions, runProbes } from "../scripts/live-gate.js";
import { isQuotaRefusalTrailer } from "../scripts/live-gate/quota.js";
import { agyToolsNoneRefusal } from "../src/adapters/agy.js";
import { getDefaultConfig } from "../src/config.js";
import { cleanupLoggedInHomes, factsFor, fixtureDirectory, loggedInEnv } from "./helpers/live-gate.js";

afterAll(cleanupLoggedInHomes);

const refusal = "RESOURCE_EXHAUSTED (code 429): Individual quota reached";
const diagnostic = (message: string) => [process.execPath, "-e", `
  console.error("Warning: quota gate: proceeding");
  console.error("Warning: version newer than audited");
  console.error("Warning: third warning");
  console.error("warning: --mode plan has no effect while slash command expansion is disabled.");
  console.error(${JSON.stringify(message)});
  process.exit(3);
`];

test("late agy quota diagnostics survive warning caps and become SKIP across eight probes", async () => {
  const directory = fixtureDirectory();
  const runner = new ProbeRunner();
  const env = loggedInEnv();
  const result = await runner.run(diagnostic(refusal), "OK", 5, join(directory, "quota"));
  expect(result.stderr).toContain("--mode plan");
  expect(quotaRefusalIn(result)).toContain("individual quota reached");
  expect(readFileSync(join(directory, "quota.err"), "utf8")).toContain(refusal);
  const rows = await runProbes([factsFor("agy")], parseOptions(["--probe", "A,B,C,D,E,F,I,K"], ""), {
    run: async () => result,
    capture: async () => result,
  }, directory, env.env, { ...getDefaultConfig(), models: { worker: { agy: "test-model" } } });
  const results = Object.values(rows[0]!.results);
  expect(results).toHaveLength(8);
  for (const probe of results) {
    expect(probe!.status).toBe("SKIP");
    expect(probe!.note).toContain("individual quota reached");
  }
});

test("structured rate-limit errors skip; quota warnings and unrelated errors remain failures", async () => {
  const runner = new ProbeRunner();
  for (const message of ["AGY_ERROR: RESOURCE_EXHAUSTED (code 429)", "provider.api_error: You've reached your weekly (7-day) usage limit"]) {
    expect(quotaRefusalIn(await runner.run(diagnostic(message), "OK", 5))).not.toBeNull();
  }
  for (const message of ["Warning: RESOURCE_EXHAUSTED (code 429); proceeding", "error: network connection refused", "HTTP 429 from a tool"]) {
    expect(quotaRefusalIn(await runner.run(diagnostic(message), "OK", 5))).toBeNull();
  }
  expect(quotaRefusalIn(await runner.run([process.execPath, "-e", `console.error(${JSON.stringify(refusal)}); console.log("OK")`], "OK", 5))).toBeNull();
  // A refusal followed by an unrelated error is a behavior failure.
  const later = [process.execPath, "-e", `console.error(${JSON.stringify(refusal)}); console.error("Error: probe output did not match"); process.exit(3);`];
  expect(quotaRefusalIn(await runner.run(later, "OK", 5))).toBeNull();
});

const summary = (attemptedActions: string[], passed = false) =>
  `probe summary: ${JSON.stringify({ mode: "hermetic", passed, status: "ERROR", attemptedActions })}`;

test.each(["D", "E"])("agy probe %s retains quota refusal through the exact trailers that follow it", async (letter) => {
  const trailer = letter === "D"
    ? `${summary(["error_message"])}\nHERMETIC agy: FAIL (probe failed, control failed)`
    : `codemux: agy ${agyToolsNoneRefusal(["error_message"])}`;
  const runner = new ProbeRunner();
  const command = [process.execPath, "-e", `console.error(${JSON.stringify(refusal)}); console.error(${JSON.stringify(trailer)}); process.exit(3);`];
  const result = letter === "D" ? await runner.capture(command, () => "no OK line", 5)
    : await runner.run(command, "OK", 5);
  expect(quotaRefusalIn(result)).toContain("individual quota reached");
  const fixture = loggedInEnv();
  const rows = await runProbes([factsFor("agy")], parseOptions(["--probe", letter], ""), {
    run: async () => result, capture: async () => result,
  }, fixtureDirectory(), fixture.env);
  expect(rows[0]!.results[letter as "D" | "E"]).toMatchObject({ status: "SKIP", note: expect.stringContaining("individual quota reached") });
});

test("the agy --tools none trailer is the adapter's own refusal text, matched exactly", () => {
  // The gate exempts exactly one trailer (scripts/live-gate/quota.ts); the
  // adapter emits it (src/adapters/agy.ts). Both build it from
  // agyToolsNoneRefusal, so a rewording on one side cannot drift alone.
  expect(`codemux: agy ${agyToolsNoneRefusal(["error_message"])}`)
    .toBe("codemux: agy --tools none forbids attempted actions: error_message");
  expect(isQuotaRefusalTrailer("codemux: agy --tools none forbids attempted actions: error_message")).toBe(true);
  const quotaSource = readFileSync(join(import.meta.dir, "../scripts/live-gate/quota.ts"), "utf8");
  expect(quotaSource).toContain('agyToolsNoneRefusal(["error_message"])');
  expect(quotaSource).not.toContain('"codemux: agy --tools none forbids');
});

// Review round 5, correctness 2: a refusal seen anywhere was kept unless a
// later line began with `error:` or `codemux:`, so a real failure could be
// reported as a quota SKIP.
test("a quota line followed by an unrelated failure is a FAIL, whatever the later line starts with", async () => {
  const runner = new ProbeRunner();
  const after = (...lines: string[]) => [process.execPath, "-e",
    `for (const line of ${JSON.stringify([refusal, ...lines])}) console.error(line); process.exit(3);`];
  for (const later of [
    "Traceback (most recent call last):",
    "probe output did not match",
    "panic: runtime error",
    "retrying after rate limit",
    // Real tool activity under --tools none, not the refusal's own step.
    `codemux: agy ${agyToolsNoneRefusal(["error_message", "tool", "unsandboxed"])}`,
    `codemux: agy ${agyToolsNoneRefusal(["tool"])}`,
    // A check whose control passed was not out of quota.
    "HERMETIC agy: FAIL (probe failed, control passed)",
    "HERMETIC agy: FAIL (probe failed, control failed) and more",
    summary(["error_message"], true),
    summary(["tool"]),
    "probe summary: not json",
  ]) {
    expect(isQuotaRefusalTrailer(later), later).toBe(false);
    const result = await runner.run(after(later), "OK", 5);
    expect(result.status).toBe("FAIL");
    expect(quotaRefusalIn(result), later).toBeNull();
  }
  // An exact trailer followed by anything else ends the refusal too.
  expect(quotaRefusalIn(await runner.run(after(summary(["error_message"]), "Candidate agy control probe; scratch removed when this check ends"), "OK", 5))).toBeNull();
  // The refusal as the final diagnostic, with warnings after it, still skips.
  expect(quotaRefusalIn(await runner.run(after("Warning: cleanup was slow"), "OK", 5))).toContain("individual quota reached");
  // Through the gate: the row stays a FAIL.
  const failedRun = await runner.run(after("probe output did not match"), "OK", 5);
  const fixture = loggedInEnv();
  const rows = await runProbes([factsFor("agy")], parseOptions(["--probe", "A"], ""), {
    run: async () => failedRun, capture: async () => failedRun,
  }, fixtureDirectory(), fixture.env, { ...getDefaultConfig(), models: { worker: { agy: "test-model" } } });
  expect(rows[0]!.results.A).toMatchObject({ status: "FAIL" });
});

test("a refusal the harness retried through is not the failure of a run that exited zero or timed out", async () => {
  const runner = new ProbeRunner();
  // The auditor's case: a transient 429, a retry, then a wrong answer with exit 0.
  const wrongAnswer = [process.execPath, "-e", `console.error(${JSON.stringify(refusal)}); console.log("not the nonce")`];
  const result = await runner.run(wrongAnswer, "OK", 5);
  expect(result.status).toBe("FAIL");
  expect(quotaRefusalIn(result)).toBeNull();
  const captured = await runner.capture(wrongAnswer, () => "no OK line", 5);
  expect(captured.status).toBe("FAIL");
  expect(quotaRefusalIn(captured)).toBeNull();
  const hung = [process.execPath, "-e", `console.error(${JSON.stringify(refusal)}); setTimeout(() => {}, 60000)`];
  const timedOut = await runner.run(hung, "OK", 1);
  expect(timedOut.status).toBe("FAIL");
  expect(quotaRefusalIn(timedOut)).toBeNull();
}, 20_000);

test("another codemux error after a refusal still clears it", async () => {
  const command = [process.execPath, "-e", `console.error(${JSON.stringify(refusal)}); console.error("codemux: agy malformed native event stream"); process.exit(3);`];
  expect(quotaRefusalIn(await new ProbeRunner().run(command, "OK", 5))).toBeNull();
});

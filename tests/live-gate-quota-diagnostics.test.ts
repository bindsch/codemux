import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ProbeRunner, quotaRefusalIn, parseOptions, runProbes } from "../scripts/live-gate.js";
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

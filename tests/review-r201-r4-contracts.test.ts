import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isWeekly, gateOnResult } from "../src/quota-gate.js";
import { POLICY, captureWarnings, result, window } from "./helpers/quota-gate.js";
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("longer windows never become weekly through their label", () => {
  for (const minutes of [10_141, 20_160, 43_200]) {
    const value = window({ kind: "weekly", windowMinutes: minutes, usedPercent: 60, remainingPercent: 40 });
    expect(isWeekly(value)).toBe(false);
    const warnings = captureWarnings();
    try { gateOnResult("claude", result({ windows: [value] }), POLICY); expect(warnings.lines).toEqual([]); }
    finally { warnings.restore(); }
  }
  for (const minutes of [null, 10_020, 10_080, 10_140]) expect(isWeekly(window({ kind: "weekly", windowMinutes: minutes }))).toBe(true);
});

test("model documentation distinguishes adapter-specific model from served_model", () => {
  const doc = read("docs/results-and-usage.md");
  expect(doc).not.toContain("Model is the served model when reported");
  expect(doc).toContain("Qwen, Pi, Gemini, Goose, and Copilot");
  expect(doc).toContain("selected model");
});

test("Claude permission ID documentation matches the shared parser bound", () => {
  expect(read("docs/session-protocol.md")).toContain("Claude and Z.AI request IDs are raw strings of 1–770 UTF-16 code units");
});

test("Qwen documents its required override default independently of the request model", () => {
  expect(read("src/adapters/qwen.ts").includes("request's or the variable's")).toBe(false);
  expect(read("docs/provider-overrides.md").includes("Qwen requires `CODEMUX_QWEN_PROVIDER_MODEL` even when `--model` is supplied.")).toBe(true);
});

test("session capability evidence describes shipped gates without patch provenance", () => {
  for (const path of ["docs/harnesses.md", "src/parity/reasons-session-w2.ts"]) {
    expect(read(path)).not.toContain("w2-session-tools.patch");
    expect(read(path)).not.toContain("eight integrated agents only");
  }
  const preview = read("docs/cli.md").split("On `session`,")[1]!.split("On `check`")[0]!;
  expect(preview).toContain("Pi, and Qwen.");
  expect(preview).not.toContain("--harness-home");
});

test("CI pins the requested scode release and commit", () => {
  expect(read(".github/workflows/ci.yml")).toContain("SCODE_TAG: v0.6.6");
  expect(read(".github/workflows/ci.yml")).toContain("SCODE_SHA: 9cbb7f8c995d778589e23d82ad334ab555e209ae");
  expect(read("CHANGELOG.md")).toContain("scode v0.6.6 (commit `9cbb7f8`)");
});

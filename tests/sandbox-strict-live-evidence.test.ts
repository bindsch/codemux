import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PARITY } from "../src/parity/index.js";
import { STRICT_LIVE_FAILURES, strictOkProbePassed } from "./helpers/strict-live-evidence.js";
import type { AgentId } from "../src/types.js";
import { CodexPlainFold } from "../src/plain-unwrap.js";
import { enforceNonEmptyResult } from "../src/result-empty.js";
import { buildScodeCommand } from "../src/sandbox.js";

test.each(Object.entries(STRICT_LIVE_FAILURES))("%s failed live probes cannot become supported from argv checks", (agent, failure) => {
  expect(strictOkProbePassed(failure)).toBe(false);
  for (const mode of ["run", "check", "session", "tui"] as const) {
    const state = PARITY[agent as AgentId][`${mode}.sandbox-strict`];
    expect(state.state).toBe("harness-limitation");
    if (state.state !== "harness-limitation") throw new Error("missing strict limitation");
    expect(failure.stdout + failure.stderr).toContain(state.refusal);
    expect(state.evidence).toContain("2026-11-11");
  }
});

test("OK requires the answer, not exit zero or the prompt echoed in a hook failure", () => {
  expect(strictOkProbePassed({ code: 0, stdout: "OK\n" })).toBe(true);
  expect(strictOkProbePassed({ code: 1, stdout: "OK" })).toBe(false);
  expect(strictOkProbePassed({ code: 0, stdout: "" })).toBe(false);
  expect(strictOkProbePassed({ code: 0, stdout: "UserPromptSubmit operation blocked by hook. Original prompt: Reply with the single word OK." })).toBe(false);
});

test("the actual Codex zero-token wire remains a failed empty answer", () => {
  const fold = new CodexPlainFold();
  fold.push('{"type":"thread.started","thread_id":"01a1c7c0-2191-79a1-9ddb-f43c29ac4f0a"}\n');
  fold.push('{"type":"turn.started"}\n');
  fold.push('{"type":"turn.completed","usage":{"input_tokens":0,"cached_input_tokens":0,"output_tokens":0}}\n');
  const raw = { stdout: fold.finish(), stderr: "Warning: no last agent message", exitCode: 0, success: true };
  const result = enforceNonEmptyResult(fold.verdict(raw), { agent: "codex", prompt: "Reply with the single word OK." }, 0);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("codex exited 0 with an empty answer");
});

test("the scode policy reference names strict, precedence, and its version boundary", () => {
  const doc = readFileSync(join(import.meta.dir, "../docs/autonomy-and-sandboxing.md"), "utf8");
  expect(doc).toContain("| `--sandbox-strict` | Requires `--sandbox`.");
  expect(doc).toContain("Overrides trusted's strict-off setting");
  expect(doc).toContain("The flag exists in scode 0.2.0");
  expect(doc).toContain("Live runtime grants were checked against scode 0.6.5");
});

test("strict support prose distinguishes superseded probes from final executable refusals", () => {
  const doc = readFileSync(join(import.meta.dir, "../docs/harnesses.md"), "utf8");
  const summary = doc.split("## Harness limitations\n")[1]!.split("Every row is a declared limitation.")[0]!;
  expect(summary).toContain("superseded writable-executable policy");
  expect(summary).toContain("installed Antigravity wrapped launch is refused before spawn with exit 64");
  expect(summary).toContain("Ordinary OpenCode at `~/.opencode/bin/opencode` is also refused");
  expect(summary).toContain("Cursor was held by the quota reserve");
  expect(summary).toContain("Copilot was refused because of ancestor executable configuration");
  expect(summary).not.toContain("could not launch the permitted model alias");
  expect(summary).not.toContain("Antigravity and OpenCode passed ordinary strict OK probes");
  const home = "/codemux-strict-fixture/home";
  expect(() => buildScodeCommand(["/usr/bin/env", `${home}/.local/bin/agy`], undefined, "low", { agentId: "agy", strict: true }, "scode", { HOME: home }))
    .toThrow("env-wrapped executable");
  expect(() => buildScodeCommand([`${home}/.opencode/bin/opencode`], undefined, "low", { agentId: "opencode", strict: true }, "scode", { HOME: home }))
    .toThrow("writable executable grant");
  for (const mode of ["run", "check", "session", "tui"] as const) {
    const state = PARITY.opencode[`${mode}.sandbox-strict`];
    expect(state.state).toBe("harness-limitation");
    if (state.state === "harness-limitation") expect(state.reason).toContain("Ordinary strict launches of ~/.opencode/bin/opencode are refused");
  }
});

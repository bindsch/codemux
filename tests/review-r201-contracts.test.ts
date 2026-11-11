import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8").replace(/\s+/g, " ");

test("Agy prompt transport references agree on stream-json stdin", () => {
  expect(read("README.md")).not.toContain("including Agy even when");
  expect(read("docs/cli.md")).toContain("Agy sends stream-json prompt frames on stdin");
  expect(read("docs/harnesses.md")).toContain("Antigravity sends stream-json prompt frames on stdin");
});

test("result session identity comments describe the shipped per-harness contract", () => {
  expect(read("src/types.ts")).not.toContain("null in this release -- reserved");
  expect(read("src/result-envelope/agy.ts")).not.toContain("like every harness in this release");
  expect(read("src/result-envelope/claude.ts")).not.toContain("reserved for the live-sessions release");
});

test("private-home lifecycle references include OpenCode and Cline", () => {
  expect(read("src/hermetic-session-canary.ts")).not.toContain('request.agent !== "opencode"');
  expect(read("src/session/cli.ts")).not.toContain("opencode has no session-keyed home");
  const final = read("docs/sessions.md").split("`--final` removes the home when the session ends.")[1]!.split("Without `--final`")[0]!;
  expect(final).toContain("cline");
  expect(final).toContain("opencode");
});

test("session check help discloses all five canary sessions", () => {
  expect(read("src/check-command.ts")).toContain("five codemux sessions");
});

test("session sandbox preview references include the newer per-turn drivers", () => {
  const paragraph = read("docs/cli.md").split("On `session`,")[1]!.split("On `check`")[0]!;
  expect(paragraph).toContain("Cline"); expect(paragraph).toContain("OpenHands");
  expect(read("src/session/cli-options.ts")).toContain("representative per-turn command for Aider, Cline, Copilot, Cursor, Droid, Gemini, Goose, Kimi, OpenCode, OpenHands, Pi, or Qwen");
});

test("budget capability reference includes Pi", () => {
  expect(read("docs/cli.md")).toContain("`run --max-budget-usd`; claude, zai, and pi");
});

test("unknown-version refusal reference includes Cline", () => {
  expect(read("docs/harnesses.md")).toContain("Copilot and Cline refuse");
});

test("source comments reflect the current hermetic and TUI capabilities", () => {
  expect(read("src/aider-history.ts")).not.toContain("that check is refused for now");
  for (const agent of ["droid", "pi"]) expect(read(`src/${agent}-provider.ts`)).not.toContain(`should ${agent} ever gain that mode`);
  expect(read("src/info-commands.ts")).not.toContain("droid accepts neither");
});

test("session coverage claims include Cline and OpenHands", () => {
  expect(read("tests/session-cli-refusals.test.ts")).toContain("copilot, goose, cline, and openhands accept");
});

test("function comments stay attached to the functions they describe", () => {
  expect(read("src/quota-gate.ts")).toMatch(/The gate every launch command calls\.[\s\S]*?proceeds\. \*\/ export const assertQuotaHeadroom/);
  expect(read("src/credentials/oauth.ts")).toMatch(/Whether a mirror still holds a refresh token[\s\S]*?module header\)\. \*\/ export function carriesRefreshToken/);
});

test("legacy ledger cost documentation describes agent-based classification", () => {
  expect(read("docs/results-and-usage.md")).not.toContain("have no field and count as billed");
  expect(read("docs/results-and-usage.md")).toContain("classified by the same agent-based rule");
});

test("preview release notes do not promise a quota check", () => {
  expect(read("CHANGELOG.md")).not.toContain("preflights and the quota gate, then print");
  expect(read("CHANGELOG.md")).toContain("skip the quota gate");
});

test("RPC acknowledgment tests assert real event types with explicit counts", () => {
  for (const path of ["tests/pi-rpc-driver.test.ts", "tests/gemini-acp-driver.test.ts"]) {
    expect(read(path)).not.toContain('=== "input_ack"');
    expect(read(path)).toContain('"input_accepted", "input_rejected", "input_rejected", "input_rejected"');
  }
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Review ul2: doc and comment claims that drifted from the code. Each
// test pins the corrected claim and refuses the stale wording where the
// stale form is gone for good, so the same drift cannot come back
// unnoticed (the same pattern as session-docs.test.ts, review live23).
const ROOT = join(import.meta.dir, "..");
const read = (path: string): string =>
  readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");

const README = read("README.md");
const COMPAT = read("docs/HARNESS-COMPATIBILITY.md");
const REPORT = read("docs/usage-ledger-report.md");
const CALL_LOG = read("src/call-log.ts");
const PACKAGE = read("package.json");

describe("usage-ledger doc claims (review ul2)", () => {
  test("the ledger location is HOME-derived on every platform, never XDG", () => {
    // ul2 contracts 5: the report once claimed an XDG_STATE_HOME rule
    // the code deliberately does not have.
    expect(REPORT).toContain("derived from `$HOME` alone, never `$XDG_STATE_HOME`");
    expect(README).toContain("derived from `$HOME` alone");
    expect(CALL_LOG).toContain("never `$XDG_STATE_HOME`");
  });

  test("the docs say what the vLLM override gateway really reported", () => {
    // ul2 contracts 6: README and the report contradicted each other;
    // the live receipt is the truth — real token counts, a zero cost.
    expect(README).not.toContain("carried no usage on its `step_finish` lines");
    expect(README).toContain("real token counts (24709 in, 2 out, 0 cached) and a zero cost");
    expect(COMPAT).not.toContain("in the recorded fixture reported none");
    expect(COMPAT).toContain("real token counts and a zero cost");
  });

  test("the session ledger comment states the real hermetic rule", () => {
    // ul2 contracts 4: "only opencode sessions can be hermetic" was
    // wrong twice — aider forwards the flag too, and the session CLI
    // refuses --hermetic for every agent in this release.
    expect(CALL_LOG).not.toContain("only opencode sessions can be hermetic");
    expect(CALL_LOG).toContain("refuses `--hermetic` outright in this release");
  });

  test("the README scopes directory tightening to the default state directory", () => {
    expect(README).not.toContain("tightened again when either arrives");
    expect(README).toContain("a relocated ledger never changes its directory's permissions");
    expect(README).toContain("a failure to tighten never stops the append");
  });

  test("the README states the --sum session-summary fold (ul3)", () => {
    // ul2 pinned the exclusion — summaries dropped because "counting both
    // would count those turns twice" — which also dropped the claude
    // family's session cost, the only record that ever carries it (ul3
    // security 3). The fold replaces it: tokens from the turns, the cost
    // from the summary, per field.
    expect(README).not.toContain("closing `session` summary records excluded");
    expect(README).not.toContain("counting both would count those turns twice");
    expect(README).toContain("Closing `session` summaries fold in per field");
    expect(README).toContain("never counted twice");
    expect(README).toContain("the session's cost from the summary");
  });

  test("the test-ledger redirect is the preload's CODEMUX_TEST_LEDGER, never NODE_ENV (ul4)", () => {
    // ul2 pinned the source-level NODE_ENV detection, which silently
    // discarded an operator's real records whenever a process outside
    // codemux's test runner exported the variable (ul4 contracts 2). The
    // one mechanism now: tests/setup.ts preloaded by every test script,
    // setting an env var codemux owns end to end.
    expect(PACKAGE).toContain("--preload ./tests/setup.ts");
    expect(README).toContain("CODEMUX_TEST_LEDGER");
    expect(README).toContain("no generic variable — `NODE_ENV=test` included — ever diverts records");
    expect(README).not.toContain("per-process throwaway file instead");
    expect(REPORT).toContain("CODEMUX_TEST_LEDGER");
    expect(CALL_LOG).not.toContain("NODE_ENV === \"test\"");
  });

  test("the README states the resumed-session fold for --sum (ul4)", () => {
    // A resumed session writes a second closing record carrying
    // session-lifetime usage again; counting both double-counts the
    // pre-resume cost. The rule: the newest closing wins.
    expect(README).toContain("folds the closings of one session to the newest");
    expect(README).toContain("the pre-resume share is never counted twice");
    expect(COMPAT).toContain("several closings fold to the newest one");
  });

  test("the README says what the streamed opencode path can and cannot know (ul4)", () => {
    // The per-harness table must name the trade: tool parts are dropped
    // as they arrive, so the run cannot outgrow the bound and the tool
    // events' contents are kept nowhere.
    expect(README).toContain("tool parts are dropped as they arrive");
    expect(README).toContain("what the tool events carried");
    expect(README).toContain("cannot outgrow the 16 MiB output bound");
  });

  test("corrupt-line promises cover wrong-shaped lines too", () => {
    expect(README).toContain("a corrupt or wrong-shaped line is skipped and counted");
  });
});

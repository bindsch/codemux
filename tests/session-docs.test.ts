import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Review live23: doc claims that drifted from the code. Each test pins
// the corrected claim and refuses the stale wording, so the same drift
// cannot come back unnoticed.
const ROOT = join(import.meta.dir, "..");
const read = (path: string): string =>
  readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");

const README = read("README.md");
const DESIGN = read("docs/LIVE-SESSIONS-DESIGN.md");
const HERMETIC = read("docs/HERMETIC.md");

describe("live-session doc claims (review live23)", () => {
  test("the README mirrors a driver-caught violation before its fatal", () => {
    expect(README).not.toContain("the raw line is not mirrored on those paths");
    expect(README).toContain("is handled the same way: the line is mirrored as `unknown`, then the fatal `error`");
  });

  test("the README's synthesized completion keeps the usage a turn reported", () => {
    expect(README).not.toContain("usage all-null because none was reported");
    expect(README).toContain("the usage the turn reported before the end");
  });

  test("HERMETIC does not class an absent registry with the refusals", () => {
    expect(HERMETIC).not.toContain("(absent, unreadable, corrupt, or world-permissive)");
    expect(HERMETIC).toContain("An absent registry has no entry to vouch from");
  });

  test("the design names the total_tokens exception to never-wipe", () => {
    expect(DESIGN).toContain("The derived `total_tokens` is the one field a later turn can null");
  });

  test("the design routes a non-object updated_input to malformed, not deny", () => {
    expect(DESIGN).not.toContain("that does not parse into arguments is an opaque action, and the answer is deny");
    expect(DESIGN).toContain("that is not a JSON object is rejected `malformed`");
  });

  test("the design says which tools carry an argument schema at low", () => {
    expect(DESIGN).not.toContain("known tool carrying an argument key outside its known schema");
    expect(DESIGN).toContain("tools without a schema (Read, WebFetch, Task, `mcp__*`, and unknown tools) accept any arguments at low");
  });

  test("the design states the blank-line and CR carve-outs of the ack rule", () => {
    expect(DESIGN).not.toContain("Every line is answered by");
    expect(DESIGN).toContain("a blank or whitespace-only line is skipped without an answer");
  });

  test("the excerpt bound is stated in bytes", () => {
    expect(DESIGN).toContain("the first 4 KiB of the line's UTF-8 bytes");
  });

  test("the FSM header cites the lifecycle section", () => {
    const fsm = readFileSync(join(ROOT, "src/session/fsm.ts"), "utf8");
    expect(fsm).toContain("The session lifecycle state machine (design §4.6)");
    expect(DESIGN).toContain("### 4.6 Lifecycle");
  });
});

describe("live-session doc claims, audit siblings (review live23)", () => {
  const PANEL = read("docs/LIVE-SESSIONS-PANEL.md");
  const header = (path: string): string => {
    const text = readFileSync(join(ROOT, path), "utf8");
    return text.slice(0, text.indexOf("*/")).replace(/\s+/g, " ");
  };

  test("the panel record carries the unified tier-2 rule", () => {
    expect(PANEL).not.toContain("the raw line is not mirrored on those paths");
  });

  test("no doc or header claims every input line is acked", () => {
    for (const text of [README, PANEL, header("src/session/protocol.ts")]) {
      expect(text).not.toMatch(/Every input line is (acknowledged|answered)|every stdin line is answered/);
    }
  });

  test("no doc or header implies every known tool has a schema at low", () => {
    expect(PANEL).not.toContain("known tool carrying an argument key outside its known schema");
    expect(header("src/session/ceiling.ts")).not.toContain("a KNOWN tool whose argument set carries a key outside that schema still denies at low");
  });

  test("the panel's keep-semantics names the total_tokens exception", () => {
    expect(PANEL).toContain("except the derived `total_tokens`");
  });
});

describe("live-session doc claims (review live25)", () => {
  const CHANGELOG = read("CHANGELOG.md");
  const REPORT = read("docs/live-sessions-report.md");
  const code = (path: string): string => readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");

  test("the design's straggler rule names every recent closed turn, not the last one", () => {
    expect(DESIGN).not.toContain("naming the turn that closed last");
    expect(DESIGN).toContain("naming any of the most recent 1024 closed turns");
  });

  test("no doc names the nonexistent --session-timeout flag", () => {
    for (const text of [README, DESIGN, CHANGELOG, REPORT]) {
      expect(text).not.toContain("--session-timeout");
    }
  });

  test("the untrusted-trust refusal is scoped to sandboxed sessions", () => {
    expect(README).not.toContain("`untrusted` is refused for sessions —");
    expect(README).toContain("`untrusted` is refused for sandboxed sessions");
    expect(CHANGELOG).not.toContain("`--hermetic`, `--tools`, and `--sandbox-trust untrusted` are refused for sessions");
    expect(DESIGN).toContain("`--sandbox-trust untrusted` is refused for a sandboxed session");
  });

  test("the registry reader names both fresh-start writers that reset a corrupt file", () => {
    const registry = code("src/session/registry.ts");
    expect(registry).not.toContain("only `recordSessionStart` treats corrupt as recoverable");
    expect(registry).toContain("only the fresh-start writers, `recordSessionStart` and");
    expect(registry).toContain("`probeRegistryForStart`, treat corrupt as recoverable");
  });

  test("the fake agy's wrongid comment matches the check's real trigger", () => {
    const fake = code("tests/fixtures/live/fake-agy-session.ts");
    expect(fake).not.toContain("tier-2 only on a resumed session");
    expect(fake).toContain("tier-2 once an id is adopted");
  });

  test("the codex driver's call() contract sits on call(), not on closeHarnessTurn()", () => {
    const driver = readFileSync(join(ROOT, "src/session/codex-driver.ts"), "utf8");
    const close = driver.indexOf("private closeHarnessTurn(");
    const before = driver.slice(driver.lastIndexOf("/**", close), close);
    expect(before).not.toContain("Send one request");
    const call = driver.indexOf("private call(");
    expect(driver.slice(driver.lastIndexOf("/**", call), call)).toContain("Send one request under the next integer id");
  });

  test("README, CHANGELOG, and the design document the session refusals live25 added", () => {
    for (const text of [README, CHANGELOG, DESIGN]) {
      expect(text).toContain("CODEMUX_<AGENT>_PROVIDER_*");
    }
    // The unreleased branch delivers the "next release" the 0.9.0 README
    // promised: overrides now reach sessions, so the promise is refused
    // wording and the delivered claim is pinned instead.
    expect(README).not.toContain("Overrides reach sessions in the next release.");
    expect(README).toContain("Provider overrides reach session spawns exactly as they reach `run`'s");
    expect(README).toContain("requires `--sandbox` and `--auto low`");
    expect(code("src/provider-override.ts")).not.toContain("the planned `codemux session` resume path");
  });
});

describe("live-session doc claims (review D1)", () => {
  const CHANGELOG = read("CHANGELOG.md");
  const COMPAT = read("docs/HARNESS-COMPATIBILITY.md");
  const FIXTURES = read("tests/fixtures/live/README.md");
  const code = (path: string): string => readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");

  test("no doc claims the codex session home is per-endpoint (review D1, security)", () => {
    // The home is keyed per session id: a per-endpoint one carries one
    // session's sandbox-planted files into the next session on the same
    // endpoint. The stale wording is refused everywhere it appeared.
    for (const text of [README, DESIGN, CHANGELOG, COMPAT]) {
      expect(text).not.toContain("persistent per-endpoint");
      expect(text).not.toContain("persists per endpoint");
    }
    expect(CHANGELOG).toContain("keyed per session");
    expect(README).toContain("never shared between sessions");
    expect(COMPAT).toContain("never follows a planted symlink");
    expect(DESIGN).toContain("settled onto its key at a resumable end, and removed at any other end");
  });

  test("the registry comment admits the adjacent autonomy ties (review D1, 2.1)", () => {
    const registry = code("src/session/registry.ts");
    expect(registry).not.toContain("strictly additive flag sets");
    expect(registry).toContain("each ladder has one adjacent tie");
  });

  test("the opencode fixture README no longer claims per-turn step_finish usage (review D1, 2.2)", () => {
    expect(FIXTURES).not.toContain("and per-turn `step_finish` usage");
    expect(FIXTURES).toContain("No `step_finish` line arrived in this recording");
  });

  test("the runLike comment no longer claims the placeholder carries the argv prompt bound (review D1, 2.3)", () => {
    const cli = code("src/session/cli.ts");
    expect(cli).not.toContain("the argv prompt bound aider enforces");
    expect(cli).toContain("never a turn's text");
    expect(cli).toContain("enforces that bound per turn at the driver");
  });
});

describe("live-session doc claims (review D2)", () => {
  const COMPAT = read("docs/HARNESS-COMPATIBILITY.md");
  const REPORT = read("docs/live-sessions-d-report.md");
  const FIXTURES = read("tests/fixtures/live/README.md");
  const code = (path: string): string => readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");

  test("no doc claims the opencode cost is a session-lifetime figure to adopt (review D2, contracts 2)", () => {
    // The stale ledger rule contradicted the driver's within-turn sum:
    // each step_finish part's cost is that step's own (the binary runs
    // `assistantMessage.cost += step.cost`), so codemux sums. The
    // claude-family session-lifetime wording (total_cost_usd) is a
    // different wire and stays.
    for (const text of [README, COMPAT]) {
      expect(text).not.toContain("the cost is the harness's session-lifetime figure");
      expect(text).not.toContain("never sums");
    }
    expect(COMPAT).toContain(
      "codemux sums step costs into the turn and turn costs into the session cumulative"
    );
    // The parser reads the usage off the line's part, and the fake emits
    // the real envelope shape (review D2, contracts 1).
    expect(COMPAT).toContain("ride inside the `part` object of the line");
    const parser = code("src/session/opencode-session.ts");
    expect(parser).toContain("tokens and cost live INSIDE part");
  });

  test("the report describes the codex session home keyed per session id (review D2, contracts 3)", () => {
    // The report's deliverable section still named the pre-D1 per-endpoint
    // shape and a stale line citation; the docs-pin refusal never covered
    // this file, which is how the drift survived. It does now.
    expect(REPORT).not.toContain("persistent per-endpoint");
    expect(REPORT).toContain("keyed per session id");
  });

  test("the CLI re-runs the validation gate before every turn it spawns (review D2, security 1)", () => {
    const cli = code("src/session/cli.ts");
    expect(cli).toContain("Re-run the adapter's validation gate before EVERY turn");
  });

  test("the opencode driver sums turn costs, never adopts a latest figure (review D2, contracts 2)", () => {
    const driver = code("src/session/opencode-driver.ts");
    expect(driver).not.toContain("addTurnUsage(this.cumulative");
    expect(driver).toContain("addUsage(this.cumulative, usage)");
  });

  test("the sweeper ages by real writes, not the directory's own mtime (review D2, security 2)", () => {
    const aider = code("src/session/aider-session.ts");
    expect(aider).toContain("the history file's mtime when there");
    const hermetic = code("src/hermetic-home.ts");
    // The comment that justified the blind spot is gone; the tree-newest
    // rule is stated.
    expect(hermetic).not.toContain("the harness writes its thread state on every turn");
    expect(hermetic).toContain("NEWEST mtime anywhere in the directory's tree");
  });

  test("the settle seam returns whether the home reached its key (review D2, correctness-2 2)", () => {
    const provider = code("src/codex-provider.ts");
    expect(provider).toContain("Returns whether the home ended where a resume finds it");
    expect(provider).toContain("keyed home is refused outright");
    const driver = code("src/session/codex-driver.ts");
    expect(driver).toContain("resumable: resumable && settledHome");
  });

  test("the fixtures README anchors the fold to the review D2 wire-level fix", () => {
    expect(FIXTURES).toContain("review D2 fixed the fold's wire level");
  });
});

describe("live-session doc claims (review D3)", () => {
  const CHANGELOG = read("CHANGELOG.md");
  const COMPAT = read("docs/HARNESS-COMPATIBILITY.md");
  const code = (path: string): string => readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");

  test("the record and the resume guard carry the provider identity (review D3, security)", () => {
    expect(DESIGN).toContain("the provider identity must match (review D3)");
    expect(DESIGN).toContain('"provider_base_url": null');
    expect(README).toContain("The registry records the provider identity");
    expect(README).toContain("never replays on another");
    expect(CHANGELOG).toContain("refuses a mismatch with exit 78 in both directions");
    expect(COMPAT).toContain("never replays on another");
    const registry = code("src/session/registry.ts");
    expect(registry).toContain("provider_base_url");
    expect(registry).toContain("providerBaseUrl");
  });

  test("a resumed codex home is never removed at settlement (review D3, correctness)", () => {
    // The D1 blanket claim is refined, not replaced: a FRESH home still
    // goes at a non-resumable end, and the old blanket wording is
    // refused where it described the resumed shape.
    expect(DESIGN).toContain(
      "settled onto its key at a resumable end, and removed at any other end of a FRESH session"
    );
    expect(DESIGN).toContain("A resumed session's home is never removed at settlement");
    // Review D7 reworded the README's sentence (the settle now runs
    // before the record release); the never-removed rule survives.
    expect(README).toContain("A resumed home is never removed at settlement");
    expect(COMPAT).toContain("never removed at settlement");
    expect(code("src/codex-provider.ts")).toContain("Never remove a resumed home at settlement");
  });

  test("the opencode provider config is written fresh per turn, never cached from the first (review D3, security 2)", () => {
    expect(COMPAT).toContain("written fresh before every turn");
    expect(DESIGN).toContain("re-writes its provider config before every turn");
    const cli = code("src/session/cli.ts");
    expect(cli).not.toContain("Cached after the first turn");
    expect(cli).toContain("A FRESH provider config before every turn");
  });
});

describe("live-session doc claims (review D4)", () => {
  const CHANGELOG = read("CHANGELOG.md");
  const COMPAT = read("docs/HARNESS-COMPATIBILITY.md");
  const code = (path: string): string => readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");

  test("the codex session-home sweep spares registry-held ids, in every doc that states the sweep (review D4, security 1)", () => {
    expect(README).toContain("never takes a home the session registry holds live");
    expect(COMPAT).toContain("never takes a home the session registry holds live");
    expect(DESIGN).toContain("never takes a home the registry holds live");
    expect(CHANGELOG).toContain("never removes a codex home the session registry holds live");
    const sweep = code("src/hermetic-home.ts");
    expect(sweep).toContain("sessionHoldState(sessionRegistryPath(), id)");
    expect(sweep).not.toContain("age alone — see the session gate above");
  });

  test("the aider history chain is lstat-checked from .codemux down (review D4, security 2)", () => {
    expect(COMPAT).toContain("every path component from `.codemux` down lstat-checked");
    expect(DESIGN).toContain("every component from `.codemux` down passes an lstat check");
    expect(CHANGELOG).toContain("lstat every path component from `.codemux` down");
    const session = code("src/session/aider-session.ts");
    expect(session).toContain("assertOwnedHistoryChain");
    // The refusal comes BEFORE mkdirSync resolves a planted link and
    // creates through it.
    expect(session.indexOf("assertOwnedHistoryChain(historyPath, true)")).toBeLessThan(
      session.indexOf("mkdirSync(sessionDir")
    );
  });

  test("the aider header drops splitlines' trailing empty element (review D4, correctness)", () => {
    expect(COMPAT).toContain("trailing empty element dropped");
    expect(DESIGN).toContain("down to the trailing empty element a final line break leaves");
    expect(CHANGELOG).toContain("drops the trailing empty element Python's `splitlines` drops");
    const history = code("src/aider-history.ts");
    expect(history).toContain("Python str.splitlines drops the one trailing empty element");
  });
});

describe("live-session doc claims (review D5)", () => {
  const CHANGELOG = read("CHANGELOG.md");
  const COMPAT = read("docs/HARNESS-COMPATIBILITY.md");
  const REPORT = read("docs/live-sessions-d-report.md");
  const code = (path: string): string => readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");

  test("the codex session-home isolation claim states the naming boundary, never the access one (review D5, security)", () => {
    // The over-claim ("nothing a sandboxed session plants there reaches a
    // later session") is refused everywhere it appeared; the delivered
    // boundary — a naming rule plus the atomic per-launch config rewrite
    // over a child-writable shared parent — is pinned instead. Pins on
    // code files stay within one comment line: the collapse keeps the
    // leading `*` of wrapped block-comment lines.
    const provider = code("src/codex-provider.ts");
    const cli = code("src/session/cli.ts");
    for (const text of [provider, cli, REPORT]) {
      expect(text).not.toContain("so nothing a sandboxed session");
    }
    expect(provider).toContain("keyed per session id — a naming rule, not an");
    expect(provider).toContain("not an access boundary (review D5, security)");
    expect(provider).toContain("rewrites its home's config.toml atomically before anything spawns");
    expect(cli).toContain("the shared parent stays child-writable");
    expect(REPORT).toContain("a naming rule, not an access boundary");
    expect(REPORT).toContain("the same trust the operator's real `~/.codex` always carried");
    expect(DESIGN).toContain("The key is a naming rule, not");
    expect(CHANGELOG).toContain("not an access boundary");
  });

  test("a deletion needs a positive free answer — an unreadable registry spares the home (review D5, correctness 1)", () => {
    expect(CHANGELOG).toContain("treat an unreadable registry as `unknown`");
    expect(DESIGN).toContain("a deletion needs a POSITIVE `free` answer");
    expect(README).toContain("a deletion needs a positive free answer");
    expect(COMPAT).toContain("never an unreadable registry's");
    const sweep = code("src/hermetic-home.ts");
    expect(sweep).toContain("Removal needs a POSITIVE `free` answer");
    const aider = code("src/session/aider-session.ts");
    expect(aider).toContain("only a positive `free` answer may remove");
    const registry = code("src/session/registry.ts");
    expect(registry).toContain('export type SessionHold = "held" | "free" | "unknown"');
  });

  test("a turn child landing after the session ended is settled before done resolves (review D5, correctness 2)", () => {
    for (const path of ["src/session/opencode-driver.ts", "src/session/aider-driver.ts"]) {
      const driver = code(path);
      expect(driver).toContain("stopped and its tree settled BEFORE");
      expect(driver).toContain("review D5, correctness 2");
    }
    expect(CHANGELOG).toContain("stopped and settled before the session's exit");
  });

  test("the codex override resume writes its config only after the claim (review D5, correctness 3)", () => {
    const provider = code("src/codex-provider.ts");
    const cli = code("src/session/cli.ts");
    expect(provider).toContain("the resume claim and before anything spawns");
    expect(provider).not.toContain("writeCodexProviderConfigInto(codexHome, override, model, multiAgent);\n  let settled");
    expect(cli).toContain("codexSessionHome?.prepareConfig()");
    expect(cli).toContain("never rewrote the live session's config");
    expect(CHANGELOG).toContain("after the resume claim");
  });
});

describe("live-session doc claims (review D7)", () => {
  const CHANGELOG = read("CHANGELOG.md");
  const COMPAT = read("docs/HARNESS-COMPATIBILITY.md");
  const code = (path: string): string => readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");

  test("the aider history file is re-checked before every turn, and a trip fails the turn (review D7, security)", () => {
    for (const text of [DESIGN, COMPAT]) {
      expect(text).toContain("before EVERY turn");
      expect(text).toContain("fails the turn");
    }
    expect(README).toContain("re-checked before every turn");
    const session = code("src/session/aider-session.ts");
    expect(session).toContain("assertAiderHistoryForTurn");
    // The check runs in the driver, before anything spawns.
    const driver = code("src/session/aider-driver.ts");
    expect(driver).toContain("assertAiderHistoryForTurn(this.options.historyPath)");
    expect(
      driver.indexOf("assertAiderHistoryForTurn(this.options.historyPath)")
    ).toBeLessThan(driver.indexOf("this.options.spawnTurn(argv)"));
  });

  test("a codex session home settles onto its key before the record is released (review D7, correctness-2 1)", () => {
    expect(DESIGN).toContain("runs BEFORE the end path releases the registry record");
    expect(COMPAT).toContain("BEFORE the registry record is released");
    expect(README).toContain("before the registry record is released");
    const driver = code("src/session/codex-driver.ts");
    expect(
      driver.indexOf("this.options.settleSessionHome(this.threadId, resumable)")
    ).toBeLessThan(
      driver.indexOf("releaseSessionRecord(this.options.registryPath, this.threadId)")
    );
  });

  test("the sweep's walk is bounded and an over-budget tree is spared (review D7, correctness-2 2)", () => {
    for (const text of [DESIGN, COMPAT]) {
      expect(text).toContain("the walk carries an entry cap");
      expect(text).toContain("spared rather than walked");
    }
    expect(CHANGELOG).toContain("entry-capped");
    const hermetic = code("src/hermetic-home.ts");
    expect(hermetic).toContain("MTIME_WALK_ENTRY_CAP");
    // The pid gate reads the NAME, so a live run is never walked (the pin
    // stays within one comment line — the collapse keeps wrapped lines'
    // leading `*`).
    expect(hermetic).toContain("comes from its NAME (no walk for a live run)");
  });

  test("the CHANGELOG warns a 0.9.0 binary about the new registry field (review D7, correctness-2 3)", () => {
    expect(CHANGELOG).toContain("Upgrade notes");
    expect(CHANGELOG).toContain("reads the whole file as corrupt");
  });
});

describe("live-session doc claims (review D8)", () => {
  const README = read("README.md");
  const CHANGELOG = read("CHANGELOG.md");
  const DESIGN = read("docs/LIVE-SESSIONS-DESIGN.md");
  const COMPAT = read("docs/HARNESS-COMPATIBILITY.md");
  const code = (path: string): string => readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");

  test("the aider-history header names the session path as the extraction's live reader (review D8, contracts)", () => {
    // The header stated two facts this branch falsifies: the session
    // driver reads and extracts the history every turn, and every
    // session owns a persistent history file kept as the resume state.
    const module = readFileSync(join(ROOT, "src/aider-history.ts"), "utf8");
    const header = module.slice(0, module.indexOf("*/"));
    expect(header).not.toContain("nothing reads the extraction today");
    expect(header).not.toContain("Only hermetic runs create the file");
    expect(header).toContain("session driver reads the history every turn");
    expect(header).toContain("never removed at exit");
  });

  test("the session history read is bounded per turn, never per file (review D8, correctness 2)", () => {
    expect(README).toContain("bounded per turn, never per file");
    for (const text of [DESIGN, COMPAT]) {
      expect(text).toContain("bounded per TURN, not per file");
      expect(text).toContain("no size limit from codemux's side");
    }
    expect(README).toContain("grows without limit");
    const history = code("src/aider-history.ts");
    // Single-line pin: the collapse keeps wrapped comment lines' `//`.
    expect(history).toContain("ONE turn's delta");
    expect(history).toContain("the accumulated session history has no size limit");
    const driver = code("src/session/aider-driver.ts");
    expect(driver).toContain(
      "readAiderHistoryDelta(this.options.historyPath, this.consumedBytes)"
    );
    // The whole-file run read must not be the session's read.
    expect(driver).not.toContain("readAiderHistory(this.options.historyPath)");
    expect(CHANGELOG).toContain("bounded per TURN, never per file");
  });

  test("CODEX_HOME is validated for codex sessions only (review D8, correctness 2 minor)", () => {
    const cli = code("src/session/cli.ts");
    expect(cli).toContain("CODEX_HOME reaches only a codex session's child");
    // The eager unconditional call is the bug's shape.
    expect(cli).not.toContain(
      "const realCodexHome = codexHarnessHome(passthroughEnv);"
    );
  });

  test("CLAUDE_CONFIG_DIR is validated for claude-family sessions only (review D8, correctness 2 audit)", () => {
    // The CODEX_HOME finding's mirror, found in the same-class audit:
    // the claude-family config-dir check also ran eagerly for every
    // agent. Single-line pin: the collapse keeps the leading `*` of
    // wrapped block-comment lines.
    const cli = code("src/session/cli.ts");
    expect(cli).toContain(
      "CLAUDE_CONFIG_DIR reaches only a claude-family session's child"
    );
  });
});

describe("live-session doc claims (review D9)", () => {
  const CHANGELOG = read("CHANGELOG.md");
  const DESIGN = read("docs/LIVE-SESSIONS-DESIGN.md");
  const COMPAT = read("docs/HARNESS-COMPATIBILITY.md");
  const REPORT = read("docs/live-sessions-d-report.md");
  const code = (path: string): string => readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");

  test("an over-budget run directory past its pid gate is reclaimed by age, never spared (review D9, correctness-2)", () => {
    // The finding: the capped walk's null spared a DEAD run's directory
    // forever, so a crashed run whose HOME held more than the cap leaked
    // and was re-walked to the cap on every later run. The run branch
    // now falls back to the directory's own mtime; a session home keeps
    // the spare (a removal needs a positive reading).
    for (const text of [DESIGN, COMPAT]) {
      expect(text).toContain("except a run directory past its pid gate");
      expect(text).toContain("reclaimed by age instead of leaking");
    }
    expect(CHANGELOG).toContain("aged by the directory's own mtime");
    expect(CHANGELOG).toContain("(D9 round)");
    const hermetic = code("src/hermetic-home.ts");
    // The old blanket claims — every caller spares a null — are refused.
    expect(hermetic).not.toContain("the caller spares the entry, the safe direction for a removal");
    expect(hermetic).not.toContain("either way the caller leaves the entry alone");
    expect(hermetic).toContain("newestMtimeMs(path) ?? directoryMtimeMs(path)");
    expect(hermetic).toContain("a removal needs a positive reading, never an exhausted probe");
  });

  test("the report header states the version the tree carries (review D9, contracts)", () => {
    // The header claimed the version was unchanged at 0.9.0 with the
    // CHANGELOG entry under [Unreleased] while the tree shipped 0.10.0 —
    // accurate when written, false once release prep landed a day
    // later. The header now names the tree's version and the CHANGELOG
    // section holding the entry, both pinned against the files
    // themselves so the claim cannot drift again.
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    expect(REPORT).not.toContain("the version is unchanged");
    expect(REPORT).toContain(`carries version ${pkg.version}`);
    expect(REPORT).toContain(`the CHANGELOG entry sits under \`[${pkg.version}]\``);
  });
});

describe("live-session doc claims (review D10)", () => {
  const README = read("README.md");
  const CHANGELOG = read("CHANGELOG.md");
  const DESIGN = read("docs/LIVE-SESSIONS-DESIGN.md");
  const COMPAT = read("docs/HARNESS-COMPATIBILITY.md");
  const code = (path: string): string => readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");

  test("a prompt aider would dispatch as its own command is refused on both paths (review D10, security)", () => {
    expect(README).toContain("on the run path (exit 64) and the session path");
    for (const text of [DESIGN, COMPAT]) {
      expect(text).toContain("before any model turn");
      expect(text).toContain("ungated by `--dry-run`");
    }
    expect(CHANGELOG).toContain("(D10 round)");
    const adapter = code("src/adapters/aider.ts");
    expect(adapter).toContain("aiderPromptIsCommand");
    // The refusal class is usage, so a script can tell a caller fix from
    // a run failure.
    expect(adapter).toContain("UsageRefusalError");
    const runtime = code("src/cli-runtime.ts");
    expect(runtime).toContain("error instanceof UsageRefusalError ? 64 : 1");
    // The session path refuses before the ack, judging the harness text
    // (the argv text is what aider dispatches; an author prefix sits
    // ahead of it and neutralizes the dispatch).
    const driver = code("src/session/aider-driver.ts");
    expect(driver).toContain("refused `unsupported` before the ack");
    expect(driver).toContain("Judged on harnessText");
  });

  test("the provider identity records the base URL without its query (review D10, security)", () => {
    expect(DESIGN).toContain("IDENTITY form — query and fragment stripped");
    expect(COMPAT).toContain("identity form (query and fragment stripped");
    const override = code("src/provider-override.ts");
    expect(override).toContain("providerIdentityBaseUrl");
    // One seam feeds the record, the resume probe, and the refusal
    // surface; the hash input is the same form so key rotation cannot
    // move a session's home. (Single-line pins: the collapse keeps
    // wrapped comment lines' leading `//` and `*`.)
    const cli = code("src/session/cli.ts");
    expect(cli).toContain("IDENTITY form (query and fragment stripped");
    const provider = code("src/codex-provider.ts");
    expect(provider).toContain("The hash input is the base URL's IDENTITY form");
  });

  test("an aider turn killed partway leaves the session not resumable (review D10, correctness-2 1)", () => {
    expect(README).toContain("that session's end is not resumable");
    for (const text of [DESIGN, COMPAT]) {
      expect(text).toContain("not resumable");
      expect(text).toContain("would replay the unanswered prompt");
    }
    const driver = code("src/session/aider-driver.ts");
    expect(driver).toContain(
      "unanswered prompt that `--restore-chat-history` would replay"
    );
  });

  test("the sweep consults the registry before the walk and splits the over-cap verdict (review D10, correctness-2 2)", () => {
    for (const text of [DESIGN, COMPAT]) {
      expect(text).toContain("POSITIVELY freed");
    }
    expect(CHANGELOG).toContain("consults the registry BEFORE walking");
    const hermetic = code("src/hermetic-home.ts");
    expect(hermetic).toContain("The registry runs BEFORE the walk");
  });

  test("a resume's own open spares the home it came for (review D10, correctness-2 3)", () => {
    expect(DESIGN).toContain("spares the keyed entry from this sweep entirely");
    expect(COMPAT).toContain("spares its keyed entry from that sweep");
    const hermetic = code("src/hermetic-home.ts");
    expect(hermetic).toContain("spareEntry");
    const provider = code("src/codex-provider.ts");
    expect(provider).toContain(
      "spared: the sweep's registry consult answers `free` for an ended"
    );
  });
});

describe("live-session doc claims (review D11)", () => {
  const README = read("README.md");
  const CHANGELOG = read("CHANGELOG.md");
  const DESIGN = read("docs/LIVE-SESSIONS-DESIGN.md");
  const COMPAT = read("docs/HARNESS-COMPATIBILITY.md");
  const code = (path: string): string => readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");

  test("a graceful end runs a turn whose spawn is still in flight, on both turn-per-process harnesses (review D11, correctness-2 1)", () => {
    // The finding: a one-prompt-then-EOF session killed its turn before
    // the turn ran — the EOF reached the end path while the scode gate
    // still held the spawn, and the late child was stopped on arrival.
    // The rule is now the landed path's: deliver the payload, drain the
    // turn, and only a signal, timeout, or crash end kills on arrival.
    for (const text of [README, DESIGN, COMPAT]) {
      expect(text).toContain("stops a late child on arrival");
    }
    expect(CHANGELOG).toContain("(D11 round)");
    expect(CHANGELOG).toContain("drains the turn with its grace period");
    const opencode = code("src/session/opencode-driver.ts");
    // Single-line pins: the collapse keeps wrapped comment lines' leading
    // `*` and `//`.
    expect(opencode).toContain("stdin payload the child has not");
    const aider = code("src/session/aider-driver.ts");
    expect(aider).toContain("its late-landing child is");
    // Both drivers keep the hard-end kill arm the D5 rule pinned.
    for (const driver of [opencode, aider]) {
      expect(driver).toContain("a signal, timeout, or crash end");
    }
  });

  test("an undeletable stale entry never blocks the sweep (review D11, correctness-2 2)", () => {
    expect(CHANGELOG).toContain("warns and moves on, the other sweeps' rule");
    const hermetic = code("src/hermetic-home.ts");
    expect(hermetic).toContain(
      "One bad entry must not block the run, or every later run"
    );
    // Both sweep branches route their removals through the guarded
    // helper, each naming what it could not remove.
    expect(hermetic).toContain('removeSweepEntry(path, "stale run directory")');
    expect(hermetic).toContain('removeSweepEntry(path, "stale session home")');
  });
});

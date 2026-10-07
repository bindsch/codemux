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
    expect(README).toContain("Overrides reach sessions in the next release.");
    expect(README).toContain("requires `--sandbox` and `--auto low`");
    expect(code("src/provider-override.ts")).not.toContain("the planned `codemux session` resume path");
  });
});

/**
 * The live gate's Keychain hygiene (scripts/live-gate/keychain.ts) and its
 * print-sandbox verifier (print-probe.ts), 2026-11-03: a probe that leaves the
 * user search list or default keychain changed fails whatever the harness
 * answered, and probe P accepts only an argv that names scode and the harness.
 * The `security` here is a fake on a private PATH.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keychainBaselineRefusal, keychainCheckApplies, keychainDrift, keychainSnapshot } from "../scripts/live-gate/keychain.js";
import { printedCommand, resolvedBinaryPaths, verifyPrintedSandbox } from "../scripts/live-gate/print-probe.js";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fakeSecurity = (body: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "codemux-gate-keychain-"));
  scratch.push(dir);
  writeFileSync(join(dir, "security"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, "security"), 0o700);
  return dir;
};

const darwinOnly = process.platform === "darwin" ? test : test.skip;

describe("keychain snapshots", () => {
  darwinOnly("a snapshot carries the search list and the default; a changed list is a drift", async () => {
    const stable = fakeSecurity(`case "$1" in list-keychains) printf '    "/u/login.keychain-db"\\n';; default-keychain) printf '    "/u/login.keychain-db"\\n';; esac`);
    const before = await keychainSnapshot({ PATH: stable });
    expect(before?.ok).toBe(true);
    const text = before !== null && before.ok ? before.text : "";
    expect(text).toContain('list-keychains: "/u/login.keychain-db"');
    expect(text).toContain("default-keychain:");
    expect(keychainDrift(before, await keychainSnapshot({ PATH: stable }))).toBeNull();
    const changed = fakeSecurity(`case "$1" in list-keychains) printf '    "/u/mirror.keychain-db"\\n    "/u/login.keychain-db"\\n';; default-keychain) printf '    "/u/login.keychain-db"\\n';; esac`);
    const drift = keychainDrift(before, await keychainSnapshot({ PATH: changed }));
    expect(drift).toContain("changed during this probe");
    expect(drift).toContain("/u/mirror.keychain-db");
  });

  darwinOnly("a failing security answer is an unobservable state, and two of them never match (review round 43)", async () => {
    const failing = fakeSecurity("exit 36");
    const snapshot = await keychainSnapshot({ PATH: failing });
    expect(snapshot).toEqual({ ok: false, reason: "security list-keychains exited 36" });
    expect(keychainDrift(snapshot, await keychainSnapshot({ PATH: failing }))).toContain("could not be observed before the probe");
    const stable = fakeSecurity(`printf '    "/u/login.keychain-db"\n'`);
    expect(keychainDrift(await keychainSnapshot({ PATH: stable }), snapshot)).toContain("could not be observed after the probe");
  });

  test("no security on PATH, or another platform, yields no snapshot; both missing is not a drift", async () => {
    const empty = mkdtempSync(join(tmpdir(), "codemux-gate-empty-"));
    scratch.push(empty);
    expect(await keychainSnapshot({ PATH: empty })).toBeNull();
    // The one shape that says the check does not apply rather than went
    // missing: both observations absent on the same machine.
    expect(keychainDrift(null, null)).toBeNull();
    expect(keychainDrift({ ok: true, text: "a" }, { ok: true, text: "a" })).toBeNull();
    expect(keychainDrift({ ok: true, text: "a" }, { ok: true, text: "b" })).toContain("before:\na\nafter:\nb");
  });

  test("a snapshot that goes missing between the two observations is a failure naming its side (review round 87)", () => {
    // A pre-probe snapshot that succeeded and no after snapshot: the gate
    // must not certify a pool it could not observe — the security tool
    // vanishing from PATH between the two calls is the live shape.
    expect(keychainDrift({ ok: true, text: "a" }, null)).toContain("the snapshot after the pool is missing");
    expect(keychainDrift(null, { ok: true, text: "anything" })).toContain("the snapshot before the pool is missing");
    // A failed observation does not hide a missing one.
    expect(keychainDrift({ ok: false, reason: "x" }, null)).toContain("the snapshot after the pool is missing");
    // The platform rule the caller stops on: macOS carries the check,
    // everything else does not.
    expect(keychainCheckApplies("darwin")).toBe(true);
    expect(keychainCheckApplies("linux")).toBe(false);
    expect(keychainCheckApplies("win32")).toBe(false);
  });

  test("a missing or failed baseline stops the gate before the pool (review round 88)", () => {
    // A usable baseline lets the pool run.
    expect(keychainBaselineRefusal({ ok: true, text: "a" }, true)).toBeNull();
    // No security tool: a refusal where the check applies, nothing where it does not.
    expect(keychainBaselineRefusal(null, true)).toContain("could not be taken");
    expect(keychainBaselineRefusal(null, false)).toBeNull();
    // The tool is present but timed out, exited nonzero, or is untrusted:
    // the pool must not run on a baseline that was attempted and failed.
    expect(keychainBaselineRefusal({ ok: false, reason: "security list-keychains exited 1" }, true))
      .toBe("the snapshot before the pool failed (security list-keychains exited 1)");
  });
});

describe("the print-sandbox verifier", () => {
  test("accepts an argv that names scode and the harness binary, one per line", () => {
    expect(verifyPrintedSandbox("/opt/homebrew/bin/scode\n--ro\n--\n/usr/local/bin/claude\n-p\nOK\n", "claude")).toBeNull();
    expect(verifyPrintedSandbox("scode\n--\nagy\n", "agy")).toBeNull();
    // A candidate that resolves a renamed binary is judged on its own name (review round 52).
    expect(verifyPrintedSandbox("scode\n--\n/opt/x/fake-agy\n", "agy", "fake-agy")).toBeNull();
    expect(verifyPrintedSandbox("scode\n--\n/opt/x/agy\n", "agy", "fake-agy")).toContain("does not name the agy binary (fake-agy)");
  });
  test("rejects an empty print, a missing scode, and a missing harness", () => {
    expect(verifyPrintedSandbox("", "claude")).toBe("nothing was printed");
    expect(verifyPrintedSandbox("/usr/local/bin/claude\n-p\n", "claude")).toContain("does not name scode");
    expect(verifyPrintedSandbox("/opt/homebrew/bin/scode\n--\n/usr/bin/true\n", "claude")).toContain("does not name the claude binary");
    // Live gate, 2026-11-06: the launch prints the file the entry name
    // resolves to, and the Claude Code package installs `claude` as a link
    // to bin/claude.exe. The resolved file names the harness; any other
    // file still does not.
    const linked = (binary: string): string[] =>
      binary === "claude" ? ["/opt/tools/bin/claude", "/opt/tools/lib/claude-code/bin/claude.exe"] : [];
    const printed = "/opt/homebrew/bin/scode\n--ro\n--\n/opt/tools/lib/claude-code/bin/claude.exe\n-p\n";
    expect(verifyPrintedSandbox(printed, "claude", undefined, linked)).toBeNull();
    expect(verifyPrintedSandbox(printed, "zai", "claude", linked)).toBeNull();
    expect(verifyPrintedSandbox("/opt/homebrew/bin/scode\n--\n/opt/tools/lib/other/bin/claude.exe\n", "claude", undefined, linked))
      .toContain("does not name the claude binary (claude)");
    expect(verifyPrintedSandbox(printed, "claude", undefined, () => [])).toContain("does not name the claude binary (claude)");
    // The harness must be the command the sandbox starts, not a word that
    // appears somewhere (review round 183): its path as a scode argument,
    // or as an argument of another command, names nothing.
    expect(verifyPrintedSandbox("scode\n--config\n/opt/tools/lib/claude-code/bin/claude.exe\n--\n/usr/bin/true\n", "claude", undefined, linked))
      .toContain("does not name the claude binary (claude)");
    expect(verifyPrintedSandbox("scode\n--\n/usr/bin/true\n/usr/local/bin/claude\n", "claude")).toContain("does not name the claude binary");
    expect(verifyPrintedSandbox("scode\n/usr/local/bin/claude\n-p\n", "claude")).toContain("does not name the claude binary");
    // scode must be the program the argv starts (review round 192): the
    // word later in the prefix, or past the separator, names nothing.
    expect(verifyPrintedSandbox("/usr/bin/true\n--\nclaude\nscode\n", "claude")).toBe("the printed argv does not name scode");
    expect(verifyPrintedSandbox("/usr/bin/true\nscode\n--\nclaude\n", "claude")).toBe("the printed argv does not name scode");
    // An env wrapper's options and assignments are skipped: agy and the
    // private-home launches start through `env NAME=value ...`.
    expect(verifyPrintedSandbox("scode\n--\n/usr/bin/env\nHOME=/tmp/home\nXDG_CONFIG_HOME=/tmp/home/.config\n/opt/x/agy\n--print\n", "agy")).toBeNull();
    expect(verifyPrintedSandbox("scode\n--\nenv\n-u\nKIMI_UPDATE\n-u\nOTHER\nkimi\n", "kimi")).toBeNull();
    expect(verifyPrintedSandbox("scode\n--\nenv\nHOME=/tmp/home\n/usr/bin/true\nagy\n", "agy")).toContain("does not name the agy binary");
    // The wrapper is read by the launch path's own parse (review round
    // 188): both unset spellings count, and a prefix the launch refuses —
    // an option after an assignment, no program at all — names no command.
    expect(verifyPrintedSandbox("scode\n--\nenv\n--unset\nKIMI_UPDATE\nkimi\n", "kimi")).toBeNull();
    expect(verifyPrintedSandbox("scode\n--\nenv\nA=1\n-u\nB\nkimi\n", "kimi")).toContain("does not name the kimi binary");
    expect(printedCommand(["scode", "--", "env", "A=1"])).toBeNull();
    expect(printedCommand(["scode", "--"])).toBeNull();
    expect(printedCommand(["scode", "agy"])).toBeNull();
  });
});

test("resolvedBinaryPaths answers the PATH match and the file it links to", () => {
  const dir = mkdtempSync(join(tmpdir(), "codemux-gate-print-"));
  scratch.push(dir);
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "lib"));
  writeFileSync(join(dir, "lib", "harness.exe"), "#!/bin/sh\n", { mode: 0o700 });
  symlinkSync(join(dir, "lib", "harness.exe"), join(dir, "bin", "harness"));
  expect(resolvedBinaryPaths("harness", join(dir, "bin")))
    .toEqual([join(dir, "bin", "harness"), realpathSync(join(dir, "lib", "harness.exe"))]);
  expect(resolvedBinaryPaths("absent-harness", join(dir, "bin"))).toEqual([]);
});

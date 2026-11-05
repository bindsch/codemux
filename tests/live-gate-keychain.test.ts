/**
 * The live gate's Keychain hygiene (scripts/live-gate/keychain.ts) and its
 * print-sandbox verifier (print-probe.ts), 2026-11-03: a probe that leaves the
 * user search list or default keychain changed fails whatever the harness
 * answered, and probe P accepts only an argv that names scode and the harness.
 * The `security` here is a fake on a private PATH.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keychainBaselineRefusal, keychainCheckApplies, keychainDrift, keychainSnapshot } from "../scripts/live-gate/keychain.js";
import { verifyPrintedSandbox } from "../scripts/live-gate/print-probe.js";

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
  });
});

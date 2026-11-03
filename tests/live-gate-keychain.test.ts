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
import { keychainDrift, keychainSnapshot } from "../scripts/live-gate/keychain.js";
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

  test("no security on PATH, or another platform, yields no snapshot and never a drift", async () => {
    const empty = mkdtempSync(join(tmpdir(), "codemux-gate-empty-"));
    scratch.push(empty);
    expect(await keychainSnapshot({ PATH: empty })).toBeNull();
    expect(keychainDrift(null, { ok: true, text: "anything" })).toBeNull();
    expect(keychainDrift({ ok: true, text: "a" }, null)).toBeNull();
    expect(keychainDrift({ ok: true, text: "a" }, { ok: true, text: "a" })).toBeNull();
    expect(keychainDrift({ ok: true, text: "a" }, { ok: true, text: "b" })).toContain("before:\na\nafter:\nb");
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

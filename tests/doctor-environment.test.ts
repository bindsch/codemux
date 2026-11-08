/**
 * The machine check's environment rows as pure functions over fixture facts
 * (audit round 2, report D; coverage gate): scode facts and the sandboxed
 * namespace probe against fake binaries, the Keychain read against a fake
 * `security`, and every row shape the report prints. Nothing here touches
 * the host's scode, Keychain, or usagemux.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig } from "../src/config.js";
import {
  aliasRow,
  keychainRowFrom,
  probeScodeNamespace,
  quotaDetail,
  readKeychainStatus,
  readScodeFacts,
  scodeEnvironmentRow,
  usagemuxRowFrom,
  type ScodeFacts, scodeBelowFloor } from "../src/doctor-environment.js";
import { isNamespaceCapabilityFailure } from "../src/scode-namespace.js";
import * as processRunner from "../src/process-runner.js";
import { USAGEMUX_MINIMUM_VERSION } from "../src/usage.js";

const scratch: string[] = [];
const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A directory of fake binaries, each a shell script, placed first on PATH. */
const fakeBin = (binaries: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "codemux-doctor-env-"));
  scratch.push(dir);
  for (const [name, body] of Object.entries(binaries)) {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o700);
  }
  process.env.PATH = `${dir}:/usr/bin:/bin`;
  return dir;
};

const facts = (overrides: Partial<ScodeFacts>): ScodeFacts => ({
  present: true,
  path: null,
  version: [0, 6, 0],
  label: "0.6.0",
  issue: null,
  ...overrides,
});

describe("scode facts", () => {
  test("absent, untrusted (inside the working directory), unreadable, and readable", async () => {
    process.env.PATH = mkdtempSync(join(tmpdir(), "codemux-doctor-empty-"));
    scratch.push(process.env.PATH);
    expect((await readScodeFacts()).label).toBe("absent");
    const dir = fakeBin({ scode: `printf 'scode 0.6.2\\n'` });
    // The trust rule refuses a binary that lives inside the working directory.
    const untrusted = await readScodeFacts(dir);
    expect(untrusted.present).toBe(false);
    expect(untrusted.label).toBe("untrusted");
    expect(untrusted.issue).toContain("not a trusted executable");
    // The working directory must not contain the binary: the repository root does not.
    const readable = await readScodeFacts(process.cwd());
    expect(readable.version).toEqual([0, 6, 2]);
    expect(readable.label).toBe("0.6.2");
    fakeBin({ scode: `printf 'no version here\\n'` });
    const unreadable = await readScodeFacts(process.cwd());
    expect(unreadable.label).toBe("unreadable");
    expect(unreadable.issue).toContain("could not parse scode version");
    fakeBin({ scode: `printf 'scode 0.6.2\\n'; exit 3` });
    const failing = await readScodeFacts(process.cwd());
    expect(failing.label).toBe("unreadable");
    expect(failing.issue).toBe("scode --version exited 3");
  });

  test("the namespace probe passes, skips on a namespace refusal, and fails otherwise", async () => {
    fakeBin({ scode: "exit 0" });
    expect(await probeScodeNamespace()).toBe("pass");
    fakeBin({ scode: `printf 'bwrap: setting up uid map: Permission denied\\n' >&2; exit 1` });
    expect(await probeScodeNamespace()).toBe("skipped");
    fakeBin({ scode: "exit 3" });
    expect(await probeScodeNamespace()).toBe("failed");
    process.env.PATH = mkdtempSync(join(tmpdir(), "codemux-doctor-empty-"));
    scratch.push(process.env.PATH);
    expect(await probeScodeNamespace()).toBe("failed");
  });

  test("the namespace probe runs the trusted scode it is given, not a later PATH resolution (review round 57)", async () => {
    const trusted = fakeBin({ scode: "exit 0" });
    const goodPath = join(trusted, "scode");
    // A different scode planted first on PATH would fail the probe...
    fakeBin({ scode: "exit 3" });
    expect(await probeScodeNamespace(process.cwd())).toBe("failed");
    // ...but the facts' trusted path is what runs.
    expect(await probeScodeNamespace(process.cwd(), goodPath)).toBe("pass");
  });

  test("the namespace probe drops ambient SCODE_* variables from the spawn environment (review round 162)", async () => {
    // A fake scode that records which SCODE_* names reach it and fails
    // when it sees an accounting name: the probe's spawn environment is
    // what the fake reads, so the assertion runs on the real spawn, not a
    // spy's idea of it. Names only, never values, and only the names the
    // test is about (review round 165): the ambient environment holds
    // credentials no test should write to disk. The recorder path rides
    // a non-SCODE_* ambient variable, which must still pass through.
    const dir = mkdtempSync(join(tmpdir(), "codemux-doctor-env-"));
    scratch.push(dir);
    const record = join(dir, "names");
    fakeBin({
      scode: `env | grep '^SCODE_\\|^PROBE_ENV_RECORD=' | cut -d= -f1 | sort > "\${PROBE_ENV_RECORD}"\n` +
        `if [ -n "\${SCODE_ACCOUNT_FILE}" ] || [ -n "\${SCODE_ACCOUNT_ID}" ]; then exit 3; fi\n` +
        "exit 0",
    });
    process.env.PROBE_ENV_RECORD = record;
    process.env.SCODE_ACCOUNT_FILE = "/ambient/account-file";
    process.env.SCODE_ACCOUNT_ID = "ambient-account-id";
    process.env.SCODE_ANY_OTHER_NAME = "ambient";
    try {
      // The verdicts stay intact: the scrub changed the environment, not
      // the probe's judgment.
      expect(await probeScodeNamespace()).toBe("pass");
      expect(readFileSync(record, "utf8")).toBe("PROBE_ENV_RECORD\n");
    } finally {
      delete process.env.PROBE_ENV_RECORD;
      delete process.env.SCODE_ACCOUNT_FILE;
      delete process.env.SCODE_ACCOUNT_ID;
      delete process.env.SCODE_ANY_OTHER_NAME;
    }
  });

  test("the namespace vocabulary matches bubblewrap's messages, line by line", () => {
    expect(isNamespaceCapabilityFailure("bwrap: No permissions to creating new namespace\n")).toBe(true);
    expect(isNamespaceCapabilityFailure("other\nbwrap: setting up gid map: EPERM")).toBe(true);
    expect(isNamespaceCapabilityFailure("  bwrap: setting up uid map:")).toBe(false);
    expect(isNamespaceCapabilityFailure("scode: command not found")).toBe(false);
  });
});

describe("the scode environment row", () => {
  test("missing and untrusted are broken with their remedies", async () => {
    const missing = await scodeEnvironmentRow(facts({ present: false, version: null, label: "absent", issue: "scode is not installed" }));
    expect(missing.state).toBe("SANDBOX-MISSING");
    expect(missing.severity).toBe("broken");
    const untrusted = await scodeEnvironmentRow(facts({ present: false, version: null, label: "untrusted", issue: "scode is not a trusted executable: x" }));
    expect(untrusted.state).toBe("UNTRUSTED");
  });

  test("an unreadable version and a version below the global minimum are broken", async () => {
    const unreadable = await scodeEnvironmentRow(facts({ version: null, label: "unreadable", issue: "could not parse" }));
    expect(unreadable.state).toBe("unreadable");
    expect(unreadable.remedy).toContain("reinstall scode");
    const old = await scodeEnvironmentRow(facts({ version: [0, 1, 0], label: "0.1.0" }));
    expect(old.state).toBe("SANDBOX-TOO-OLD");
    expect(old.detail).toContain("below the global minimum");
  });

  test("a prerelease of a floor is below the floor, as on the launch gate (review 344)", async () => {
    // The gate orders 0.6.0-rc1 below the 0.6.0 agy floor; doctor's rows
    // compared the numeric core and called the same scode healthy.
    const rc = facts({ version: [0, 6, 0], label: "0.6.0-rc1", semver: "0.6.0-rc1" });
    expect(scodeBelowFloor(rc, "0.6.0")).toBe(true);
    expect(scodeBelowFloor(rc, "0.5.0")).toBe(false);
    expect(scodeBelowFloor(facts({ version: [0, 6, 0], label: "0.6.0", semver: "0.6.0" }), "0.6.0")).toBe(false);
    // Facts without a token (built elsewhere) keep the numeric rule.
    expect(scodeBelowFloor(facts({ version: [0, 6, 0], label: "0.6.0" }), "0.6.0")).toBe(false);
    expect(scodeBelowFloor(facts({ version: [0, 5, 9], label: "0.5.9" }), "0.6.0")).toBe(true);
    // The global minimum row follows the same rule.
    const minimumRc = await scodeEnvironmentRow(facts({ version: [0, 2, 0], label: "0.2.0-rc1", semver: "0.2.0-rc1" }));
    expect(minimumRc.state).toBe("SANDBOX-TOO-OLD");
  });

  test("the namespace probe's three outcomes shape the row", async () => {
    fakeBin({ scode: "exit 0" });
    const pass = await scodeEnvironmentRow(facts({}));
    expect(pass.state).toBe("ok");
    expect(pass.detail).toContain("namespace probe passed");
    fakeBin({ scode: `printf 'bwrap: error writing to setgroups: EPERM\\n' >&2; exit 1` });
    const skipped = await scodeEnvironmentRow(facts({}));
    expect(skipped.severity).toBe("info");
    expect(skipped.detail).toContain("namespace probe skipped");
    fakeBin({ scode: "exit 2" });
    const failed = await scodeEnvironmentRow(facts({}));
    expect(failed.state).toBe("PROBE-FAILED");
    expect(failed.severity).toBe("broken");
  });

  test("--keep-env support is probed on the trusted path and its absence is a warning", async () => {
    const dir = fakeBin({ scode: `if [ "$1" = "--help" ]; then printf 'usage: scode [--keep-env NAME]\\n'; exit 0; fi; exit 0` });
    const supported = await scodeEnvironmentRow(facts({ path: join(dir, "scode") }));
    expect(supported.detail).toContain("--keep-env supported");
    const dir2 = fakeBin({ scode: `if [ "$1" = "--help" ]; then printf 'usage: scode\\n'; exit 0; fi; exit 0` });
    const unsupported = await scodeEnvironmentRow(facts({ path: join(dir2, "scode") }));
    expect(unsupported.severity).toBe("warn");
    expect(unsupported.detail).toContain("--keep-env unsupported");
  });
});

describe("the Keychain read", () => {
  const darwinOnly = process.platform === "darwin" ? test : test.skip;
  test("the test seam and other platforms never run security", async () => {
    const skipped = await readKeychainStatus({ CODEMUX_NO_KEYCHAIN_SYNC: "1", PATH: "" });
    expect(skipped.state).toBe(process.platform === "darwin" ? "skipped" : "not-macos");
  });
  darwinOnly("readable, no entry, locked over SSH, unreadable, and no security tool", async () => {
    fakeBin({ security: `if [ "$1" = "default-keychain" ]; then printf '"/nonexistent/keychain-db"\n'; fi; exit 0` });
    const missing = await readKeychainStatus({ PATH: process.env.PATH, USER: "account-under-test" });
    expect(missing.state).toBe("default-missing");
    expect(missing.detail).toContain("/nonexistent/keychain-db");
    // The fake needs dirname on its PATH; fakeBin put the directory first on process.env.PATH.
    const dir = fakeBin({ security: `printf '%s\n' "$*" >> "$(dirname "$0")/security.log"; if [ "$1" = "default-keychain" ]; then printf '"%s"\n' "$0"; fi; exit 0` });
    expect((await readKeychainStatus({ PATH: process.env.PATH, USER: "account-under-test" })).state).toBe("readable");
    // The same item the credential reader queries: service and account (review round 46).
    expect(readFileSync(join(dir, "security.log"), "utf8")).toContain("-s Claude Code-credentials -a account-under-test");
    fakeBin({ security: `if [ "$1" = "default-keychain" ]; then printf '"%s"\\n' "$0"; exit 0; fi; printf 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\\n' >&2; exit 44` });
    expect((await readKeychainStatus({ PATH: process.env.PATH })).state).toBe("no-entry");
    // No item AND a default that names a missing file: the default is the
    // finding, whatever the item lookup says (review round 53).
    fakeBin({ security: `if [ "$1" = "default-keychain" ]; then printf '"/nonexistent/keychain-db"\\n'; exit 0; fi; printf 'could not be found\\n' >&2; exit 44` });
    expect((await readKeychainStatus({ PATH: process.env.PATH })).state).toBe("default-missing");
    fakeBin({ security: `if [ "$1" = "default-keychain" ]; then printf '"%s"\\n' "$0"; exit 0; fi; printf 'User interaction is not allowed.\\n' >&2; exit 36` });
    expect((await readKeychainStatus({ PATH: process.env.PATH, SSH_CONNECTION: "1" })).state).toBe("locked-ssh");
    const unreadable = await readKeychainStatus({ PATH: process.env.PATH });
    expect(unreadable.state).toBe("unreadable");
    expect(unreadable.detail).toContain("security exited 36");
    const empty = mkdtempSync(join(tmpdir(), "codemux-doctor-empty-"));
    scratch.push(empty);
    expect((await readKeychainStatus({ PATH: empty })).detail).toContain("not on PATH");
    // A world-writable security fails the executable trust rule and never runs.
    const writable = fakeBin({ security: `printf 'ran\\n' > "$(dirname "$0")/security-ran"; exit 0` });
    chmodSync(join(writable, "security"), 0o777);
    const untrusted = await readKeychainStatus({ PATH: writable });
    expect(untrusted.state).toBe("unreadable");
    expect(untrusted.detail).toContain("not trusted");
    expect(existsSync(join(writable, "security-ran"))).toBe(false);
  });
  darwinOnly("a default-keychain query that fails, prints nothing, or times out is unreadable, whatever the item lookup says (review round 147)", async () => {
    // Nonzero exit: the fake's item lookup succeeds, but the store a launch
    // writes to was never determined, so the status fails closed — and the
    // command's own output stays out of the detail.
    fakeBin({ security: `if [ "$1" = "default-keychain" ]; then printf 'security: default-keychain exploded\\n' >&2; exit 9; fi; exit 0` });
    const failed = await readKeychainStatus({ PATH: process.env.PATH, USER: "account-under-test" });
    expect(failed.state).toBe("unreadable");
    expect(failed.detail).toBe("the user default keychain could not be determined");
    // An empty answer is not a store either: exit 0, no path printed.
    fakeBin({ security: `if [ "$1" = "default-keychain" ]; then exit 0; fi; exit 0` });
    const empty = await readKeychainStatus({ PATH: process.env.PATH, USER: "account-under-test" });
    expect(empty.state).toBe("unreadable");
    expect(empty.detail).toBe("the user default keychain could not be determined");
    // A query that never answers resolves as a failed result, not a throw:
    // same fail-closed row, still no command output in the detail.
    const timedOut = { success: false, exitCode: 124, stdout: "", stderr: "timed out", timedOut: true as const };
    const runner = spyOn(processRunner, "runCapturedCommand").mockResolvedValue(timedOut);
    try {
      const quiet = await readKeychainStatus({ PATH: process.env.PATH, USER: "account-under-test" });
      expect(quiet.state).toBe("unreadable");
      expect(quiet.detail).toBe("the user default keychain could not be determined");
      expect(runner).toHaveBeenCalledTimes(1);
    } finally {
      runner.mockRestore();
    }
  });
  test("every status maps to a row severity", () => {
    expect(keychainRowFrom({ state: "readable", detail: "d" }).severity).toBe("ok");
    expect(keychainRowFrom({ state: "not-macos", detail: "d" }).severity).toBe("info");
    expect(keychainRowFrom({ state: "skipped", detail: "d" }).severity).toBe("info");
    expect(keychainRowFrom({ state: "no-entry", detail: "d" }).state).toBe("no-entry");
    expect(keychainRowFrom({ state: "locked-ssh", detail: "d" }).severity).toBe("warn");
    expect(keychainRowFrom({ state: "unreadable", detail: "d" }).severity).toBe("warn");
    const missing = keychainRowFrom({ state: "default-missing", detail: "d" });
    expect(missing.severity).toBe("broken");
    expect(missing.remedy).toContain("security default-keychain -d user -s");
  });
});

describe("config, alias, and usagemux rows", () => {
  test("the alias row reports every alias that cannot resolve", () => {
    const config = getDefaultConfig();
    // An alias whose mapping names no model for its agent cannot resolve.
    config.models = { worker: { claude: "sonnet", codex: "" } };
    const row = aliasRow(config);
    expect(row.state).toBe("invalid");
    expect(row.severity).toBe("broken");
    expect(row.detail).toContain("worker->codex");
    expect(aliasRow({ ...getDefaultConfig(), models: {} }).detail).toBe("no model aliases configured");
  });

  test("the quota detail names the policy or its absence", () => {
    expect(quotaDetail({ ...getDefaultConfig(), quota: false })).toBe("quota gate disabled");
    expect(quotaDetail(getDefaultConfig())).toContain("ceiling");
    // A per-agent map is spelled out, never `[object Object]` (review round 50).
    const mapped = { ...getDefaultConfig(), quota: { ...(getDefaultConfig().quota as Exclude<ReturnType<typeof getDefaultConfig>["quota"], false>), timeoutSeconds: { default: 60, claude: 90 } } };
    expect(quotaDetail(mapped as never)).toContain("timeout default 60 s, claude 90 s");
  });

  test("the usagemux row: missing, unreadable, stale, and current", () => {
    const missing = usagemuxRowFrom({ version: null, issue: "usagemux is not installed", belowMinimum: false } as never);
    expect(missing.state).toBe("USAGEMUX-MISSING");
    expect(missing.detail).toContain("optional");
    expect(missing.remedy).toContain("brew install bindsch/tap/usagemux");
    // An installed usagemux whose version cannot be read is its own state
    // (review round 361): MISSING keeps meaning "not on PATH", and the
    // remedy says reinstall, not install — the binary exists.
    const unreadable = usagemuxRowFrom({ version: null, issue: "usagemux --version exited 3", belowMinimum: false } as never);
    expect(unreadable.state).toBe("USAGEMUX-UNREADABLE");
    expect(unreadable.severity).toBe("warn");
    expect(unreadable.detail).toBe("usagemux --version exited 3");
    expect(unreadable.remedy).toContain("brew reinstall bindsch/tap/usagemux");
    expect(usagemuxRowFrom({ version: null, issue: "usagemux --version printed no version", belowMinimum: false } as never).state).toBe("USAGEMUX-UNREADABLE");
    expect(usagemuxRowFrom({ version: null, issue: "spawn timed out", belowMinimum: false } as never).state).toBe("USAGEMUX-UNREADABLE");
    const stale = usagemuxRowFrom({ version: "0.2.1", issue: null, belowMinimum: true } as never);
    expect(stale.state).toBe("USAGEMUX-STALE");
    expect(stale.detail).toContain(USAGEMUX_MINIMUM_VERSION);
    expect(usagemuxRowFrom({ version: "1.0.1", issue: null, belowMinimum: false } as never).state).toBe("ok");
  });
});

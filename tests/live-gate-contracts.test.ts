// Version-contract, usage, and codemux-version columns for the live gate.
// scripts/live-gate/contracts.ts owns the contract table and probes.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runContractColumn, runUsageCheck, stampCodemuxVersion } from "../scripts/live-gate.js";
import { gateFailed } from "../scripts/live-gate/report.js";
import type { HarnessContract } from "../src/harness-contracts.js";
import { ROOT, fixtureDirectory, passRow, reportInput } from "./helpers/live-gate.js";

test("the contract column classifies verdicts from a fake binary", async () => {
  const directory = fixtureDirectory();
  // The probe's working directory is separate from the binary's: the trust
  // check refuses a binary inside the working directory, exactly as the
  // launch path does.
  const workdir = join(directory, "work");
  mkdirSync(workdir);
  const binary = join(directory, "fake-harness");
  writeFileSync(binary, `#!${process.execPath}\nconsole.log("harness version 9.9.9, other output");\n`, { mode: 0o700 });
  const contract: HarnessContract = {
    binary: "fake-harness", min: "1.0.0", maxAudited: "2.0.0",
    pattern: /version (\d+\.\d+\.\d+)/, versionArgs: ["--version"],
  } as unknown as HarnessContract;
  const stale: HarnessContract = { ...contract, maxAudited: "9.9.9" } as unknown as HarnessContract;
  // A recorded break at exactly the installed version: the same detail line
  // doctor prints, so both surfaces agree, and its own verdict class.
  const broken: HarnessContract = {
    ...stale,
    breaks: [{
      from: "9.9.9", note: "the deny shorthand stopped gating writes",
      affects: ["low", "medium"], mitigatedBySandbox: true,
    }],
  } as unknown as HarnessContract;
  const unmitigated: HarnessContract = {
    ...stale,
    breaks: [{ from: "9.9.9", note: "auto-approve ignores its flag", affects: ["high"], mitigatedBySandbox: false }],
  } as unknown as HarnessContract;
  const tooOld: HarnessContract = { ...contract, min: "10.0.0", maxAudited: "11.0.0" } as unknown as HarnessContract;
  // Every row here runs the ONE shared verdict probe (src/harness-health.ts
  // probeVersionVerdict) with its own contract: the detail lines below are
  // that module's labels, asserted verbatim so the gate's column and
  // doctor's table cannot drift apart (audit D15's reuse clause).
  try {
    const supported = await runContractColumn(
      [{ id: "claude", binaryName: binary }],
      { contracts: { claude: stale }, which: () => binary, workdir });
    expect(supported[0]).toMatchObject({
      agent: "claude", version: "9.9.9", min: "1.0.0", ceiling: "9.9.9",
      verdict: "SUPPORTED", detail: "ok (9.9.9)",
    });
    const above = await runContractColumn(
      [{ id: "claude", binaryName: binary }],
      { contracts: { claude: contract }, which: () => binary, workdir });
    expect(above[0]!.verdict).toBe("CONTRACT-STALE");
    expect(above[0]!.detail).toBe("above audited ceiling (9.9.9; audited 2.0.0)");
    const below = await runContractColumn(
      [{ id: "claude", binaryName: binary }],
      { contracts: { claude: tooOld }, which: () => binary, workdir });
    expect(below[0]!.verdict).toBe("CONTRACT-STALE");
    expect(below[0]!.detail).toBe("below minimum (9.9.9; minimum 10.0.0)");
    const brokenRow = await runContractColumn(
      [{ id: "claude", binaryName: binary }],
      { contracts: { claude: broken }, which: () => binary, workdir });
    expect(brokenRow[0]!.verdict).toBe("KNOWN-BREAK");
    expect(brokenRow[0]!.detail).toBe(
      "known break at low and medium autonomy from 9.9.9 (sandbox mitigates): " +
        "the deny shorthand stopped gating writes"
    );
    expect(brokenRow[0]!.mitigated).toBe(true);
    const unmitigatedRow = await runContractColumn(
      [{ id: "claude", binaryName: binary }],
      { contracts: { claude: unmitigated }, which: () => binary, workdir });
    expect(unmitigatedRow[0]!.verdict).toBe("KNOWN-BREAK");
    expect(unmitigatedRow[0]!.detail).toContain("at high autonomy from 9.9.9 (no mitigation)");
    expect(unmitigatedRow[0]!.mitigated).toBeUndefined();
    const noContract = await runContractColumn([{ id: "droid", binaryName: binary }], { contracts: {}, which: () => binary });
    expect(noContract[0]!.verdict).toBe("NO-CONTRACT");
    expect(noContract[0]!.detail).toBe("no version contract for this harness");
    const unresolvable = await runContractColumn([{ id: "droid" }], { contracts: { droid: contract }, which: () => null });
    expect(unresolvable[0]!.verdict).toBe("UNREADABLE");
    expect(unresolvable[0]!.detail).toContain("could not resolve");
    const silent = join(directory, "silent-harness");
    writeFileSync(silent, `#!${process.execPath}\nconsole.log("no version in this output");\n`, { mode: 0o700 });
    const silentRow = await runContractColumn(
      [{ id: "claude", binaryName: silent }],
      { contracts: { claude: stale }, which: () => silent, workdir });
    expect(silentRow[0]!.verdict).toBe("UNREADABLE");
    expect(silentRow[0]!.version).toBe("?");
    expect(silentRow[0]!.detail).toBe("unreadable");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the contract column refuses an untrusted binary without running it", async () => {
  // Review round 3, contracts-2: the probe used to spawn the unresolved
  // binary name, re-resolving through PATH where a relative entry could
  // hand it a binary planted in the working directory. The resolution now
  // hands the shared verdict probe the resolved path, and that probe runs
  // the same trust check every codemux spawn applies — an untrusted binary
  // is reported, never executed.
  const directory = fixtureDirectory();
  const workdir = join(directory, "work");
  mkdirSync(workdir);
  const contract: HarnessContract = {
    binary: "fake-harness", min: "1.0.0", maxAudited: "9.9.9",
    pattern: /version (\d+\.\d+\.\d+)/, versionArgs: ["--version"],
  } as unknown as HarnessContract;
  const deps = { contracts: { claude: contract }, workdir };
  try {
    const writable = join(directory, "writable-harness");
    writeFileSync(writable, `#!${process.execPath}\nconsole.log("harness version 9.9.9");\n`, { mode: 0o700 });
    chmodSync(writable, 0o766); // group- and world-writable
    const writableRow = await runContractColumn([{ id: "claude", binaryName: writable }], { ...deps, which: () => writable });
    expect(writableRow[0]!.verdict).toBe("UNTRUSTED");
    expect(writableRow[0]!.detail).toContain("world-writable");
    const planted = join(workdir, "planted-harness");
    writeFileSync(planted, `#!${process.execPath}\nconsole.log("harness version 9.9.9");\n`, { mode: 0o700 });
    const plantedRow = await runContractColumn([{ id: "claude", binaryName: planted }], { ...deps, which: () => planted });
    expect(plantedRow[0]!.verdict).toBe("UNTRUSTED");
    expect(plantedRow[0]!.detail).toContain("inside the execution working directory");
    const trusted = join(directory, "trusted-harness");
    writeFileSync(trusted, `#!${process.execPath}\nconsole.log("harness version 9.9.9");\n`, { mode: 0o700 });
    const trustedRow = await runContractColumn([{ id: "claude", binaryName: trusted }], { ...deps, which: () => trusted });
    expect(trustedRow[0]!.verdict).toBe("SUPPORTED");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the contract and usage columns run with their default dependencies", async () => {
  // The default closures (Bun.which, the shared verdict probe,
  // runCapturedCommand) are what the real gate runs with; exercise them
  // against bun itself, no injected deps.
  const contract: HarnessContract = {
    binary: "bun", min: "0.0.1", maxAudited: "1.0.0",
    pattern: /(\d+\.\d+\.\d+)/, versionArgs: ["--version"],
  } as unknown as HarnessContract;
  const rows = await runContractColumn([{ id: "claude", binaryName: "bun" }], {
    contracts: { claude: contract }, workdir: ROOT,
  });
  expect(rows[0]!.verdict).toBe("CONTRACT-STALE");
  expect(rows[0]!.version).toMatch(/^\d+\.\d+\.\d+$/);
  const stamp = await stampCodemuxVersion(process.execPath);
  expect(stamp).toMatch(/^\d/);
  const usage = await runUsageCheck(process.execPath);
  expect(["SKIP", "PASS", "FAIL"]).toContain(usage.status);
});

test("the usage check skips, passes, and fails on real conditions", async () => {
  const absent = await runUsageCheck("codemux", { which: () => null });
  expect(absent).toEqual({ status: "SKIP", detail: "usagemux is not installed" });
  const snapshot = JSON.stringify({
    schemaVersion: "1",
    generatedAt: new Date().toISOString(),
    results: [{ client: "claude", provider: null, status: "not-applicable", source: null,
      plan: null, account: null, windows: [], credits: null,
      subscriptionRenewsAt: null, subscriptionExpiresAt: null, message: null }],
  });
  // The version read is injected everywhere below so no test depends on
  // whether the host has a usagemux installed (audit D5's floor is its own
  // test).
  const current = async () => ({ version: "1.0.0", belowMinimum: false });
  const pass = await runUsageCheck("codemux", {
    which: (name) => (name === "usagemux" ? "/bin/usagemux" : null),
    readVersion: current,
    run: async (command) => {
      expect(command).toEqual(["codemux", "usage", "--json"]);
      return { exitCode: 0, stdout: snapshot, stderr: "" };
    },
  });
  expect(pass.status).toBe("PASS");
  expect(pass.detail).toContain("protocol 1");
  const nonzero = await runUsageCheck("codemux", {
    which: () => "/bin/usagemux",
    readVersion: current,
    run: async () => ({ exitCode: 3, stdout: "", stderr: "boom" }),
  });
  expect(nonzero.status).toBe("FAIL");
  expect(nonzero.detail).toContain("exited 3");
  const unparseable = await runUsageCheck("codemux", {
    which: () => "/bin/usagemux",
    readVersion: current,
    run: async () => ({ exitCode: 0, stdout: "not json", stderr: "" }),
  });
  expect(unparseable.status).toBe("FAIL");
  expect(unparseable.detail).toContain("protocol 1");
  expect(unparseable.detail).toContain("invalid JSON");
  expect(gateFailed(reportInput({ usage: unparseable }))).toBe(true);
  expect(gateFailed(reportInput({ usage: absent, rows: [passRow("claude", ["A"])], probes: ["A"] }))).toBe(false);
  // A version the reader could not read is not a floor failure: the
  // snapshot check still decides.
  const unreadable = await runUsageCheck("codemux", {
    which: () => "/bin/usagemux",
    readVersion: async () => ({ version: null, belowMinimum: false }),
    run: async () => ({ exitCode: 0, stdout: snapshot, stderr: "" }),
  });
  expect(unreadable.status).toBe("PASS");
});

test("the usage check fails a usagemux below the protocol minimum", async () => {
  // Audit D5: a usagemux old enough to predate the validated snapshot
  // shape is a FAIL before any snapshot is judged — the gate used to pass
  // on whatever such a build printed.
  const stale = await runUsageCheck("codemux", {
    which: () => "/bin/usagemux",
    readVersion: async () => ({ version: "0.2.1", belowMinimum: true }),
    run: async () => {
      throw new Error("the snapshot check must not run");
    },
  });
  expect(stale.status).toBe("FAIL");
  expect(stale.detail).toContain("usagemux 0.2.1 is below 1.0.0");
  expect(gateFailed(reportInput({ usage: stale }))).toBe(true);
});

test("the usage check fails a snapshot that does not validate against the protocol", async () => {
  // Any parseable JSON used to pass: `{"ok":true}` is JSON and no usagemux
  // snapshot at all, and a codemux/usagemux pair disagreeing on the protocol
  // shape sailed through the gate.
  const current = async () => ({ version: "1.0.0", belowMinimum: false });
  const wrongShape = await runUsageCheck("codemux", {
    which: () => "/bin/usagemux",
    readVersion: current,
    run: async () => ({ exitCode: 0, stdout: '{"ok":true}', stderr: "" }),
  });
  expect(wrongShape.status).toBe("FAIL");
  expect(wrongShape.detail).toContain("usagemux protocol 1 snapshot");
  expect(wrongShape.detail).toContain("unknown field 'ok'");
  const wrongVersion = await runUsageCheck("codemux", {
    which: () => "/bin/usagemux",
    readVersion: current,
    run: async () => ({ exitCode: 0, stdout: '{"schemaVersion":"2","generatedAt":"2026-11-02T12:00:00Z","results":[]}', stderr: "" }),
  });
  expect(wrongVersion.status).toBe("FAIL");
  expect(wrongVersion.detail).toContain("unsupported usagemux protocol version '2'");
  expect(gateFailed(reportInput({ usage: wrongShape }))).toBe(true);
});

test("the version stamp records the binary under test", async () => {
  expect(await stampCodemuxVersion("codemux", async (command) => {
    expect(command).toEqual(["codemux", "--version"]);
    return { exitCode: 0, stdout: "2.0.0\n" };
  })).toBe("2.0.0");
  expect(await stampCodemuxVersion("codemux", async () => ({ exitCode: 0, stdout: "\n" }))).toBe("unreadable");
  expect(await stampCodemuxVersion("codemux", async () => ({ exitCode: 1, stdout: "2.0.0\n" }))).toBe("unreadable");
  expect(await stampCodemuxVersion("codemux", async () => { throw new Error("no binary"); })).toBe("unreadable");
});

test("staleContracts keeps the stale and known-broken rows only", () => {
  const { staleContracts } = require("../scripts/live-gate/contracts.js") as typeof import("../scripts/live-gate/contracts.js");
  const rows = [
    { agent: "a", verdict: "CONTRACT-STALE" },
    { agent: "b", verdict: "KNOWN-BREAK" },
    { agent: "c", verdict: "SUPPORTED" },
    { agent: "d", verdict: "NO-CONTRACT" },
  ] as never[];
  expect(staleContracts(rows).map((row: { agent: string }) => row.agent)).toEqual(["a", "b"]);
});

test("the usage check's default lookup reports an absent usagemux without running anything", async () => {
  const directory = fixtureDirectory();
  const saved = process.env.PATH;
  process.env.PATH = directory;
  try {
    const check = await runUsageCheck(join(directory, "codemux"));
    expect(check.status).toBe("SKIP");
    expect(check.detail).toContain("usagemux");
  } finally {
    process.env.PATH = saved;
    rmSync(directory, { recursive: true, force: true });
  }
});

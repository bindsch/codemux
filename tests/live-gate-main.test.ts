// Tests for the live gate's main(): binary validation, SIGHUP handling,
// the nothing-was-probed refusal, and the in-process run. main() lives in
// the entry barrel scripts/live-gate.ts (only spawned children run it as
// an entry; review round 8, edges).
import { afterAll, expect, test } from "bun:test";
import { CHECKOUT_VERSION, discoverCandidate, main, probeApplies, unsupportedNote } from "../scripts/live-gate.js";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AGENT_IDS } from "../src/types.js";
import { PROBE_FEATURE } from "../src/parity/probe-features.js";
import { ROOT, fixtureDirectory } from "./helpers/live-gate.js";

// The gate snapshots the Keychain search list through `security` before
// its probe pool and stops when that baseline cannot be taken (review
// round 88). These tests run the whole gate, so they bring their own
// `security`: a fake in a private directory ahead of PATH with a stable
// answer, never the machine's tool or its Keychain state (a sandbox that
// denies the real one must not fail them).
const SECURITY_DIR = mkdtempSync(join(tmpdir(), "codemux-gate-main-security-"));
writeFileSync(join(SECURITY_DIR, "security"), `#!/bin/sh\nprintf '    "/u/login.keychain-db"\\n'\n`);
chmodSync(join(SECURITY_DIR, "security"), 0o700);
const GATE_ENV = { ...process.env, PATH: `${SECURITY_DIR}:${process.env.PATH ?? ""}` };
afterAll(() => rmSync(SECURITY_DIR, { recursive: true, force: true }));

/** A fake candidate build (round 18, edges 4): answers `--version` with
 * this checkout's version and `list --json` with the given available
 * agents, so a subprocess main() runs the full candidate path — discovery
 * from the listing, probes against the candidate — without a real
 * codemux. Anything else it is asked exits 64. */
function fakeCandidate(directory: string, installed: readonly string[]): string {
  const listing = {
    schema: "codemux-list-1",
    agents: installed.map((id) => ({
      id,
      available: true,
      capabilities: { hermetic: false, checkHermetic: false, sessionHermetic: false,
        limitations: Object.fromEntries(Object.values(PROBE_FEATURE).filter((feature) => feature !== null)
          .map((feature) => [feature, { reason: `Synthetic candidate does not implement ${feature}`, evidence: "Synthetic fixture 1.0.0" }])),
        resultJson: false, toolsNone: false, toolsNoneRequiresHermetic: false, providerOverride: false, sessions: false, experimentMcp: false, experimentPrefix: null, servedModelEvidence: false, model: false, effort: false },
    })),
  };
  const path = join(directory, "candidate");
  writeFileSync(path, `#!${process.execPath}
    const args = process.argv.slice(2);
    if (args[0] === "--version") { console.log(${JSON.stringify(CHECKOUT_VERSION)}); process.exit(0); }
    if (args[0] === "list" && args[1] === "--json") { console.log(${JSON.stringify(JSON.stringify(listing))}); process.exit(0); }
    if (args[0] === "usage" && args[1] === "--json") {
      // A snapshot that validates (the gate now runs it through the same
      // validator the usage command uses), not bare JSON.
      console.log(JSON.stringify({ schemaVersion: "1", generatedAt: new Date().toISOString(), results: [] }));
      process.exit(0);
    }
    console.error("unexpected candidate arguments: " + args.join(" ")); process.exit(64);
  `, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

test("the main candidate fixture declares isolation and limitation evidence", async () => {
  const directory = fixtureDirectory();
  try {
    const candidate = fakeCandidate(directory, ["claude"]);
    const { facts } = await discoverCandidate(candidate, CHECKOUT_VERSION, false, CHECKOUT_VERSION);
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact).toMatchObject({ id: "claude", checkHermetic: false, sessionHermetic: false });
    for (const letter of ["D", "K"] as const) {
      const feature = PROBE_FEATURE[letter]!;
      expect(probeApplies(letter, fact)).toBe(false);
      expect(unsupportedNote(letter, fact)).toBe(`Synthetic candidate does not implement ${feature}`);
      expect(fact.limitations?.[feature]?.evidence).toBe("Synthetic fixture 1.0.0");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each(["missing", "non-executable", "directory"])("live gate refuses a %s binary with exit 2 before probing", (kind) => {
  const directory = fixtureDirectory();
  const binary = kind === "directory" ? directory : join(directory, "codemux");
  if (kind === "non-executable") writeFileSync(binary, "", { mode: 0o600 });
  try {
    const result = Bun.spawnSync([process.execPath, join(ROOT, "scripts/live-gate.ts"), "--codemux", binary], {
      cwd: ROOT, env: { ...GATE_ENV, LIVE_GATE_SKIP: AGENT_IDS.join(",") },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("existing executable file");
    expect(result.stderr.toString()).toContain(binary);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a bad --timeout prints commander's argument error exactly once", () => {
  // Review round 9: commander prints the message itself before the
  // exitOverride throw, so main()'s catch must not repeat it.
  const result = Bun.spawnSync(
    [process.execPath, join(ROOT, "scripts/live-gate.ts"), "--codemux", process.execPath, "--timeout", "soon"],
    { cwd: ROOT, env: { ...GATE_ENV } }
  );
  const stderr = result.stderr.toString();
  expect(result.exitCode).not.toBe(0);
  expect(stderr.split("Expected an integer from 1 to").length - 1).toBe(1);
  expect(stderr).toContain("live-gate: could not complete");
});

test("live gate registers and removes SIGHUP handling and exits 129", async () => {
  const directory = fixtureDirectory();
  const candidate = fakeCandidate(directory, ["agy"]);
  const source = `
    import { mock } from "bun:test";
    mock.module(${JSON.stringify(join(ROOT, "src/adapters/index.ts"))}, () => ({
      AGENT_IDS: ${JSON.stringify([...AGENT_IDS])},
      // The gate asks each listed harness's adapter for its login state before
      // the matrix (audit D8); the stub reports a login so every probe runs.
      getAdapter: () => ({ loginState: () => ({ state: "logged-in" }) }),
      getAvailableAdapters: () => [{
        id: "agy",
        binaryName: "fake-agy",
        capabilities: () => ({ supportsNonInteractive: true, supportsInteractive: true, supportsModel: true,
          supportsAutonomy: true, autonomyLevels: ["read-only", "low", "medium", "high"], supportsEffort: true,
          effortLevels: [] }),
        isAvailable: () => true,
      }],
    }));
    const { main, ProbeRunner } = await import(${JSON.stringify(join(ROOT, "scripts/live-gate.ts"))});
    // Park the first probe so main() sits inside runProbes when the signal
    // arrives. Emitting during the earlier --version or usage captures would
    // hit runCapturedCommand's own interrupt path, which process.exit(143)s
    // before main can print the report (src/process-runner.ts).
    let released = false;
    const parked: Array<(value: { status: "PASS"; seconds: number }) => void> = [];
    const probeResult = () => ({ status: "PASS" as const, seconds: 0.01 });
    const parkedRun = () => released ? Promise.resolve(probeResult()) : new Promise((resolve) => { parked.push(resolve); });
    ProbeRunner.prototype.run = parkedRun;
    ProbeRunner.prototype.capture = parkedRun;
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const before = signals.map((signal) => process.listenerCount(signal));
    process.argv = ["bun", "live-gate", "--codemux", ${JSON.stringify(candidate)}];
    const pending = main();
    for (let attempt = 0; parked.length === 0 && attempt < 200; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (parked.length === 0) throw new Error("main never reached a probe");
    for (const [index, signal] of signals.entries()) {
      if (process.listenerCount(signal) !== before[index] + 1) throw new Error("missing " + signal);
    }
    process.emit("SIGHUP");
    released = true;
    for (const resolve of parked.splice(0)) resolve(probeResult());
    await pending;
    for (const [index, signal] of signals.entries()) {
      if (process.listenerCount(signal) !== before[index]) throw new Error("leaked " + signal);
    }
    console.log("signal handlers removed");
  `;
  const proc = Bun.spawn([process.execPath, "-e", source], {
    cwd: ROOT, env: { ...GATE_ENV },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ]);
  const report = stdout.match(/^Report: (.+)$/m)?.[1];
  try {
    // The interrupt fires between probes, so nothing here should print except
    // harness Warning: chatter.
    expect(stderr.replace(/^Warning:[^\n]*\n/gm, "")).toBe("");
    expect(exit).toBe(129);
    expect(stdout).toContain("signal handlers removed");
    // An interrupted gate's saved report keeps the marker (review round
    // 201): it never read the versions again, so the file must not pass
    // for the record of a finished gate.
    expect(report).toBeDefined();
    expect(readFileSync(report!, "utf8").startsWith("PRELIMINARY: the gate did not finish")).toBe(true);
  } finally {
    if (report) rmSync(dirname(report), { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([
  { label: "none installed", installed: [] as string[], only: [] as string[], skipEnv: "", skipFlag: "", skipped: false },
  { label: "only uninstalled", installed: ["agy"], only: ["kimi"], skipEnv: "", skipFlag: "", skipped: false },
  { label: "only skipped or uninstalled", installed: ["agy"], only: ["agy", "kimi"], skipEnv: "", skipFlag: "agy", skipped: true },
  { label: "all skipped by environment", installed: ["agy", "kimi"], only: [], skipEnv: "agy,kimi", skipFlag: "", skipped: true },
  { label: "all skipped by flag", installed: ["agy", "kimi"], only: [], skipEnv: "", skipFlag: "agy,kimi", skipped: true },
])("live gate fails when nothing was probed: $label", async ({ installed, only, skipEnv, skipFlag, skipped }) => {
  const directory = fixtureDirectory();
  const candidate = fakeCandidate(directory, installed);
  const args = [
    "--codemux", candidate,
    ...(only.length === 0 ? [] : ["--only", only.join(",")]),
    ...(skipFlag === "" ? [] : ["--skip", skipFlag]),
  ];
  const source = `
    import { mock } from "bun:test";
    mock.module(${JSON.stringify(join(ROOT, "src/adapters/index.ts"))}, () => ({
      AGENT_IDS: ${JSON.stringify([...AGENT_IDS])},
      getAdapter: (id: string) => { throw new Error("unexpected getAdapter for " + id); },
      getAvailableAdapters: () => (${JSON.stringify(installed)} as string[]).map((id) => ({
        id,
        binaryName: "fake-" + id,
        capabilities: () => ({ supportsNonInteractive: true, supportsInteractive: true, supportsModel: true,
          supportsAutonomy: true, autonomyLevels: ["read-only", "low", "medium", "high"], supportsEffort: true,
          effortLevels: [] }),
        isAvailable: () => true,
      })),
    }));
    const { main, ProbeRunner } = await import(${JSON.stringify(join(ROOT, "scripts/live-gate.ts"))});
    ProbeRunner.prototype.run = async () => { throw new Error("unexpected harness probe"); };
    ProbeRunner.prototype.capture = ProbeRunner.prototype.run;
    process.argv = ["bun", "live-gate", ...${JSON.stringify(args)}];
    await main();
  `;
  const proc = Bun.spawn([process.execPath, "-e", source], {
    cwd: ROOT, env: { ...GATE_ENV, ...(skipEnv === "" ? {} : { LIVE_GATE_SKIP: skipEnv }) },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ]);
  const report = stdout.match(/^Report: (.+)$/m)?.[1];
  const message = `live-gate: nothing was probed${skipped ? " (all skipped)" : ""}`;
  try {
    expect(stderr.replace(/Warning:[^\n]*\n/g, "")).toBe("");
    expect(exit).toBe(1);
    expect(stdout).toContain("| Agent | Probe | Result | Seconds | Note |");
    expect(stdout).toContain(message);
    expect(stdout.split("\n")[0]).toBe(`Codemux: ${candidate}`);
    // The matrix came from the candidate's listing, and the report says so.
    expect(stdout).toContain(`NOTE: the probe matrix comes from the candidate (${candidate} list --json)`);
    expect(stdout).toContain(`live-gate (${candidate}): 0 pass, 0 fail,`);
    expect(stdout.indexOf(`live-gate (${candidate}): 0 pass, 0 fail,`)).toBeLessThan(stdout.indexOf(message));
    expect(report).toBeDefined();
    expect(readFileSync(report!, "utf8")).toContain(message);
  } finally {
    if (report) rmSync(dirname(report), { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("main() runs in process: report written, exit code set, handlers removed", async () => {
  // Review round 8, edges: run.ts is inside the per-file coverage floor,
  // so main() needs an in-process caller too (the subprocess tests above
  // pin the process boundary the coverage run cannot see). The adapter
  // list and the two codemux captures are stubbed on their module
  // exports — the only parts that touch the installed world.
  const { spyOn } = await import("bun:test");
  const adaptersModule = await import("../src/adapters/index.js");
  const contractsModule = await import("../scripts/live-gate/contracts.js");
  const adapters = spyOn(adaptersModule, "getAvailableAdapters").mockReturnValue([]);
  const version = spyOn(contractsModule, "stampCodemuxVersion").mockResolvedValue("test-version");
  const usage = spyOn(contractsModule, "runUsageCheck").mockResolvedValue({ status: "SKIP", detail: "stubbed" });
  const printed: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.join(" "));
  });
  const argv = process.argv;
  const code = process.exitCode;
  const path = process.env.PATH;
  // The default launcher: discovery then reads the mocked adapter
  // registry in process, and no candidate listing is spawned. The fake
  // `security` answers the gate's Keychain baseline here too.
  process.argv = ["bun", "live-gate"];
  process.env.PATH = GATE_ENV.PATH;
  try {
    await main();
    // Nothing was probed (no adapters available), so the gate fails.
    expect(process.exitCode).toBe(1);
    expect(printed.join("\n")).toContain("live-gate: nothing was probed");
  } finally {
    process.argv = argv;
    process.exitCode = code;
    process.env.PATH = path;
    adapters.mockRestore();
    version.mockRestore();
    usage.mockRestore();
    log.mockRestore();
  }
});

test("the report is saved before the version reread, and a failed reread prints the row unreadable (review rounds 183, 190)", async () => {
  // The reread's version subprocesses run under the signal-forwarding
  // runner, which ends the process on a signal: the pool's results must be
  // on disk before it starts. A reread that throws must not cost the
  // report either.
  const { spyOn } = await import("bun:test");
  const adaptersModule = await import("../src/adapters/index.js");
  const contractsModule = await import("../scripts/live-gate/contracts.js");
  const runModule = await import("../scripts/live-gate/run.js");
  const directory = fixtureDirectory();
  let readings = 0;
  let savedBeforeReread = "";
  const spies: { mockRestore(): void }[] = [
    spyOn(adaptersModule, "getAvailableAdapters").mockReturnValue([]),
    spyOn(contractsModule, "stampCodemuxVersion").mockResolvedValue("test-version"),
    spyOn(contractsModule, "runUsageCheck").mockResolvedValue({ status: "SKIP", detail: "stubbed" }),
    spyOn(runModule, "createReportDirectory").mockReturnValue(directory),
    spyOn(contractsModule, "runContractColumn").mockImplementation(async () => {
      readings++;
      if (readings === 1) {
        return [{ agent: "agy", version: "1.4.12", min: "1.2.14", ceiling: "1.4.12", verdict: "SUPPORTED", detail: "ok (1.4.12)" }];
      }
      savedBeforeReread = readFileSync(join(directory, "report.md"), "utf8");
      throw new Error("the reread failed");
    }),
  ];
  const printed: string[] = [];
  spies.push(spyOn(console, "log").mockImplementation((...args: unknown[]) => { printed.push(args.join(" ")); }));
  const argv = process.argv;
  const code = process.exitCode;
  const path = process.env.PATH;
  process.argv = ["bun", "live-gate"];
  process.env.PATH = GATE_ENV.PATH;
  try {
    await main();
    expect(readings).toBe(2);
    expect(savedBeforeReread).toContain("| agy | 1.4.12 | 1.2.14 | 1.4.12 | SUPPORTED");
    // The early copy says it is preliminary; the final report does not
    // (review round 194).
    expect(savedBeforeReread.startsWith("PRELIMINARY: the gate did not finish")).toBe(true);
    expect(readFileSync(join(directory, "report.md"), "utf8")).not.toContain("PRELIMINARY");
    const unreadable = "| agy | 1.4.12 | 1.2.14 | 1.4.12 | UNREADABLE (the version could not be read again after the probes; before them: ok (1.4.12)) |";
    expect(printed.join("\n")).toContain(unreadable);
    expect(readFileSync(join(directory, "report.md"), "utf8")).toContain(unreadable);
  } finally {
    process.argv = argv;
    process.exitCode = code;
    process.env.PATH = path;
    for (const spy of spies) spy.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a throwing adapter in the login pre-check closes probe J's listener, so the process exits (review round 45)", async () => {
  // In process: runProbes rejects; with the listener left open the script
  // would never exit on its own. Bounded by the test's own timeout.
  const source = `
    import { mock } from "bun:test";
    mock.module(${JSON.stringify(join(ROOT, "src/adapters/index.ts"))}, () => ({
      AGENT_IDS: ${JSON.stringify([...AGENT_IDS])},
      getAdapter: () => { throw new Error("constructor refused: invalid XDG path"); },
      getAvailableAdapters: () => [],
    }));
    const { runProbes, parseOptions } = await import(${JSON.stringify(join(ROOT, "scripts/live-gate.ts"))});
    const facts = [{ id: "opencode", hermetic: false, resultJson: false, toolsNoneRequiresHermetic: false, sessions: false,
      experiment: false, experimentPrefixes: [], providerOverride: false, servedModelEvidence: false, model: false, effort: false }];
    try {
      // This checkout's own launcher: the login pre-check runs only there (a
      // candidate's credential locations are its own; review round 52).
      await runProbes(facts, parseOptions(["--probe", "J", "--codemux", ${JSON.stringify(join(ROOT, "bin/codemux"))}, "--timeout", "5"], ""), undefined, "/tmp", { PATH: process.env.PATH });
      console.log("unexpected: runProbes resolved");
    } catch (error) {
      console.log("rejected: " + (error instanceof Error ? error.message : String(error)));
    }
  `;
  const proc = Bun.spawn([process.execPath, "-e", source], { cwd: ROOT, env: { ...GATE_ENV }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const exited = await Promise.race([proc.exited, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 15_000))]);
  if (exited === "hung") proc.kill();
  const stdout = await new Response(proc.stdout).text();
  expect(exited).not.toBe("hung");
  expect(stdout).toContain("rejected: constructor refused");
}, 25_000); // the 15 s hang detector above must fire before the runner's own timeout (review round 54)

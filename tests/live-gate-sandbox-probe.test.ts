// Probe J of the live gate (audit D7; reworked 2026-11-06): the sandbox
// policy flags against a provably reachable loopback port, with no model
// turn. The launch prints the sandbox it would build, and the gate runs
// its own script behind the printed scode arguments. The pieces live in
// scripts/live-gate/loopback.ts; the probe body in scripts/live-gate/run.ts.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseOptions, runProbes } from "../scripts/live-gate.js";
import { prepareNoNetProbe, sandboxPrefixFromPrint, startReachableListener } from "../scripts/live-gate/loopback.js";
import { cleanupLoggedInHomes, factsFor, fixtureDirectory, loggedInEnv } from "./helpers/live-gate.js";

afterAll(cleanupLoggedInHomes);

/** The environment without SCODE_* names: the suite itself may run under
 * scode, and probe J unsets every such name it finds. */
const withoutScode = (env: Record<string, string | undefined>): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith("SCODE_")));

/** The argv a launch prints under --print-sandbox: scode's part, the
 * separator, then the harness command. */
const PRINTED_SANDBOX = "/opt/tools/bin/scode\n-C\n/tmp/probe\n--trust\nstandard\n--no-net\n--scrub-env\n--\n/opt/tools/bin/kimi\n--print\nOK\n";

test("probe J prints the sandbox for the policy flags and runs its script behind it, with no model turn (audit D7)", async () => {
  const fixture = loggedInEnv();
  const reportDirectory = fixtureDirectory();
  const printed: string[][] = [];
  const ran: string[][] = [];
  try {
    const rows = await runProbes([factsFor("kimi")], parseOptions(["--probe", "J", "--timeout", "10"], ""), {
      async run(command, expected) {
        ran.push(command);
        expect(expected).toBe("BLOCKED");
        // The script sits in the probe directory, executable by its owner
        // only — read here, before the cleanup removes a passed probe's
        // directory.
        const script = command[command.length - 1]!;
        expect(readdirSync(join(script, ".."))).toEqual(["nonet.sh"]);
        expect(statSync(script).mode & 0o777).toBe(0o700);
        return { status: "PASS", seconds: 2, stderr: "" };
      },
      async capture(command, verify) {
        printed.push(command);
        expect(verify({ exit: 0, stdout: PRINTED_SANDBOX })).toBeNull();
        return { status: "PASS", seconds: 1, stderr: "", note: "Warning: kimi 9.9.9 is newer than the audited ceiling" };
      },
    }, reportDirectory, withoutScode(fixture.env));
    // The three policy flags ride one print-only launch: the release
    // contract runs them together, so the probe does too.
    const command = printed[0]!;
    expect(command).toContain("--sandbox-no-net");
    expect(command).toContain("--sandbox-scrub-env");
    expect(command[command.indexOf("--sandbox-trust") + 1]).toBe("standard");
    expect(command[command.indexOf("--auto") + 1]).toBe("medium");
    expect(command).toContain("--print-sandbox");
    // The script runs behind the printed scode prefix, through the
    // separator; the harness command is never started.
    expect(ran).toHaveLength(1);
    expect(ran[0]!.slice(0, 8)).toEqual(["/opt/tools/bin/scode", "-C", "/tmp/probe", "--trust", "standard", "--no-net", "--scrub-env", "--"]);
    expect(ran[0]!.slice(8, 9)).toEqual(["/bin/sh"]);
    expect(ran[0]![9]).toMatch(/\/nonet\.sh$/);
    expect(ran[0]).not.toContain("/opt/tools/bin/kimi");
    // The print step's warning stays on the row (review round 188).
    expect(rows[0]!.results.J).toMatchObject({
      status: "PASS", seconds: 3, note: "Warning: kimi 9.9.9 is newer than the audited ceiling",
    });
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("probe J runs its script without the ambient SCODE_* names a real launch scrubs (review round 188)", async () => {
  // scode reads SCODE_* itself (its accounting sink among them), and a real
  // launch removes them before it starts scode. The script step must run
  // in that same state, or it tests another sandbox.
  const fixture = loggedInEnv();
  const reportDirectory = fixtureDirectory();
  const ran: string[][] = [];
  try {
    await runProbes([factsFor("kimi")], parseOptions(["--probe", "J", "--timeout", "10"], ""), {
      async run(command) { ran.push(command); return { status: "PASS", seconds: 0, stderr: "" }; },
      async capture(_command, verify) {
        verify({ exit: 0, stdout: PRINTED_SANDBOX });
        return { status: "PASS", seconds: 0, stderr: "" };
      },
    }, reportDirectory, { ...withoutScode(fixture.env), SCODE_ACCOUNT_FILE: "/tmp/ambient-accounting", scode_debug: "1" });
    expect(ran[0]!.slice(0, 6)).toEqual(["/usr/bin/env", "-u", "SCODE_ACCOUNT_FILE", "-u", "scode_debug", "/opt/tools/bin/scode"]);
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("probe J fails on a print it cannot use and never runs the script", async () => {
  const fixture = loggedInEnv();
  const reportDirectory = fixtureDirectory();
  try {
    const rows = await runProbes([factsFor("kimi")], parseOptions(["--probe", "J", "--timeout", "10"], ""), {
      async run() { throw new Error("the script must not run behind an unusable print"); },
      async capture(_command, verify) {
        const problem = verify({ exit: 0, stdout: "/opt/tools/bin/kimi\n--print\nOK\n" });
        return { status: "FAIL", seconds: 1, stderr: problem ?? "" };
      },
    }, reportDirectory, fixture.env);
    expect(rows[0]!.results.J).toMatchObject({ status: "FAIL", stderr: "the printed argv does not start with scode" });
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("sandboxPrefixFromPrint keeps scode's part of a printed argv through the separator", () => {
  expect(sandboxPrefixFromPrint(PRINTED_SANDBOX)).toEqual({
    argv: ["/opt/tools/bin/scode", "-C", "/tmp/probe", "--trust", "standard", "--no-net", "--scrub-env", "--"],
  });
  const policy = "--trust\nstandard\n--no-net\n--scrub-env\n";
  expect(sandboxPrefixFromPrint(`scode\n${policy}--\nagy\n`))
    .toEqual({ argv: ["scode", "--trust", "standard", "--no-net", "--scrub-env", "--"] });
  // The first separator ends the prefix: a harness argument spelled --
  // stays on the harness side.
  expect(sandboxPrefixFromPrint(`scode\n${policy}--\ncodex\n--\nOK\n`))
    .toEqual({ argv: ["scode", "--trust", "standard", "--no-net", "--scrub-env", "--"] });
  // The script proves only the network block, so the printed arguments
  // must show all three policies (review round 180): a launch that dropped
  // the scrub, changed the trust level, or lost the network denial fails
  // here, before anything runs. A policy word on the harness side of the
  // separator does not count.
  expect(sandboxPrefixFromPrint("/tmp/scode\n--trust\ntrusted\n--no-net\n--\nkimi\n")).toEqual({
    problem: "the printed scode arguments lack --scrub-env, --trust standard; the launch did not carry the policy it was asked for",
  });
  expect(sandboxPrefixFromPrint("scode\n--trust\nstandard\n--scrub-env\n--\nkimi\n--no-net\n")).toEqual({
    problem: "the printed scode arguments lack --no-net; the launch did not carry the policy it was asked for",
  });
  expect(sandboxPrefixFromPrint("scode\n--no-net\n--scrub-env\n--trust\n--\nstandard\n")).toEqual({
    problem: "the printed scode arguments lack --trust standard; the launch did not carry the policy it was asked for",
  });
  expect(sandboxPrefixFromPrint("")).toEqual({ problem: "nothing was printed" });
  // A print that ends at the separator starts no harness (review round 188).
  expect(sandboxPrefixFromPrint(`scode\n${policy}--\n`))
    .toEqual({ problem: "the printed argv names no harness command after the -- separator" });
  expect(sandboxPrefixFromPrint("/usr/bin/env\nscode\n--\nkimi\n")).toEqual({ problem: "the printed argv does not start with scode" });
  expect(sandboxPrefixFromPrint("/opt/tools/bin/scode\n--no-net\nkimi\n"))
    .toEqual({ problem: "the printed argv has no -- separator before the harness command" });
});

test("the no-net script answers OPEN, BLOCKED, and NO-CURL from the curl outcome", async () => {
  // The script is a pure read of curl's outcome: exit 0 → OPEN (the
  // address was reachable), any failure → BLOCKED, no curl on PATH →
  // NO-CURL. Each branch is driven by a stub curl standing in for the
  // production outcomes, because a suite running inside a network-
  // restricted sandbox has no loopback curl to observe — the test cannot
  // depend on one. The listener itself still serves: the fetch proves the
  // address the script targets is reachable outside any sandbox.
  const listener = await startReachableListener();
  const directory = fixtureDirectory();
  try {
    const probe = prepareNoNetProbe(directory, listener.port);
    expect(probe.expected).toBe("BLOCKED");
    expect(probe.script).toBe(join(directory, "nonet.sh"));
    expect(await (await fetch(`http://127.0.0.1:${listener.port}/`)).text()).toBe("reachable\n");
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const stubCurl = (outcome: string) =>
      writeFileSync(join(bin, "curl"), `#!/bin/sh\n${outcome}\n`, { mode: 0o700 });
    const run = () =>
      Bun.spawnSync(["/bin/sh", join(directory, "nonet.sh")], { env: { PATH: bin } }).stdout.toString();
    stubCurl("exit 0"); // curl reached the listener
    expect(run()).toBe("OPEN");
    stubCurl("exit 7"); // connection refused or blocked
    expect(run()).toBe("BLOCKED");
    rmSync(join(bin, "curl"));
    expect(run()).toBe("NO-CURL");
  } finally {
    await listener.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

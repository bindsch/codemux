// The gate skips only positively established missing credentials.
// Missing native-store evidence leaves authentication unknown.
// --probe-anyway forces a skipped run,
// H2 (loopback credentials, not the operator's) is exempt, and the checks
// ahead of the login read keep their precedence. tests/helpers/live-gate.ts
// owns the logged-in fixture environment every runProbes call site passes.
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { parseOptions, runProbes } from "../scripts/live-gate.js";
import { getAdapter } from "../src/adapters/index.js";
import { AGENT_IDS } from "../src/types.js";
import { cleanupLoggedInHomes, factsFor, fixtureDirectory, loggedInEnv, loggedOutEnv } from "./helpers/live-gate.js";

afterAll(cleanupLoggedInHomes);

// The states that do NOT skip: only no-credential does. claude (no mirror
// → unknown), cline (no readable store at all), and copilot (a config the
// reader cannot judge → unknown) still run.
const NO_CREDENTIAL_STORE: Record<string, string> = { zai: "~/.zai" };
const RUNS_ANYWAY = new Set<string>(AGENT_IDS.filter((id) => id !== "zai"));

test("the logged-in fixture environment leaves no harness at no-credential", () => {
  // The fixture's own health check: an adapter that grows a new store (or
  // renames one) would flip its row to no-credential and quietly skip the
  // probe in every test below, so pin every state here.
  const fixture = loggedInEnv();
  for (const id of AGENT_IDS) {
    const login = getAdapter(id, fixture.env).loginState();
    expect(login.state, `${id} under the fixture home`).not.toBe("no-credential");
  }
});

test("an empty home leaves native authentication unknown and skips only ZAI's required key", async () => {
  const fixture = loggedOutEnv();
  const reportDirectory = fixtureDirectory();
  let ran = 0;
  try {
    const rows = await runProbes(AGENT_IDS.map(factsFor), parseOptions(["--probe", "A"], ""), {
      async run() { ran++; return { status: "PASS", seconds: 0, stderr: "" }; },
      async capture() { throw new Error("probe A never captures"); },
    }, reportDirectory, fixture.env);
    expect(ran).toBe(RUNS_ANYWAY.size);
    for (const row of rows) {
      const result = row.results.A!;
      if (RUNS_ANYWAY.has(row.agent)) {
        expect(result.status, row.agent).toBe("PASS");
      } else {
        expect(result.status, row.agent).toBe("SKIP");
        expect(result.note, row.agent)
          .toBe(`no credentials detected: ${NO_CREDENTIAL_STORE[row.agent]}`);
      }
    }
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("H2 runs without credentials and --probe-anyway forces the rest (audit D8)", async () => {
  // H2's credentials come from the loopback override, so an absent store
  // skips nothing there; --probe-anyway says the operator knows better and
  // forces every other cell to run.
  const fixture = loggedOutEnv();
  const reportDirectory = fixtureDirectory();
  const commands: string[][] = [];
  try {
    const skipped = await runProbes([factsFor("zai")], parseOptions(["--probe", "A,H2"], ""), {
      async run(command) { commands.push(command); return { status: "PASS", seconds: 0, stderr: "" }; },
      async capture(command) { commands.push(command); return { status: "PASS", seconds: 0, stderr: "" }; },
    }, reportDirectory, fixture.env);
    expect(skipped[0]!.results.A).toMatchObject({ status: "SKIP", note: "no credentials detected: ~/.zai" });
    expect(skipped[0]!.results.H2).toMatchObject({ status: "PASS" });

    const forced = await runProbes(
      [factsFor("zai")],
      parseOptions(["--probe", "A,H2", "--probe-anyway", "zai"], ""),
      {
        async run(command) { commands.push(command); return { status: "PASS", seconds: 0, stderr: "" }; },
        async capture(command) { commands.push(command); return { status: "PASS", seconds: 0, stderr: "" }; },
      },
      reportDirectory, fixture.env);
    expect(forced[0]!.results.A).toMatchObject({ status: "PASS" });
    expect(forced[0]!.results.H2).toMatchObject({ status: "PASS" });
    expect(commands).toHaveLength(3);
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("J and P run without credentials: they print a sandbox and start no harness", async () => {
  // Since 2026-11-06 probe J takes no model turn (a harness without network
  // cannot reach its provider), so like P it needs no login.
  const fixture = loggedOutEnv();
  const reportDirectory = fixtureDirectory();
  try {
    const rows = await runProbes([factsFor("zai")], parseOptions(["--probe", "A,J,P"], ""), {
      async run() { return { status: "PASS", seconds: 0, stderr: "" }; },
      async capture(_command, verify) {
        verify({ exit: 0, stdout: "scode\n--trust\nstandard\n--no-net\n--scrub-env\n--\nclaude\n" });
        return { status: "PASS", seconds: 0, stderr: "" };
      },
    }, reportDirectory, fixture.env);
    expect(rows[0]!.results.A).toMatchObject({ status: "SKIP", note: "no credentials detected: ~/.zai" });
    expect(rows[0]!.results.J).toMatchObject({ status: "PASS" });
    expect(rows[0]!.results.P).toMatchObject({ status: "PASS" });
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("the checks ahead of the login read keep their precedence (audit D8)", async () => {
  // An unsupported cell stays unsupported, an operator skip stays the
  // operator's, and H without its opt-in stays an opt-in note — none of
  // them becomes a credentials note for a harness with no store.
  const fixture = loggedOutEnv();
  const reportDirectory = fixtureDirectory();
  try {
    // cursor: no provider override (H unsupported); agy: operator skip;
    // claude: H's opt-in gate (claude is the one H harness, and an absent
    // mirror reads unknown, so its cells run and H skips on the opt-in).
    const rows = await runProbes(
      [factsFor("cursor"), factsFor("agy"), factsFor("claude")],
      parseOptions(["--probe", "A,H", "--skip", "agy"], ""),
      {
        async run() { return { status: "PASS", seconds: 0, stderr: "" }; },
        async capture() { throw new Error("nothing here captures"); },
      },
      reportDirectory, fixture.env);
    expect(rows[0]!.results.A).toMatchObject({ status: "PASS" });
    expect(rows[0]!.results.H).toMatchObject({ status: "UNSUPPORTED" });
    expect(rows[1]!.results.A).toMatchObject({ status: "SKIP", note: "operator requested" });
    // The capability check runs before the operator skip: agy declares
    // no provider override (a harness limitation), so H is UNSUPPORTED,
    // not the operator's SKIP. Gemini gained an override in 2.0.0.
    expect(rows[1]!.results.H).toMatchObject({ status: "UNSUPPORTED" });
    expect(rows[2]!.results.A).toMatchObject({ status: "PASS" });
    expect(rows[2]!.results.H).toMatchObject({
      status: "SKIP",
      note: "opt-in probe: --probe provider-override with LIVE_GATE_PROVIDER_OVERRIDE=1 and the CODEMUX_CLAUDE_PROVIDER_* environment exported",
    });
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
});

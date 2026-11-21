import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { formatReport, parseOptions, runProbes } from "../scripts/live-gate.js";
import { cleanupLoggedInHomes, factsFor, fixtureDirectory, loggedInEnv, reportInput } from "./helpers/live-gate.js";

afterAll(cleanupLoggedInHomes);

test("native run/session/check probes opt claude and agy into sandbox login stores", async () => {
  const fixture = loggedInEnv();
  const directory = fixtureDirectory();
  const commands: string[][] = [];
  const capture = async (command: string[]) => {
    commands.push(command);
    return { status: "PASS" as const, seconds: 0, stderr: "" };
  };
  try {
    await runProbes([factsFor("claude"), factsFor("agy"), factsFor("codex")],
      parseOptions(["--probe", "A,B,C,D,E,F,G,I2,K,P"], ""),
      { run: capture, capture }, directory, fixture.env);
    for (const agent of ["claude", "agy", "codex"]) {
      const selected = commands.filter((command) => command[command.indexOf("-a") + 1] === agent);
      expect(selected.length).toBeGreaterThan(0);
      expect(selected.some((command) => command[1] === "session")).toBe(true);
      expect(selected.some((command) => command[1] === "check")).toBe(true);
      expect(selected.some((command) => command.includes("--print-sandbox"))).toBe(true);
      for (const command of selected) {
        expect(command.includes("--sandbox-login-store"), command.join(" "))
          .toBe(agent !== "codex");
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provider-override probes do not opt into native login stores", async () => {
  const fixture = loggedInEnv({
    LIVE_GATE_PROVIDER_OVERRIDE: "1",
    CODEMUX_CLAUDE_PROVIDER_BASE_URL: "https://provider.example/v1",
    CODEMUX_CLAUDE_PROVIDER_API_KEY: "synthetic",
    CODEMUX_CLAUDE_PROVIDER_MODEL: "synthetic-model",
  });
  const directory = fixtureDirectory();
  const commands: string[][] = [];
  try {
    await runProbes([factsFor("claude")],
      parseOptions(["--probe", "H,H2"], "", fixture.env), {
        async run() { throw new Error("override probes must capture"); },
        async capture(command) {
          commands.push(command);
          return { status: "PASS", seconds: 0, stderr: "" };
        },
      }, directory, fixture.env);
    expect(commands).toHaveLength(2);
    for (const command of commands) expect(command).not.toContain("--sandbox-login-store");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the live-gate report header discloses the explicit sandbox login-store opt-in and exclusions", () => {
  const header = formatReport(reportInput()).split("| Agent |", 1)[0]!;
  expect(header).toContain("claude and agy explicitly pass --sandbox-login-store");
  expect(header).toContain("including hermetic check canaries and print-sandbox");
  expect(header).toContain("Provider-override probes do not opt in");
});

test("no-network policy prints use the native probes' explicit login-store policy", async () => {
  const fixture = loggedInEnv();
  const directory = fixtureDirectory();
  const commands: string[][] = [];
  try {
    await runProbes([factsFor("claude"), factsFor("agy")], parseOptions(["--probe", "J"], ""), {
      async run() { throw new Error("a refused synthetic print must not start a command"); },
      async capture(command) {
        commands.push(command);
        return { status: "FAIL", seconds: 0, stderr: "synthetic print refusal" };
      },
    }, directory, fixture.env);
    expect(commands).toHaveLength(2);
    for (const command of commands) expect(command).toContain("--sandbox-login-store");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

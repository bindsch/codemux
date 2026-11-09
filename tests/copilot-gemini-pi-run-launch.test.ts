import { expect, spyOn, test } from "bun:test";
import { Command } from "commander";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig } from "../src/config.js";
import { registerRunCommand } from "../src/run-command.js";
import { createFakeBinaryEnv } from "./helpers/cli.js";

type Agent = "copilot" | "gemini" | "pi";
class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
const versions = { copilot: "Copilot binary version: 1.0.85", gemini: "0.60.0", pi: "0.85.1" };
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const fixturePath = join(import.meta.dir, "fixtures/live/fake-copilot-gemini-pi-run.ts");

async function launch(agent: Agent, flags: string[], prompt: string, override = false, expectedExit = 0) {
  const home = mkdtempSync(join(tmpdir(), "w3-run-launch-"));
  const workdir = join(home, "work");
  mkdirSync(workdir);
  const observation = join(home, "observed.json");
  const fake = createFakeBinaryEnv({ [agent]:
    `if [ "$1" = "--version" ] || [ "$1" = "--binary-version" ]; then printf '%s\\n' '${versions[agent]}'; exit 0; fi\n` +
    `exec bun ${quote(fixturePath)} ${agent} "$@"`,
  });
  const prior = { ...process.env };
  const priorExitCode = process.exitCode;
  const stdout: string[] = [];
  const errors: string[] = [];
  const error = spyOn(console, "error").mockImplementation((...values) => { errors.push(values.map(String).join(" ")); });
  const write = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write);
  const exit = spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Exit(code ?? 0); }) as typeof process.exit);
  try {
    for (const key of Object.keys(process.env)) {
      if (/^(CODEMUX_(COPILOT|GEMINI|PI)_PROVIDER_|COPILOT_|GEMINI_|GOOGLE_|PI_)/.test(key)) delete process.env[key];
    }
    Object.assign(process.env, fake.env, { HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
      W3_OBSERVATION: observation, CODEMUX_NO_KEYCHAIN_SYNC: "1" });
    if (override) {
      const prefix = `CODEMUX_${agent.toUpperCase()}_PROVIDER_`;
      process.env[`${prefix}BASE_URL`] = "http://127.0.0.1:9/v1";
      process.env[`${prefix}API_KEY`] = "synthetic-key";
      process.env[`${prefix}MODEL`] = "synthetic-model";
      process.env[`${prefix}MAX_OUTPUT_TOKENS`] = "1234";
      if (agent === "copilot") process.env[`${prefix}MAX_CONTEXT_TOKENS`] = "4000";
    }
    const program = new Command();
    program.exitOverride();
    registerRunCommand(program, getDefaultConfig(), () => {});
    let code: number | undefined;
    try {
      await program.parseAsync(["node", "codemux", "run", "-a", agent, "--no-sandbox", "--auto", "high",
        "--cwd", workdir, "--timeout", "5", "--pass-env", "W3_OBSERVATION", "--result-json", "-p", prompt, ...flags]);
      code = typeof process.exitCode === "number" ? process.exitCode : undefined;
    } catch (caught) {
      if (!(caught instanceof Exit)) throw caught;
      code = caught.code;
    }
    expect(code, errors.join("\n")).toBe(expectedExit);
    const observed = JSON.parse(readFileSync(observation, "utf8")) as {
      args: string[]; stdin: string; policy: string | null;
      settings: { tools?: { core?: unknown[] }; modelConfigs?: unknown } | null;
      provider: { models: Record<string, unknown>[] } | null;
      budgetAborted?: boolean;
      session?: { excludedTools: string[]; model: string; models: Record<string, unknown>[] } | null;
    };
    return { observed, envelope: JSON.parse(stdout.join("")) };
  } finally {
    error.mockRestore(); write.mockRestore(); exit.mockRestore();
    for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
    Object.assign(process.env, prior);
    process.exitCode = priorExitCode;
    fake.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
}

test.each(["copilot", "gemini", "pi"] as const)("%s launches long stdin and no-web through the run command", async (agent) => {
  const prompt = "synthetic prompt ".repeat(10_000);
  const { observed, envelope } = await launch(agent, ["--no-web"], prompt);
  expect(observed.stdin.trimEnd()).toBe(prompt.trimEnd());
  expect(observed.args).not.toContain(prompt);
  if (agent === "copilot") {
    // A --result-json copilot run is the observed RPC session (launch.ts
    // prepareCopilotModelRun): the prompt rides session.send, no-web rides
    // excludedTools, usage comes from the native metrics, and the served
    // model is the provider response's own model.
    expect(envelope.codemux.usage).toMatchObject({ input_tokens: 5, output_tokens: 5, total_tokens: 10 });
    expect(observed.session?.excludedTools).toEqual(expect.arrayContaining(["builtin:web_fetch", "mcp:web_search"]));
    expect(envelope.codemux.served_model).toBe("copilot-provider-model");
    return;
  }
  expect(envelope.codemux.usage).toMatchObject({ input_tokens: 10, output_tokens: 2, cached_input_tokens: 3, total_tokens: 15 });
  if (agent === "gemini") {
    expect(observed.policy).toContain('toolName = "google_web_search"');
    expect(observed.policy).toContain('toolName = "web_fetch"');
  } else expect(observed.args).toContain("--mode");
}, 15_000);

test("copilot delivers both provider token caps before the fake child runs", async () => {
  const { observed } = await launch("copilot", [], "synthetic cap", true);
  expect(observed.session?.models[0]).toMatchObject({ maxOutputTokens: 1234, maxContextWindowTokens: 4000 });
  expect(observed.session?.model).toBe("codemux/model");
  expect(observed.args.join(" ")).not.toContain("synthetic-key");
});

test("gemini delivers the output cap through the run settings file", async () => {
  const { observed } = await launch("gemini", [], "synthetic cap", true);
  expect(JSON.stringify(observed.settings?.modelConfigs)).toContain('"maxOutputTokens":1234');
  expect(observed.args.join(" ")).not.toContain("synthetic-key");
});

test("gemini plain tools-none delivers a native empty core allowlist", async () => {
  const { observed } = await launch("gemini", ["--tools", "none"], "synthetic tools");
  expect(observed.settings?.tools?.core).toEqual([]);
  expect(observed.policy).toContain('toolName = "*"');
});

test.each(["0.02", "0.01"])("pi enforces USD budget %s through a fake child and the actual run command", async (limit) => {
  const exhausted = limit === "0.01";
  const { observed, envelope } = await launch("pi", ["--max-budget-usd", limit], "synthetic budget", false, exhausted ? 1 : 0);
  expect(observed.args).toContain("--extension");
  expect(observed.budgetAborted).toBe(exhausted);
  expect(envelope.codemux.usage.cost_usd).toBe(0.01);
  expect(envelope.codemux.failure_code).toBe(exhausted ? "budget-limit" : null);
});

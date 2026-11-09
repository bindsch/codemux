import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AiderAdapter, AIDER_NO_TOOLS_FLAGS } from "../src/adapters/aider.js";
import { createAiderRunFiles } from "../src/aider-run-files.js";
import { runCapturedCommand } from "../src/process-runner.js";
import { AIDER_RUN_LIMITATIONS } from "../src/parity/reasons-run-aider.js";
import { RUN_DECLARATIONS } from "../src/parity/declarations-run.js";

const directories: string[] = [];
function fixture(): string {
  const root = join(process.cwd(), "scratch", "fix", "w5-test-fixtures");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "aider-"));
  mkdirSync(join(dir, ".git"));
  directories.push(dir);
  return dir;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function refusal(key: keyof typeof AIDER_RUN_LIMITATIONS): string {
  const state = AIDER_RUN_LIMITATIONS[key];
  if (state.state !== "harness-limitation") throw new Error("expected an evidenced limitation");
  return state.refusal;
}

describe("Aider run carriers", () => {
  test("a fake PATH child reads the exact private prompt while stdin declines confirmations", async () => {
    const home = fixture();
    const binary = join(home, "aider");
    writeFileSync(binary, `#!${process.execPath}
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const prompt = await Bun.file(value("--message-file")).text();
const settings = JSON.parse(await Bun.file(value("--model-settings-file")).text());
const reader = Bun.stdin.stream().getReader();
const first = await reader.read();
await Bun.write(value("--analytics-log"), JSON.stringify({event:"message_send", properties:{completion_tokens:2,total_cost:0.25}}));
console.log(JSON.stringify({prompt, settings, decline:new TextDecoder().decode(first.value).slice(0,2), noWeb:args.includes("--no-detect-urls"), noTools:value("--chat-mode")==="ask" && ["--no-git","--no-auto-lint","--no-auto-test"].every(flag=>args.includes(flag))}));
`, { mode: 0o700 });
    const prompt = `private leading dash --x\n${"é".repeat(40_000)}\nend`;
    const adapter = new AiderAdapter({ HOME: home, PATH: home,
      CODEMUX_AIDER_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
      CODEMUX_AIDER_PROVIDER_API_KEY: "synthetic-only",
      CODEMUX_AIDER_PROVIDER_MODEL: "test-model",
      CODEMUX_AIDER_PROVIDER_MAX_OUTPUT_TOKENS: "123",
    });
    const request = { agent: "aider" as const, prompt, cwd: home, autonomy: "high" as const, web: false, tools: "none" as const };
    adapter.validateRunRequest(request);
    const context = adapter.prepareRun(request);
    try {
      const command = adapter.buildRunCommand(request, context);
      expect(command.join(" ")).not.toContain(prompt);
      expect(command).toContain("--no-stream");
      const result = await runCapturedCommand(command, {
        cwd: home, env: { PATH: home }, stdinInput: adapter.getStdinInput(request),
        stdinRepeats: adapter.stdinRepeats(request), timeoutMs: 5000,
      });
      expect(result.exitCode).toBe(0);
      const observed = JSON.parse(result.stdout);
      expect(observed.prompt).toBe(prompt);
      expect(observed.decline).toBe("n\n");
      expect(observed.noWeb).toBe(true);
      expect(observed.noTools).toBe(true);
      expect(observed.settings[0].extra_params.max_tokens).toBe(123);
      expect(adapter.processRunResult(result, request, context).usage).toMatchObject({ output_tokens: 2, cost_usd: 0.25 });
    } finally { adapter.cleanupRunSync(context); }
    expect(existsSync(context.aiderRunFiles!.home)).toBe(false);
  });

  test("run files are private, independent, and removed on preparation failure", () => {
    const home = fixture();
    const source = join(home, ".aider");
    const first = createAiderRunFiles(source, "first");
    const second = createAiderRunFiles(source, "second");
    expect(first.home).not.toBe(second.home);
    expect(statSync(first.home).mode & 0o777).toBe(0o700);
    expect(statSync(first.promptPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(first.promptPath, "utf8")).toBe("first");
    first.finalize();
    first.finalize();
    expect(readFileSync(second.promptPath, "utf8")).toBe("second");
    second.finalize();
    expect(() => createAiderRunFiles(source, "p", undefined, 10)).toThrow("requires a resolved model");
    expect(readdirSync(join(source, ".codemux-hermetic"))).toEqual([]);
  });

  test("web denial preserves every autonomy level and the ordinary default", () => {
    const adapter = new AiderAdapter({ HOME: fixture() });
    for (const autonomy of ["read-only", "low", "medium", "high"] as const) {
      const command = adapter.buildRunCommand({ agent: "aider", prompt: "p", autonomy, web: false });
      expect(command).toContain("--no-detect-urls");
      if (autonomy === "medium" || autonomy === "high") expect(command).toContain("--yes-always");
    }
    expect(adapter.buildRunCommand({ agent: "aider", prompt: "p" })).not.toContain("--no-detect-urls");
  });

  test("unsupported native controls fail before any child launch", () => {
    const adapter = new AiderAdapter({ HOME: fixture(), PATH: "" });
    for (const [option, value, reason] of [
      ["maxBudgetUsd", 1, "budget"], ["experimentProjectSettings", true, "project"],
      ["enablePlaywrightMcp", true, "playwrightMcp"], ["experimentMcp", "fixture.json", "experimentMcp"],
    ] as const) {
      expect(() => adapter.validateRunRequest({ agent: "aider", prompt: "p", sandboxed: true, [option]: value }))
        .toThrow(refusal(reason));
    }
    for (const state of Object.values(RUN_DECLARATIONS.aider)) {
      if (state.state === "harness-limitation") expect(state.reason).not.toContain("OPEN:");
    }
  });

  test("ask without Git removes every model tool at all autonomy levels", () => {
    const home = fixture();
    const adapter = new AiderAdapter({ HOME: home, PATH: "" });
    for (const autonomy of ["read-only", "low", "medium", "high"] as const) {
      for (const hermetic of [false, true]) {
        const request = { agent: "aider" as const, prompt: "p", cwd: home, tools: "none" as const, autonomy, hermetic };
        expect(() => adapter.validateRunRequest(request)).not.toThrow();
        const command = adapter.buildRunCommand(request);
        for (const flag of AIDER_NO_TOOLS_FLAGS) expect(command).toContain(flag);
        expect(command).toContain("--no-suggest-shell-commands");
      }
    }
    expect(adapter.buildRunCommand({ agent: "aider", prompt: "p" })).not.toContain("--chat-mode");
  });
});

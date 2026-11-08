import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAdapter } from "../src/adapters/index.js";
import { AGENT_IDS } from "../src/types.js";
import { assertExperimentMcpUnavailable, readExperimentSpec, validateExperimentRequest } from "../src/experiment-mcp.js";
import { runCli, minimalPath } from "./helpers/cli.js";
import { MARKER, respond } from "./fixtures/experiment-mcp.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function specification(extra: Record<string, unknown> = {}) {
  const scratch = resolve("scratch");
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, "experiment-spec-test-"));
  directories.push(directory);
  const path = join(directory, "spec.json");
  const spec = { name: "experiment", command: process.execPath, args: [], env: [], ...extra };
  writeFileSync(path, JSON.stringify(spec));
  return { path, spec };
}

describe("experiment MCP validates its harness result contract", () => {
  test("omitting the flag leaves requests unchanged", () => {
    expect(() => assertExperimentMcpUnavailable("claude", undefined)).not.toThrow();
  });

  test("rejects invalid spec arguments without opening a file", () => {
    for (const agent of AGENT_IDS) {
      for (const spec of [null, 12, {}, [], "", " ", "file\0.json"]) {
        expect(() => assertExperimentMcpUnavailable(agent, spec)).toThrow("specification path");
      }
    }
  });

  for (const agent of AGENT_IDS.filter((agent) => !["claude", "zai", "codex", "kimi"].includes(agent))) {
    test(`${agent} refuses before preparing or spawning a harness`, () => {
      const request = { agent, prompt: "probe", hermetic: true, tools: "none" as const,
        autonomy: "read-only" as const, sandboxed: true, experimentMcp: "/does/not/exist.json" };
      expect(() => getAdapter(agent).validateRunRequest(request)).toThrow("no verified");
    });
  }

  test("Codex reads the spec and requires its exact header opt-in", () => {
    for (const extra of [{}, { accept_harness_prefix: [] }]) {
      const { path } = specification(extra);
      expect(() => assertExperimentMcpUnavailable("codex", path)).toThrow("accept_harness_prefix");
      expect(() => assertExperimentMcpUnavailable("codex", path)).toThrow("Wall time: {secs:.4} seconds\\nOutput:");
    }
    const { path } = specification({ accept_harness_prefix: ["codex-wall-time"] });
    expect(() => assertExperimentMcpUnavailable("codex", path)).not.toThrow();
    expect(() => assertExperimentMcpUnavailable("codex", "/does/not/exist.json")).toThrow("ENOENT");
  });

  test("Kimi reads the spec and requires its own header opt-in", () => {
    for (const extra of [{}, { accept_harness_prefix: [] }, { accept_harness_prefix: ["codex-wall-time"] }]) {
      const { path } = specification(extra);
      expect(() => assertExperimentMcpUnavailable("kimi", path)).toThrow("kimi-wall-time");
      expect(() => assertExperimentMcpUnavailable("kimi", path)).toThrow("Wall time: {secs:.3} seconds");
    }
    const { path } = specification({ accept_harness_prefix: ["kimi-wall-time"] });
    expect(() => assertExperimentMcpUnavailable("kimi", path)).not.toThrow();
    expect(() => assertExperimentMcpUnavailable("kimi", "/does/not/exist.json")).toThrow("ENOENT");
  });

  test("accept_harness_prefix accepts only a unique array of known prefixes", () => {
    for (const value of [null, false, "codex-wall-time", {}, [null], ["unknown"],
      ["codex-wall-time", "codex-wall-time"], ["kimi-wall-time", "kimi-wall-time"]]) {
      const { path } = specification({ accept_harness_prefix: value });
      expect(() => readExperimentSpec(path)).toThrow("accept_harness_prefix");
    }
    for (const value of [[], ["codex-wall-time"], ["kimi-wall-time"], ["codex-wall-time", "kimi-wall-time"]]) {
      const { path, spec } = specification({ accept_harness_prefix: value });
      expect(readExperimentSpec(path)).toEqual(spec);
    }
  });

  test("Claude and Z.AI ignore a valid accepted-prefix field", () => {
    for (const agent of ["claude", "zai"] as const) {
      for (const extra of [{}, { accept_harness_prefix: [] }, { accept_harness_prefix: ["codex-wall-time"] }]) {
        const { path } = specification(extra);
        expect(() => validateExperimentRequest({ agent, prompt: "probe", hermetic: true, tools: "none",
          autonomy: "read-only", sandboxed: true, experimentMcp: path })).not.toThrow();
      }
    }
  });

  for (const command of ["run", "check"]) {
    test(`Kimi ${command} refuses its missing prefix opt-in before stdin or installation checks`, async () => {
      const { path } = specification();
      const result = await runCli([command, "-a", "kimi", "--hermetic", "--tools", "none", "--experiment-mcp", path,
        ...(command === "run" ? ["-f", "-"] : [])], { PATH: minimalPath() }, { stdin: "", holdStdin: true });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("kimi-wall-time");
      expect(result.stderr).toContain("Wall time:");
      expect(result.stderr).not.toContain("not installed");
      expect(result.stdout).toBe("");
    });
  }

  test("Codex refuses a disconnected loopback relay", () => {
    const { path } = specification({ accept_harness_prefix: ["codex-wall-time"] });
    const request = { agent: "codex" as const, prompt: "probe", hermetic: true, tools: "none" as const,
      autonomy: "read-only" as const, sandboxed: true, experimentMcp: path };
    expect(() => validateExperimentRequest(request)).not.toThrow();
    const disconnected = { ...request, sandboxNoNet: true };
    expect(() => validateExperimentRequest(disconnected)).toThrow("--sandbox-no-net");
  });

  for (const command of ["run", "check"]) {
    test(`${command} parses the flag and refuses before installation checks or stdin`, async () => {
      const { path } = specification();
      const result = await runCli([command, "-a", "codex", "--hermetic", "--tools", "none",
        "--experiment-mcp", path, ...(command === "run" ? ["-f", "-"] : [])],
      { PATH: minimalPath() }, { stdin: "", holdStdin: true });
      expect(result.exitCode).not.toBe(0);
      // run demands the spec prefix (its header names the wall-time
      // wrapper); a codex check is refused outright before that demand
      // (review round 381), so the operator is not sent to fix the spec.
      expect(result.stderr).toContain(command === "run" ? "Wall time:" : "Codex --experiment-mcp supports run only");
      expect(result.stderr).not.toContain("not installed");
      expect(result.stderr).not.toContain("unknown option");
      expect(result.stdout).toBe("");
    });

    test(`${command} requires a spec argument`, async () => {
      const result = await runCli([command, "--experiment-mcp"], { PATH: minimalPath() });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("argument missing");
    });
  }

  test("Codex's default refusal names its header and required opt-in", async () => {
    const { path } = specification();
    const result = await runCli(["run", "-a", "codex", "--hermetic", "--tools", "none",
      "--experiment-mcp", path, "-p", "probe"], { PATH: minimalPath() });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Wall time:");
    expect(result.stderr).toContain("accept_harness_prefix");
  });

  test("plain runs cannot bypass the refusal", async () => {
    const result = await runCli(["run", "--experiment-mcp", "/missing.json", "--auto", "high",
      "--no-sandbox", "-p", "probe"], { PATH: minimalPath() });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--experiment-mcp requires");
  });
});

describe("experiment MCP diagnostic fixture", () => {
  test("has only bash, returns a fixed marker, and ignores command text", () => {
    const list = respond({ id: 1, method: "tools/list" }) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((tool) => tool.name)).toEqual(["bash"]);
    expect(respond({ id: 2, method: "tools/call", params: { name: "bash" } })).toEqual({
      jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: MARKER }] },
    });
    expect(respond({ method: "notifications/initialized" })).toBeNull();
    expect(respond({ id: 3, method: "tools/call", params: { name: "exec_command" } })).toHaveProperty("error");
    expect(respond({ id: 4, method: "unknown" })).toHaveProperty("error");
    expect(respond({ id: 5, method: "ping" })).toHaveProperty("result");
  });

  test("stdio emits valid JSONL with the exact server marker", async () => {
    const proc = Bun.spawn([process.execPath, "--no-env-file", "--no-install",
      "--config=./bunfig.runtime.toml", "tests/fixtures/experiment-mcp.ts"], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const messages = [
      { id: 0, method: "initialize" }, { method: "notifications/initialized" },
      { id: 1, method: "tools/list" }, { id: 2, method: "tools/call", params: { name: "bash", command: "ignored" } },
    ];
    proc.stdin.write(messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
    proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim().split("\n").map((line) => JSON.parse(line)))
      .toEqual(messages.map(respond).filter(Boolean));
  });
});

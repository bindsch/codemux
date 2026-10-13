import { describe, expect, test } from "bun:test";
import { getAdapter } from "../src/adapters/index.js";
import { AGENT_IDS } from "../src/types.js";
import { assertExperimentMcpUnavailable } from "../src/experiment-mcp.js";
import { runCli, minimalPath } from "./helpers/cli.js";
import { MARKER, respond } from "./fixtures/experiment-mcp.js";

describe("experiment MCP refuses an unverified result contract", () => {
  test("omitting the flag leaves requests unchanged", () => {
    expect(() => assertExperimentMcpUnavailable("claude", undefined)).not.toThrow();
  });

  test("rejects invalid spec arguments without opening a file", () => {
    for (const spec of [null, 12, {}, [], "", " ", "file\0.json"]) {
      expect(() => assertExperimentMcpUnavailable("claude", spec)).toThrow("specification path");
    }
  });

  for (const agent of AGENT_IDS.filter((agent) => agent !== "claude")) {
    test(`${agent} refuses before preparing or spawning a harness`, () => {
      const request = { agent, prompt: "probe", hermetic: true, tools: "none" as const,
        autonomy: "read-only" as const, sandboxed: true, experimentMcp: "/does/not/exist.json" };
      const reason = agent === "codex" ? "Wall time:" : "no verified";
      expect(() => getAdapter(agent).validateRunRequest(request)).toThrow(reason);
    });
  }

  for (const command of ["run", "check"]) {
    test(`${command} parses the flag and refuses before installation checks or stdin`, async () => {
      const result = await runCli([command, "-a", "codex", "--hermetic", "--tools", "none",
        "--experiment-mcp", "/missing.json", ...(command === "run" ? ["-f", "-"] : [])],
      { PATH: minimalPath() }, { stdin: "", holdStdin: true });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Wall time:");
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

  test("Codex reports the byte-control limitation", async () => {
    const result = await runCli(["run", "-a", "codex", "--hermetic", "--tools", "none",
      "--experiment-mcp", "/missing.json", "-p", "probe"], { PATH: minimalPath() });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Wall time:");
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

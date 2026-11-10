import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAdapter } from "../src/adapters/pi.js";
import { PI_AGENT_DIR_ENV, PI_PROVIDER_KEY_ENV } from "../src/pi-provider.js";
import { PI_ANSWER_FIELD, parsePiResultEnvelope, piResult } from "../src/result-envelope/pi.js";
import type { RunRequest, RunResult } from "../src/types.js";

// Lane R-a: pi's run-surface parity. The --no-approve regression (the
// flag means project trust at 0.85.1, not auto-approve), the --hermetic
// private agent directory, and the --result-json envelope over pi's
// `--mode json` event wire.

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "codemux-pi-parity-"));
}

describe("pi --no-approve: project trust at every level", () => {
  const adapter = new PiAdapter();

  test("TUI passes --no-approve at every autonomy level (regression)", () => {
    expect(adapter.buildTuiCommand(undefined, "read-only"))
      .toEqual(["pi", "--no-approve", "--no-extensions", "--tools", "read,grep,find,ls"]);
    expect(adapter.buildTuiCommand(undefined, "low"))
      .toEqual(["pi", "--no-approve", "--no-extensions", "--tools", "read,grep,find,ls,edit,write"]);
    expect(adapter.buildTuiCommand(undefined, "medium"))
      .toEqual(["pi", "--no-approve"]);
    expect(adapter.buildTuiCommand(undefined, "high"))
      .toEqual(["pi", "--no-approve"]);
  });

  test("TUI without autonomy still passes --no-approve", () => {
    expect(adapter.buildTuiCommand()).toEqual(["pi", "--no-approve"]);
    expect(adapter.buildTuiCommand("model-x"))
      .toEqual(["pi", "--no-approve", "--model", "model-x"]);
  });

  test("run path keeps --no-approve unconditionally", () => {
    expect(adapter.buildRunCommand({ agent: "pi", prompt: "p" }))
      .toEqual(["pi", "--print", "--no-session", "--no-approve", "--mode", "json"]);
  });
});

describe("pi --hermetic: private agent directory", () => {
  function hermeticAdapter(home: string): PiAdapter {
    return new PiAdapter({ HOME: home }, home);
  }

  test("prepareRun relocates the agent directory; nothing operator-owned loads", () => {
    const home = tempHome();
    try {
      const adapter = hermeticAdapter(home);
      const request: RunRequest = { agent: "pi", prompt: "p", hermetic: true };
      adapter.validateRunRequest(request);
      const context = adapter.prepareRun(request);
      const dir = context.piProviderAgentDir;
      expect(dir).toBeDefined();
      expect(dir!.path.startsWith(join(home, ".pi", "agent", ".codemux", `hermetic-${process.pid}-`))).toBe(true);
      // The private directory ships no SYSTEM.md, no settings.json, no
      // models.json (no override) and no auth.json (the operator has none).
      expect(existsSync(join(dir!.path, "SYSTEM.md"))).toBe(false);
      expect(existsSync(join(dir!.path, "settings.json"))).toBe(false);
      expect(existsSync(join(dir!.path, "models.json"))).toBe(false);
      expect(existsSync(join(dir!.path, "auth.json"))).toBe(false);
      expect(adapter.getRunEnv(request, context))
        .toEqual({ [PI_AGENT_DIR_ENV]: dir!.path });
      adapter.cleanupRunSync(context);
      expect(existsSync(dir!.path)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an operator file login shares the private directory by hard link", () => {
    const home = tempHome();
    try {
      const agentDir = join(home, ".pi", "agent");
      mkdirSync(agentDir, { recursive: true });
      const auth = join(agentDir, "auth.json");
      writeFileSync(auth, "{}\n", { mode: 0o600 });
      const adapter = hermeticAdapter(home);
      const context = adapter.prepareRun({ agent: "pi", prompt: "p", hermetic: true });
      const linked = join(context.piProviderAgentDir!.path, "auth.json");
      expect(statSync(linked).ino).toBe(statSync(auth).ino);
      adapter.cleanupRunSync(context);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a symlink login file is refused, not followed", () => {
    const home = tempHome();
    try {
      const agentDir = join(home, ".pi", "agent");
      mkdirSync(join(agentDir, "elsewhere"), { recursive: true });
      writeFileSync(join(agentDir, "elsewhere", "real.json"), "{}\n");
      symlinkSync(join(agentDir, "elsewhere", "real.json"), join(agentDir, "auth.json"));
      const adapter = hermeticAdapter(home);
      expect(() => adapter.prepareRun({ agent: "pi", prompt: "p", hermetic: true })).toThrow("not a regular file");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an override ride-along writes models.json and links no login", () => {
    const home = tempHome();
    try {
      const agentDir = join(home, ".pi", "agent");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, "auth.json"), "{}\n", { mode: 0o600 });
      const adapter = new PiAdapter({
        HOME: home,
        CODEMUX_PI_PROVIDER_BASE_URL: "https://api.example/v1",
        CODEMUX_PI_PROVIDER_API_KEY: "key-1",
        CODEMUX_PI_PROVIDER_MODEL: "provider-model",
      }, home);
      const request: RunRequest = { agent: "pi", prompt: "p", hermetic: true };
      adapter.validateRunRequest(request);
      const context = adapter.prepareRun(request);
      const dir = context.piProviderAgentDir!.path;
      const models = JSON.parse(readFileSync(join(dir, "models.json"), "utf-8"));
      expect(models.providers.codemux.models[0].id).toBe("provider-model");
      expect(existsSync(join(dir, "auth.json"))).toBe(false);
      const env = adapter.getRunEnv(request, context);
      expect(env[PI_AGENT_DIR_ENV]).toBe(dir);
      expect(env[PI_PROVIDER_KEY_ENV]).toBe("key-1");
      adapter.cleanupRunSync(context);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("buildRunCommand adds --no-context-files only under --hermetic", () => {
    const adapter = new PiAdapter();
    expect(adapter.buildRunCommand({ agent: "pi", prompt: "p", hermetic: true }))
      .toEqual(["pi", "--print", "--no-session", "--no-approve", "--mode", "json", "--no-context-files"]);
    expect(adapter.buildRunCommand({ agent: "pi", prompt: "p" }))
      .toEqual(["pi", "--print", "--no-session", "--no-approve", "--mode", "json"]);
  });

  test("a passed-through agent directory cannot combine with --hermetic", () => {
    const adapter = new PiAdapter({ PI_CODING_AGENT_DIR: "/tmp/agent" });
    expect(() => adapter.validateRunRequest({
      agent: "pi",
      prompt: "p",
      hermetic: true,
      passthroughEnv: [PI_AGENT_DIR_ENV],
    })).toThrow("--hermetic cannot combine with a passed-through PI_CODING_AGENT_DIR");
  });
});

describe("pi --result-json: the --mode json wire", () => {
  const adapter = new PiAdapter();

  test("a result-json run switches the print mode", () => {
    expect(adapter.buildRunCommand({ agent: "pi", prompt: "p", resultJson: true }))
      .toEqual(["pi", "--print", "--no-session", "--no-approve", "--mode", "json"]);
  });

  test("the reply is the last assistant message's text blocks", () => {
    const wire = [
      JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "go" }] } }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          model: "gemini-2.5-pro",
          usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, totalTokens: 20, cost: { total: 0.01 } },
          stopReason: "tool_calls",
          content: [{ type: "tool_call", tool: "read" }],
        },
      }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          model: "gemini-2.5-pro",
          usage: { input: 7, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 9, cost: { total: 0.004 } },
          stopReason: "stop",
          content: [
            { type: "thinking", thinking: "internal" },
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      }),
    ].join("\n") + "\n";
    const parsed = parsePiResultEnvelope(wire)!;
    expect(parsed.answer).toBe("first\nsecond");
    expect(parsed.servedModel).toBe("gemini-2.5-pro");
    expect(parsed.usage).toEqual({
      input_tokens: 17,
      output_tokens: 7,
      cached_input_tokens: 5,
      total_tokens: 29,
      cost_usd: 0.014,
    });
  });

  test("distinct served models report null", () => {
    const wire = [
      JSON.stringify({ type: "message_end", message: { role: "assistant", model: "a", stopReason: "stop", usage: {}, content: [{ type: "text", text: "x" }] } }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", model: "b", stopReason: "stop", usage: {}, content: [{ type: "text", text: "y" }] } }),
    ].join("\n");
    const parsed = parsePiResultEnvelope(wire)!;
    expect(parsed.servedModel).toBeNull();
  });

  test("an aborted final message fails the run even at exit 0", () => {
    const wire = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", model: "m", stopReason: "aborted", errorMessage: "stop hit", usage: {}, content: [] },
    }) + "\n";
    const result = piResult(
      { stdout: wire, stderr: "", exitCode: 0, success: true },
      { agent: "pi", prompt: "p", resultJson: true }
    );
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("reported a aborted stop (stop hit)");
    expect(JSON.parse(result.stdout).codemux.failure_code).toBe("harness-error");
  });

  test("no wire events fails loudly", () => {
    const result = piResult(
      { stdout: "plain text\n", stderr: "", exitCode: 0, success: true },
      { agent: "pi", prompt: "p", resultJson: true }
    );
    expect(result.success).toBe(false);
    expect(result.stderr).toContain("pi printed no wire events");
  });

  test("a wire with no assistant message fails", () => {
    const wire = JSON.stringify({ type: "session", sessionId: "s" }) + "\n";
    const result = piResult(
      { stdout: wire, stderr: "", exitCode: 0, success: true },
      { agent: "pi", prompt: "p", resultJson: true }
    );
    expect(result.success).toBe(false);
    expect(result.stderr).toContain("reported no assistant message");
  });

  test("the envelope carries the reply under the family answer field", () => {
    expect(PI_ANSWER_FIELD).toBe("reply");
    const wire = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        model: "m",
        stopReason: "stop",
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } },
        content: [{ type: "text", text: "done" }],
      },
    }) + "\n";
    const request: RunRequest = { agent: "pi", prompt: "p", resultJson: true, model: "m" };
    const result = piResult({ stdout: wire, stderr: "", exitCode: 0, success: true } as RunResult, request);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.reply).toBe("done");
    expect(envelope.codemux).toEqual({
      agent: "pi",
      labels: null,
      model: "m",
      served_model: "m",
      model_alias: null,
      usage: { input_tokens: 1, output_tokens: 2, cached_input_tokens: 0, total_tokens: 3, cost_usd: 0 },
      session_id: null,
      recording: null,
      failure_code: null,
      final_message: "done",
      truncated: false,
    });
    expect(result.stdout.endsWith("\n")).toBe(true);
  });
});

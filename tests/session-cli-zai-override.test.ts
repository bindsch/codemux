import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driveSession, fakeClaudeEnv } from "./helpers/session-cli.js";
import { runCli } from "./helpers/cli.js";
import { readRegistry, sessionRegistryPath } from "../src/session/registry.js";

test("Zai override reaches a fresh and resumed fake session without a Z.AI login", async () => {
  const fake = fakeClaudeEnv();
  const home = mkdtempSync(join(tmpdir(), "codemux-zai-override-"));
  const workdir = join(home, "work");
  mkdirSync(workdir);
  const baseArgs = ["session", "-a", "zai", "--no-sandbox", "--auto", "high", "--cwd", workdir,
    "--shutdown-grace", "2", "--tools", "none", "--pass-env", "FAKE_STATE_DIR,FAKE_MODEL_ID"];
  const env = { ...fake.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), ZAI_API_KEY: "",
    CODEMUX_ZAI_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
    CODEMUX_ZAI_PROVIDER_API_KEY: "synthetic-key",
    CODEMUX_ZAI_PROVIDER_MODEL: "local-coder",
    CODEMUX_ZAI_PROVIDER_MAX_OUTPUT_TOKENS: "2048",
    CODEMUX_ZAI_PROVIDER_MAX_CONTEXT_TOKENS: "32768",
    FAKE_MODEL_ID: "served-local-coder" };
  let id: string | undefined;
  try {
    for (let turn = 0; turn < 2; turn++) {
      const session = await driveSession([...baseArgs, ...(id === undefined ? [] : ["--resume", id])], env);
      try {
        session.send({ type: "user", text: "scenario:basic hello" });
        const started = await session.waitFor("session_started", (event) => event.type === "session_started");
        const completed = await session.waitFor("turn_completed", (event) => event.type === "turn_completed");
        if (id !== undefined) expect(started.session_id).toBe(id);
        id = started.session_id;
        expect(started.agent).toBe("zai");
        expect(completed.model_served).toBe("served-local-coder");
        session.send({ type: "shutdown" });
        expect((await session.exit)[0]).toBe(0);
      } finally {
        await session.proc.kill();
      }
    }
    const registry = readRegistry(sessionRegistryPath(home));
    expect(registry.outcome).toBe("ok");
    const record = registry.outcome === "ok" ? registry.file.sessions.find((entry) => entry.id === id) : undefined;
    expect(record?.provider_base_url).toBe("http://127.0.0.1:9/v1");
    expect(record?.model).toBe("local-coder");
    const spawns = readFileSync(join(fake.stateDir, "argv.jsonl"), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line).args as string[]);
    expect(spawns).toHaveLength(2);
    for (const args of spawns) {
      expect(args[args.indexOf("--tools") + 1]).toBe("");
      expect(args[args.indexOf("--model") + 1]).toBe("local-coder");
      expect(JSON.parse(args[args.indexOf("--settings") + 1]!).modelPicker.options[0].model).toBe("local-coder");
      expect(args.join(" ")).not.toContain(env.CODEMUX_ZAI_PROVIDER_API_KEY);
    }
    expect(spawns[1]).toContain("--resume");
    const rejected = await runCli([...baseArgs, "--resume", id!], {
      ...env, CODEMUX_ZAI_PROVIDER_BASE_URL: "http://127.0.0.1:10/v1",
    });
    expect(rejected.exitCode).toBe(78);
    expect(rejected.stderr).toContain("provider");
    expect(readFileSync(join(fake.stateDir, "argv.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  } finally {
    fake.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

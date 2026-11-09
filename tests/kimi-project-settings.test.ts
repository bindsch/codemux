/**
 * `--experiment-project-settings` on kimi (src/kimi-project-settings.ts):
 * the validator's gates through the shared dispatch, the adapter's guard
 * flip (a plain hermetic run refuses the repository's own inputs; the
 * project-settings run loads them), the argv difference the mode makes
 * (no --skills-dir, whose presence would replace the project's own skill
 * discovery), and the session driver's per-turn command and registry
 * record over the e2e rig.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KimiAdapter } from "../src/adapters/kimi.js";
import {
  assertProjectSettingsAgent,
  validateProjectSettingsRequest,
  type ProjectSettingsRequest,
} from "../src/claude-project-settings.js";
import { buildKimiSessionCommand } from "../src/session/kimi-session.js";
import { populateKimiHermeticSessionHome } from "../src/kimi-hermetic.js";
import { readRegistry } from "../src/session/registry.js";
import { settledPrivateHomePath } from "../src/session/private-home-key.js";
import { fakePrivateHome, settledPath } from "./helpers/fake-private-home.js";
import {
  cleanups,
  of,
  send,
  startSession,
  waitFor,
  type Event,
} from "./helpers/session-kimi-e2e.js";
import type { RunRequest } from "../src/types.js";

afterAll(async () => {
  for (const clean of cleanups) await clean();
});

const base: ProjectSettingsRequest = {
  agent: "kimi", hermetic: true, autonomy: "low", sandbox: true, cwd: tmpdir(),
};

describe("kimi --experiment-project-settings", () => {
  test("the shared dispatch reaches the kimi arm and its gates", () => {
    expect(() => assertProjectSettingsAgent("kimi")).not.toThrow();
    expect(() => validateProjectSettingsRequest(base)).not.toThrow();
    // Session shape: same gates (the CLI sends session: true).
    expect(() => validateProjectSettingsRequest({ ...base, session: true })).not.toThrow();
    for (const [change, message] of [
      [{ hermetic: false }, "requires --hermetic"],
      [{ sandbox: false }, "requires the scode sandbox"],
      [{ autonomy: "read-only" }, "requires --auto low for kimi"],
      [{ autonomy: "medium" }, "requires --auto low for kimi"],
      [{ autonomy: "high" }, "requires --auto low for kimi"],
      [{ tools: "none" }, "cannot be combined with --tools none"],
      [{ experimentMcp: "spec.json" }, "cannot be combined with --experiment-mcp"],
      [{ passthroughEnv: ["KIMI_CODE_HOME"] }, "cannot be combined with --pass-env KIMI_CODE_HOME"],
    ] as const) {
      expect(() => validateProjectSettingsRequest({ ...base, ...change })).toThrow(message);
    }
  });

  test("the hermetic project-input refusal flips in project-settings mode", () => {
    const scratch = join(import.meta.dir, "../scratch");
    mkdirSync(scratch, { recursive: true });
    const home = mkdtempSync(join(scratch, "kimi-project-"));
    try {
      const brand = join(home, ".kimi-code");
      const cwd = join(home, "work");
      mkdirSync(join(brand, "credentials"), { recursive: true });
      mkdirSync(cwd, { recursive: true });
      // A repository with kimi's own project channels present: the Git
      // root's instructions and a project-local MCP file.
      mkdirSync(join(cwd, ".git"), { recursive: true });
      writeFileSync(join(cwd, "AGENTS.md"), "# project instructions\n");
      mkdirSync(join(cwd, ".kimi-code"), { recursive: true });
      writeFileSync(join(cwd, ".kimi-code", "mcp.json"), '{"mcpServers":{}}');
      const adapter = new KimiAdapter({ HOME: home }, home);
      const plain: RunRequest = {
        agent: "kimi", prompt: "parity", cwd, hermetic: true,
        autonomy: "low", sandboxed: true,
      };
      // The plain hermetic run refuses the repository's inputs; the
      // project-settings run loads them (the guard is the one refusal
      // the mode flips).
      expect(() => adapter.validateRunRequest(plain)).toThrow("refuse project customization");
      const project = { ...plain, experimentProjectSettings: true };
      expect(() => adapter.validateRunRequest(project)).not.toThrow();
      // The launch-path gate: a programmatic caller cannot reach the
      // private home without the mode's requirements.
      expect(() => adapter.prepareRun({ ...project, sandboxed: false }))
        .toThrow("requires the scode sandbox");
      expect(() => adapter.prepareRun({ ...project, hermetic: false }))
        .toThrow("requires --hermetic");
      const context = adapter.prepareRun(project);
      try {
        expect(context.kimiHermeticHome).toBeDefined();
        // The argv difference: the env prefix and the profile carrier
        // stay, --skills-dir goes (it would replace the project's own
        // skill discovery with the empty private directory).
        const argv = adapter.buildRunCommand(project, context);
        expect(argv[0]).toBe("env");
        expect(argv).toContain("--agent-file");
        expect(argv).not.toContain("--skills-dir");
        expect(adapter.buildRunCommand(plain, context)).toContain("--skills-dir");
      } finally {
        adapter.cleanupRunSync(context);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a session turn drops --skills-dir only in project-settings mode", async () => {
    // The run-hermetic shape keeps the private skills dir on the argv.
    const hermetic = buildKimiSessionCommand({ prompt: "turn", hermeticHome: "/private/home" });
    expect(hermetic).toContain("--skills-dir");
    const project = buildKimiSessionCommand({
      prompt: "turn", hermeticHome: "/private/home", projectSettings: true,
    });
    expect(project).not.toContain("--skills-dir");
    // The env prefix survives the mode: the operator's global channels
    // stay behind the redirected HOME and KIMI_CODE_HOME.
    expect(project[0]).toBe("env");
    expect(project).toContain("HOME=/private/home");

    // Over the e2e rig: the registry record carries project_settings,
    // and every per-turn command keeps the mode's argv shape.
    const home = fakePrivateHome();
    populateKimiHermeticSessionHome(home.dir, null);
    const session = await startSession({
      privateHome: home, hermetic: true, experimentProjectSettings: true,
    });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    const started = await waitFor(session.events, of("session_started"), "session_started") as Event;
    const sessionId = "session_11111111-2222-3333-4444-555555555555";
    // The settled, session-keyed name (the driver computes it from the
    // home's own dir, idempotently across the settle).
    expect(started.private_home).toBe(settledPath(home, sessionId));
    expect(settledPrivateHomePath(home.dir, sessionId)).toBe(started.private_home);
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    expect(session.argvs.length).toBeGreaterThan(0);
    for (const argv of session.argvs) {
      expect(argv).not.toContain("--skills-dir");
      expect(argv).toContain("--prompt");
    }
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const registry = readRegistry(session.options.registryPath as string);
    expect(registry.outcome).toBe("ok");
    const record = registry.outcome === "ok"
      ? registry.file.sessions.find((entry) => entry.id === sessionId)
      : undefined;
    expect(record?.project_settings).toBe(true);
    expect(record?.hermetic).toBe(true);
    home.remove();
  });
});

/** OpenHands hermetic sessions through the real `codemux session` command
 * over a fake openhands: the session-lifetime private HOME across turns,
 * --resume and --final; the native deny rule; and the project-settings
 * mode loading the working directory's own .openhands. */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRegistry } from "../src/session/registry.js";
import { OPENHANDS_DENY_HOOKS_JSON } from "../src/session/openhands-home.js";
import { removeDir } from "./helpers/session-command.js";
import { openhandsHermeticFixture } from "./helpers/openhands-hermetic-fixture.js";

type Fixture = ReturnType<typeof openhandsHermeticFixture>;
type Run = Awaited<ReturnType<Fixture["run"]>>;

function completed(run: Run, turns = 2) {
  expect(run.exitCode, run.stderr).toBe(0);
  expect(run.driveError).toBeUndefined();
  expect(run.events.filter((event) => event.type === "turn_completed").map((event) => event.finish))
    .toEqual(Array(turns).fill("end"));
  const started = run.events.find((event) => event.type === "session_started")!;
  return { id: started.session_id as string, home: started.private_home as string, ended: run.events.at(-1)! };
}

describe("openhands hermetic sessions", () => {
  test("fresh, resume, and --final share one settled private home", async () => {
    const f = openhandsHermeticFixture("openhands-hermetic-cli");
    try {
      const first = completed(await f.run(["--hermetic"]));
      const expected = join(f.parent, `session-${first.id}`);
      expect(first.home).toBe(expected);
      expect(statSync(expected).mode & 0o777).toBe(0o700);
      expect(statSync(join(expected, ".openhands")).mode & 0o777).toBe(0o700);
      // The deferred identity: the first turn ran in the run-shaped home,
      // which settled onto session-<id> at the adopt.
      const [one, two] = f.observations();
      expect(one!.home).not.toBe(expected);
      expect(String(one!.home).startsWith(`${f.parent}/run-`)).toBe(true);
      expect(two!.home).toBe(expected);
      for (const entry of [one!, two!]) {
        expect(entry.persistence).toBe(join(entry.home as string, ".openhands"));
        expect(entry.conversations).toBe(join(entry.home as string, ".openhands", "conversations"));
        expect(entry.auth).toBe(true);
        expect(entry.homeHooks).toBeNull();
        expect(entry.args).toContain("--override-with-envs");
        // The task file lives in the real openhands directory and is gone.
        expect(String(entry.task).startsWith(join(f.operator, ".openhands", ".codemux"))).toBe(true);
        expect(existsSync(entry.task as string)).toBe(false);
      }
      expect(two!.args).toContain("--resume");
      expect(two!.turns).toBe(2);
      const registry = readRegistry(f.registryFile);
      expect(registry.outcome).toBe("ok");
      if (registry.outcome === "ok") {
        expect(registry.file.sessions[0]).toMatchObject({ agent: "openhands", hermetic: true, harness_home: expected });
      }
      // A file the session wrote survives the resume.
      writeFileSync(join(expected, "synthetic-consumer"), "kept\n");
      const resumed = completed(await f.run(["--hermetic", "--resume", first.id], { turns: 1 }), 1);
      expect([resumed.id, resumed.home]).toEqual([first.id, expected]);
      expect(readFileSync(join(expected, "synthetic-consumer"), "utf8")).toBe("kept\n");
      expect(f.observations()[2]).toMatchObject({ home: expected, turns: 3, id: first.id });

      const final = completed(await f.run(["--hermetic", "--resume", first.id, "--final"], { turns: 1 }), 1);
      expect(final.home).toBe(expected);
      expect(f.observations()[3]).toMatchObject({ home: expected, turns: 4 });
      expect(final.ended).toMatchObject({ type: "session_ended", resumable: false });
      expect(existsSync(expected)).toBe(false);
      expect(readdirSync(f.parent)).toEqual([]);
      // Every turn went through scode with the private HOME inside the
      // sandboxed command, never the sandbox's own environment.
      const sandbox = readFileSync(join(f.state, "scode.txt"), "utf8");
      expect(sandbox.split("BEGIN\n").filter(Boolean)).toHaveLength(4);
      expect(sandbox).toContain(`BEGIN\n${f.operator}\n`);
      expect(sandbox).toContain(`HOME=${expected}\n`);
    } finally { removeDir(f.root); }
  }, 30_000);

  test("--hermetic without the provider override refuses with 64 and opens no home", async () => {
    const f = openhandsHermeticFixture("openhands-hermetic-refuse");
    try {
      for (const key of Object.keys(f.env)) if (key.startsWith("CODEMUX_OPENHANDS_PROVIDER_")) f.env[key] = undefined;
      const result = await f.run(["--hermetic"], { turns: 0 });
      expect(result.exitCode).toBe(64);
      expect(result.stderr).toContain("openhands --hermetic requires the provider override");
      expect(existsSync(f.parent)).toBe(false);
      expect(f.observations()).toEqual([]);
    } finally { removeDir(f.root); }
  }, 20_000);

  test("--permission-policy deny plants the PreToolUse rule; a default resume removes it", async () => {
    const f = openhandsHermeticFixture("openhands-hermetic-deny");
    try {
      const first = completed(await f.run(["--hermetic", "--permission-policy", "deny"], { turns: 1 }), 1);
      expect(f.observations()[0]!.homeHooks).toBe(OPENHANDS_DENY_HOOKS_JSON);
      const hooks = JSON.parse(OPENHANDS_DENY_HOOKS_JSON);
      expect(hooks.pre_tool_use[0].matcher).toBe("/(?!(?:finish|think)$).*/");
      expect(hooks.pre_tool_use[0].hooks[0].command).toEndWith("exit 2");
      const planted = join(first.home, ".openhands", "hooks.json");
      expect(statSync(planted).mode & 0o777).toBe(0o600);
      completed(await f.run(["--hermetic", "--resume", first.id], { turns: 1 }), 1);
      expect(f.observations()[1]!.homeHooks).toBeNull();
      completed(await f.run(["--hermetic", "--resume", first.id, "--permission-policy", "deny", "--final"], { turns: 1 }), 1);
      expect(f.observations()[2]!.homeHooks).toBe(OPENHANDS_DENY_HOOKS_JSON);
    } finally { removeDir(f.root); }
  }, 30_000);

  test("--permission-policy deny without --hermetic refuses with 64", async () => {
    const f = openhandsHermeticFixture("openhands-deny-plain");
    try {
      const result = await f.run(["--permission-policy", "deny"], { turns: 0 });
      expect(result.exitCode).toBe(64);
      expect(result.stderr).toContain("--permission-policy deny requires --hermetic for native deny rules for 'openhands'");
      expect(f.observations()).toEqual([]);
    } finally { removeDir(f.root); }
  }, 20_000);

  test("--experiment-project-settings loads the working directory's .openhands on every turn", async () => {
    const f = openhandsHermeticFixture("openhands-hermetic-project");
    try {
      const project = '{ "pre_tool_use": [] }\n';
      mkdirSync(join(f.work, ".openhands"));
      writeFileSync(join(f.work, ".openhands", "hooks.json"), project);
      const first = completed(await f.run(["--hermetic", "--experiment-project-settings"], { auto: "low" }));
      expect(first.home).toBe(join(f.parent, `session-${first.id}`));
      for (const entry of f.observations()) {
        expect(entry.cwdHooks).toBe(project);
        expect(entry.homeHooks).toBeNull();
      }
      const record = readRegistry(f.registryFile);
      if (record.outcome === "ok") expect(record.file.sessions[0]).toMatchObject({ project_settings: true, hermetic: true });
      // A plain hermetic session refuses the same working directory.
      const plain = await f.run(["--hermetic"], { turns: 0 });
      expect(plain.exitCode).not.toBe(0);
      expect(plain.stderr).toContain(".openhands");
      // Deny would be displaced by the project's hooks.json: refused.
      const deny = await f.run(["--hermetic", "--experiment-project-settings", "--permission-policy", "deny"],
        { turns: 0, auto: "low" });
      expect(deny.exitCode).toBe(64);
      expect(deny.stderr).toContain("--permission-policy deny refuses --experiment-project-settings for openhands");
      expect(f.observations()).toHaveLength(2);
    } finally { removeDir(f.root); }
  }, 30_000);
});

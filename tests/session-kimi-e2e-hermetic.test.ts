/**
 * Driver e2e for the HERMETIC kimi session: the per-turn env(1) spawn
 * shape over the private home (every turn, resume turns included), the
 * settle onto the session-keyed name at the first child exit after the
 * resume hint, the config.toml generation at the first turn of a fresh
 * home (operator allowlist + consumer overlay, written once, never
 * rewritten), the registry record's hermetic and harness_home keys, and
 * the fail-closed fold when the settle cannot complete. The rig is
 * tests/helpers/session-kimi-e2e.ts, which applies the env prefix to the
 * fake child's environment the way env(1) would.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRegistry } from "../src/session/registry.js";
import { settledPrivateHomePath } from "../src/session/private-home-key.js";
import {
  kimiPrivateBrandHome,
  kimiPrivateSkillsDir,
  KIMI_HERMETIC_ENV_ASSIGNMENTS,
  KIMI_HERMETIC_ENV_OMISSIONS,
  populateKimiHermeticSessionHome,
} from "../src/kimi-hermetic.js";
import { fakePrivateHome, fakeResumedPrivateHome, settledPath } from "./helpers/fake-private-home.js";
import {
  cleanups,
  fakeRecord,
  of,
  send,
  startSession,
  waitFor,
  ID,
  type Event,
} from "./helpers/session-kimi-e2e.js";

afterAll(async () => {
  for (const clean of cleanups) await clean();
});

/** An operator brand home with a config carrying one allowlisted key, one
 * dropped key, and a permission table the session config must drop when
 * no consumer supplies its own. */
function operatorHome(): string {
  const home = mkdtempSync(join(tmpdir(), "codemux-kimi-op-"));
  const brand = join(home, ".kimi-code");
  mkdirSync(brand, { recursive: true });
  writeFileSync(
    join(brand, "config.toml"),
    [
      'default_model = "operator/model.v1"',
      'default_permission_mode = "auto"',
      "auto_session_title = true",
      "[permission]",
      "rules = []",
      "",
    ].join("\n")
  );
  return brand;
}

const registryEntry = (session: { options: { registryPath: string | null } }) => {
  const registry = readRegistry(session.options.registryPath as string);
  expect(registry.outcome).toBe("ok");
  return registry.outcome === "ok"
    ? registry.file.sessions.find((r) => r.id === ID)
    : undefined;
};

describe("kimi session e2e - hermetic", () => {
  test("every turn carries the env(1) prefix over the private home, and settle lands before the second turn", async () => {
    const home = fakePrivateHome();
    const operator = operatorHome();
    populateKimiHermeticSessionHome(home.dir, operator);
    // Captured before turn 1: `dir` follows the settle rename (the
    // launcher's contract), so it names the keyed path from the first
    // child's exit on.
    const fresh = home.dir;
    const session = await startSession({
      privateHome: home,
      hermeticSourceHome: operator,
    });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("session_started"), "session_started");
    await waitFor(session.events, of("turn_completed"), "turn_completed");

    // The settled path is what the report, the record, and every later
    // turn name; the rename itself could only have landed between the
    // two turns — at the first child's exit.
    const settled = settledPrivateHomePath(fresh, ID);
    send(session.driver, { type: "user", text: "scenario:basic two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    expect(home.settled).toBe(true);

    const prefix = [
      "env",
      ...KIMI_HERMETIC_ENV_OMISSIONS.flatMap((name) => ["-u", name]),
      ...KIMI_HERMETIC_ENV_ASSIGNMENTS,
    ];
    for (const [turn, argv] of session.argvs.entries()) {
      expect(argv.slice(0, prefix.length)).toEqual(prefix);
      // Turn 1 ran on the fresh dir, turn 2 on the settled one — never
      // the same spelling twice once the rename landed.
      const base = turn === 0 ? fresh : settled;
      expect(argv[prefix.length]).toBe(`HOME=${base}`);
      expect(argv[prefix.length + 1]).toBe(`KIMI_CODE_HOME=${kimiPrivateBrandHome(base)}`);
      expect(argv[prefix.length + 2]).toBe("kimi");
      expect(argv[argv.indexOf("--skills-dir") + 1]).toBe(kimiPrivateSkillsDir(base));
    }
    expect(session.argvs[1]![session.argvs[1]!.indexOf("--session") + 1]).toBe(ID);

    // The env prefix really reached the children (the rig applies it):
    // both turns ran with the private HOME and brand home.
    const envs = fakeRecord(session, "env.jsonl");
    expect(envs[0]!.home).toBe(fresh);
    expect(envs[0]!.kimiCodeHome).toBe(kimiPrivateBrandHome(fresh));
    expect(envs[1]!.home).toBe(settled);
    expect(envs[1]!.kimiCodeHome).toBe(kimiPrivateBrandHome(settled));

    // The report and the registry name the settled brand home.
    const started = of("session_started")(session.events) as Event;
    expect(started.private_home).toBe(settled);
    const entry = registryEntry(session);
    expect(entry?.hermetic).toBe(true);
    expect(entry?.harness_home).toBe(kimiPrivateBrandHome(settled));

    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    expect(ended.resumable).toBe(true);
    home.remove();
    rmSync(operator, { recursive: true, force: true });
  });

  test("the first turn generates the config once: operator allowlist, consumer overlay, permission verbatim", async () => {
    const home = fakePrivateHome();
    const operator = operatorHome();
    const { brandHome } = populateKimiHermeticSessionHome(home.dir, operator);
    // The consumer's pre-write: an allowlisted key it chose for this
    // session and a permission rules table that must survive whole.
    writeFileSync(
      join(brandHome, "config.toml"),
      [
        'default_model = "consumer/model.v2"',
        "[[permission.rules]]",
        'tool = "Bash"',
        'allow = "ls"',
        "",
      ].join("\n")
    );
    const session = await startSession({
      privateHome: home,
      hermeticSourceHome: operator,
    });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    // The config was generated into the fresh home, which settled at the
    // turn's child exit — so it is read through the keyed name.
    const configPath = join(kimiPrivateBrandHome(settledPrivateHomePath(home.dir, ID)), "config.toml");
    const generated = readFileSync(configPath, "utf8");
    const parsed = Bun.TOML.parse(generated) as Record<string, any>;
    // The consumer's allowlisted key won; the operator's dropped key and
    // permission table stayed dropped; the consumer's rules survived
    // whole; the session's own key landed.
    expect(parsed.default_model).toBe("consumer/model.v2");
    expect(parsed.default_permission_mode).toBeUndefined();
    expect(parsed.permission).toEqual({ rules: [{ tool: "Bash", allow: "ls" }] });
    expect(parsed.auto_session_title).toBe(false);

    // Turn 2 and the resume-shaped turn never rewrite it.
    send(session.driver, { type: "user", text: "scenario:basic two" });
    await waitFor(
      session.events,
      (events) => events.filter((event) => event.type === "turn_completed")[1],
      "second turn_completed"
    );
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(generated);
    home.remove();
    rmSync(operator, { recursive: true, force: true });
  });

  test("a resumed private home is never rewritten and spawns on the keyed path", async () => {
    const home = fakeResumedPrivateHome(ID);
    const operator = operatorHome();
    // The earlier process's config, with a marker the driver must leave
    // alone (populate creates the brand home in the settled dir).
    const brandHome = kimiPrivateBrandHome(home.dir);
    const { brandHome: created } = populateKimiHermeticSessionHome(home.dir, operator);
    expect(created).toBe(brandHome);
    writeFileSync(join(brandHome, "config.toml"), 'default_model = "earlier/model"\n');
    const session = await startSession({
      resumeSessionId: ID,
      privateHome: home,
      hermeticSourceHome: operator,
    });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect((started as Event).private_home).toBe(home.dir);
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    // The turn spawned on the keyed path and the config was not touched.
    expect(session.argvs[0]!.includes(`HOME=${home.dir}`)).toBe(true);
    expect(session.argvs[0]!.includes(`KIMI_CODE_HOME=${brandHome}`)).toBe(true);
    expect(readFileSync(join(brandHome, "config.toml"), "utf8")).toBe('default_model = "earlier/model"\n');
    const entry = registryEntry(session);
    expect(entry?.hermetic).toBe(true);
    expect(entry?.harness_home).toBe(brandHome);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    home.remove();
    rmSync(operator, { recursive: true, force: true });
  });

  test("a settle that cannot complete costs resumable and keeps the home run-shaped (fail closed)", async () => {
    const home = fakePrivateHome();
    const operator = operatorHome();
    populateKimiHermeticSessionHome(home.dir, operator);
    home.failSettle = true;
    const session = await startSession({
      privateHome: home,
      hermeticSourceHome: operator,
    });
    send(session.driver, { type: "user", text: "scenario:basic one" });
    await waitFor(session.events, of("turn_completed"), "turn_completed");
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
    const ended = session.events[session.events.length - 1] as Event;
    expect(ended.type).toBe("session_ended");
    // The registry's harness_home names the settled brand home, which
    // does not exist: the next resume is refused on the missing home.
    expect(ended.resumable).toBe(false);
    expect(home.settled).toBe(false);
    expect(existsSync(settledPath(home, ID))).toBe(false);
    const entry = registryEntry(session);
    expect(entry?.harness_home).toBe(kimiPrivateBrandHome(settledPrivateHomePath(home.dir, ID)));
    home.remove();
    rmSync(operator, { recursive: true, force: true });
  });

  test("a plain session reports private_home: null — the key is always present", async () => {
    // The protocol doc promises the field on every session_started (no
    // omission), so a plain session carries an explicit null.
    const session = await startSession();
    send(session.driver, { type: "user", text: "scenario:basic one" });
    const started = await waitFor(session.events, of("session_started"), "session_started");
    expect("private_home" in started).toBe(true);
    expect((started as Event).private_home).toBe(null);
    send(session.driver, { type: "shutdown" });
    expect(await session.code).toBe(0);
  });
});

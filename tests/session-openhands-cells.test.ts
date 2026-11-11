/** The openhands session parity cells that are not CLI round trips: the
 * session home module's policy and refusal rules, the driver's hermetic
 * override flag, and the three declared limitations, each checked against
 * the refusal `codemux session -a openhands` prints today. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig } from "../src/config.js";
import { PARITY } from "../src/parity/index.js";
import { resolveSessionRequest, type SessionCommandOptions } from "../src/session/cli-request.js";
import { SESSION_AGENTS } from "../src/session/cli-agents.js";
import {
  applyOpenhandsSessionPolicy, OPENHANDS_DENY_HOOKS_JSON, OPENHANDS_HERMETIC_OVERRIDE_REFUSAL, openOpenhandsSessionHome,
} from "../src/session/openhands-home.js";
import { OPENHANDS_DRIVER_PROFILE } from "../src/session/openhands-driver.js";
import { openTurnAgentPrivateHome } from "../src/session/turn-driver-homes.js";
import { UsageRefusalError } from "../src/validation.js";
import { removeDir } from "./helpers/session-command.js";
import { refusingCall } from "./helpers/session-cli-hermetic.js";

const conversation = "0f8fad5b-d9cb-469f-a165-70867728950e"; // a synthetic v4 UUID
const overrideNames = ["CODEMUX_OPENHANDS_PROVIDER_BASE_URL", "CODEMUX_OPENHANDS_PROVIDER_API_KEY", "CODEMUX_OPENHANDS_PROVIDER_MODEL"];
let root: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codemux-openhands-cells-"));
  saved = Object.fromEntries(["HOME", ...overrideNames].map((name) => [name, process.env[name]]));
  process.env.HOME = join(root, "operator");
  mkdirSync(process.env.HOME);
  process.env.CODEMUX_OPENHANDS_PROVIDER_BASE_URL = "http://127.0.0.1:9/v1";
  process.env.CODEMUX_OPENHANDS_PROVIDER_API_KEY = "synthetic-key";
  process.env.CODEMUX_OPENHANDS_PROVIDER_MODEL = "fixture-model";
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  removeDir(root);
});

const stateRoot = () => join(process.env.HOME!, ".openhands");
const hooksOf = (home: string) => join(home, ".openhands", "hooks.json");

describe("openhands session home", () => {
  test("refuses without the provider override before any directory exists", () => {
    for (const name of overrideNames) delete process.env[name];
    expect(() => openOpenhandsSessionHome({ stateRoot: stateRoot(), resume: false, sessionId: null, permissionPolicy: "default" }))
      .toThrow(new UsageRefusalError(OPENHANDS_HERMETIC_OVERRIDE_REFUSAL));
    expect(existsSync(stateRoot())).toBe(false);
  });

  test("a fresh home starts run-shaped, settles, and carries no hooks by default", () => {
    const home = openOpenhandsSessionHome({ stateRoot: stateRoot(), resume: false, sessionId: null, permissionPolicy: "default" });
    expect(home.dir.startsWith(join(stateRoot(), ".codemux-hermetic", "run-"))).toBe(true);
    expect(lstatSync(join(home.dir, ".openhands")).mode & 0o777).toBe(0o700);
    expect(existsSync(hooksOf(home.dir))).toBe(false);
    home.settle(conversation);
    expect(home.dir).toBe(join(stateRoot(), ".codemux-hermetic", `session-${conversation}`));
    expect(home.remove()).toBe(true);
  });

  test("deny plants the rule; a resume applies its own command's policy", () => {
    const fresh = openTurnAgentPrivateHome({ agent: "openhands", hermetic: true, resumeSessionId: null, sessionId: null,
      passthroughEnv: [], override: null, model: undefined, permissionPolicy: "deny" })!;
    expect(readFileSync(hooksOf(fresh.dir), "utf8")).toBe(OPENHANDS_DENY_HOOKS_JSON);
    expect(lstatSync(hooksOf(fresh.dir)).mode & 0o777).toBe(0o600);
    fresh.settle(conversation);
    const reopen = (permissionPolicy: "default" | "deny") => openOpenhandsSessionHome({
      stateRoot: stateRoot(), resume: true, sessionId: conversation, permissionPolicy });
    expect(existsSync(hooksOf(reopen("default").dir))).toBe(false);
    expect(readFileSync(hooksOf(reopen("deny").dir), "utf8")).toBe(OPENHANDS_DENY_HOOKS_JSON);
    // A hooks.json that is not codemux's rule stays under default.
    writeFileSync(hooksOf(fresh.dir), "{}\n");
    expect(readFileSync(hooksOf(reopen("default").dir), "utf8")).toBe("{}\n");
    // Deny replaces a link instead of writing through it.
    const outside = join(root, "outside.json");
    writeFileSync(outside, "outside\n");
    const target = hooksOf(fresh.dir);
    unlinkSync(target);
    symlinkSync(outside, target);
    reopen("deny");
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
    expect(fresh.remove()).toBe(true);
  });

  test("a linked brand directory or a directory at hooks.json is refused", () => {
    const home = join(root, "home");
    mkdirSync(home);
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(home, ".openhands"));
    expect(() => applyOpenhandsSessionPolicy(home, "deny")).toThrow("is not a directory");
    // Default never reads through the link either.
    writeFileSync(join(elsewhere, "hooks.json"), OPENHANDS_DENY_HOOKS_JSON);
    applyOpenhandsSessionPolicy(home, "default");
    expect(readdirSync(elsewhere)).toEqual(["hooks.json"]);
    const other = join(root, "other");
    mkdirSync(join(other, ".openhands", "hooks.json"), { recursive: true });
    expect(() => applyOpenhandsSessionPolicy(other, "deny")).toThrow("cannot replace the directory");
    applyOpenhandsSessionPolicy(join(root, "absent"), "default");
  });
});

describe("openhands driver", () => {
  test("a hermetic turn always carries --override-with-envs and the env prefix", () => {
    let finalize: (() => void) | undefined;
    const argv = OPENHANDS_DRIVER_PROFILE.buildTurnCommand({
      text: "synthetic", sessionId: null, firstTurn: true, hermeticHome: "/synthetic/home", autonomy: "high",
      onSettled: (cleanup) => { finalize = cleanup; },
    });
    expect(argv.slice(0, 2)).toEqual(["env", "HOME=/synthetic/home"]);
    expect(argv).toContain("--override-with-envs");
    const task = argv[argv.indexOf("--file") + 1]!;
    expect(task.startsWith(join(stateRoot(), ".codemux"))).toBe(true);
    // Parsing is independent of the owning turn's resource cleanup.
    OPENHANDS_DRIVER_PROFILE.parseTurnOutput!("", null);
    expect(existsSync(task)).toBe(true);
    expect(finalize).toBeDefined();
    finalize!();
    expect(existsSync(task)).toBe(false);
  });
});

describe("openhands session limitations print their declared refusals", () => {
  const cwd = () => { const dir = join(root, "work"); mkdirSync(dir, { recursive: true }); return dir; };
  const refusal = (options: Partial<SessionCommandOptions>) => refusingCall(() => resolveSessionRequest(
    { agent: "openhands", sandbox: true, auto: "high", cwd: cwd(), ...options } as SessionCommandOptions, getDefaultConfig()));
  const cases = [
    ["session.interrupt", { turnTimeout: "1" }],
    ["session.tools", { tools: "none" }],
    ["session.playwright-mcp", { enablePlaywrightMcp: true, auto: "low" }],
  ] as const;
  for (const [feature, options] of cases) test(feature, () => {
    const state = PARITY.openhands[feature];
    expect(state.state).toBe("harness-limitation");
    if (state.state !== "harness-limitation") return;
    expect(state.evidence).toContain("1.16.0");
    const result = refusal(options);
    expect(result.code).toBe(64);
    expect(result.message).toContain(state.refusal);
  });

  test("the session table entry matches the declarations", () => {
    expect(SESSION_AGENTS.openhands).toMatchObject({ hermetic: true, denyRules: "hermetic", interrupt: false, tools: false });
  });
});

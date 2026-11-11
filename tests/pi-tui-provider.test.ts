import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PiAdapter } from "../src/adapters/pi.js";
import { piNativeSessionDir } from "../src/pi-launch.js";

const OVERRIDE = {
  CODEMUX_PI_PROVIDER_BASE_URL: "https://pi.synthetic.invalid/v1",
  CODEMUX_PI_PROVIDER_API_KEY: "synthetic-tui-key",
  CODEMUX_PI_PROVIDER_MODEL: "synthetic-model",
};
const AGENT_ENV = "PI_CODING_AGENT_DIR";

function withHome(run: (home: string) => void): void {
  const parent = join(process.cwd(), "scratch", "fix", "pi-synthetic");
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "tui-"));
  try { run(home); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

describe("pi generic TUI provider lifecycle", () => {
  test("a private models directory shares only the native transcript store", () => withHome((home) => {
    const agent = join(home, ".pi", "agent");
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "settings.json"), "operator settings");
    writeFileSync(join(agent, "auth.json"), "operator login");
    const adapter = new PiAdapter({ ...OVERRIDE, HOME: home }, home);
    const prepared = adapter.prepareTuiEnvironment(undefined, "high");
    const directory = prepared.env[AGENT_ENV]!;
    try {
      expect(readdirSync(directory).sort()).toEqual(["models.json", "sessions"]);
      expect(lstatSync(join(directory, "sessions")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(directory, "sessions"))).toBe(join(agent, "sessions"));
      const models = readFileSync(join(directory, "models.json"), "utf8");
      expect(models).not.toContain(OVERRIDE.CODEMUX_PI_PROVIDER_API_KEY);
      expect(prepared.env.CODEMUX_PI_PROVIDER_API_KEY).toBe(OVERRIDE.CODEMUX_PI_PROVIDER_API_KEY);
      expect(JSON.parse(models).providers.codemux.models[0].id).toBe("synthetic-model");
      const native = piNativeSessionDir(directory, home);
      mkdirSync(native, { recursive: true });
      writeFileSync(join(native, "session.jsonl"), "preserved transcript");
      prepared.finalize();
      prepared.finalize();
      expect(existsSync(directory)).toBe(false);
      expect(readFileSync(join(piNativeSessionDir(agent, home), "session.jsonl"), "utf8")).toBe("preserved transcript");
      expect(readFileSync(join(agent, "settings.json"), "utf8")).toBe("operator settings");
    } finally { prepared.finalize(); }
  }));

  test("two TUI preparations retain independent models and cleanup", () => withHome((home) => {
    const adapter = new PiAdapter({ ...OVERRIDE, HOME: home }, home);
    const first = adapter.prepareTuiEnvironment("first", "high");
    const second = adapter.prepareTuiEnvironment("second", "high");
    try {
      expect(first.env[AGENT_ENV]).not.toBe(second.env[AGENT_ENV]);
      for (const [prepared, model] of [[first, "first"], [second, "second"]] as const) {
        expect(JSON.parse(readFileSync(join(prepared.env[AGENT_ENV]!, "models.json"), "utf8"))
          .providers.codemux.models[0].id).toBe(model);
        expect(adapter.buildTuiCommand(model, "high")).toEqual(["pi", "--no-approve", "--model", `codemux/${model}`]);
      }
      first.finalize();
      expect(existsSync(second.env[AGENT_ENV]!)).toBe(true);
    } finally { first.finalize(); second.finalize(); }
  }));

  test("an explicitly passed agent directory retains native cwd selection", () => withHome((home) => {
    const custom = `${join(home, "custom-agent")} `;
    const adapter = new PiAdapter({ ...OVERRIDE, HOME: home, [AGENT_ENV]: custom }, home);
    const prepared = adapter.prepareTuiEnvironment(undefined, "high", undefined, true, [AGENT_ENV]);
    try {
      expect(prepared.env[AGENT_ENV]!.startsWith(join(custom, ".codemux"))).toBe(true);
      expect(readlinkSync(join(prepared.env[AGENT_ENV]!, "sessions"))).toBe(join(custom, "sessions"));
      expect(existsSync(join(home, ".pi"))).toBe(false);
    } finally { prepared.finalize(); }
  }));

  test("an ambient agent directory remains ignored when not passed", () => withHome((home) => {
    const adapter = new PiAdapter({ ...OVERRIDE, HOME: home, [AGENT_ENV]: "relative/ignored" }, home);
    const prepared = adapter.prepareTuiEnvironment();
    try {
      expect(readlinkSync(join(prepared.env[AGENT_ENV]!, "sessions"))).toBe(join(home, ".pi", "agent", "sessions"));
    } finally { prepared.finalize(); }
  }));

  test("print-only preparation has the same provider model and creates no files", () => withHome((home) => {
    const adapter = new PiAdapter({ ...OVERRIDE, HOME: home }, home);
    const prepared = adapter.prepareTuiEnvironment("preview", "high", "high", true, [], true);
    try {
      expect(adapter.buildTuiCommand("preview", "high", "high", true))
        .toEqual(["pi", "--no-approve", "--model", "codemux/preview", "--thinking", "high"]);
      expect(existsSync(prepared.env[AGENT_ENV]!)).toBe(false);
    } finally { prepared.finalize(); }
    expect(existsSync(prepared.env[AGENT_ENV]!)).toBe(false);
  }));

  test("plain interactive launches preserve customization and create no artifacts", () => withHome((home) => {
    const adapter = new PiAdapter({ HOME: home }, home);
    const prepared = adapter.prepareTuiEnvironment("native", "low");
    expect(prepared.env).toEqual({});
    expect(adapter.buildTuiCommand("native", "low")).toEqual([
      "pi", "--no-approve", "--model", "native", "--no-extensions", "--tools", "read,grep,find,ls,edit,write",
    ]);
    prepared.finalize();
    expect(existsSync(join(home, ".pi"))).toBe(false);
  }));

  test("a non-directory transcript path fails and removes the private artifacts", () => withHome((home) => {
    const agent = join(home, ".pi", "agent");
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "sessions"), "existing file");
    const adapter = new PiAdapter({ ...OVERRIDE, HOME: home }, home);
    expect(() => adapter.prepareTuiEnvironment(undefined, "high")).toThrow();
    expect(readdirSync(join(agent, ".codemux"))).toEqual([]);
    expect(readFileSync(join(agent, "sessions"), "utf8")).toBe("existing file");
  }));

  test("invalid models and incomplete overrides refuse before artifacts", () => withHome((home) => {
    const adapter = new PiAdapter({ ...OVERRIDE, HOME: home }, home);
    expect(() => adapter.validateTuiRequest("${KEY}", home)).toThrow("must not contain");
    expect(() => adapter.prepareTuiEnvironment("${KEY}")).toThrow("must not contain");
    expect(() => adapter.buildTuiCommand("${KEY}")).toThrow("must not contain");
    const missingModel = new PiAdapter({ ...OVERRIDE, CODEMUX_PI_PROVIDER_MODEL: undefined, HOME: home }, home);
    expect(() => missingModel.validateTuiRequest(undefined, home)).toThrow("needs a model");
    expect(() => missingModel.prepareTuiEnvironment()).toThrow("needs a model");
    const missingKey = new PiAdapter({ ...OVERRIDE, CODEMUX_PI_PROVIDER_API_KEY: undefined, HOME: home }, home);
    expect(() => missingKey.prepareTuiEnvironment()).toThrow("missing CODEMUX_PI_PROVIDER_API_KEY");
    expect(existsSync(join(home, ".pi"))).toBe(false);
  }));

  test("invalid passed agent directories refuse at validation and preparation", () => withHome((home) => {
    for (const value of ["relative", " ", `${home}\0suffix`]) {
      const adapter = new PiAdapter({ ...OVERRIDE, HOME: home, [AGENT_ENV]: value }, home);
      expect(() => adapter.validateTuiRequest(undefined, home, "high", undefined, [AGENT_ENV])).toThrow();
      expect(() => adapter.prepareTuiEnvironment(undefined, "high", undefined, true, [AGENT_ENV])).toThrow();
    }
    expect(existsSync(join(home, ".pi"))).toBe(false);
  }));
});

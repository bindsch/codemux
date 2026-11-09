import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import { prepareOpencodeTuiEffort, validateOpencodeTuiEffortModel } from "../src/opencode-tui-effort.js";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(import.meta.dir, "../scratch/fix/opencode-tui-"));
  scratch.push(home);
  return home;
}

test.each([undefined, "model", "/model", "provider/"])("TUI effort refuses an unaddressable model %s", (model) => {
  expect(() => validateOpencodeTuiEffortModel(model)).toThrow("explicit provider/model selector");
});

test("TUI effort supplies a private variant map and removes it after this launch", () => {
  const home = fixture();
  const data = join(home, ".local/share/opencode");
  const realState = join(home, ".local/state/opencode");
  mkdirSync(realState, { recursive: true });
  const previous = JSON.stringify({ variant: { "provider/model": "low" } });
  writeFileSync(join(realState, "model.json"), previous);
  const first = prepareOpencodeTuiEffort(data, "provider/model", "high");
  const second = prepareOpencodeTuiEffort(data, "provider/model", "none");
  try {
    const path = join(first.env.XDG_STATE_HOME, "opencode/model.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      recent: [{ providerID: "provider", modelID: "model" }], favorite: [], variant: { "provider/model": "high" },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(first.env.XDG_STATE_HOME).not.toBe(second.env.XDG_STATE_HOME);
    first.finalize();
    expect(existsSync(first.env.XDG_STATE_HOME)).toBe(false);
    expect(existsSync(second.env.XDG_STATE_HOME)).toBe(true);
    expect(readFileSync(join(realState, "model.json"), "utf8")).toBe(previous);
  } finally { first.finalize(); second.finalize(); }
});

test("adapter TUI preparation composes provider credentials and private effort state", () => {
  const home = fixture();
  const plain = new OpencodeAdapter({ HOME: home }, home);
  const noEffort = plain.prepareTuiEnvironment();
  expect(noEffort.env).toEqual({});
  noEffort.finalize();
  expect(() => plain.prepareTuiEnvironment(undefined, undefined, "high")).toThrow("explicit provider/model");
  const preview = plain.prepareTuiEnvironment("provider/model", "high", "low", true, [], true);
  expect(existsSync(preview.env.XDG_STATE_HOME!)).toBe(false);
  preview.finalize();
  const adapter = new OpencodeAdapter({ HOME: home,
    CODEMUX_OPENCODE_PROVIDER_BASE_URL: "https://provider.invalid/v1",
    CODEMUX_OPENCODE_PROVIDER_API_KEY: "synthetic-key",
    CODEMUX_OPENCODE_PROVIDER_MODEL: "model",
  }, home);
  const state = adapter.prepareTuiEnvironment(undefined, "read-only", "medium");
  try {
    expect(state.env.CODEMUX_OPENCODE_PROVIDER_API_KEY).toBe("synthetic-key");
    const path = join(state.env.XDG_STATE_HOME!, "opencode/model.json");
    expect(JSON.parse(readFileSync(path, "utf8")).variant).toEqual({ "codemux/model": "medium" });
  } finally { state.finalize(); }
});

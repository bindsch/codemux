import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CallerHarnessHome } from "../src/session/harness-home.js";
import { buildKimiSessionCommand } from "../src/session/kimi-session.js";
import { buildKimiSessionPreview } from "../src/session/kimi-preview.js";
import { buildAgySessionCommand } from "../src/session/agy-session.js";
import { buildAiderSessionCommand } from "../src/session/aider-session.js";
import { buildAiderSessionPreview } from "../src/session/aider-preview.js";
import { buildOpenCodeTurnCommand } from "../src/session/opencode-command.js";
import { finishOpenCodeSessionHome, prepareOpenCodeCallerTurnContext, settleOpenCodeSessionHome } from "../src/session/opencode-home.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const id = "11111111-2222-3333-4444-555555555555";

function homeFixture() {
  const dir = mkdtempSync(resolve("scratch/fix/native-command-"));
  roots.push(dir);
  let verifies = 0;
  const home: CallerHarnessHome = {
    dir, callerOwned: true, resumed: false, settled: true, blockedPaths: [],
    environment: { HOME: dir, KIMI_CODE_HOME: join(dir, ".kimi-code"),
      OPENCODE_CONFIG_DIR: join(dir, ".config", "opencode"), XDG_DATA_HOME: join(dir, ".local", "share") },
    environmentOmissions: ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT"],
    verify: () => { verifies++; },
    settle: () => { throw new Error("caller state must not settle"); },
    remove: () => { throw new Error("caller state must not be removed"); },
  };
  return { home, verifies: () => verifies };
}

test("Kimi caller commands and previews preserve native customization across resume", () => {
  const { home } = homeFixture();
  const argv = buildKimiSessionCommand({ callerHome: home, prompt: "read", resumeSessionId: `session_${id}` });
  expect(argv).toContain(`HOME=${home.dir}`);
  expect(argv).toContain(`KIMI_CODE_HOME=${join(home.dir, ".kimi-code")}`);
  expect(argv).not.toContain("--skills-dir");
  expect(argv).not.toContain("--agent-file");
  expect(argv).toContain(`session_${id}`);
  const preview = buildKimiSessionPreview({ callerHome: home, harnessHome: home.dir, hermetic: false });
  expect(preview.slice(0, preview.indexOf("kimi"))).toEqual(argv.slice(0, argv.indexOf("kimi")));
});

test("Agy caller commands retain caller customization and overlay explicit denial only", () => {
  const { home } = homeFixture();
  const argv = buildAgySessionCommand({ callerHome: home, autonomy: "low", resumeConversationId: "conversation" });
  expect(argv).toContain(`HOME=${home.dir}`);
  expect(argv).not.toContain("--disable-slash-commands");
  expect(argv).not.toContain("--safe-mode");
  const settings = join(home.dir, ".gemini", "antigravity-cli", "settings.json");
  mkdirSync(join(home.dir, ".gemini", "antigravity-cli"), { recursive: true });
  const original = '{"customInstructions":"caller marker","permissions":{"deny":["command(publish)"]}}';
  writeFileSync(settings, original);
  const denied = buildAgySessionCommand({ callerHome: home, autonomy: "high", permissionPolicy: "deny" });
  expect(denied).not.toContain("--dangerously-skip-permissions");
  expect(denied.find((arg) => arg.startsWith("--settings="))).toContain("command(publish)");
  expect(readFileSync(settings, "utf8")).toBe(original);
});

test("Aider caller commands and preview keep config discovery and stable history", () => {
  const { home } = homeFixture();
  const preview = buildAiderSessionPreview({ callerHome: home, harnessHome: home.dir, sessionId: id, hermetic: false, autonomy: "low" });
  expect(preview.privateHome).toBe(home.dir);
  expect(preview.historyPath).toBe(join(home.dir, ".aider", ".codemux", "sessions", id, "history.md"));
  expect(preview.argv).toContain(`HOME=${home.dir}`);
  for (const flag of ["--config", "--env-file", "--model-settings-file", "--model-metadata-file"]) {
    expect(preview.argv).not.toContain(flag);
  }
  expect(preview.argv).toContain("--restore-chat-history");
  const capped = buildAiderSessionCommand({ callerHome: home, autonomy: "high", permissionPolicy: "deny",
    historyPath: preview.historyPath, modelSettingsPath: join(home.dir, "cap.yml"), prompt: "read" });
  expect(capped[capped.indexOf("--model-settings-file") + 1]).toBe(join(home.dir, "cap.yml"));
  expect(capped).toContain("AIDER_YES_ALWAYS=false");
  expect(capped).not.toContain("--yes-always");
});

test("OpenCode caller commands allow native config and never settle or remove the home", async () => {
  const { home, verifies } = homeFixture();
  const argv = buildOpenCodeTurnCommand({ privateHome: home, autonomy: "low" });
  expect(argv).toContain(`HOME=${home.dir}`);
  expect(argv).toContain(`OPENCODE_CONFIG_DIR=${join(home.dir, ".config", "opencode")}`);
  expect(argv.some((arg) => arg.startsWith("OPENCODE_DISABLE_"))).toBe(false);
  expect(verifies()).toBe(1);
  expect(settleOpenCodeSessionHome(home, "ses_fixture1234")).toBe(true);
  expect(await finishOpenCodeSessionHome(home, { final: true, resumable: true, sessionId: "ses_fixture1234" }))
    .toEqual({ usable: true, removed: false });
  expect(await finishOpenCodeSessionHome(home, { final: false, resumable: false, sessionId: null }))
    .toEqual({ usable: true, removed: false });
  expect(existsSync(home.dir)).toBe(true);
});

test("OpenCode provider overlay stays inside caller state and does not replace customization", () => {
  const { home } = homeFixture();
  const settings = join(home.dir, ".config", "opencode", "opencode.json");
  mkdirSync(join(home.dir, ".config", "opencode"), { recursive: true });
  const original = '{"instructions":["caller.md"],"mcp":{"caller":{"enabled":true}}}';
  writeFileSync(settings, original);
  const argv = buildOpenCodeTurnCommand({ privateHome: home, autonomy: "low", permissionPolicy: "deny" });
  const override = { baseUrl: "https://provider.invalid/v1", apiKey: "synthetic-token", model: "example" };
  const prepared = prepareOpenCodeCallerTurnContext(home, override, undefined, argv);
  const config = prepared.context.opencodeProviderConfig!;
  try {
    expect(config.path.startsWith(`${home.dir}/`)).toBe(true);
    expect(prepared.argv[prepared.argv.indexOf("opencode") - 1]).toBe(`OPENCODE_CONFIG=${config.path}`);
    expect(prepared.argv).toContain('OPENCODE_CONFIG_CONTENT={"permission":"deny"}');
    expect(prepared.argv.join(" ")).not.toContain(override.apiKey);
    expect(readFileSync(config.path, "utf8")).toContain("{env:CODEMUX_OPENCODE_PROVIDER_API_KEY}");
    expect(readFileSync(settings, "utf8")).toBe(original);
  } finally { config.finalize(); }
  expect(existsSync(home.dir)).toBe(true);
  expect(readFileSync(settings, "utf8")).toBe(original);
  const bare = prepareOpenCodeCallerTurnContext(home, override, "selected", ["opencode", "run"]);
  try { expect(bare.argv[0]).toBe("env"); } finally { bare.context.opencodeProviderConfig!.finalize(); }
  const preview = prepareOpenCodeCallerTurnContext(home, override, "selected", argv, true);
  expect(existsSync(preview.context.opencodeProviderConfig!.path)).toBe(false);
  preview.context.opencodeProviderConfig!.finalize();
  expect(prepareOpenCodeCallerTurnContext(home, null, undefined, argv)).toEqual({ context: {}, argv });
  expect(() => prepareOpenCodeCallerTurnContext(home, override, undefined, ["other"])).toThrow("missing its native command");
  expect(() => prepareOpenCodeCallerTurnContext(home, { baseUrl: override.baseUrl }, undefined, argv)).toThrow("requires a base URL");
});

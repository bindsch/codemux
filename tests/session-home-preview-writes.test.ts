import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSessionPrivateHome } from "../src/session/private-home.js";
import { createCodexSessionProviderHome, openCodexSessionProviderHome, codexSessionProviderHomePath } from "../src/codex-provider.js";
import { openProjectSettingsSessionConfigDir } from "../src/claude-project-config.js";
import { openOpenCodeSessionHome } from "../src/session/opencode-home.js";
import { treeSnapshot } from "./helpers/tree-snapshot.js";
import { runSessionCommand } from "./helpers/session-command.js";

const root = mkdtempSync(join(import.meta.dir, "../scratch/session-home-preview-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const provider = { baseUrl: "https://provider.invalid/v1", apiKey: "synthetic" };

for (const kind of ["directory", "symlink", "writable", "file", "missing"] as const) {
  test(`Codex provider resume validates a ${kind} parent without preview writes`, () => {
    const rootHome = join(root, `provider-parent-${kind}`), id = "recorded-session";
    const parent = join(rootHome, ".codemux-provider");
    mkdirSync(rootHome);
    if (kind === "symlink") {
      const target = join(rootHome, "target"); mkdirSync(target); symlinkSync(target, parent);
    } else if (kind === "file") writeFileSync(parent, "preserve");
    else if (kind !== "missing") mkdirSync(parent);
    if (kind === "directory" || kind === "symlink" || kind === "writable") {
      mkdirSync(codexSessionProviderHomePath(rootHome, provider.baseUrl, id));
      const stale = join(parent, "run-2147483647-stale"); mkdirSync(stale);
      writeFileSync(join(stale, "sentinel"), "preserve");
      const old = new Date(Date.now() - 4 * 86_400_000); utimesSync(stale, old, old);
    }
    if (kind === "writable") chmodSync(parent, 0o777);
    const before = treeSnapshot(rootHome);
    const open = (printOnly: boolean) => openCodexSessionProviderHome(rootHome, provider, "synthetic", null, id, printOnly);
    if (kind === "directory") {
      const home = open(true); home.prepareConfig(); home.settle(id, true); home.abandon();
    } else expect(() => open(true)).toThrow();
    expect(treeSnapshot(rootHome)).toEqual(before);
    // A real open may create a missing parent or sweep a valid parent.
    if (kind === "symlink" || kind === "writable" || kind === "file") {
      expect(() => open(false)).toThrow();
      expect(treeSnapshot(rootHome)).toEqual(before);
    }
  });
}

test("real and preview resumes reject a symlinked parent without changing it", () => {
  const target = join(root, "parent-target"), parent = join(root, "parent-link"), sessionId = "existing-session";
  mkdirSync(join(target, `session-${sessionId}`), { recursive: true });
  symlinkSync(target, parent);
  const before = treeSnapshot(root);
  for (const printOnly of [true, false]) {
    expect(() => openSessionPrivateHome({ parent, sessionId, resume: true, printOnly,
      idPattern: /^[a-z-]+$/, blockedPaths: [] })).toThrow("must be a directory owned by the current user");
    expect(treeSnapshot(root)).toEqual(before);
  }
});

test("missing resumed homes have the real launch's explanatory refusal without preview writes", () => {
  const parent = join(root, "missing-resume"), sessionId = "removed-session";
  const input = { parent, sessionId, resume: true, idPattern: /^[a-z-]+$/, blockedPaths: [] };
  const message = `session ${sessionId} has no private home at ${join(parent, `session-${sessionId}`)}: ` +
    "it was removed (--final or the stale sweep) and the session's transcript with it, so it cannot resume";
  const before = treeSnapshot(root);
  expect(() => openSessionPrivateHome({ ...input, printOnly: true })).toThrow(message);
  expect(treeSnapshot(root)).toEqual(before);
  expect(() => openSessionPrivateHome(input)).toThrow(message);
});

for (const resume of [false, true]) {
  test(`shared session home preview leaves the tree unchanged, resume=${resume}`, () => {
    const parent = join(root, `shared-${resume}`), id = "recorded-session";
    mkdirSync(parent);
    if (resume) { mkdirSync(join(parent, `session-${id}`)); writeFileSync(join(parent, `session-${id}`, "state"), "preserve"); }
    const before = treeSnapshot(parent);
    const home = openSessionPrivateHome({ parent, resume, sessionId: resume ? id : undefined,
      idPattern: /^[a-z-]+$/, blockedPaths: [], printOnly: true, populate: () => { throw new Error("preview populated"); } });
    home.settle(id); home.remove();
    expect(treeSnapshot(parent)).toEqual(before);
  });
  test(`Codex provider session preview leaves the tree unchanged, resume=${resume}`, () => {
    const rootHome = join(root, `codex-${resume}`), id = "recorded-session";
    mkdirSync(rootHome);
    if (resume) {
      const dir = codexSessionProviderHomePath(rootHome, provider.baseUrl, id);
      mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "config.toml"), "preserve");
    }
    const before = treeSnapshot(rootHome);
    const home = resume ? openCodexSessionProviderHome(rootHome, provider, "synthetic", null, id, true)
      : createCodexSessionProviderHome(rootHome, provider, "synthetic", null, true);
    home.prepareConfig(); home.settle(id, true); home.abandon();
    expect(treeSnapshot(rootHome)).toEqual(before);
  });
}

test("Claude and OpenCode session preview delegates create no state", () => {
  const home = join(root, "delegates"); mkdirSync(home);
  const before = treeSnapshot(home);
  const claude = openProjectSettingsSessionConfigDir("2ccecd6b-dbb5-4d96-bb2c-417ea01f20e9", false, home,
    { HOME: home }, undefined, true);
  const opencode = openOpenCodeSessionHome({ dataDir: join(home, "data"), stateDir: join(home, "state"), printOnly: true });
  claude.remove(); opencode.remove();
  expect(treeSnapshot(home)).toEqual(before);
});

for (const agent of ["codex", "claude", "opencode", "pi", "droid", "cline", "gemini", "goose"] as const) {
  test(`${agent} session provider preflight and preview leave the tree unchanged`, async () => {
    const home = join(root, `cli-${agent}`), cwd = join(home, "project");
    mkdirSync(cwd, { recursive: true }); mkdirSync(join(cwd, ".git"));
    const before = treeSnapshot(home), prefix = `CODEMUX_${agent.toUpperCase()}_PROVIDER_`;
    const result = await runSessionCommand(["-a", agent, "--sandbox", "--sandbox-scrub-env", "--print-sandbox", "--cwd", cwd], {
      [agent]: `if [ "$1" = "--version" ]; then echo '${agent === "codex" ? "codex-cli 0.166.0" : "99.0.0"}'; exit 0; fi\nexit 99`,
      scode: 'if [ "$1" = "--help" ]; then echo --keep-env; exit 0; fi\nexit 99',
    }, { env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache"),
      [`${prefix}BASE_URL`]: provider.baseUrl, [`${prefix}API_KEY`]: provider.apiKey, [`${prefix}MODEL`]: "synthetic" } });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(treeSnapshot(home)).toEqual(before);
  });
}

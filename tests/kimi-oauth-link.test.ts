// Review round 5, part A: a private Kimi brand home shared the token store
// and not Kimi's own refresh lock, so two Kimi processes could rotate one
// refresh token at once. Every private home links `oauth` to the operator's
// directory, the way it links `credentials`.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KimiAdapter } from "../src/adapters/kimi.js";
import { createKimiHermeticHome, KIMI_HERMETIC_ENV_ASSIGNMENTS, KIMI_HERMETIC_ENV_OMISSIONS, populateKimiHermeticSessionHome, relinkKimiSessionHome } from "../src/kimi-hermetic.js";
import { plantKimiCanary } from "../src/kimi-isolation-probe.js";
import { kimiOperatorOauthDirectory, linkKimiOauthDirectory } from "../src/kimi-oauth-link.js";
import { createKimiPolicyHome, populateKimiPolicySessionHome } from "../src/kimi-run-policy.js";
import { applyHarnessHomeSandboxBlocks } from "../src/launch/harness-home-sandbox.js";
import { buildScodeCommand, type SandboxOptions } from "../src/sandbox.js";
import { callerHarnessHomeSharedLogins, openCallerHarnessHome } from "../src/session/harness-home.js";
import { seedHarnessHomeCanary, type PlantedHarnessHomeCanary } from "../src/hermetic-session-canary-home.js";
import type { RunRequest } from "../src/types.js";

function fixture() {
  const scratch = join(import.meta.dir, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "kimi-oauth-"));
  const brand = join(home, ".kimi-code");
  const cwd = join(home, "work");
  mkdirSync(join(brand, "credentials"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(brand, "credentials", "kimi-code.json"), "synthetic");
  const oauth = join(brand, "oauth");
  const linked = (privateBrandHome: string): void => {
    const link = join(privateBrandHome, "oauth");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(oauth);
    expect(statSync(oauth).isDirectory()).toBe(true);
    expect(statSync(oauth).mode & 0o777).toBe(0o700);
  };
  return { home, brand, cwd, oauth, linked, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe("every private Kimi home shares the operator's refresh-lock directory", () => {
  test("a hermetic run and a tools-none run link it, and removal leaves the operator directory", () => {
    const f = fixture();
    try {
      expect(existsSync(f.oauth)).toBe(false);
      for (const toolsNone of [false, true]) {
        const home = createKimiHermeticHome(f.brand, toolsNone);
        f.linked(home.kimiHome);
        // Kimi's sentinel and lock directory land in the operator's directory.
        writeFileSync(join(home.kimiHome, "oauth", "kimi-code"), "");
        mkdirSync(join(home.kimiHome, "oauth", "kimi-code.lock"));
        home.finalize();
        expect(existsSync(home.home)).toBe(false);
        expect(readdirSync(f.oauth).sort()).toEqual(["kimi-code", "kimi-code.lock"]);
        rmSync(join(f.oauth, "kimi-code.lock"), { recursive: true });
      }
    } finally { f.cleanup(); }
  });

  test("two private homes and the operator home contend on one lock directory", () => {
    const f = fixture();
    try {
      const first = createKimiHermeticHome(f.brand), second = createKimiHermeticHome(f.brand);
      try {
        // proper-lockfile's lock is a mkdir of `<target>.lock`.
        mkdirSync(join(first.kimiHome, "oauth", "kimi-code.lock"));
        expect(() => mkdirSync(join(second.kimiHome, "oauth", "kimi-code.lock"))).toThrow("EEXIST");
        expect(() => mkdirSync(join(f.brand, "oauth", "kimi-code.lock"))).toThrow("EEXIST");
      } finally { first.finalize(); second.finalize(); }
    } finally { f.cleanup(); }
  });

  test("a policy run keeps one link when the operator directory already exists", () => {
    const f = fixture();
    try {
      mkdirSync(f.oauth, { mode: 0o700 });
      writeFileSync(join(f.brand, "config.toml"), "");
      const request: RunRequest = { agent: "kimi", prompt: "hi", cwd: f.cwd, web: false };
      const home = createKimiPolicyHome(f.brand, request);
      try { f.linked(home.kimiHome); } finally { home.finalize(); }
    } finally { f.cleanup(); }
  });

  test("project-settings mode and the adapter's hermetic tools-none run link it", () => {
    const f = fixture();
    try {
      mkdirSync(join(f.cwd, ".git"));
      const adapter = new KimiAdapter({ HOME: f.home }, f.home);
      const requests: RunRequest[] = [
        { agent: "kimi", prompt: "p", cwd: f.cwd, hermetic: true, autonomy: "low", sandboxed: true, experimentProjectSettings: true },
        { agent: "kimi", prompt: "p", cwd: f.cwd, hermetic: true, autonomy: "high", tools: "none" },
      ];
      for (const request of requests) {
        const context = adapter.prepareRun(request);
        try { f.linked(context.kimiHermeticHome!.kimiHome); } finally { adapter.cleanupRunSync(context); }
      }
    } finally { f.cleanup(); }
  });

  test("hermetic and policy session homes link it at creation", () => {
    const f = fixture();
    try {
      const hermetic = join(f.home, "session-hermetic"), policy = join(f.home, "session-policy");
      mkdirSync(hermetic); mkdirSync(policy);
      f.linked(populateKimiHermeticSessionHome(hermetic, f.brand).brandHome);
      populateKimiPolicySessionHome(policy, f.brand);
      f.linked(join(policy, ".kimi-code"));
      // A print-only home touches nothing of the operator's.
      rmSync(f.oauth, { recursive: true });
      const preview = join(f.home, "session-preview");
      mkdirSync(preview);
      populateKimiHermeticSessionHome(preview, f.brand, true);
      expect(existsSync(f.oauth)).toBe(false);
      expect(existsSync(join(preview, ".kimi-code", "oauth"))).toBe(false);
    } finally { f.cleanup(); }
  });

  test("a resumed home from 2.0.3 gains the link, replacing the directory Kimi made for itself", () => {
    const f = fixture();
    try {
      const dir = join(f.home, "session-old");
      mkdirSync(join(dir, ".kimi-code"), { recursive: true });
      const brandHome = join(dir, ".kimi-code");
      symlinkSync(join(f.brand, "credentials"), join(brandHome, "credentials"), "dir");
      relinkKimiSessionHome(dir, f.brand);
      f.linked(brandHome);
      relinkKimiSessionHome(dir, f.brand);
      f.linked(brandHome);
      // Kimi 2.6 created its own lock directory in the unlinked home.
      rmSync(join(brandHome, "oauth"));
      mkdirSync(join(brandHome, "oauth", "kimi-code.lock"), { recursive: true });
      writeFileSync(join(brandHome, "oauth", "kimi-code"), "");
      relinkKimiSessionHome(dir, f.brand);
      f.linked(brandHome);
      expect(readdirSync(f.oauth)).toEqual([]);
    } finally { f.cleanup(); }
  });

  test("a foreign entry at the link is refused by path and never deleted", () => {
    const f = fixture();
    try {
      const dir = join(f.home, "session-odd");
      const brandHome = join(dir, ".kimi-code");
      mkdirSync(join(brandHome, "oauth"), { recursive: true });
      symlinkSync(join(f.brand, "credentials"), join(brandHome, "credentials"), "dir");
      writeFileSync(join(brandHome, "oauth", "notes.txt"), "caller data");
      expect(() => relinkKimiSessionHome(dir, f.brand)).toThrow(join(brandHome, "oauth"));
      expect(readFileSync(join(brandHome, "oauth", "notes.txt"), "utf8")).toBe("caller data");
      rmSync(join(brandHome, "oauth"), { recursive: true });
      const elsewhere = join(f.home, "elsewhere");
      mkdirSync(elsewhere);
      symlinkSync(elsewhere, join(brandHome, "oauth"));
      expect(() => relinkKimiSessionHome(dir, f.brand)).toThrow("points somewhere else");
      expect(readlinkSync(join(brandHome, "oauth"))).toBe(elsewhere);
      // A home that shares no credential store gets no link.
      const keyed = join(f.home, "session-keyed");
      mkdirSync(join(keyed, ".kimi-code"), { recursive: true });
      relinkKimiSessionHome(keyed, f.brand);
      expect(existsSync(join(keyed, ".kimi-code", "oauth"))).toBe(false);
    } finally { f.cleanup(); }
  });

  test("the operator directory is the brand home's own, also when credentials is a symlink elsewhere", () => {
    const f = fixture();
    try {
      const elsewhere = join(f.home, "dotfiles", "kimi");
      mkdirSync(join(elsewhere, "creds"), { recursive: true });
      rmSync(join(f.brand, "credentials"), { recursive: true });
      symlinkSync(join(elsewhere, "creds"), join(f.brand, "credentials"));
      const home = createKimiHermeticHome(f.brand);
      try {
        f.linked(home.kimiHome);
        expect(readdirSync(elsewhere)).toEqual(["creds"]);
      } finally { home.finalize(); }
      // A file where the directory belongs refuses by path and stays.
      rmSync(f.oauth, { recursive: true });
      writeFileSync(f.oauth, "not a directory");
      expect(() => kimiOperatorOauthDirectory(f.brand)).toThrow(f.oauth);
      expect(() => linkKimiOauthDirectory(f.brand, join(f.home, "nowhere"))).toThrow("is not a directory");
      expect(readFileSync(f.oauth, "utf8")).toBe("not a directory");
    } finally { f.cleanup(); }
  });

  test("a read-only operator home is left as it is and the link still names its directory", () => {
    const f = fixture();
    try {
      chmodSync(f.brand, 0o500);
      const privateBrandHome = join(f.home, "private-brand");
      mkdirSync(privateBrandHome);
      linkKimiOauthDirectory(f.brand, privateBrandHome);
      expect(readlinkSync(join(privateBrandHome, "oauth"))).toBe(f.oauth);
      expect(readdirSync(f.brand)).toEqual(["credentials"]);
      // Kimi's own preparation of the lock fails closed there, as it does natively.
      expect(() => writeFileSync(join(privateBrandHome, "oauth", "kimi-code"), "")).toThrow();
      // A home built from that private home (a check canary's hermetic run) chains to the same place.
      const nested = join(f.home, "nested-brand");
      mkdirSync(nested);
      linkKimiOauthDirectory(privateBrandHome, nested);
      expect(readlinkSync(join(nested, "oauth"))).toBe(join(privateBrandHome, "oauth"));
    } finally { chmodSync(f.brand, 0o700); f.cleanup(); }
  });

  test("a caller-owned home links it and the sandbox grants it beside the credential store", () => {
    const f = fixture();
    try {
      const dir = join(f.home, "caller");
      const blocked = [f.brand];
      openCallerHarnessHome({ agent: "kimi", dir, cwd: f.cwd, blockedPaths: blocked, sourceHome: f.home, sourceEnv: {}, apiKeyAuth: false });
      f.linked(join(dir, ".kimi-code"));
      const shared = callerHarnessHomeSharedLogins("kimi", f.home, {}, f.cwd, false);
      expect(shared).toEqual([join(f.brand, "credentials"), f.oauth]);
      expect(callerHarnessHomeSharedLogins("kimi", f.home, {}, f.cwd, true)).toEqual([]);
      const options: SandboxOptions = {};
      applyHarnessHomeSandboxBlocks(options, dir, blocked, shared);
      const argv = buildScodeCommand(["kimi"], f.cwd, "low", options, "scode", { HOME: f.home });
      const granted = argv.filter((_, index) => argv[index - 1] === "--allow");
      expect(granted).toContain(join(f.brand, "credentials"));
      expect(granted).toContain(f.oauth);
      expect(argv.filter((_, index) => argv[index - 1] === "--block")).toContain(f.brand);
      // An API-key caller home links neither the store nor the lock directory.
      const keyed = join(f.home, "caller-keyed");
      openCallerHarnessHome({ agent: "kimi", dir: keyed, cwd: f.cwd, blockedPaths: blocked, sourceHome: f.home, sourceEnv: {}, apiKeyAuth: true });
      expect(existsSync(join(keyed, ".kimi-code", "oauth"))).toBe(false);
    } finally { f.cleanup(); }
  });

  test("the planted canary home links it, and the caller-home canary names the operator brand home", () => {
    const f = fixture();
    try {
      const planted = plantKimiCanary({ HOME: f.home });
      try {
        f.linked(planted.brandHome);
        // The authenticated home is a session home under the planted one; the
        // chain ends at the operator brand home, whatever `credentials` resolves to.
        const session = join(planted.brandHome, ".codemux-hermetic", "session-x");
        mkdirSync(session, { recursive: true });
        populateKimiHermeticSessionHome(session, planted.brandHome);
        const plant = { operatorHome: join(f.home, "scratch-operator"), home: join(f.home, "scratch-caller"), env: {} } as unknown as PlantedHarnessHomeCanary;
        seedHarnessHomeCanary("kimi", plant, session);
        expect(plant.env.KIMI_CODE_HOME).toBe(realpathSync(f.brand));
      } finally { planted.cleanup(); }
    } finally { f.cleanup(); }
  });
});

describe("KIMI_DISABLE_OAUTH_LOCK", () => {
  test("codemux never sets it and passes the operator's own value through unchanged", () => {
    const f = fixture();
    try {
      const mentions = (list: readonly string[]) => list.filter((entry) => entry.includes("KIMI_DISABLE_OAUTH_LOCK"));
      expect(mentions(KIMI_HERMETIC_ENV_ASSIGNMENTS)).toEqual([]);
      expect(mentions(KIMI_HERMETIC_ENV_OMISSIONS)).toEqual([]);
      mkdirSync(join(f.cwd, ".git"));
      const request: RunRequest = { agent: "kimi", prompt: "p", cwd: f.cwd, hermetic: true, autonomy: "high" };
      const unset = new KimiAdapter({ HOME: f.home }, f.home);
      const context = unset.prepareRun(request);
      try {
        expect(mentions(unset.buildRunCommand(request, context))).toEqual([]);
        expect(unset.buildExecutionEnv(unset.getRunEnv(request, context)).KIMI_DISABLE_OAUTH_LOCK).toBeUndefined();
      } finally { unset.cleanupRunSync(context); }
      const exported = new KimiAdapter({ HOME: f.home, KIMI_DISABLE_OAUTH_LOCK: "1" }, f.home);
      expect(exported.buildExecutionEnv({}, ["KIMI_DISABLE_OAUTH_LOCK"]).KIMI_DISABLE_OAUTH_LOCK).toBe("1");
      expect(exported.getEnvOmissions()).not.toContain("KIMI_DISABLE_OAUTH_LOCK");
    } finally { f.cleanup(); }
  });

  test("no source file assigns it", () => {
    const root = join(import.meta.dir, "../src");
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []);
    const hits = walk(root).filter((path) => readFileSync(path, "utf8").includes("KIMI_DISABLE_OAUTH_LOCK"));
    expect(hits).toEqual([]);
  });
});

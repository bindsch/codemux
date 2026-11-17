// Hermetic agy session homes written by codemux 2.0.3 resume after the
// upgrade (review round 3). Every home here is built by hand in 2.0.3's
// real layout: a copied regular token file, a private Library/Keychains
// directory holding the codemux mirror, the private preference file, and
// the marker 2.0.3 wrote. No test rewrites the marker of a current home.
import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGY_FILE_TOKEN, AGY_NATIVE_PATHS } from "../src/agy-auth.js";
import { AGY_MIGRATION_LOCK, migrateIdleLegacyAgyHomes, migrateLegacyAgyHome } from "../src/session/agy-legacy-home.js";
import { verifyAgySessionPrivateHome } from "../src/session/agy-private-home.js";
import { cleanupAgyIsolation, setup } from "./helpers/agy-isolation-setup.js";

afterEach(cleanupAgyIsolation);

const MIRROR = join(AGY_NATIVE_PATHS[0], "login.keychain-db");

function operator(platform: NodeJS.Platform, fileToken: boolean) {
  const { home } = setup(false);
  const source = join(home, "operator");
  mkdirSync(join(source, ".gemini/antigravity-cli"), { recursive: true });
  if (platform === "darwin") {
    mkdirSync(join(source, AGY_NATIVE_PATHS[0]), { recursive: true });
    mkdirSync(join(source, "Library/Preferences"), { recursive: true });
    writeFileSync(join(source, AGY_NATIVE_PATHS[0], "login.keychain-db"), "the operator's real keychain");
    writeFileSync(join(source, AGY_NATIVE_PATHS[1]), "the operator's preferences");
  }
  if (fileToken) writeFileSync(join(source, AGY_FILE_TOKEN), "the operator's live token");
  const parent = join(source, ".gemini/.codemux-isolation-probes");
  mkdirSync(parent);
  return { source, parent, options: { environment: { HOME: source }, scrubbing: false, platform } };
}

/** A home as 2.0.3's populate left it. On macOS every arm prepared the
 * private Keychain and selected it as the private default. */
function legacyHome(parent: string, name: string, marker: "token" | "keychain", platform: NodeJS.Platform): string {
  const dir = join(parent, name);
  mkdirSync(join(dir, ".gemini/antigravity-cli"), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, ".codemux-probe-pid"), "999999", { mode: 0o600 });
  writeFileSync(join(dir, ".codemux-probe-owner"), "1b91a970-7a85-421e-b9d0-09b06665b637", { mode: 0o600 });
  if (platform === "darwin") {
    mkdirSync(join(dir, AGY_NATIVE_PATHS[0]), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, "Library/Preferences"), { recursive: true });
    writeFileSync(join(dir, MIRROR), "a codemux-made mirror", { mode: 0o600 });
    writeFileSync(join(dir, AGY_NATIVE_PATHS[1]), "a private default selecting the mirror");
  }
  if (marker === "token") {
    writeFileSync(join(dir, AGY_FILE_TOKEN), "a stale copied token", { flag: "wx", mode: 0o600 });
  }
  writeFileSync(join(dir, ".codemux-login"), marker, { mode: 0o600 });
  // The session's own state, which the migration must leave alone.
  mkdirSync(join(dir, ".gemini/antigravity-cli/conversations"));
  writeFileSync(join(dir, ".gemini/antigravity-cli/conversations/turn.json"), "transcript");
  writeFileSync(join(dir, ".gemini/antigravity-cli/settings.json"), "caller settings");
  return dir;
}

function expectNativeHome(dir: string, source: string, platform: NodeJS.Platform, fileToken: boolean): void {
  expect(readFileSync(join(dir, ".codemux-login"), "utf8")).toBe("native");
  if (fileToken) expect(readlinkSync(join(dir, AGY_FILE_TOKEN))).toBe(join(source, AGY_FILE_TOKEN));
  else expect(lstatSync(join(dir, AGY_FILE_TOKEN), { throwIfNoEntry: false })).toBeUndefined();
  for (const relative of AGY_NATIVE_PATHS) {
    if (platform === "darwin") expect(readlinkSync(join(dir, relative))).toBe(join(source, relative));
    else expect(lstatSync(join(dir, relative), { throwIfNoEntry: false })).toBeUndefined();
  }
  expect(readFileSync(join(dir, ".gemini/antigravity-cli/conversations/turn.json"), "utf8")).toBe("transcript");
  expect(readFileSync(join(dir, ".gemini/antigravity-cli/settings.json"), "utf8")).toBe("caller settings");
}

function expectOperatorUntouched(source: string, platform: NodeJS.Platform, fileToken: boolean): void {
  if (fileToken) expect(readFileSync(join(source, AGY_FILE_TOKEN), "utf8")).toBe("the operator's live token");
  if (platform === "darwin") {
    expect(readFileSync(join(source, AGY_NATIVE_PATHS[0], "login.keychain-db"), "utf8")).toBe("the operator's real keychain");
    expect(readFileSync(join(source, AGY_NATIVE_PATHS[1]), "utf8")).toBe("the operator's preferences");
  }
}

test.each(["darwin", "linux"] as const)("%s: a real 2.0.3 token home resumes on the live token", (platform) => {
  const { source, parent, options } = operator(platform, true);
  const dir = legacyHome(parent, "session-token", "token", platform);
  expect(verifyAgySessionPrivateHome(dir, options)).toBe("native");
  expectNativeHome(dir, source, platform, true);
  // The link reads the operator's live token, not the stale copy.
  expect(readFileSync(join(dir, AGY_FILE_TOKEN), "utf8")).toBe("the operator's live token");
  expectOperatorUntouched(source, platform, true);
  // A second resume verifies the migrated home like any current one.
  expect(verifyAgySessionPrivateHome(dir, options)).toBe("native");
});

test("darwin: a real 2.0.3 keychain home resumes on the linked native login", () => {
  const { source, parent, options } = operator("darwin", false);
  const dir = legacyHome(parent, "session-keychain", "keychain", "darwin");
  // The Keychain library's atomic-write sibling and lock file are mirror files too.
  writeFileSync(join(dir, AGY_NATIVE_PATHS[0], "login.keychain-db.sb-1a2b3c4d-AbCdEf"), "staging");
  writeFileSync(join(dir, AGY_NATIVE_PATHS[0], ".fl5A3B7F21"), "");
  expect(verifyAgySessionPrivateHome(dir, options)).toBe("native");
  expectNativeHome(dir, source, "darwin", false);
  expectOperatorUntouched(source, "darwin", false);
});

test("a private Keychains directory holding anything but the mirror refuses and removes nothing", () => {
  const { source, parent, options } = operator("darwin", true);
  for (const marker of ["token", "keychain"] as const) {
    const dir = legacyHome(parent, `session-foreign-${marker}`, marker, "darwin");
    writeFileSync(join(dir, AGY_NATIVE_PATHS[0], "other.keychain-db"), "not codemux's");
    expect(() => verifyAgySessionPrivateHome(dir, options)).toThrow("holds a file codemux did not create");
    expect(readFileSync(join(dir, MIRROR), "utf8")).toBe("a codemux-made mirror");
    expect(readFileSync(join(dir, ".codemux-login"), "utf8")).toBe(marker);
    if (marker === "token") expect(readFileSync(join(dir, AGY_FILE_TOKEN), "utf8")).toBe("a stale copied token");
  }
  expectOperatorUntouched(source, "darwin", true);
});

test("an interrupted migration finishes on the next resume", () => {
  const { source, parent, options } = operator("darwin", true);
  const dir = legacyHome(parent, "session-interrupted", "token", "darwin");
  // The pass stopped after the copies were removed and before the marker.
  expect(verifyAgySessionPrivateHome(dir, options)).toBe("native");
  writeFileSync(join(dir, ".codemux-login"), "token", { mode: 0o600 });
  expect(verifyAgySessionPrivateHome(dir, options)).toBe("native");
  expectNativeHome(dir, source, "darwin", true);
});

test("idle 2.0.3 homes lose their login copies before any resume; held and unreadable ones are left alone", () => {
  const { source, parent } = operator("darwin", true);
  const idle = legacyHome(parent, "session-idle", "token", "darwin");
  const keychain = legacyHome(parent, "session-idle-keychain", "keychain", "darwin");
  const held = legacyHome(parent, "session-held", "token", "darwin");
  const unknown = legacyHome(parent, "session-unknown", "keychain", "darwin");
  const spared = legacyHome(parent, "session-spared", "token", "darwin");
  const foreign = legacyHome(parent, "session-foreign", "keychain", "darwin");
  writeFileSync(join(foreign, AGY_NATIVE_PATHS[0], "other.keychain-db"), "not codemux's");
  const hold = (id: string) => id === "held" ? "held" : id === "unknown" ? "unknown" : "free";
  migrateIdleLegacyAgyHomes(parent, source, "spared", hold, "darwin");
  expectNativeHome(idle, source, "darwin", true);
  expectNativeHome(keychain, source, "darwin", true);
  for (const dir of [held, spared]) {
    expect(readFileSync(join(dir, AGY_FILE_TOKEN), "utf8")).toBe("a stale copied token");
    expect(readFileSync(join(dir, ".codemux-login"), "utf8")).toBe("token");
  }
  for (const dir of [unknown, foreign]) {
    expect(existsSync(join(dir, MIRROR))).toBe(true);
    expect(readFileSync(join(dir, ".codemux-login"), "utf8")).toBe("keychain");
  }
  expectOperatorUntouched(source, "darwin", true);
  // A missing parent is not an error.
  migrateIdleLegacyAgyHomes(join(parent, "absent"), source, undefined, hold, "darwin");
});

test("a migration another process holds: the idle sweep skips it, a resume waits for it and never sees a half-removed home", async () => {
  // Review round 4, correctness 2: the sweep's check-then-act raced a resume and the loser died on a raw ENOENT.
  const { source, parent, options } = operator("darwin", true);
  const dir = legacyHome(parent, "session-raced", "token", "darwin");
  const worker = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/agy-migration-worker.ts"), dir, source, "1500"],
    { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = worker.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("held");
    reader.releaseLock();
    // The losing sweep leaves the home to the holder.
    migrateIdleLegacyAgyHomes(parent, source, undefined, () => "free", "darwin");
    expect(migrateLegacyAgyHome(dir, source, "darwin")).toBe(false);
    expect(readFileSync(join(dir, ".codemux-login"), "utf8")).toBe("token");
    expect(readFileSync(join(dir, AGY_FILE_TOKEN), "utf8")).toBe("a stale copied token");
    // A losing resume whose wait runs out refuses by name.
    expect(() => verifyAgySessionPrivateHome(dir, { ...options, legacyMigrationWaitMs: 10 })).toThrow("retry the resume");
    // A losing resume that waits finds the finished home.
    expect(verifyAgySessionPrivateHome(dir, options)).toBe("native");
    expect(await worker.exited).toBe(0);
    expectNativeHome(dir, source, "darwin", true);
    expect(existsSync(join(dir, AGY_MIGRATION_LOCK))).toBe(true);
    expectOperatorUntouched(source, "darwin", true);
  } finally { worker.kill(); await worker.exited; }
});

// Review round 5, security 1: the home is writable by its sandboxed child,
// and the unsandboxed marker rewrite followed links planted in it.
test("links planted at staging names are never written through", () => {
  const { source, parent, options } = operator("linux", true);
  const dir = legacyHome(parent, "session-planted", "token", "linux");
  const victim = join(source, "operator-file");
  writeFileSync(victim, "the operator's file");
  // 2.0.4's first staging name was the marker plus the process id.
  for (const pid of [process.pid, process.pid + 1, 1]) symlinkSync(victim, join(dir, `.codemux-login.tmp-${pid}`));
  expect(verifyAgySessionPrivateHome(dir, options)).toBe("native");
  expect(readFileSync(victim, "utf8")).toBe("the operator's file");
  expect(lstatSync(join(dir, ".codemux-login")).isFile()).toBe(true);
  expectNativeHome(dir, source, "linux", true);
  // No staging file of this pass is left behind; the planted links stay as they were.
  const staged = readdirSync(dir).filter((name) => name.startsWith(".codemux-login.tmp-"));
  expect(staged.sort()).toEqual([1, process.pid, process.pid + 1].map((pid) => `.codemux-login.tmp-${pid}`).sort());
  for (const name of staged) expect(readlinkSync(join(dir, name))).toBe(victim);
});

test("a marker that is a symbolic link is refused and its target is never rewritten", () => {
  const { source, parent, options } = operator("linux", true);
  const dir = legacyHome(parent, "session-linked-marker", "token", "linux");
  const victim = join(source, "operator-file");
  writeFileSync(victim, "token");
  unlinkSync(join(dir, ".codemux-login"));
  symlinkSync(victim, join(dir, ".codemux-login"));
  expect(() => verifyAgySessionPrivateHome(dir, options)).toThrow("carries no login marker");
  migrateIdleLegacyAgyHomes(parent, source, undefined, () => "free", "linux");
  expect(readFileSync(victim, "utf8")).toBe("token");
  expect(readlinkSync(join(dir, ".codemux-login"))).toBe(victim);
  // Nothing was migrated: the copied token is still the regular file 2.0.3 wrote.
  expect(readFileSync(join(dir, AGY_FILE_TOKEN), "utf8")).toBe("a stale copied token");
  expect(lstatSync(join(dir, AGY_FILE_TOKEN)).isFile()).toBe(true);
});

test("a legacy marker without the 2.0.3 layout starts no migration", () => {
  const { source, parent, options } = operator("darwin", true);
  // A current API-key home whose child rewrote the marker: no copied token, no private Keychains.
  const dir = join(parent, "session-marker-only");
  mkdirSync(join(dir, ".gemini/antigravity-cli"), { recursive: true, mode: 0o700 });
  for (const marker of ["token", "keychain"]) {
    writeFileSync(join(dir, ".codemux-login"), marker, { mode: 0o600 });
    expect(() => verifyAgySessionPrivateHome(dir, options)).toThrow("the marker alone is not trusted");
    migrateIdleLegacyAgyHomes(parent, source, undefined, () => "free", "darwin");
    expect(readFileSync(join(dir, ".codemux-login"), "utf8")).toBe(marker);
    // No login was linked into the home.
    expect(lstatSync(join(dir, AGY_FILE_TOKEN), { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(join(dir, "Library"), { throwIfNoEntry: false })).toBeUndefined();
  }
});

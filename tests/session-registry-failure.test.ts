import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  claimForResume,
  lookupForResume,
  probeRegistryForStart,
  readRegistry,
  recordSessionStart,
  type SandboxTrust,
  touchSession,
} from "../src/session/registry.js";
import type { AutonomyLevel } from "../src/types.js";
import { craftEntry, makeRoot, newRecord, probe, registryIn, seedRegistry } from "./helpers/session-registry.js";

describe("failure policy", () => {
  test("a corrupt registry fails resume closed", () => {
    const path = registryIn(makeRoot());
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "not json at all", { mode: 0o600 });
    const result = lookupForResume(path, "sess-1", probe());
    expect(result.outcome).toBe("untrusted");
    if (result.outcome === "untrusted") expect(result.reason).toContain("corrupt");
  });

  test("a shape-valid but wrong registry is corrupt, not ok", () => {
    const path = registryIn(makeRoot());
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, '{"version":2,"sessions":[]}', { mode: 0o600 });
    expect(readRegistry(path).outcome).toBe("corrupt");
    writeFileSync(path, '{"version":1,"sessions":[{"id":"x"}]}', { mode: 0o600 });
    expect(readRegistry(path).outcome).toBe("corrupt");
  });

  test("prototype-chain spellings of the enum fields are corrupt, not ranks", () => {
    // Review live11, minor 6: validation used `in`, and `"constructor"
    // in AUTONOMY_REACH` is true through the prototype chain — so a
    // tampered record carrying autonomy "toString" or sandbox_trust
    // "constructor" validated, and the trust guard then compared
    // TRUST_RANK["constructor"] (a function, so NaN) against a number:
    // never greater, so a trusted resume above the recorded trust was
    // never refused. Object.hasOwn makes such records corrupt, which
    // fails the resume closed.
    const path = registryIn(makeRoot());
    seedRegistry(path, [craftEntry({ id: "proto-trust", sandbox_trust: "constructor" as SandboxTrust })]);
    expect(readRegistry(path).outcome).toBe("corrupt");
    const refused = lookupForResume(path, "proto-trust", probe());
    expect(refused.outcome).toBe("untrusted");
    if (refused.outcome === "untrusted") expect(refused.reason).toContain("corrupt");

    const otherPath = registryIn(makeRoot());
    seedRegistry(otherPath, [craftEntry({ id: "proto-auto", autonomy: "toString" as AutonomyLevel })]);
    expect(readRegistry(otherPath).outcome).toBe("corrupt");
  });

  test("the next new session backs the corrupt file up and starts fresh", () => {
    const path = registryIn(makeRoot());
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{corrupt", { mode: 0o600 });
    expect(recordSessionStart(path, newRecord()).ok).toBe(true);
    const dir = join(path, "..");
    const backups = readdirSync(dir).filter((name) => name.startsWith("live-sessions.json.corrupt-"));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(dir, backups[0] as string), "utf8")).toBe("{corrupt");
    const read = readRegistry(path);
    expect(read.outcome).toBe("ok");
    if (read.outcome === "ok") expect(read.file.sessions.length).toBe(1);
    // Updates against a still-corrupt registry fail rather than reset.
    const again = registryIn(makeRoot());
    mkdirSync(join(again, ".."), { recursive: true });
    writeFileSync(again, "{corrupt", { mode: 0o600 });
    expect(touchSession(again, "sess-1").ok).toBe(false);
  });
});

describe("registry failure classes (review live22)", () => {
  test("a claim that cannot reach the registry is unavailable, not untrusted", () => {
    // Correctness major 3: an I/O failure inside the claim's locked
    // update (a busy lock, ENOSPC, EACCES; here a file where the
    // registry's directory must be) came back "untrusted", which the CLI
    // maps to 78, the permanent policy refusal. Nothing was judged, so it
    // is unavailable now, and the CLI exits 1 as a fresh session does.
    const root = makeRoot();
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a directory");
    const result = claimForResume(join(blocker, "reg", "live-sessions.json"), "sess-1", probe());
    expect(result.outcome).toBe("unavailable");
    // A registry codemux will not vouch from stays untrusted.
    const path = registryIn(makeRoot());
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, "not json at all", { mode: 0o600 });
    expect(claimForResume(path, "sess-1", probe()).outcome).toBe("untrusted");
  });

  test("a transient read failure is unavailable for resume, never the 78 refusal", () => {
    // Sibling of major 3 on the unlocked lookup: descriptor exhaustion
    // (EMFILE) while reading a healthy registry was classed "untrusted".
    const path = registryIn(makeRoot());
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, '{"version":1,"sessions":[]}', { mode: 0o600 });
    const realOpen = fs.openSync;
    const openSpy = spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (String(target) === fs.realpathSync(path)) {
        throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
      }
      return realOpen(target, flags, mode);
    }) as typeof fs.openSync);
    try {
      expect(readRegistry(path).outcome).toBe("unavailable");
      expect(lookupForResume(path, "sess-1", probe()).outcome).toBe("unavailable");
    } finally {
      openSpy.mockRestore();
    }
    expect(lookupForResume(path, "sess-1", probe()).outcome).toBe("not_found");
  });

  test("the start probe refuses an untrusted or unreachable registry and accepts a fresh one", () => {
    // Correctness major 4: a fresh agy session runs its first turn before
    // its id exists, so the registry is proven writable before the spawn.
    const fresh = registryIn(makeRoot());
    expect(probeRegistryForStart(fresh).ok).toBe(true);
    const wide = registryIn(makeRoot());
    mkdirSync(join(wide, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(wide, '{"version":1,"sessions":[]}', { mode: 0o600 });
    chmodSync(wide, 0o644);
    const refused = probeRegistryForStart(wide);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.kind).toBe("untrusted");
    const root = makeRoot();
    writeFileSync(join(root, "blocker"), "x");
    const blocked = probeRegistryForStart(join(root, "blocker", "reg", "live-sessions.json"));
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.kind).toBe("unavailable");
  });
});

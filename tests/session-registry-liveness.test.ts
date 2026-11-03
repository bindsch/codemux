import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  processIdentityAlive,
  sessionHoldState,
  sessionRegistryPath,
} from "../src/session/registry.js";
import {
  craftEntry,
  DEAD_PID,
  makeRoot,
  registryIn,
  seedRegistry,
} from "./helpers/session-registry.js";

describe("registry path and liveness", () => {
  test("the default path is home-derived per platform", () => {
    expect(sessionRegistryPath("/Users/x", "darwin")).toBe(
      "/Users/x/Library/Application Support/codemux/live-sessions.json"
    );
    expect(sessionRegistryPath("/home/x", "linux")).toBe(
      "/home/x/.local/state/codemux/live-sessions.json"
    );
  });

  test("identity liveness: self alive, out-of-range pid dead", () => {
    expect(processIdentityAlive(process.pid, null)).toBe(true);
    expect(processIdentityAlive(DEAD_PID, null)).toBe(false);
  });

  test("sessionHoldState answers held/free/unknown so a deletion acts only on a positive free (reviews D2, D5)", () => {
    // The file-sweeper's liveness skip: only a session the registry holds
    // OPEN under a live owner is protected from the age sweep (`held`) —
    // an ended or dead-owner session stays sweepable, an unknown id is
    // not held. The D5 rule: a registry that cannot be READ answers
    // `unknown`, never a folded-in "not held" — the sweeps spare what
    // they cannot judge, and only a positive `free` may remove.
    const path = registryIn(makeRoot());
    seedRegistry(path, [
      craftEntry({ id: "live-id", owner_pid: process.pid }),
      craftEntry({ id: "ended-id", owner_pid: process.pid, ended: "2026-10-05T11:00:00.000Z" }),
      craftEntry({ id: "dead-id", owner_pid: DEAD_PID }),
    ]);
    expect(sessionHoldState(path, "live-id")).toBe("held");
    expect(sessionHoldState(path, "ended-id")).toBe("free");
    expect(sessionHoldState(path, "dead-id")).toBe("free");
    expect(sessionHoldState(path, "unknown-id")).toBe("free");
    // No registry at all: nothing can be held (a deletion may proceed).
    expect(sessionHoldState(join(makeRoot(), "absent.json"), "live-id")).toBe("free");
    // A corrupt file is as unreadable as a busy read: unknown, not free.
    const corruptRoot = makeRoot();
    const corruptPath = registryIn(corruptRoot);
    mkdirSync(join(corruptPath, ".."), { recursive: true });
    writeFileSync(corruptPath, "not json", { mode: 0o600 });
    expect(sessionHoldState(corruptPath, "live-id")).toBe("unknown");
    // An untrusted placement (a symlinked registry file) reads the same
    // way: unknown — every not-ok read spares the candidate (review D5,
    // correctness 1 — the transient failure that deleted a live home).
    const linkedRoot = makeRoot();
    const linkedPath = registryIn(linkedRoot);
    mkdirSync(join(linkedPath, ".."), { recursive: true });
    seedRegistry(join(linkedRoot, "reg", "real.json"), [
      craftEntry({ id: "live-id", owner_pid: process.pid }),
    ]);
    symlinkSync(join(linkedRoot, "reg", "real.json"), linkedPath);
    expect(sessionHoldState(linkedPath, "live-id")).toBe("unknown");
  });

  test("an unreadable table and an EPERM probe mean alive, never dead (review live16)", () => {
    // Review live16, minor: the signal-0 fallback read every throw as a
    // dead process, so inside a sandbox that denies signals a live lock
    // holder or session owner looked dead and could be stolen. Only
    // ESRCH proves the pid is gone; the probe is stubbed so the test
    // does not depend on the runner's uid.
    const original = process.kill;
    const throwWith = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    try {
      process.kill = throwWith("EPERM") as typeof process.kill;
      expect(processIdentityAlive(4242, null, new Map())).toBe(true);
      process.kill = throwWith("ESRCH") as typeof process.kill;
      expect(processIdentityAlive(4242, null, new Map())).toBe(false);
    } finally {
      process.kill = original;
    }
  });
});

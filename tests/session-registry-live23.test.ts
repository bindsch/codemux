import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireLock } from "../src/session/registry-io.js";
import { lookupForResume, readRegistry, recordSessionStart } from "../src/session/registry.js";
import { DEAD_PID, makeRoot, newRecord, probe, registryIn } from "./helpers/session-registry.js";

describe("review live23", () => {
  test("a dead acquirer's lock file with invalid UTF-8 is stolen like any junk", () => {
    // Audit sibling of contracts major 2: the strict decode threw, and
    // the lock reader classed that `unknown` (never stolen), so the bytes
    // blocked every registry write until someone deleted the file.
    const root = makeRoot();
    const lockPath = join(root, "live-sessions.json.lock");
    const corpse = join(root, `.live-sessions.json.lock.${DEAD_PID}.badb17.held`);
    writeFileSync(corpse, Buffer.from([0xff, 0xfe, 0x0a]), { mode: 0o600 });
    const handle = acquireLock(lockPath, { attempts: 1 });
    expect(existsSync(corpse)).toBe(false);
    handle.release();
  });

  test("an invalid-UTF-8 registry is corrupt, so the next start backs it up and resets", () => {
    // Contracts major 2: the strict decode threw a code-less error, which
    // the reader classed untrusted. Every start and resume was then
    // refused 78 until someone deleted the file by hand.
    const path = registryIn(makeRoot());
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), { mode: 0o600 });
    expect(readRegistry(path).outcome).toBe("corrupt");
    expect(lookupForResume(path, "sess-1", probe()).outcome).toBe("untrusted");
    expect(recordSessionStart(path, newRecord()).ok).toBe(true);
    expect(readRegistry(path).outcome).toBe("ok");
    const backups = readdirSync(dirname(path)).filter((name) => name.includes(".corrupt-"));
    expect(backups).toHaveLength(1);
  });

  test("a dangling symlink at the registry directory is refused as untrusted, naming the link", () => {
    // Contracts minor 4: `existsSync` follows links, so a dangling link
    // read as "nothing exists yet", skipped the symlink refusal, and the
    // write then failed as "unavailable" on every start. The registry
    // file's own existence check had the same shape.
    const root = makeRoot();
    symlinkSync(join(root, "gone"), join(root, "reg"));
    const path = join(root, "reg", "live-sessions.json");
    const outcome = recordSessionStart(path, newRecord());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("untrusted");
      expect(outcome.error).toContain("symbolic link");
    }
    const fileRoot = makeRoot();
    const filePath = registryIn(fileRoot);
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    symlinkSync(join(fileRoot, "gone"), filePath);
    const fileOutcome = recordSessionStart(filePath, newRecord());
    expect(fileOutcome.ok).toBe(false);
    if (!fileOutcome.ok) {
      expect(fileOutcome.kind).toBe("untrusted");
      expect(fileOutcome.error).toContain("the registry is a symbolic link");
    }
  });
});

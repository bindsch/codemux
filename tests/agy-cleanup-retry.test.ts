/**
 * The agy private-home cleanup's retry contract (review round 137): a
 * failed removal stays retryable — the validation descriptors and the
 * owned state survive a failure — until the removal succeeds or nothing
 * is left to remove; the process-exit call closes the descriptors
 * whatever the outcome. The fixtures create owned homes directly, with
 * no Keychain state, so cleanup tests directory removal alone.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as fs from "node:fs";
import { AgyAdapter } from "../src/adapters/agy.js";
import { createAgyProbeHome } from "../src/adapters/agy-probe-home.js";
import { agyKeychainHost } from "../src/agy-keychain.js";
import type { RunContext } from "../src/adapters/base.js";
import type { RunRequest } from "../src/types.js";

/** The Keychain host's own home, pointed at each test's temp home: the
 * suite's shared one is removed when another file emits the exit event,
 * so a test that reads it depends on file order (review round 140). */
let hostHome: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  hostHome?.mockRestore();
  hostHome = undefined;
});

function preparedProbe(): { adapter: AgyAdapter; context: RunContext; probeHome: string } {
  const home = mkdtempSync(join(tmpdir(), "codemux-agy-cleanup-"));
  hostHome = spyOn(agyKeychainHost, "home").mockReturnValue(home);
  const adapter = new AgyAdapter({ HOME: home });
  const context: RunContext = {
    agyProbe: { mode: "plain", diagnostic: false, operatorHome: home, printOnly: true },
  };
  createAgyProbeHome(context, home);
  return { adapter, context, probeHome: context.agyProbe!.home! };
}

test("a failed removal is retried by the next cleanup and succeeds; a succeeded one stays idempotent", () => {
  const { adapter, context, probeHome } = preparedProbe();
  const originalRemove = fs.rmSync;
  let failures = 0;
  const remove = spyOn(fs, "rmSync").mockImplementation(((path, options) => {
    if (path === probeHome) {
      failures += 1;
      if (failures === 1) {
        throw Object.assign(new Error("EACCES: probe removal denied"), { code: "EACCES" });
      }
    }
    return originalRemove(path, options);
  }) as typeof fs.rmSync);
  try {
    // First attempt: the removal fails, is reported, and leaves the home.
    expect(() => adapter.cleanupRunSync(context)).toThrow("agy probe cleanup failed");
    expect(existsSync(probeHome)).toBe(true);
    // Second attempt: the full validation and removal run again and pass.
    adapter.cleanupRunSync(context);
    expect(existsSync(probeHome)).toBe(false);
    // Third and later calls (the exit backstop included) return normally.
    adapter.cleanupRunSync(context);
    adapter.cleanupRunSync(context, true);
  } finally {
    remove.mockRestore();
    rmSync(dirname(dirname(dirname(probeHome))), { recursive: true, force: true });
  }
});

test("a cleanup that keeps failing releases its descriptors at process exit", () => {
  const { adapter, context, probeHome } = preparedProbe();
  const originalRemove = fs.rmSync;
  const originalClose = fs.closeSync;
  const closes: number[] = [];
  const close = spyOn(fs, "closeSync").mockImplementation(((fd: number) => {
    closes.push(fd);
    return originalClose(fd);
  }) as typeof fs.closeSync);
  const remove = spyOn(fs, "rmSync").mockImplementation(((path, options) => {
    if (path === probeHome) {
      throw Object.assign(new Error("EIO: probe removal failed"), { code: "EIO" });
    }
    return originalRemove(path, options);
  }) as typeof fs.rmSync);
  try {
    expect(() => adapter.cleanupRunSync(context)).toThrow("agy probe cleanup failed");
    // The marker's bounded read closes its own transient descriptor each
    // attempt (review round 199); the validation descriptors stay open
    // for the retry.
    expect(closes).toHaveLength(1);
    expect(() => adapter.cleanupRunSync(context, true)).toThrow("agy probe cleanup failed");
    // The exit call runs one more marker read, then closes both
    // validation descriptors, failure or not.
    expect(closes).toHaveLength(4);
    for (const fd of closes.slice(-2)) expect(() => fs.fstatSync(fd)).toThrow();
    expect(existsSync(probeHome)).toBe(true);
  } finally {
    remove.mockRestore();
    close.mockRestore();
    rmSync(dirname(dirname(dirname(probeHome))), { recursive: true, force: true });
  }
});

test("a preparation that fails and cannot remove its home still closes its descriptors (review round 139)", () => {
  // The context never reaches the launcher, so no later call exists: the
  // preparation's own cleanup is the last attempt. Every host seam is
  // stubbed: no `security` binary, no Keychain, no real home.
  const home = mkdtempSync(join(tmpdir(), "codemux-agy-prepare-fail-"));
  const adapter = new AgyAdapter({ HOME: home, PATH: "/usr/bin:/bin" });
  const request: RunRequest = {
    agent: "agy", prompt: "p", cwd: join(home, "w"), autonomy: "read-only", sandboxed: true,
  };
  const originalRemove = fs.rmSync;
  const originalClose = fs.closeSync;
  const closes: number[] = [];
  const spies = [
    spyOn(agyKeychainHost, "home").mockReturnValue(home),
    spyOn(agyKeychainHost, "securityPath").mockReturnValue(undefined),
    spyOn(agyKeychainHost, "spawnSync").mockImplementation((() => {
      throw new Error("no process may be spawned in this test");
    }) as typeof agyKeychainHost.spawnSync),
    spyOn(fs, "closeSync").mockImplementation(((fd: number) => {
      closes.push(fd);
      return originalClose(fd);
    }) as typeof fs.closeSync),
    spyOn(fs, "rmSync").mockImplementation(((path, options) => {
      if (String(path).includes(".codemux-isolation-probes/run-")) {
        throw Object.assign(new Error("EIO: probe removal failed"), { code: "EIO" });
      }
      return originalRemove(path, options);
    }) as typeof fs.rmSync),
  ];
  try {
    // With no login reachable the preparation fails after the home exists.
    expect(() => adapter.prepareRun(request)).toThrow(/agy is not logged in.*cleanup failed: .*agy probe cleanup failed/s);
    // Both validation descriptors were closed although the removal failed.
    expect(closes.length).toBeGreaterThanOrEqual(2);
    for (const fd of closes.slice(-2)) expect(() => fs.fstatSync(fd)).toThrow();
  } finally {
    for (const spy of spies.reverse()) spy.mockRestore();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a retry is pending from preparation until the cleanup finished (review round 141)", () => {
  const { adapter, context, probeHome } = preparedProbe();
  const originalRemove = fs.rmSync;
  let failures = 0;
  const remove = spyOn(fs, "rmSync").mockImplementation(((path, options) => {
    if (path === probeHome && failures++ === 0) {
      throw Object.assign(new Error("EBUSY: probe removal busy"), { code: "EBUSY" });
    }
    return originalRemove(path, options);
  }) as typeof fs.rmSync);
  try {
    expect(adapter.cleanupRetryPending(context)).toBe(true);
    expect(() => adapter.cleanupRunSync(context)).toThrow("agy probe cleanup failed");
    // The failed attempt kept its state: the launcher keeps its backstop.
    expect(adapter.cleanupRetryPending(context)).toBe(true);
    adapter.cleanupRunSync(context);
    expect(adapter.cleanupRetryPending(context)).toBe(false);
    // A context this adapter never prepared has nothing pending.
    expect(adapter.cleanupRetryPending({} as RunContext)).toBe(false);
    expect(adapter.cleanupRetryPending(undefined)).toBe(false);
  } finally {
    remove.mockRestore();
    rmSync(dirname(dirname(dirname(probeHome))), { recursive: true, force: true });
  }
});

test("a removal that failed after deleting the marker is still retried to the end (review round 143)", () => {
  const { adapter, context, probeHome } = preparedProbe();
  const marker = join(probeHome, ".codemux-probe-owner");
  const originalRemove = fs.rmSync;
  let failures = 0;
  const remove = spyOn(fs, "rmSync").mockImplementation(((path, options) => {
    if (path === probeHome && failures++ === 0) {
      // A recursive removal that got as far as the marker, then failed.
      originalRemove(marker);
      throw Object.assign(new Error("EBUSY: probe removal busy"), { code: "EBUSY" });
    }
    return originalRemove(path, options);
  }) as typeof fs.rmSync);
  try {
    expect(existsSync(marker)).toBe(true);
    expect(() => adapter.cleanupRunSync(context)).toThrow("agy probe cleanup failed");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(probeHome)).toBe(true);
    // The retry does not stop at the missing marker.
    adapter.cleanupRunSync(context);
    expect(existsSync(probeHome)).toBe(false);
  } finally {
    remove.mockRestore();
    rmSync(dirname(dirname(dirname(probeHome))), { recursive: true, force: true });
  }
});

test("a home whose marker is missing before any removal began is still refused", () => {
  const { adapter, context, probeHome } = preparedProbe();
  try {
    rmSync(join(probeHome, ".codemux-probe-owner"));
    expect(() => adapter.cleanupRunSync(context)).toThrow("refusing cleanup of a replaced agy probe home or parent");
    expect(existsSync(probeHome)).toBe(true);
  } finally {
    // The exit call refuses the same way; it is made for its descriptor close.
    expect(() => adapter.cleanupRunSync(context, true)).toThrow("refusing cleanup");
    rmSync(dirname(dirname(dirname(probeHome))), { recursive: true, force: true });
  }
});

test("an oversized marker is refused without being read whole (review round 199)", () => {
  // The marker read is bounded: a file past the bound cannot be this
  // run's 36-character marker, so the cleanup refuses it instead of
  // reading it to find out.
  const { adapter, context, probeHome } = preparedProbe();
  try {
    fs.appendFileSync(join(probeHome, ".codemux-probe-owner"), "x".repeat(300));
    expect(() => adapter.cleanupRunSync(context)).toThrow("refusing cleanup of a replaced agy probe home or parent");
    expect(existsSync(probeHome)).toBe(true);
  } finally {
    rmSync(dirname(dirname(dirname(probeHome))), { recursive: true, force: true });
  }
});

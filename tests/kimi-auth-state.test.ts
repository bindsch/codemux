import { expect, spyOn, test } from "bun:test";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryExclusiveFlock } from "../src/flock.js";
import {
  beginKimiPrivateState, kimiCommandBrandHome, kimiOperatorBrandHome, kimiPrivateHomeOperator,
  registerKimiPrivateHome, withKimiPrivateState,
} from "../src/kimi-auth-state.js";
import { runCapturedCommand } from "../src/process-runner.js";
import { spawnSessionChild } from "../src/session/spawn.js";
import { kimiLoginState } from "../src/harness-health.js";
import { openCallerHarnessHome } from "../src/session/harness-home.js";

function fixture() {
  const scratch = join(import.meta.dir, "../scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "kimi-auth-state-"));
  const brand = join(root, ".kimi-code");
  mkdirSync(join(brand, "credentials"), { recursive: true });
  writeFileSync(join(brand, "credentials", "synthetic.json"), "0");
  // A private brand home in the shape every run and session home has.
  const privateHome = (name = "run-1"): string => {
    const home = join(brand, ".codemux-hermetic", name, ".kimi-code");
    mkdirSync(home, { recursive: true });
    return home;
  };
  const command = (home: string): string[] => ["env", `KIMI_CODE_HOME=${home}`, "kimi"];
  return { root, brand, privateHome, command, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const worker = join(import.meta.dir, "fixtures/kimi-state-worker.ts");
/** True when no process holds the short copy lock on the operator home. */
function copyLockFree(brand: string): boolean {
  const fd = openSync(brand, "r");
  try { return tryExclusiveFlock(fd); } finally { closeSync(fd); }
}

test("child env prefixes select the brand home the child itself resolves", () => {
  expect(kimiCommandBrandHome(["env", "-u", "KIMI_CODE_HOME", "HOME=/private", "kimi", "--prompt", "--help"],
    { KIMI_CODE_HOME: "/other" }, "/work")).toBe("/private/.kimi-code");
  expect(kimiCommandBrandHome(["env", "KIMI_CODE_HOME=/custom", "kimi"], {}, "/work")).toBe("/custom");
  expect(kimiCommandBrandHome(["kimi", "--version"], {}, "/work")).toBeNull();
  expect(kimiCommandBrandHome(["claude"], {}, "/work")).toBeNull();
});

test("a private home is known by its location or its registration, never by a link a child could change", () => {
  const f = fixture();
  try {
    const home = f.privateHome();
    expect(kimiPrivateHomeOperator(home)).toBe(f.brand);
    // The session home's rename at settle keeps the shape.
    expect(kimiPrivateHomeOperator(join(f.brand, ".codemux-hermetic", "session-abc", ".kimi-code"))).toBe(f.brand);
    expect(kimiPrivateHomeOperator(f.brand)).toBeUndefined();
    // A brand home whose links point at another directory is still a plain home.
    const lookalike = join(f.root, "lookalike");
    mkdirSync(lookalike);
    symlinkSync(join(f.brand, "credentials"), join(lookalike, "credentials"));
    symlinkSync(join(f.brand, "oauth"), join(lookalike, "oauth"));
    expect(kimiPrivateHomeOperator(lookalike)).toBeUndefined();
    const forget = registerKimiPrivateHome(lookalike, f.brand);
    expect(kimiPrivateHomeOperator(lookalike)).toBe(f.brand);
    const nested = join(lookalike, ".codemux-hermetic", "run-2", ".kimi-code");
    expect(kimiOperatorBrandHome(nested)).toBe(f.brand);
    forget();
    expect(kimiPrivateHomeOperator(lookalike)).toBeUndefined();
    expect(kimiOperatorBrandHome(nested)).toBe(lookalike);
  } finally { f.cleanup(); }
});

test("empty-token tombstone remains unknown with file evidence and no token values", () => {
  const f = fixture();
  try {
    expect(kimiLoginState(f.root, {}).state).toBe("unknown");
    writeFileSync(join(f.brand, "credentials", "kimi-code.json"), JSON.stringify({ access_token: "", refresh_token: "", expires_at: 0 }));
    expect(kimiLoginState(f.root, {})).toEqual({ state: "unknown", store: "~/.kimi-code/credentials/kimi-code.json", refreshPresent: false,
      note: "the readable Kimi credential file has empty access and refresh tokens; no Kimi credential file confirms a login, and only a kimi run can confirm it" });
  } finally { f.cleanup(); }
});

test("login health reads an explicit brand home without exposing its path or tokens", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.brand, "credentials", "kimi-code.json"), JSON.stringify({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_at: Date.now() + 60_000 }));
    const state = kimiLoginState(join(f.root, "unrelated-home"), { KIMI_CODE_HOME: f.brand });
    expect(state).toEqual({ state: "logged-in", store: "KIMI_CODE_HOME/credentials/kimi-code.json" });
    expect(JSON.stringify(state)).not.toContain("synthetic");
    expect(JSON.stringify(state)).not.toContain(f.brand);
  } finally { f.cleanup(); }
});

test("caller-owned private homes preserve the grant's device identity and region", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.brand, "device_id"), "synthetic-device");
    writeFileSync(join(f.brand, "region"), "synthetic-region");
    const cwd = join(f.root, "work");
    mkdirSync(cwd);
    const dir = join(f.root, "caller");
    const home = openCallerHarnessHome({ agent: "kimi", dir, cwd, blockedPaths: [], sourceHome: f.root, sourceEnv: {}, apiKeyAuth: false });
    expect(readFileSync(join(dir, ".kimi-code", "device_id"), "utf8")).toBe("synthetic-device");
    expect(readFileSync(join(dir, ".kimi-code", "region"), "utf8")).toBe("synthetic-region");
    home.verify();
    expect(readFileSync(join(dir, ".kimi-code", "device_id"), "utf8")).toBe("synthetic-device");
    // The caller home is registered, so its launches synchronize and publish.
    expect(kimiPrivateHomeOperator(join(dir, ".kimi-code"))).toBe(f.brand);
    expect(copyLockFree(f.brand)).toBe(true);
  } finally { f.cleanup(); }
});

test("a launch refreshes stale private identity and publishes native-created missing state", () => {
  const f = fixture();
  try {
    const brand = f.privateHome();
    const initial = beginKimiPrivateState(f.command(brand), {}, f.root);
    writeFileSync(join(brand, "device_id"), "native-generated-device");
    writeFileSync(join(brand, "region"), "native-generated-region");
    initial.end();
    expect(readFileSync(join(f.brand, "device_id"), "utf8")).toBe("native-generated-device");
    writeFileSync(join(f.brand, "device_id"), "new-canonical-device");
    const next = beginKimiPrivateState(f.command(brand), {}, f.root);
    expect(readFileSync(join(brand, "device_id"), "utf8")).toBe("new-canonical-device");
    expect(readFileSync(join(brand, "region"), "utf8")).toBe("native-generated-region");
    next.end();
  } finally { f.cleanup(); }
});

test("exclusive state publication preserves external updates and refuses orphaned private identity", () => {
  const f = fixture();
  try {
    const brand = f.privateHome();
    writeFileSync(join(brand, "device_id"), "orphaned-private-device");
    expect(() => beginKimiPrivateState(f.command(brand), {}, f.root)).toThrow("canonical device_id is missing");
    expect(copyLockFree(f.brand)).toBe(true);
    writeFileSync(join(f.brand, "device_id"), "canonical-device");
    const state = beginKimiPrivateState(f.command(brand), {}, f.root);
    writeFileSync(join(brand, "region"), "native-region");
    writeFileSync(join(f.brand, "region"), "external-region");
    state.end();
    expect(readFileSync(join(f.brand, "region"), "utf8")).toBe("external-region");
  } finally { f.cleanup(); }
});

test("untrusted state is refused and the copy lock is not left held", () => {
  const f = fixture();
  try {
    const brand = f.privateHome();
    writeFileSync(join(f.root, "state-target"), "not-trusted");
    symlinkSync(join(f.root, "state-target"), join(f.brand, "device_id"));
    expect(() => beginKimiPrivateState(f.command(brand), {}, f.root)).toThrow();
    expect(copyLockFree(f.brand)).toBe(true);
  } finally { f.cleanup(); }
});

test("a plain run is never refused and never touched, with or without a symlinked credentials directory", async () => {
  // Review round 5, correctness 1 and edges 1: `credentials` alone pointed at
  // another directory, and every Kimi launch failed with "start a new session".
  const f = fixture();
  try {
    const elsewhere = join(f.root, "dotfiles", "kimi");
    mkdirSync(join(elsewhere, "creds"), { recursive: true });
    rmSync(join(f.brand, "credentials"), { recursive: true });
    symlinkSync(join(elsewhere, "creds"), join(f.brand, "credentials"));
    writeFileSync(join(f.brand, "device_id"), "native-device");
    // A stray file beside the store must never replace the brand home's own.
    writeFileSync(join(elsewhere, "region"), "unrelated-region");
    for (const env of [{ HOME: f.root }, { KIMI_CODE_HOME: f.brand }]) {
      const ran = await withKimiPrivateState(["kimi", "--prompt", "hi"], env, f.root, async (publish) => { publish(); return "ran"; });
      expect(ran).toBe("ran");
    }
    expect(readFileSync(join(f.brand, "device_id"), "utf8")).toBe("native-device");
    expect(existsSync(join(f.brand, "region"))).toBe(false);
    expect(readdirSync(elsewhere).sort()).toEqual(["creds", "region"]);
    expect(readdirSync(join(elsewhere, "creds"))).toEqual([]);
    // A plain run with no device state yet creates nothing beside the store either.
    rmSync(join(f.brand, "device_id"));
    await withKimiPrivateState(["kimi"], { HOME: f.root }, f.root, async () => {
      writeFileSync(join(f.brand, "device_id"), "minted-by-kimi");
    });
    expect(readdirSync(elsewhere).sort()).toEqual(["creds", "region"]);
  } finally { f.cleanup(); }
});

test("a private run reads and publishes device state at the brand home when credentials is a symlink", async () => {
  const f = fixture();
  try {
    const elsewhere = join(f.root, "dotfiles", "kimi");
    mkdirSync(join(elsewhere, "creds"), { recursive: true });
    rmSync(join(f.brand, "credentials"), { recursive: true });
    symlinkSync(join(elsewhere, "creds"), join(f.brand, "credentials"));
    writeFileSync(join(f.brand, "device_id"), "brand-home-device");
    writeFileSync(join(elsewhere, "device_id"), "wrong-device");
    const brand = f.privateHome();
    await withKimiPrivateState(f.command(brand), {}, f.root, async () => {
      expect(readFileSync(join(brand, "device_id"), "utf8")).toBe("brand-home-device");
      writeFileSync(join(brand, "region"), "native-region");
    });
    expect(readFileSync(join(f.brand, "region"), "utf8")).toBe("native-region");
    expect(readdirSync(elsewhere).sort()).toEqual(["creds", "device_id"]);
    expect(readFileSync(join(elsewhere, "device_id"), "utf8")).toBe("wrong-device");
  } finally { f.cleanup(); }
});

test("concurrent launches are not serialized: both children run at once and codemux holds no lock meanwhile", async () => {
  const f = fixture();
  try {
    const bin = join(f.root, "bin");
    mkdirSync(bin);
    // The child reports any descriptor beyond stdio: the lifetime lock rode in as fd 3.
    writeFileSync(join(bin, "kimi"), `#!/bin/sh\n[ -e /dev/fd/3 ] && echo "fd3 $1" >> "${f.root}/events"\n` +
      `echo "start $1" >> "${f.root}/events"\nsleep 0.6\necho "end $1" >> "${f.root}/events"\n`, { mode: 0o755 });
    const env = { PATH: `${bin}:${process.env.PATH!}` };
    const homes = [f.privateHome("run-a"), f.privateHome("run-b"), f.brand];
    const started = Date.now();
    let observed = false;
    const runs = homes.map((home, index) => withKimiPrivateState(f.command(home), env, f.root, async () => {
      const child = runCapturedCommand([join(bin, "kimi"), String(index)], { cwd: f.root, env, timeoutMs: 10_000 });
      await Bun.sleep(200);
      // While the children run: the short copy lock is free and no lock file exists.
      expect(copyLockFree(f.brand)).toBe(true);
      expect(readdirSync(join(f.brand, "credentials"))).toEqual(["synthetic.json"]);
      observed = true;
      return child;
    }));
    const results = await Promise.all(runs);
    expect(results.map((result) => result.exitCode)).toEqual([0, 0, 0]);
    expect(observed).toBe(true);
    const events = readFileSync(join(f.root, "events"), "utf8").trim().split("\n");
    // Every child started before any ended, and none inherited a descriptor.
    expect(events.slice(0, 3).every((line) => line.startsWith("start "))).toBe(true);
    expect(events.filter((line) => line.startsWith("fd3"))).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_700);
  } finally { f.cleanup(); }
}, 15_000);

test("a nested launch of the same home starts at once, in this process and from a child", async () => {
  // Review round 5, edges 2: a Kimi agent that delegated to codemux waited on its own parent's lock.
  const f = fixture();
  try {
    const brand = f.privateHome();
    const started = Date.now();
    const inner = await withKimiPrivateState(f.command(brand), {}, f.root, async () => {
      const again = await withKimiPrivateState(f.command(brand), {}, f.root, async () => "inner ran");
      const child = Bun.spawn([process.execPath, worker, brand, "nested"], { stdout: "pipe", stderr: "pipe" });
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      return `${again} ${output.trim()}`;
    });
    expect(inner).toBe("inner ran inner-done");
    expect(Date.now() - started).toBeLessThan(8_000);
  } finally { f.cleanup(); }
}, 15_000);

test("signal cleanup can publish native state before removing the private home", async () => {
  const f = fixture();
  try {
    const brand = f.privateHome();
    await withKimiPrivateState(f.command(brand), {}, f.root, async (publish) => {
      writeFileSync(join(brand, "device_id"), "native-before-interrupt");
      publish();
      rmSync(brand, { recursive: true });
    });
    expect(readFileSync(join(f.brand, "device_id"), "utf8")).toBe("native-before-interrupt");
  } finally { f.cleanup(); }
});

test("an abort through process.exit still writes native state back, and warns once when it cannot", async () => {
  // Review round 4, correctness 1: the write-back ran only in a finally the abort never reached.
  const f = fixture();
  try {
    const brand = f.privateHome();
    const abort = () => Bun.spawn([process.execPath, worker, brand, "abort"], { stdout: "pipe", stderr: "pipe" });
    const first = abort();
    expect(await first.exited).toBe(3);
    expect(readFileSync(join(f.brand, "device_id"), "utf8")).toBe("native-before-abort");
    // The next launch of that home is not refused as stale.
    beginKimiPrivateState(f.command(brand), {}, f.root).end();
    // A write-back that fails on abort is one warning line, and the exit code stands.
    rmSync(join(f.brand, "device_id"));
    rmSync(join(brand, "device_id"));
    chmodSync(f.brand, 0o500);
    const second = abort();
    try {
      expect(await second.exited).toBe(3);
      const stderr = await new Response(second.stderr).text();
      expect(stderr.split("\n").filter((line) => line.includes("could not write Kimi's native state back"))).toHaveLength(1);
    } finally { chmodSync(f.brand, 0o700); }
  } finally { f.cleanup(); }
});

test("a failed state write-back after the run keeps the run's result and warns once", async () => {
  const f = fixture();
  try {
    const brand = f.privateHome();
    const lines: string[] = [];
    const result = await withKimiPrivateState(f.command(brand), {}, f.root, async (publish) => {
      // Native Kimi created its identity; the shared home then refuses the write-back.
      writeFileSync(join(brand, "device_id"), "native-generated-device");
      writeFileSync(join(brand, "region"), "native-generated-region");
      chmodSync(f.brand, 0o500);
      publish();
      return "run succeeded";
    }, (line) => lines.push(line));
    expect(result).toBe("run succeeded");
    // One line for the explicit publish and the end together.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("Warning: codemux could not write Kimi's native state back");
    expect(lines[0]).toContain("the run's result is unaffected");
    // The session path: the settled promise resolves instead of rejecting.
    chmodSync(f.brand, 0o700);
    for (const name of ["device_id", "region"]) rmSync(join(brand, name));
    const bin = join(f.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "kimi"), `#!/bin/sh\nprintf device > '${brand}/device_id' && chmod 500 '${f.brand}'\n`, { mode: 0o755 });
    const env = { PATH: `${bin}:/usr/bin:/bin` };
    const work = join(f.root, "work");
    mkdirSync(work);
    const child = await spawnSessionChild(["env", `KIMI_CODE_HOME=${brand}`, join(bin, "kimi")], env,
      { cwd: work, sandboxed: false, autonomy: "low", graceMs: 50 }, { onLine: () => {}, onFatal: () => {} });
    const warned = spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await child.settled;
      expect(warned.mock.calls.filter(([line]) => String(line).includes("could not write Kimi's native state back"))).toHaveLength(1);
    } finally { warned.mockRestore(); }
    chmodSync(f.brand, 0o700);
    expect(existsSync(join(f.brand, "device_id"))).toBe(false);
    expect(copyLockFree(f.brand)).toBe(true);
  } finally { chmodSync(f.brand, 0o700); f.cleanup(); }
});

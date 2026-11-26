import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SCODE_DARWIN_FLOOR_REASON, SCODE_DARWIN_KEYCHAIN_SERVICES_MINIMUM_VERSION, SCODE_MINIMUM_VERSION,
  SCODE_NO_LOGIN_STORE_MINIMUM_VERSION, assertCompatibleScode, scodeDeniesKeychainServices, scodeGatePlatform, scodeLaunchFloor,
  scodeSupportsNoLoginStore,
} from "../src/cli-runtime/scode.js";
import { assertHarnessSupported } from "../src/cli-runtime.js";
import { sandboxLine } from "../src/doctor-harness-row.js";
import { assertEarlyScodeFloor } from "../src/launch/scode-floor.js";
import { scodeEnvironmentRow, type ScodeFacts } from "../src/doctor-environment.js";
import { SCODE_FLOORS } from "../src/harness-contracts.js";
import { scratchRoot } from "./helpers/keychain-home.js";

// scode 0.6.11 denies com.apple.authd and the security agent names
// whenever the login-store grant is not applied, and leaves
// com.apple.SecurityServer reachable (0.6.9 denied it and broke HTTPS for
// clients that load the system root certificates through it). On macOS
// every sandboxed launch requires it; the platform is passed explicitly so
// the file tests both platforms on either host.
const root = scratchRoot("scode-darwin-floor");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const workdir = join(root, "work");
mkdirSync(workdir);

function fakeScode(version: string): string {
  const path = join(root, `scode-${version}`);
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = --version ]; then echo 'scode ${version}'; exit 0; fi\nexit 99\n`);
  chmodSync(path, 0o755);
  return path;
}
const env = { PATH: process.env.PATH ?? "" };

describe("the macOS scode floor", () => {
  test("the floor is 0.6.11 and no existing floor is lowered", () => {
    expect(SCODE_DARWIN_KEYCHAIN_SERVICES_MINIMUM_VERSION).toBe("0.6.11");
    expect(SCODE_MINIMUM_VERSION).toBe("0.2.0");
    expect(SCODE_NO_LOGIN_STORE_MINIMUM_VERSION).toBe("0.6.8");
    expect(SCODE_FLOORS.agy).toBe("0.6.0");
    expect(scodeLaunchFloor("0.2.0", "darwin")).toBe("0.6.11");
    expect(scodeLaunchFloor("0.6.0", "darwin")).toBe("0.6.11");
    expect(scodeLaunchFloor("0.6.11", "darwin")).toBe("0.6.11");
    expect(scodeLaunchFloor("0.7.0", "darwin")).toBe("0.7.0");
    expect(scodeLaunchFloor("0.2.0", "linux")).toBe("0.2.0");
    expect(scodeLaunchFloor("0.6.0", "linux")).toBe("0.6.0");
    expect(scodeLaunchFloor(undefined, "linux")).toBe(SCODE_MINIMUM_VERSION);
  });

  test("the capability helper orders versions like its neighbors", () => {
    expect(scodeDeniesKeychainServices("0.6.8")).toBe(false);
    expect(scodeDeniesKeychainServices("0.6.11-rc1")).toBe(false);
    expect(scodeDeniesKeychainServices("0.6.11")).toBe(true);
    expect(scodeDeniesKeychainServices("0.6.11+build.3")).toBe(true);
    expect(scodeDeniesKeychainServices("0.7.0")).toBe(true);
    // Every scode that denies the services also knows --no-login-store.
    expect(scodeSupportsNoLoginStore(SCODE_DARWIN_KEYCHAIN_SERVICES_MINIMUM_VERSION)).toBe(true);
  });

  test("on macOS a sandboxed launch refuses scode older than 0.6.11, with the reason", async () => {
    for (const version of ["0.2.0", "0.6.0", "0.6.7", "0.6.8", "0.6.9", "0.6.10", "0.6.11-rc1"]) {
      const refusal = assertCompatibleScode(fakeScode(version), workdir, env, undefined, "darwin");
      await expect(refusal).rejects.toThrow(`scode ${version} is too old; 0.6.11 or newer is required${SCODE_DARWIN_FLOOR_REASON}`);
    }
    expect(SCODE_DARWIN_FLOOR_REASON).toContain("keychain");
  });

  test("on macOS 0.6.11 and newer pass, and a higher caller floor still applies", async () => {
    await expect(assertCompatibleScode(fakeScode("0.6.11"), workdir, env, undefined, "darwin")).resolves.toBe("0.6.11");
    await expect(assertCompatibleScode(fakeScode("0.7.1"), workdir, env, SCODE_FLOORS.agy, "darwin")).resolves.toBe("0.7.1");
    const refusal = assertCompatibleScode(fakeScode("0.6.11"), workdir, env, "0.7.0", "darwin");
    await expect(refusal).rejects.toThrow("scode 0.6.11 is too old; 0.7.0 or newer is required");
    await expect(assertCompatibleScode(fakeScode("0.6.11"), workdir, env, "0.7.0", "darwin")).rejects.not.toThrow("macOS");
  });

  test("off macOS the floors are the ones the caller names", async () => {
    await expect(assertCompatibleScode(fakeScode("0.2.0"), workdir, env, undefined, "linux")).resolves.toBe("0.2.0");
    await expect(assertCompatibleScode(fakeScode("0.6.8"), workdir, env, SCODE_FLOORS.agy, "linux")).resolves.toBe("0.6.8");
    await expect(assertCompatibleScode(fakeScode("0.1.9"), workdir, env, undefined, "linux"))
      .rejects.toThrow("scode 0.1.9 is too old; 0.2.0 or newer is required");
  });

  test("the default platform is the host's", async () => {
    const launch = assertCompatibleScode(fakeScode("0.6.8"), workdir, env);
    if (process.platform === "darwin") await expect(launch).rejects.toThrow("0.6.11 or newer is required");
    else await expect(launch).resolves.toBe("0.6.8");
  });

  test("the doctor row reports the macOS floor", async () => {
    const facts = (version: readonly [number, number, number], label: string): ScodeFacts =>
      ({ present: true, path: null, version, label, semver: label, issue: null });
    const old = await scodeEnvironmentRow(facts([0, 6, 8], "0.6.8"), "darwin");
    expect(old.state).toBe("SANDBOX-TOO-OLD");
    expect(old.severity).toBe("broken");
    expect(old.detail).toContain("scode 0.6.8 is below the macOS minimum 0.6.11");
    expect(old.detail).toContain("keychain");
    expect(old.remedy).toBe("brew upgrade bindsch/tap/scode to >= 0.6.11");
    const elsewhere = await scodeEnvironmentRow(facts([0, 1, 0], "0.1.0"), "linux");
    expect(elsewhere.detail).toBe("scode 0.1.0 is below the global minimum 0.2.0");
  });

  test("every harness row in doctor carries the macOS floor, not only a harness with its own (review round 2)", () => {
    const facts: ScodeFacts = { present: true, path: null, version: [0, 6, 8], label: "0.6.8", semver: "0.6.8", issue: null };
    const previous = scodeGatePlatform.value;
    try {
      scodeGatePlatform.value = "darwin";
      for (const agent of ["codex", "claude", "agy"] as const) {
        const row = sandboxLine(agent, facts);
        expect(row.state).toBe("SANDBOX-TOO-OLD");
        expect(row.floor).toBe("0.6.11");
        expect(row.line).toContain("0.6.11");
      }
      scodeGatePlatform.value = "linux";
      expect(sandboxLine("codex", facts).state).not.toBe("SANDBOX-TOO-OLD");
    } finally { scodeGatePlatform.value = previous; }
  });

  test("where a floor applies, a missing scode is refused before any harness probe, for every agent (review round 2)", async () => {
    const bin = join(root, "no-scode-bin");
    mkdirSync(bin);
    const marker = join(root, "codex-probed");
    writeFileSync(join(bin, "codex"), `#!/bin/sh\ntouch '${marker}'\necho 'codex-cli 99.0.0'\n`);
    chmodSync(join(bin, "codex"), 0o755);
    const previous = scodeGatePlatform.value;
    try {
      scodeGatePlatform.value = "darwin";
      await expect(assertEarlyScodeFloor("codex", SCODE_FLOORS.codex, { PATH: bin }, workdir)).rejects.toThrow("requires scode 0.6.11 or newer");
      // The shared gate every launch path uses (run, tui, session) refuses
      // an old or missing scode before it runs the harness binary.
      await expect(assertHarnessSupported("codex", "codex", workdir, { PATH: bin }, undefined, true)).rejects.toThrow("requires scode 0.6.11 or newer");
      expect(existsSync(marker)).toBe(false);
      const old = join(root, "old-scode-bin");
      mkdirSync(old);
      writeFileSync(join(old, "scode"), "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'scode 0.6.8'; exit 0; fi\nexit 99\n");
      chmodSync(join(old, "scode"), 0o755);
      await expect(assertHarnessSupported("codex", "codex", workdir, { PATH: `${old}:${bin}` }, undefined, true)).rejects.toThrow("0.6.11");
      expect(existsSync(marker)).toBe(false);
      scodeGatePlatform.value = "linux";
      await assertEarlyScodeFloor("codex", SCODE_FLOORS.codex, { PATH: bin }, workdir);
    } finally { scodeGatePlatform.value = previous; }
  });
});

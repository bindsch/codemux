/**
 * Review round 331, items 4 and 5: an executable redirect
 * (OPENCODE_BIN_PATH) selects the binary OpenCode's launcher execs, and
 * the pre-spawn trust machinery never covered it. The gate (item 4) now
 * refuses a redirect it cannot resolve to a trusted executable instead of
 * warning, and both launch paths (item 5) pin the resolved target beside
 * the command's own positions, the way the Playwright binary is pinned, so
 * replacing it between the version probe and the spawn fails the pre-spawn
 * re-stat. Every case drives the real gate and the real launch lifecycle
 * over fake binaries on a fake PATH.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertHarnessSupported, launchRedirectCheck } from "../src/cli-runtime.js";
import { launchRunRequest } from "../src/launch.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { createFakeBinaryEnv } from "./helpers/cli.js";
import type { RunResult } from "../src/types.js";

/** The redirect target's first body: an audited version for the gate's
 * probe, a marker for the launch. The replacement body differs in length,
 * so the identity re-stat catches it even on a filesystem that reuses the
 * inode. */
const TARGET_BODY =
  "#!/bin/sh\ncase \"$1\" in --version) printf '1.18.11\\n';; *) printf 'redirect-ran\\n';; esac\n";
const REPLACED_BODY = "#!/bin/sh\nprintf 'REPLACED-BYTES-RAN\\n'\n";

/** A launcher that execs the redirect target exactly the way OpenCode's
 * own launcher does; the command's own trust check sees only this file. */
const LAUNCHER_BODY = 'exec "$OPENCODE_BIN_PATH" "$@"';

interface RedirectStage {
  fake: { env: Record<string, string>; cleanup: () => void };
  target: string;
  cwd: string;
  /** Rewrites the redirect target after the launch path captured its
   * identity; getStdinInput runs between the capture and the spawn on
   * both launch paths. */
  replaceTarget(): void;
}

function stageRedirect(withScode: boolean): RedirectStage {
  const fake = createFakeBinaryEnv(
    withScode
      ? {
          opencode: LAUNCHER_BODY,
          scode: 'while [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"',
        }
      : { opencode: LAUNCHER_BODY }
  );
  const targetDir = mkdtempSync(join(tmpdir(), "codemux-redirect-target-"));
  const cwd = mkdtempSync(join(tmpdir(), "codemux-redirect-work-"));
  const target = join(targetDir, "redirected-opencode");
  writeFileSync(target, TARGET_BODY);
  chmodSync(target, 0o755);
  return {
    fake,
    target,
    cwd,
    replaceTarget: () => {
      writeFileSync(target, REPLACED_BODY);
      chmodSync(target, 0o755);
    },
  };
}

/** An adapter whose command is the fake launcher and whose environment
 * carries the active redirect; `replaceInStdin` moves the attack into
 * getStdinInput, which both launch paths call after capturing the
 * redirect's identity and before the spawn. */
class RedirectAdapter extends ClaudeAdapter {
  override readonly id = "opencode" as const;
  private readonly stage: RedirectStage;
  private readonly replaceInStdin: boolean;
  constructor(stage: RedirectStage, replaceInStdin: boolean) {
    super({ ...stage.fake.env, OPENCODE_BIN_PATH: stage.target });
    this.stage = stage;
    this.replaceInStdin = replaceInStdin;
  }
  override prepareRun() {
    return {};
  }
  override buildRunCommand() {
    return ["opencode", "run"];
  }
  override processRunResult(raw: RunResult) {
    return raw;
  }
  override getStdinInput() {
    if (this.replaceInStdin) this.stage.replaceTarget();
    return null;
  }
}

describe("executable redirects (review 331, items 4 and 5)", () => {
  test("the gate refuses a relative redirect value instead of warning", async () => {
    const stage = stageRedirect(false);
    try {
      const env = {
        PATH: stage.fake.env.PATH ?? "",
        OPENCODE_BIN_PATH: "./elsewhere/opencode",
      };
      await expect(
        assertHarnessSupported(
          "opencode", "opencode", stage.cwd, env, "low", false, ["OPENCODE_BIN_PATH"]
        )
      ).rejects.toThrow("does not name one trusted absolute executable");
    } finally {
      stage.fake.cleanup();
      rmSync(join(stage.target, ".."), { recursive: true, force: true });
      rmSync(stage.cwd, { recursive: true, force: true });
    }
  });

  test("a direct launch runs the resolved redirect target (control)", async () => {
    const stage = stageRedirect(false);
    try {
      const result = await launchRunRequest(
        new RedirectAdapter(stage, false),
        {
          agent: "opencode", prompt: "probe", cwd: stage.cwd, autonomy: "high",
          sandboxed: false, passthroughEnv: ["OPENCODE_BIN_PATH"],
        },
        { sandbox: false, requestedAutonomy: "high", cwd: stage.cwd }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("redirect-ran");
    } finally {
      stage.fake.cleanup();
      rmSync(join(stage.target, ".."), { recursive: true, force: true });
      rmSync(stage.cwd, { recursive: true, force: true });
    }
  });

  test("a direct launch refuses a redirect target replaced before the spawn", async () => {
    // The finding: the pre-spawn checks covered only paths embedded in the
    // command, so replacing the redirect target after its version probe
    // executed different bytes without triggering the identity check. The
    // replacement lands in getStdinInput — after runDirect captured the
    // redirect's identity, before the runner's re-stat — and the launch
    // must refuse with the replacement caught, never exec the new bytes.
    const stage = stageRedirect(false);
    try {
      await expect(
        launchRunRequest(
          new RedirectAdapter(stage, true),
          {
            agent: "opencode", prompt: "probe", cwd: stage.cwd, autonomy: "high",
            sandboxed: false, passthroughEnv: ["OPENCODE_BIN_PATH"],
          },
          { sandbox: false, requestedAutonomy: "high", cwd: stage.cwd }
        )
      ).rejects.toThrow("executable changed after its trust check");
    } finally {
      stage.fake.cleanup();
      rmSync(join(stage.target, ".."), { recursive: true, force: true });
      rmSync(stage.cwd, { recursive: true, force: true });
    }
  });

  test("a sandboxed launch refuses a redirect target replaced before the spawn", async () => {
    // The same attack under scode: the launcher runs inside the sandbox,
    // but it still execs the redirect target by absolute path, so the
    // sandboxed branch pins the target the same way and the runner's
    // pre-spawn re-stat catches the replacement.
    const stage = stageRedirect(true);
    try {
      await expect(
        launchRunRequest(
          new RedirectAdapter(stage, true),
          {
            agent: "opencode", prompt: "probe", cwd: stage.cwd, autonomy: "high",
            sandboxed: true, passthroughEnv: ["OPENCODE_BIN_PATH"],
          },
          { sandbox: true, requestedAutonomy: "high", cwd: stage.cwd }
        )
      ).rejects.toThrow("executable changed after its trust check");
    } finally {
      stage.fake.cleanup();
      rmSync(join(stage.target, ".."), { recursive: true, force: true });
      rmSync(stage.cwd, { recursive: true, force: true });
    }
  });

  test("launchRedirectCheck refuses an active redirect that no longer resolves (review 337)", () => {
    // The gate resolved the target seconds earlier; by the time the launch
    // captures its identity the file is gone, relative, or writable. A null
    // here would mean "no redirect" to every caller and spawn with no pin.
    const stage = stageRedirect(false);
    try {
      for (const value of [join(stage.target, "..", "missing"), "redirected-opencode", stage.target]) {
        if (value === stage.target) chmodSync(stage.target, 0o777);
        expect(() =>
          launchRedirectCheck("opencode", { ...stage.fake.env, OPENCODE_BIN_PATH: value }, stage.cwd)
        ).toThrow(/does not name one trusted absolute executable/);
      }
      chmodSync(stage.target, 0o755);
      expect(
        launchRedirectCheck("opencode", { ...stage.fake.env, OPENCODE_BIN_PATH: stage.target }, stage.cwd)
      ).not.toBeNull();
    } finally {
      stage.fake.cleanup();
      rmSync(stage.cwd, { recursive: true, force: true });
    }
  });

  test("runInteractive pins the redirect from the child's environment, not process.env (review 338, item 13)", async () => {
    // The child's environment is built from the adapter's own view, so a
    // redirect present there but not in process.env decided whether the
    // launcher execs a redirect while the pin read process.env and saw
    // none — escaping both the pin and the gate. The check must read the
    // environment the child is spawned with; a relative value is the
    // refusal the pin owns.
    const stage = stageRedirect(false);
    const saved = process.env.OPENCODE_BIN_PATH;
    delete process.env.OPENCODE_BIN_PATH;
    class TuiRedirectAdapter extends ClaudeAdapter {
      override readonly id = "opencode" as const;
      constructor() {
        super({ ...stage.fake.env, OPENCODE_BIN_PATH: "./elsewhere/opencode" });
      }
      override prepareRun() {
        return {};
      }
      override buildTuiCommand() {
        return ["opencode"];
      }
      override processRunResult(raw: RunResult) {
        return raw;
      }
    }
    try {
      await expect(
        new TuiRedirectAdapter().runInteractive(
          undefined, stage.cwd, "high", undefined, false, ["OPENCODE_BIN_PATH"]
        )
      ).rejects.toThrow("does not name one trusted absolute executable");
    } finally {
      if (saved === undefined) delete process.env.OPENCODE_BIN_PATH;
      else process.env.OPENCODE_BIN_PATH = saved;
      stage.fake.cleanup();
      rmSync(join(stage.target, ".."), { recursive: true, force: true });
      rmSync(stage.cwd, { recursive: true, force: true });
    }
  });

  test("launchRedirectCheck answers null only when the environment carries no redirect (round 401, item 9)", () => {
    // The scan reads the environment itself, whatever channel supplied the
    // name: a redirect set by the adapter's own env (not `--pass-env`) is
    // as active as a passed-through one. Only an unset or empty value
    // answers null.
    const stage = stageRedirect(false);
    try {
      expect(
        launchRedirectCheck("opencode", stage.fake.env, stage.cwd)
      ).toBeNull();
      expect(
        launchRedirectCheck(
          "opencode",
          { ...stage.fake.env, OPENCODE_BIN_PATH: "" },
          stage.cwd
        )
      ).toBeNull();
      expect(
        launchRedirectCheck(
          "opencode",
          { ...stage.fake.env, OPENCODE_BIN_PATH: stage.target },
          stage.cwd
        )
      ).not.toBeNull();
    } finally {
      stage.fake.cleanup();
      rmSync(join(stage.target, ".."), { recursive: true, force: true });
      rmSync(stage.cwd, { recursive: true, force: true });
    }
  });
});

/** An adapter whose environment view carries no redirect but whose
 * getEnv injects one — the adapter channel the scan used to miss. */
class InjectedRedirectAdapter extends ClaudeAdapter {
  override readonly id = "opencode" as const;
  constructor(env: Record<string, string>) {
    super(env);
  }
  override prepareRun() {
    return {};
  }
  override buildRunCommand() {
    return ["opencode", "run"];
  }
  override processRunResult(raw: RunResult) {
    return raw;
  }
  override getEnv() {
    return { OPENCODE_BIN_PATH: "./elsewhere/opencode" };
  }
}

describe("executable redirects (review 401, item 9)", () => {
  test("the gate refuses a redirect injected by the adapter env channel", async () => {
    // The scan used to filter only the `--pass-env` list, so a redirect
    // name that arrived through getEnv — kept in the child's environment
    // by sanitizeEnvironment — bypassed the gate, the version check, and
    // the pre-spawn pin entirely. The gate now scans the built execution
    // environment, whatever channel supplied the name: an unresolvable
    // value is refused here with the passthrough list empty.
    const stage = stageRedirect(false);
    try {
      const adapter = new InjectedRedirectAdapter(stage.fake.env);
      const built = adapter.buildExecutionEnv(adapter.getEnv(), []);
      expect(built.OPENCODE_BIN_PATH).toBe("./elsewhere/opencode");
      await expect(
        assertHarnessSupported("opencode", "opencode", stage.cwd, built, "low", false, [])
      ).rejects.toThrow("does not name one trusted absolute executable");
    } finally {
      stage.fake.cleanup();
      rmSync(join(stage.target, ".."), { recursive: true, force: true });
      rmSync(stage.cwd, { recursive: true, force: true });
    }
  });

  test("a direct run refuses an adapter-injected redirect it cannot resolve", async () => {
    // The same channel on the launch path: pre-fix the pin read the
    // passthrough list, saw no redirect, and spawned the launcher, which
    // exec'd a value nobody had resolved or pinned. The launch now scans
    // the child's environment and refuses before the spawn.
    const stage = stageRedirect(false);
    try {
      await expect(
        launchRunRequest(
          new InjectedRedirectAdapter(stage.fake.env),
          {
            agent: "opencode", prompt: "probe", cwd: stage.cwd, autonomy: "high",
            sandboxed: false, passthroughEnv: [],
          },
          { sandbox: false, requestedAutonomy: "high", cwd: stage.cwd }
        )
      ).rejects.toThrow("does not name one trusted absolute executable");
    } finally {
      stage.fake.cleanup();
      rmSync(join(stage.target, ".."), { recursive: true, force: true });
      rmSync(stage.cwd, { recursive: true, force: true });
    }
  });
});

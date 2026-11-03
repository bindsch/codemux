import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURSOR_ENTRY_ENV, CursorAdapter } from "../src/adapters/cursor.js";

describe("CursorAdapter", () => {
  // Every construction passes an explicit environment: the constructor
  // defaults to process.env, and an exported CODEMUX_CURSOR_ENTRY=cursor
  // -- exactly what tests/installed-contract.test.ts hardens against --
  // would flip any test whose outcome depends on the opt-in being absent.
  const adapter = new CursorAdapter(
    (name) => name === "agent" ? "/fake/agent" : null,
    {}
  );

  test("describes its supported capabilities", () => {
    expect(adapter.id).toBe("cursor");
    expect(adapter.binaryName).toBe("agent");
    expect(adapter.capabilities()).toEqual({
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: false,
      effortLevels: [],
    });
  });

  test("builds plain-text headless commands", () => {
    expect(adapter.buildRunCommand({
      agent: "cursor",
      prompt: "fix the tests",
      model: "gpt-5",
      autonomy: "high",
    })).toEqual([
      "agent",
      "--print",
      "--output-format",
      "text",
      "--trust",
      "--model",
      "gpt-5",
      "--force",
    ]);
    expect(adapter.getStdinInput({ agent: "cursor", prompt: "fix the tests" }))
      .toBe("fix the tests");
    expect(() => adapter.validateRunRequest({
      agent: "cursor",
      prompt: "x".repeat(40_000),
      autonomy: "read-only",
      sandboxed: true,
      passthroughEnv: ["CURSOR_API_KEY"],
    })).not.toThrow();
  });

  test("maps current CLI agent modes", () => {
    expect(adapter.mapAutonomy("read-only")).toEqual(["--mode", "plan"]);
    expect(adapter.mapAutonomy("low")).toEqual([]);
    expect(adapter.mapAutonomy("medium")).toEqual(["--auto-review"]);
    expect(adapter.mapAutonomy("high")).toEqual(["--force"]);
  });

  test("builds interactive commands", () => {
    expect(adapter.buildTuiCommand("gpt-5", "medium", undefined, true))
      .toEqual(["agent", "--trust", "--sandbox", "disabled", "--model", "gpt-5", "--auto-review"]);
    expect(adapter.requiresSandboxForAutonomy("read-only")).toBe(true);
    expect(adapter.requiresSandboxForAutonomy("high")).toBe(false);
  });

  test("prefers cursor-agent and falls back to the generic agent name", () => {
    // scode 0.6.0 dropped the bare `agent` name from its known-harness
    // list (the surface was too generic to keep), so a sandboxed launch
    // of `agent` warns that its sandbox behavior is untested;
    // `cursor-agent` -- the name Cursor's installer lays down and scode
    // knows -- is the primary, and `agent` stays a fallback for machines
    // where only it resolves.
    const both = new CursorAdapter(
      (name) => (name === "cursor-agent" || name === "agent" ? `/fake/${name}` : null),
      {}
    );
    expect(both.binaryName).toBe("cursor-agent");
    expect(both.isAvailable()).toBe(true);
    expect(both.buildRunCommand({
      agent: "cursor",
      prompt: "test",
      autonomy: "read-only",
      sandboxed: true,
    })).toEqual([
      "cursor-agent",
      "--print",
      "--output-format",
      "text",
      "--trust",
      "--sandbox",
      "disabled",
      "--mode",
      "plan",
    ]);
    expect(both.buildTuiCommand()).toEqual(["cursor-agent"]);
    // The alias still answers when it is the only one that resolves: the
    // describe-level adapter above is exactly that machine.
    const aliasOnly = new CursorAdapter(
      (name) => name === "agent" ? "/fake/agent" : null,
      {}
    );
    expect(aliasOnly.binaryName).toBe("agent");
    expect(aliasOnly.isAvailable()).toBe(true);
    expect(aliasOnly.buildRunCommand({
      agent: "cursor",
      prompt: "test",
      autonomy: "read-only",
      sandboxed: true,
    })).toEqual([
      "agent",
      "--print",
      "--output-format",
      "text",
      "--trust",
      "--sandbox",
      "disabled",
      "--mode",
      "plan",
    ]);
  });

  test("the desktop entry is ignored without the opt-in", () => {
    // Resolve `cursor-agent`, then `agent`; neither found means "not
    // installed" -- and a desktop `cursor` on PATH is not one of the
    // things looked for.
    // The wrapper behind `cursor agent` may install or update the agent on
    // first use, so it must never run on codemux's own initiative.
    // The empty explicit environment is the point (round 4): without it
    // this construction reads process.env, and an exported
    // CODEMUX_CURSOR_ENTRY=cursor makes desktopOptIn true, the desktop
    // entry resolve, and this test fail.
    const desktopOnly = new CursorAdapter(
      (name) => (name === "cursor" ? "/fake/cursor" : null),
      {}
    );
    expect(desktopOnly.isAvailable()).toBe(false);
    expect(desktopOnly.binaryName).toBe("cursor-agent");
    expect(desktopOnly.displayName).toBe("cursor-agent");
    // A value other than `cursor` opts into nothing.
    const wrongValue = new CursorAdapter(
      (name) => (name === "cursor" ? "/fake/cursor" : null),
      { [CURSOR_ENTRY_ENV]: "desktop" }
    );
    expect(wrongValue.isAvailable()).toBe(false);
    expect(wrongValue.binaryName).toBe("cursor-agent");
    // Nothing resolved: the "harness not found" error names the standalone.
    const none = new CursorAdapter(() => null, {});
    expect(none.isAvailable()).toBe(false);
    expect(none.binaryName).toBe("cursor-agent");
  });

  test("an exported CODEMUX_CURSOR_ENTRY cannot flip the opt-out tests", () => {
    // The round-4 regression pin: with the opt-in exported in the real
    // environment -- the exact scenario tests/installed-contract.test.ts
    // hardens against for the gate -- a construction that defaulted to
    // process.env reported the desktop entry as installed, so "ignored
    // without the opt-in" failed. The explicit empty environment must be
    // what isolates these tests; reverting any construction here to the
    // process.env default makes this test fail again.
    const saved = process.env[CURSOR_ENTRY_ENV];
    process.env[CURSOR_ENTRY_ENV] = "cursor";
    try {
      const desktopOnly = new CursorAdapter(
        (name) => (name === "cursor" ? "/fake/cursor" : null),
        {}
      );
      expect(desktopOnly.isAvailable()).toBe(false);
      expect(desktopOnly.binaryName).toBe("cursor-agent");
      expect(desktopOnly.displayName).toBe("cursor-agent");
    } finally {
      if (saved === undefined) {
        delete process.env[CURSOR_ENTRY_ENV];
      } else {
        process.env[CURSOR_ENTRY_ENV] = saved;
      }
    }
  });

  test("the desktop entry is used when the opt-in is set", () => {
    // CODEMUX_CURSOR_ENTRY=cursor selects the desktop entry outright,
    // standalone builds included: the operator asked for the wrapper's
    // entry. When the `cursor` it names does not resolve, the default
    // standalone chain answers instead.
    const desktopOnly = new CursorAdapter(
      (name) => (name === "cursor" ? "/fake/cursor" : null),
      { [CURSOR_ENTRY_ENV]: "cursor" }
    );
    expect(desktopOnly.isAvailable()).toBe(true);
    expect(desktopOnly.binaryName).toBe("cursor");
    expect(desktopOnly.displayName).toBe("cursor");
    expect(desktopOnly.buildRunCommand({
      agent: "cursor",
      prompt: "test",
      autonomy: "read-only",
      sandboxed: true,
    })).toEqual([
      "cursor",
      "agent",
      "--print",
      "--output-format",
      "text",
      "--trust",
      "--sandbox",
      "disabled",
      "--mode",
      "plan",
    ]);
    expect(desktopOnly.buildTuiCommand("gpt-5", "medium", undefined, true)).toEqual([
      "cursor",
      "agent",
      "--trust",
      "--sandbox",
      "disabled",
      "--model",
      "gpt-5",
      "--auto-review",
    ]);
    // The opt-in outranks a resolved standalone `cursor-agent` (and the
    // `agent` alias).
    const both = new CursorAdapter(
      (name) =>
        (name === "cursor" || name === "cursor-agent" ? `/fake/${name}` : null),
      { [CURSOR_ENTRY_ENV]: "cursor" }
    );
    expect(both.isAvailable()).toBe(true);
    expect(both.binaryName).toBe("cursor");
    // The opt-in names a `cursor` that is not there: default resolution.
    const missing = new CursorAdapter(
      (name) => (name === "agent" ? "/fake/agent" : null),
      { [CURSOR_ENTRY_ENV]: "cursor" }
    );
    expect(missing.isAvailable()).toBe(true);
    expect(missing.binaryName).toBe("agent");
  });

  test("the desktop opt-in requires the --pass-env gesture", () => {
    // The variable being set is not authorization, however it was
    // populated: a shell profile or repository-controlled environment
    // must not make codemux execute an installer-capable wrapper. Only
    // the passthrough name -- argv the operator typed -- authorizes the
    // entry, and a launch without it is refused with both fixes named,
    // before the version gate could probe anything.
    const adapter = new CursorAdapter(
      (name) => (name === "cursor" ? "/fake/cursor" : null),
      { [CURSOR_ENTRY_ENV]: "cursor" }
    );
    expect(() => adapter.validateRunRequest({
      agent: "cursor",
      prompt: "test",
      autonomy: "read-only",
      sandboxed: true,
    })).toThrow(`add --pass-env ${CURSOR_ENTRY_ENV}`);
    expect(() => adapter.validateRunRequest({
      agent: "cursor",
      prompt: "test",
      autonomy: "read-only",
      sandboxed: true,
      passthroughEnv: [CURSOR_ENTRY_ENV, "CURSOR_API_KEY"],
    })).not.toThrow();
    expect(() => adapter.validateTuiRequest(undefined, undefined))
      .toThrow(`add --pass-env ${CURSOR_ENTRY_ENV}`);
    expect(() => adapter.validateTuiRequest(
      undefined,
      undefined,
      "read-only",
      undefined,
      [CURSOR_ENTRY_ENV]
    )).not.toThrow();
    // The standalone entries never need the gesture.
    const standalone = new CursorAdapter(
      (name) => (name === "agent" ? "/fake/agent" : null),
      {}
    );
    expect(() => standalone.validateRunRequest({
      agent: "cursor",
      prompt: "test",
      autonomy: "read-only",
      sandboxed: true,
      passthroughEnv: ["CURSOR_API_KEY"],
    })).not.toThrow();
  });

  test("discovery never executes a repository-local cursor, whatever the trust check would say", () => {
    // The round-2 finding: entry resolution once probed `cursor agent
    // --help` on the PATH-resolved `cursor`, forbidden-rooted at
    // process.cwd() rather than the run's --cwd, so a repository-controlled
    // cursor on PATH executed outside the sandbox during discovery --
    // before the launch's trust check, which knows the run's working
    // directory, could refuse it. Discovery still executes nothing at all:
    // entry resolution, availability, and command building are spawn-free,
    // and the launch's gate is the first and only place that resolves the
    // binary to a trusted path. The worst case here is the opt-in set
    // (the entry actually selected) with the binary inside a repository;
    // the fake cursor marks its execution, and nothing here may create
    // the marker.
    const repoDir = mkdtempSync(join(tmpdir(), "codemux-cursor-repo-"));
    const binary = join(repoDir, "bin", "cursor");
    const marker = join(repoDir, "ran");
    try {
      mkdirSync(join(repoDir, "bin"), { recursive: true });
      // User-owned and not group- or world-writable: a file the launch's
      // own trust check accepts outside its forbidden root. Only the run's
      // --cwd (this repository) makes it untrusted -- the exact case the
      // probe's process.cwd() root missed.
      writeFileSync(binary, `#!/bin/sh\necho ran >> '${marker}'\nexit 0\n`);
      chmodSync(binary, 0o755);
      const adapter = new CursorAdapter(
        (name) => (name === "cursor" ? binary : null),
        { [CURSOR_ENTRY_ENV]: "cursor" }
      );
      expect(adapter.isAvailable()).toBe(true);
      expect(adapter.binaryName).toBe("cursor");
      expect(adapter.displayName).toBe("cursor");
      expect(adapter.buildRunCommand({
        agent: "cursor",
        prompt: "test",
        autonomy: "read-only",
        sandboxed: true,
        cwd: repoDir,
      })).toEqual([
        "cursor",
        "agent",
        "--print",
        "--output-format",
        "text",
        "--trust",
        "--sandbox",
        "disabled",
        "--mode",
        "plan",
      ]);
      expect(adapter.buildTuiCommand("gpt-5", "medium", undefined, true))
        .toContain("--auto-review");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("diagnostics never execute the desktop wrapper's installer path", () => {
    // The other round-2 finding: `list`, `doctor`, and `verify` once probed
    // `cursor agent --help` when the desktop entry was the only candidate,
    // and the desktop wrapper (the Cursor.app 3.23.12 launcher script)
    // downloads and runs https://cursor.com/install when
    // ~/.local/bin/cursor-agent is absent and runs `cursor-agent update`
    // when the build is old -- before forwarding even --help. The fake
    // models that wrapper: it marks any invocation of its `agent`
    // subcommand. Availability (list, doctor, and verify's installed
    // check), entry naming, and the command building verify performs must
    // all leave the marker untouched -- even with the opt-in active, which
    // is the case that actually selects this entry.
    const dir = mkdtempSync(join(tmpdir(), "codemux-cursor-wrapper-"));
    const wrapper = join(dir, "cursor");
    const marker = join(dir, "agent-subcommand-ran");
    try {
      writeFileSync(
        wrapper,
        `#!/bin/sh\nif [ "$1" = "agent" ]; then echo ran >> '${marker}'; fi\nexit 0\n`
      );
      chmodSync(wrapper, 0o755);
      const adapter = new CursorAdapter(
        (name) => (name === "cursor" ? wrapper : null),
        { [CURSOR_ENTRY_ENV]: "cursor" }
      );
      // The desktop entry counts as installed under the opt-in...
      expect(adapter.isAvailable()).toBe(true);
      // ...and answering every diagnostic question runs nothing.
      expect(adapter.binaryName).toBe("cursor");
      expect(adapter.displayName).toBe("cursor");
      expect(adapter.capabilities().supportsNonInteractive).toBe(true);
      expect(adapter.buildRunCommand({ agent: "cursor", prompt: "test" }))
        .toContain("--print");
      expect(adapter.buildTuiCommand()).toEqual(["cursor", "agent"]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects Cursor project hooks before launch", () => {
    const cwd = mkdtempSync(join(tmpdir(), "codemux-cursor-project-"));
    mkdirSync(join(cwd, ".git"));
    mkdirSync(join(cwd, ".cursor"));
    writeFileSync(join(cwd, ".cursor", "hooks.json"), "{}");
    try {
      expect(() => adapter.validateRunRequest({
        agent: "cursor",
        prompt: "inspect",
        autonomy: "read-only",
        sandboxed: true,
        cwd,
      })).toThrow("refuses repository executable configuration");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("BaseAdapter execution fails closed without an explicit sandbox", async () => {
    await expect(adapter.run({ agent: "cursor", prompt: "test" })).rejects.toThrow(
      "cannot enforce 'read-only' autonomy without an external sandbox"
    );
  });
});

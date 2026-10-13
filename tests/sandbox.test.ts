import { describe, test, expect } from "bun:test";
import {
  buildScodeCommand,
  buildSandboxEnv,
  mapAutonomyToScodeFsMode,
  mapAutonomyToScodeTrust,
  withKeepEnvExemption,
} from "../src/sandbox.js";

describe("sandbox utilities", () => {
  test("buildScodeCommand builds base command", () => {
    expect(buildScodeCommand(["codex", "exec", "-"])).toEqual([
      "scode",
      "--trust",
      "standard",
      "--ro",
      "--",
      "codex",
      "exec",
      "-",
    ]);
  });

  test("buildScodeCommand adds cwd and read-only fs mode", () => {
    expect(buildScodeCommand(["codex", "exec"], "/tmp/work", "read-only")).toEqual([
      "scode",
      "-C",
      "/tmp/work",
      "--trust",
      "standard",
      "--ro",
      "--",
      "codex",
      "exec",
    ]);
  });

  test("buildScodeCommand uses rw mode for non-read-only autonomy", () => {
    const cmd = buildScodeCommand(["codex", "exec"], "/tmp/work", "high");
    expect(cmd).toEqual([
      "scode",
      "-C",
      "/tmp/work",
      "--trust",
      "standard",
      "--rw",
      "--",
      "codex",
      "exec",
    ]);
    expect(cmd).toContain("--rw");
    expect(cmd).not.toContain("--ro");
  });

  test("buildScodeCommand applies explicit sandbox overrides", () => {
    expect(
      buildScodeCommand(
        ["codex", "exec"],
        "/tmp/work",
        "medium",
        { trust: "trusted", noNet: true, scrubEnv: true }
      )
    ).toEqual([
      "scode",
      "-C",
      "/tmp/work",
      "--trust",
      "trusted",
      "--rw",
      "--no-net",
      "--scrub-env",
      "--",
      "codex",
      "exec",
    ]);
  });

  test("buildScodeCommand renders the keep-env exemption beside --scrub-env", () => {
    // scode 0.6.0's --keep-env takes one comma-joined list of names.
    // buildScodeCommand renders it whenever the list is non-empty, with
    // no --scrub-env condition of its own — the tie between the two
    // lives in withKeepEnvExemption (the only setter of keepEnv, and it
    // requires a scrub that can be on), so passing both together here is
    // the shape every spawn path reaches.
    expect(
      buildScodeCommand(
        ["codex", "exec"],
        "/tmp/work",
        "medium",
        {
          trust: "standard",
          scrubEnv: true,
          keepEnv: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
        }
      )
    ).toEqual([
      "scode",
      "-C",
      "/tmp/work",
      "--trust",
      "standard",
      "--rw",
      "--scrub-env",
      "--keep-env",
      "ANTHROPIC_AUTH_TOKEN,ANTHROPIC_BASE_URL",
      "--",
      "codex",
      "exec",
    ]);
    // An empty list renders nothing -- an exemption with no names is no
    // exemption, and a scode without the flag must never see it.
    expect(
      buildScodeCommand(["codex", "exec"], undefined, "high", {
        scrubEnv: true,
        keepEnv: [],
      })
    ).not.toContain("--keep-env");
    expect(buildScodeCommand(["codex", "exec"], undefined, "high")).not.toContain(
      "--keep-env"
    );
  });

  test("untrusted trust cannot be weakened by non-read-only autonomy", () => {
    const cmd = buildScodeCommand(
      ["codex", "exec"],
      "/tmp/work",
      "high",
      { trust: "untrusted" }
    );
    expect(cmd).toContain("--ro");
    expect(cmd).not.toContain("--rw");
  });

  test("withKeepEnvExemption rides untrusted trust like an explicit scrub (al21)", () => {
    // scode's untrusted preset implies --scrub-env (0.6.0 --help:
    // "--trust untrusted    Maximum lockdown: --strict + --no-net +
    // --scrub-env + --ro"), so credentials codemux injected are stripped
    // there exactly as under --sandbox-scrub-env. Before al21 the
    // exemption keyed on scrubEnv alone and an untrusted override run
    // launched with its only credential scrubbed away.
    const injected = {
      ANTHROPIC_BASE_URL: "https://override.example/v1",
      ANTHROPIC_AUTH_TOKEN: "unit-key",
    };
    const untrusted = withKeepEnvExemption({ trust: "untrusted" }, injected, false);
    expect(untrusted.keepEnv).toEqual(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]);
    // The gateway token is credential-shaped, so the exemption is
    // required even without an override marking it.
    expect(untrusted.keepEnvRequired).toBe(true);
    // An explicit scrub keeps its shape under any trust spelling.
    expect(
      withKeepEnvExemption({ trust: "standard", scrubEnv: true }, injected, true)
    ).toEqual({
      trust: "standard",
      scrubEnv: true,
      keepEnv: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
      keepEnvRequired: true,
    });
    // No scrub can be on: standard and trusted trust come back unchanged,
    // because scode prints "--keep-env has no effect without
    // --scrub-env" on stderr for every run that carries the flag without
    // a scrub (verified on the installed 0.6.0).
    expect(withKeepEnvExemption({ trust: "standard" }, injected, true)).toEqual({
      trust: "standard",
    });
    expect(withKeepEnvExemption({ trust: "trusted" }, injected, true)).toEqual({
      trust: "trusted",
    });
    // Nothing injected: nothing to exempt, even under untrusted trust.
    expect(withKeepEnvExemption({ trust: "untrusted" }, {}, true)).toEqual({
      trust: "untrusted",
    });
  });

  test("mapAutonomyToScodeFsMode maps normalized levels", () => {
    expect(mapAutonomyToScodeFsMode("read-only")).toBe("ro");
    expect(mapAutonomyToScodeFsMode("low")).toBe("rw");
    expect(mapAutonomyToScodeFsMode("medium")).toBe("rw");
    expect(mapAutonomyToScodeFsMode("high")).toBe("rw");
  });

  test("mapAutonomyToScodeTrust keeps hosted agents network-capable", () => {
    expect(mapAutonomyToScodeTrust("read-only")).toBe("standard");
    expect(mapAutonomyToScodeTrust("low")).toBe("standard");
    expect(mapAutonomyToScodeTrust("medium")).toBe("standard");
    expect(mapAutonomyToScodeTrust("high")).toBe("standard");
  });

  test("buildSandboxEnv does not inject browser sandbox overrides", () => {
    const env = buildSandboxEnv({
      TEST_FLAG: "ok",
      SCODE_CONFIG: "/repo/weakened.yaml",
      scode_trust: "trusted",
    });
    expect(env.TEST_FLAG).toBe("ok");
    expect(env.SCODE_CONFIG).toBeUndefined();
    expect(env.scode_trust).toBeUndefined();
    expect(env.ORACLE_CHROME_NO_SANDBOX).toBeUndefined();
    expect(env.PLAYWRIGHT_MCP_NO_SANDBOX).toBeUndefined();
  });

  test("buildSandboxEnv forwards requested accounting variables after stripping", () => {
    const env = buildSandboxEnv(
      {
        SCODE_ACCOUNT_FILE: "/attacker/chosen/path",
        SCODE_ACCOUNT_ID: "forged",
      },
      { accountFile: "/tmp/trace/account.jsonl", accountId: "crew-job-42" }
    );
    expect(env.SCODE_ACCOUNT_FILE).toBe("/tmp/trace/account.jsonl");
    expect(env.SCODE_ACCOUNT_ID).toBe("crew-job-42");
  });

  test("buildSandboxEnv omits accounting variables when not requested", () => {
    const env = buildSandboxEnv({ SCODE_ACCOUNT_FILE: "/attacker/chosen/path" });
    expect(env.SCODE_ACCOUNT_FILE).toBeUndefined();
    expect(env.SCODE_ACCOUNT_ID).toBeUndefined();
    expect(buildSandboxEnv({}, { trust: "standard" }).SCODE_ACCOUNT_FILE).toBeUndefined();
  });

  test("buildSandboxEnv never inherits the parent implicitly", () => {
    const marker = "CODEMUX_TEST_PARENT_SECRET";
    process.env[marker] = "must-not-leak";
    try {
      expect(buildSandboxEnv()[marker]).toBeUndefined();
    } finally {
      delete process.env[marker];
    }
  });
});

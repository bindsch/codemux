import { describe, expect, test } from "bun:test";
import { AGENT_IDS, getAdapter } from "../src/adapters/index.js";
import { HARNESS_CONTRACTS } from "../src/harness-compatibility.js";

describe("current harness documentation and the version gate agree", () => {
  test("headless capability rows match the implemented adapters", async () => {
    const document = await Bun.file(new URL("../docs/harnesses.md", import.meta.url)).text();
    const section = document.split("## Headless capabilities\n")[1]?.split("\n## ")[0];
    expect(section).toBeDefined();
    const rows = (section ?? "").split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| ---"))
      .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
      .filter((cells) => cells[0] !== "Agent");
    expect(rows.map((row) => row[0]).sort()).toEqual([...AGENT_IDS].sort());
    for (const row of rows) {
      const agent = row[0] as typeof AGENT_IDS[number];
      // Adapter construction only resolves names; it does not launch a harness.
      const caps = getAdapter(agent, { PATH: "" }).capabilities();
      expect(row[1], agent).toBe(agent === "qwen" ? "current binary only" : "yes");
      expect(row[2], agent).toBe("all four");
      expect(caps.autonomyLevels, agent).toEqual(["read-only", "low", "medium", "high"]);
      expect(row[3], agent).toBe(caps.supportsEffort ? caps.effortLevels.join(", ") : "unsupported");
      expect(row[4] !== "no", agent).toBe(Boolean(caps.supportsHermetic));
      expect(row[5] !== "no", agent).toBe(Boolean(caps.supportsToolSelection));
      expect(row[6] === "yes", agent).toBe(Boolean(caps.supportsResultJson));
      expect(row[7] === "yes", agent).toBe(Boolean(caps.supportsProviderOverride));
    }
  });

  async function documentedContracts(): Promise<Map<string, string[]>> {
    const document = await Bun.file(
      new URL("../docs/harnesses.md", import.meta.url)
    ).text();
    const section = document.split("## Version contracts\n")[1]?.split("\n## ")[0];
    expect(section).toBeDefined();
    const rows = (section ?? "").split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| ---"))
      .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
      .filter((cells) => cells[0] !== "Harness");
    expect(rows).toHaveLength(16);
    expect(new Set(rows.map((cells) => cells[1])).size).toBe(rows.length);
    return new Map(rows.map((cells) => [cells[1]!, cells]));
  }

  test("every declared contract has its exact minimum and audited ceiling documented", async () => {
    const rows = await documentedContracts();
    for (const [agent, contract] of Object.entries(HARNESS_CONTRACTS)) {
      const row = rows.get(agent);
      expect(row, agent).toBeDefined();
      expect(row?.[2], agent).toBe(contract.min);
      expect(row?.[3], agent).toBe(contract.maxAudited);
    }
  });

  test("historical installation never invents a version gate", async () => {
    const rows = await documentedContracts();
    const ungated = ["cline", "goose", "gemini", "pi", "qwen"];
    for (const agent of ungated) {
      expect(rows.get(agent)?.[2], agent).toBe("none");
      expect(rows.get(agent)?.[3], agent).toBe("none");
      expect(HARNESS_CONTRACTS[agent as keyof typeof HARNESS_CONTRACTS]).toBeUndefined();
    }
    expect(rows.get("agy")?.[4]).toContain("1.3.3");
    expect(rows.get("agy")?.[3]).toBe("1.2.14");
    expect(rows.get("claude")?.[4]).toContain("2.1.280");
    expect(rows.get("claude")?.[3]).toBe("2.1.223");
  });

  test("legacy entry points link to current contracts without duplicating version tables", async () => {
    for (const [name, target] of [
      ["HARNESS-COMPATIBILITY.md", "harnesses.md"],
      ["HERMETIC.md", "isolation.md"],
    ]) {
      const document = await Bun.file(new URL(`../docs/${name}`, import.meta.url)).text();
      expect(document).toContain(`(${target})`);
      expect(document).not.toContain("| Harness |");
    }
  });
});

describe("the version probe runs before any sandbox, so it scrubs its own environment", () => {
  test("a variable that redirects code loading cannot reach the probe", async () => {
    // Copilot imports COPILOT_CLI_DIST_DIR's index.js instead of its installed distribution, for
    // `--version` too. Inherited, it lets an environment variable choose which code runs and what
    // version the gate reads -- outside the sandbox, because the probe runs before one exists.
    // Reproduced against the real binary during review: the unscrubbed probe reported a fabricated
    // 0.0.1 from a fixture directory while copilot 1.0.85 was installed.
    const { probeEnvironment } = await import("../src/environment.js");
    const probe = probeEnvironment({
      PATH: "/usr/bin",
      HOME: "/tmp",
      LANG: "C",
      COPILOT_CLI_DIST_DIR: "/tmp/fixture",
      COPILOT_HOME: "/tmp/fixture",
      DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
      LD_PRELOAD: "/tmp/evil.so",
      BASH_ENV: "/tmp/evil.sh",
      ANTHROPIC_API_KEY: "secret",
      GITHUB_TOKEN: "secret",
    });
    // Nothing that can redirect code loading.
    expect(probe.COPILOT_CLI_DIST_DIR).toBeUndefined();
    expect(probe.COPILOT_HOME).toBeUndefined();
    expect(probe.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(probe.LD_PRELOAD).toBeUndefined();
    expect(probe.BASH_ENV).toBeUndefined();
    // And no credentials: the probe reads a version string, and an allowlist is what makes that
    // claim true. A denylist would have passed every one of these through, outside the sandbox.
    expect(probe.ANTHROPIC_API_KEY).toBeUndefined();
    expect(probe.GITHUB_TOKEN).toBeUndefined();
    // It still has to be able to find and run the binary and read its output.
    expect(Object.keys(probe).sort()).toEqual(["HOME", "LANG", "PATH"]);
  });

  test("neither a passed-through secret nor a selector reaches the probe", async () => {
    // Two regressions a round apart, pulling opposite ways. Dropping every passed-through name
    // made the gate measure the default binary while the launch ran an override. Keeping them all
    // handed credentials to the harness's version command, which runs before scode exists and has
    // network access even under --sandbox-no-net. The sets are different: a selector is a small
    // knowable list, a credential is anything.
    const { probeEnvironment } = await import("../src/environment.js");
    const raw = {
      PATH: "/usr/bin",
      OPENCODE_BIN_PATH: "/opt/oc/1.18.0",
      INTERNAL_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
    };
    const probe = probeEnvironment(raw, ["OPENCODE_BIN_PATH", "INTERNAL_TOKEN", "GITHUB_TOKEN"]);
    // Nothing the operator passed through reaches the probe, selector or secret. Carrying the
    // selector was tried and withdrawn: the probe runs before scode and only the PATH-resolved
    // launcher is validated, so honoring a redirect inside the probe environment executes an
    // unvalidated binary outside the sandbox. The gate answers the redirect one level up
    // instead -- it resolves the value to a trusted executable and probes that binary
    // directly -- so the probe environment never needs to carry it.
    expect(probe.OPENCODE_BIN_PATH).toBeUndefined();
    expect(probe.INTERNAL_TOKEN).toBeUndefined();
    expect(probe.GITHUB_TOKEN).toBeUndefined();
  });

  test("a redirect is named so the caller can refuse to speak for the launch", async () => {
    // OpenCode's launcher picks its binary from OPENCODE_BIN_PATH. The name is listed so
    // `assertHarnessSupported` can answer it: resolve the value to a trusted executable and
    // read the verdict from that binary, or -- when it cannot -- warn rather than measuring
    // the default binary and calling it confirmed.
    const { EXECUTABLE_REDIRECTS, activeRedirects } = await import("../src/environment.js");
    expect(EXECUTABLE_REDIRECTS.opencode).toContain("OPENCODE_BIN_PATH");

    // It is in play only for the harness that reads it, and only when actually set. A flat set
    // made `--pass-env OPENCODE_BIN_PATH` skip the version check for every agent, even with the
    // variable unset -- a universal bypass in place of a narrow "cannot confirm".
    const set = { OPENCODE_BIN_PATH: "/opt/oc" };
    expect(activeRedirects("opencode", set, ["OPENCODE_BIN_PATH"])).toEqual(["OPENCODE_BIN_PATH"]);
    expect(activeRedirects("claude", set, ["OPENCODE_BIN_PATH"])).toEqual([]);
    expect(activeRedirects("opencode", {}, ["OPENCODE_BIN_PATH"])).toEqual([]);

    // A set-but-empty value is not a redirect: OpenCode's launcher reads it as no override and
    // runs its default binary, which the probe can read. Counting it as one skipped the gate and
    // let a release below the floor run without the compatibility override.
    expect(activeRedirects("opencode", { OPENCODE_BIN_PATH: "" }, ["OPENCODE_BIN_PATH"]))
      .toEqual([]);
    expect(activeRedirects("opencode", { OPENCODE_BIN_PATH: " " }, ["OPENCODE_BIN_PATH"]))
      .toEqual(["OPENCODE_BIN_PATH"]);
    const runtime = await Bun.file(
      new URL("../src/cli-runtime.ts", import.meta.url)
    ).text();
    expect(runtime).toContain("activeRedirects(");
    expect(runtime).toContain("cannot confirm the version");
  });

  test("the probe environment is a subset of the launch environment", async () => {
    // The allow side matched the upper-cased name while the launch matches exactly, so lowercase
    // variants reached the probe and were stripped from the launch -- `https_proxy` among them,
    // which most HTTP clients honor, so the two execs could resolve the network differently.
    const { probeEnvironment, sanitizeEnvironment } = await import("../src/environment.js");
    const raw = {
      PATH: "/usr/bin",
      HOME: "/tmp",
      https_proxy: "http://lowercase",
      HTTPS_PROXY: "http://uppercase",
      home: "/lowercase",
    };
    const probe = probeEnvironment(raw);
    const launch = sanitizeEnvironment("copilot", raw);
    for (const name of Object.keys(probe)) {
      expect(launch, `${name} reaches the probe but not the launch`).toHaveProperty(name);
    }
    expect(probe.https_proxy).toBeUndefined();
    expect(probe.home).toBeUndefined();
  });

  test("the probe keeps the locale prefixes the launch keeps", async () => {
    // The round12 finding: the probe allowlist carried INERT_ENV alone while
    // sanitizeEnvironment also keeps every LC_* name (INERT_PREFIXES), so the
    // --version exec and the run could resolve their locales differently with
    // no rule either way. The prefix rule now matches, keeping the probe a
    // subset of the launch rather than a divergent twin.
    const { probeEnvironment, sanitizeEnvironment } = await import("../src/environment.js");
    const raw = { PATH: "/usr/bin", LANG: "C", LC_ALL: "C.UTF-8", LC_CTYPE: "UTF-8" };
    const probe = probeEnvironment(raw);
    expect(probe.LC_ALL).toBe("C.UTF-8");
    expect(probe.LC_CTYPE).toBe("UTF-8");
    const launch = sanitizeEnvironment("copilot", raw);
    for (const name of Object.keys(probe)) {
      expect(launch, `${name} reaches the probe but not the launch`).toHaveProperty(name);
    }
  });

  test("the probe uses the environment it is given and decides nothing", async () => {
    // The decoupling, asserted structurally. Every regression in this path came from the probe
    // deciding its own environment while the launch decided differently: a dropped
    // OPENCODE_BIN_PATH made the gate measure one executable while the launch ran another, and a
    // case-insensitive allowlist let `https_proxy` reach the probe but not the launch. The
    // decision now lives in `cli-runtime.assertHarnessSupported`, the only scope where the launch
    // environment is also visible, so the two cannot drift apart.
    const source = await Bun.file(
      new URL("../src/harness-compatibility.ts", import.meta.url)
    ).text();
    // A type-only import is the right dependency: it carries no runtime coupling and is what makes
    // the contract enforceable, since only `probeEnvironment` can produce the branded type. What
    // must not appear is a value import or a call -- this module must never build an environment.
    expect(source).toContain('import type { ProbeEnvironment } from "./environment.js"');
    expect(source).not.toMatch(/^import \{[^}]*\} from "\.\/environment\.js"/m);
    expect(source).not.toContain("probeEnvironment(");

    const runtime = await Bun.file(
      new URL("../src/cli-runtime.ts", import.meta.url)
    ).text();
    const resolver = runtime.slice(runtime.indexOf("export async function assertHarnessSupported"));
    expect(resolver).toContain("probeEnvironment(");
    // Both sources of names the launch keeps have to reach it.
    expect(resolver).toContain("explicitPassthrough");
    expect(resolver).toContain("Object.keys(extraEnv");
  });
});

describe("no version-fallback machinery exists", () => {
  test("the band below the primary flag warns rather than being covered by a fallback", async () => {
    // A fallback to copilot's bare `--version` was tried and withdrawn: it lets copilot
    // auto-update and report a cached newer version while the launch, which passes
    // --no-auto-update, runs the bundled older one -- the gate approving a version that never
    // runs. With --no-auto-update it may hit an unknown option on exactly the releases it serves.
    // An unreadable version goes to the gate's per-contract null rule instead -- warn by
    // default, refuse where the contract pins it (copilot does; every release it supports can
    // answer the probe) -- never to a second probe.
    // The machinery itself is gone: a contract cannot carry a fallback the interface has no
    // field for, and re-adding either name fails here.
    const source = (await Promise.all([
      Bun.file(new URL("../src/harness-compatibility.ts", import.meta.url)).text(),
      Bun.file(new URL("../src/harness-contracts.ts", import.meta.url)).text(),
    ])).join("\n");
    expect(source).not.toContain("fallbackVersionArgs");
    expect(source).not.toContain("fallbackPattern");
  });
});

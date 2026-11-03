/**
 * Review round 39 on the machine check's harness row: the usage column reads
 * the account a launch spends from (quota.spendsFrom), a complete provider
 * override makes the native login irrelevant, the spend probe invokes this
 * codemux rather than whatever `codemux` PATH resolves, and the opencode
 * adapter never strands its provider configuration when the hermetic home
 * cannot be created. Fake binaries and fixture homes only.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAdapter } from "../src/adapters/index.js";
import type { AgentId } from "../src/types.js";
import { OpencodeAdapter } from "../src/adapters/opencode.js";
import { getDefaultConfig } from "../src/config.js";
import { checkHarness } from "../src/doctor-harness-row.js";
import { spendProbeCommand } from "../src/doctor-spend.js";
import * as hermetic from "../src/opencode-hermetic.js";
import type { ScodeFacts } from "../src/doctor-environment.js";
import { fakeScodeHelp, fakeUsagemux, fixtureHome, readPathMarker } from "./helpers/doctor.js";
import { createFakeBinaryEnv } from "./helpers/cli.js";

const homes: string[] = [];
const savedEnv = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const scode: ScodeFacts = { present: true, path: null, version: [0, 6, 0], label: "0.6.0", issue: null };
const opencodeGreen = `if [ "$1" = "--version" ]; then printf '1.18.18\\n'; exit 0; fi; exit 0`;

/** Runs one harness row with the fake PATH as the process environment, the
 * way the doctor does for its whole table. */
const rowFor = async (
  agent: AgentId,
  binaries: Record<string, string>,
  home: string,
  extraEnv: Record<string, string>,
  policy: ReturnType<typeof getDefaultConfig>["quota"]
) => {
  const fake = createFakeBinaryEnv({ scode: fakeScodeHelp(), usagemux: fakeUsagemux(), ...binaries });
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, { PATH: fake.env.PATH, HOME: home, CODEMUX_NO_KEYCHAIN_SYNC: "1", ...extraEnv });
    const adapter = getAdapter(agent, process.env);
    const row = await checkHarness(adapter, {
      versionTimeoutMs: 5_000,
      scode,
      usagePolicy: policy === false ? null : policy,
      usagemuxPresent: true,
    });
    return { row, calls: readPathMarker(fake.env, "usagemux-calls.log") };
  } finally {
    fake.cleanup();
  }
};

describe("the usage column honors quota.spendsFrom", () => {
  test("opencode mapped to claude queries claude and says so", async () => {
    const home = fixtureHome({ ".local/share/opencode/auth.json": "{}" }, homes);
    const policy = { ...getDefaultConfig().quota as Exclude<ReturnType<typeof getDefaultConfig>["quota"], false>, spendsFrom: { opencode: "claude" } };
    const { row, calls } = await rowFor("opencode", { opencode: opencodeGreen }, home, {}, policy);
    expect(calls).toContain("client=claude");
    expect(calls).not.toContain("client=opencode");
    expect(row.checks.usage).toContain("spends from claude:");
  });

  test("without a mapping the harness's own client is queried", async () => {
    const home = fixtureHome({ ".local/share/opencode/auth.json": "{}" }, homes);
    const { row, calls } = await rowFor("opencode", { opencode: opencodeGreen }, home, {}, getDefaultConfig().quota);
    expect(calls).toContain("client=opencode");
    expect(row.checks.usage).not.toContain("spends from");
  });
});

describe("a complete provider override replaces the native login", () => {
  test("no native credential with a complete override is not NO-LOGIN", async () => {
    // codex: a current version with no known break, so the row's state and
    // severity come from the login and override columns alone.
    const home = fixtureHome({}, homes);
    const override = {
      CODEMUX_CODEX_PROVIDER_BASE_URL: "https://provider.example/v1",
      CODEMUX_CODEX_PROVIDER_API_KEY: "test-key-do-not-print",
      CODEMUX_CODEX_PROVIDER_MODEL: "m",
    };
    const codexGreen = `if [ "$1" = "--version" ]; then printf 'codex-cli 0.165.0\\n'; exit 0; fi; exit 0`;
    const { row } = await rowFor("codex", { codex: codexGreen }, home, override, getDefaultConfig().quota);
    expect(row.state).toBe("OK");
    expect(row.detail.join("\n")).toContain("provider override set; the native login and the native usage window are not used");
    // Informational, never a warning: `--strict` must not fail on it (review round 46).
    expect(row.severity).toBe("ok");
    expect(row.detail.join("\n")).not.toContain("test-key-do-not-print");
  });

  test("a complete override on a harness without the capability is OVERRIDE-INVALID, not a login (review round 43)", async () => {
    const home = fixtureHome({}, homes);
    const { row } = await rowFor(
      "gemini",
      { gemini: `if [ "$1" = "--version" ]; then printf '0.9.0\\n'; exit 0; fi; exit 0` },
      home,
      {
        CODEMUX_GEMINI_PROVIDER_BASE_URL: "https://provider.example/v1",
        CODEMUX_GEMINI_PROVIDER_API_KEY: "test-key-do-not-print",
        CODEMUX_GEMINI_PROVIDER_MODEL: "x",
      },
      getDefaultConfig().quota
    );
    expect(row.state).toBe("OVERRIDE-INVALID");
    expect(row.detail.join("\n")).toContain("gemini does not support a provider override");
  });

  test("an active override silences the native usage verdict (the launch skips the native gate)", async () => {
    const home = fixtureHome({}, homes);
    const fake = createFakeBinaryEnv({ scode: fakeScodeHelp(), usagemux: fakeUsagemux({ remainingPercent: 0, usedPercent: 100 }), opencode: opencodeGreen });
    try {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, {
        PATH: fake.env.PATH, HOME: home, CODEMUX_NO_KEYCHAIN_SYNC: "1",
        CODEMUX_OPENCODE_PROVIDER_BASE_URL: "https://provider.example/v1",
        CODEMUX_OPENCODE_PROVIDER_API_KEY: "test-key-do-not-print",
        CODEMUX_OPENCODE_PROVIDER_MODEL: "glm-5.3",
      });
      const row = await checkHarness(getAdapter("opencode", process.env), {
        versionTimeoutMs: 5_000, scode, usagePolicy: getDefaultConfig().quota as never, usagemuxPresent: true,
      });
      expect(row.state).not.toBe("QUOTA-LOW");
      expect(row.detail.join("\n")).toContain("native usage window are not used");
    } finally {
      fake.cleanup();
    }
  });

  test("an incomplete override stays OVERRIDE-INVALID and the login still counts", async () => {
    const home = fixtureHome({}, homes);
    const { row } = await rowFor(
      "opencode",
      { opencode: opencodeGreen },
      home,
      { CODEMUX_OPENCODE_PROVIDER_BASE_URL: "https://provider.example/v1" },
      getDefaultConfig().quota
    );
    expect(row.state).toBe("OVERRIDE-INVALID");
  });
});

describe("the spend probe runs this codemux", () => {
  test("the command is bun with this checkout's runtime config and entry point", () => {
    const command = spendProbeCommand();
    expect(command[0]).toBe(process.execPath);
    expect(command).toContain("--no-env-file");
    expect(command.some((part) => part.startsWith("--config=") && part.endsWith("bunfig.runtime.toml"))).toBe(true);
    expect(command[command.length - 1]!.endsWith(join("src", "index.ts"))).toBe(true);
  });
});

describe("opencode prepareRun on a failed hermetic home", () => {
  test("the provider configuration written first is cleaned up and the error propagates", () => {
    const home = mkdtempSync(join(tmpdir(), "codemux-opencode-home-"));
    homes.push(home);
    const adapter = new OpencodeAdapter(
      {
        CODEMUX_OPENCODE_PROVIDER_BASE_URL: "https://provider.example/v1",
        CODEMUX_OPENCODE_PROVIDER_API_KEY: "test-key-do-not-print",
        CODEMUX_OPENCODE_PROVIDER_MODEL: "glm-5.3",
      },
      home
    );
    const creation = spyOn(hermetic, "createOpencodeHermeticHome").mockImplementation(() => {
      throw new Error("disk full");
    });
    const cleanup = spyOn(adapter, "cleanupRunSync");
    try {
      expect(() => adapter.prepareRun({ agent: "opencode", prompt: "x", hermetic: true, model: "glm-5.3" })).toThrow("disk full");
      expect(cleanup).toHaveBeenCalledTimes(1);
      const context = cleanup.mock.calls[0]![0] as { opencodeProviderConfig?: unknown } | undefined;
      expect(context?.opencodeProviderConfig).toBeDefined();
    } finally {
      creation.mockRestore();
      cleanup.mockRestore();
    }
  });
});

describe("the usage verdict follows the gate's configured budget (review round 44)", () => {
  test("an answer past quota.timeoutSeconds is QUOTA-UNREADABLE, never QUOTA-LOW", async () => {
    // codex: a current version with no known break, a logged-in store, and a
    // usagemux that answers "0% left" two seconds late under a 1 s budget.
    const home = fixtureHome({ ".codex/auth.json": '{"auth_mode":"chatgpt","tokens":{"refresh_token":"present"}}' }, homes);
    const slow = `sleep 7\n${fakeUsagemux({ remainingPercent: 0, usedPercent: 100 })}`; // past the 1 s policy plus the 5 s grace
    const codexGreen = `if [ "$1" = "--version" ]; then printf 'codex-cli 0.165.0\\n'; exit 0; fi; exit 0`;
    const fake = createFakeBinaryEnv({ scode: fakeScodeHelp(), usagemux: slow, codex: codexGreen });
    try {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, { PATH: fake.env.PATH, HOME: home, CODEMUX_NO_KEYCHAIN_SYNC: "1" });
      const policy = { ...(getDefaultConfig().quota as Exclude<ReturnType<typeof getDefaultConfig>["quota"], false>), timeoutSeconds: 1 };
      const row = await checkHarness(getAdapter("codex", process.env), {
        versionTimeoutMs: 5_000, scode, usagePolicy: policy, usagemuxPresent: true,
      });
      expect(row.state).toBe("QUOTA-UNREADABLE");
      expect(row.checks.usage).toContain("past the gate's 1 s budget (plus its 5 s grace)");
      expect(row.detail.join("\n")).toContain("raise quota.timeoutSeconds for codex");
    } finally {
      fake.cleanup();
    }
  }, 20_000);
});

describe("the override column asks the adapter (review round 45)", () => {
  test("a complete override with a cap the adapter cannot carry is OVERRIDE-INVALID with the adapter's reason", async () => {
    const home = fixtureHome({}, homes);
    const { row } = await rowFor(
      "droid",
      { droid: `if [ "$1" = "--version" ]; then printf '0.186.0\\n'; exit 0; fi; exit 0` },
      home,
      {
        CODEMUX_DROID_PROVIDER_BASE_URL: "https://provider.example/v1",
        CODEMUX_DROID_PROVIDER_API_KEY: "test-key-do-not-print",
        CODEMUX_DROID_PROVIDER_MODEL: "m",
        CODEMUX_DROID_PROVIDER_MAX_CONTEXT_TOKENS: "4000",
      },
      getDefaultConfig().quota
    );
    expect(row.state).toBe("OVERRIDE-INVALID");
    expect(row.detail.join("\n")).toContain("context cap cannot ride the override");
    expect(row.detail.join("\n")).not.toContain("test-key-do-not-print");
  });
});

describe("the gate budget is the launching agent's entry (review round 45)", () => {
  test("spendsFrom maps the client, the timeout stays the agent's", async () => {
    const home = fixtureHome({ ".codex/auth.json": '{"auth_mode":"chatgpt","tokens":{"refresh_token":"present"}}' }, homes);
    const slow = `sleep 7\n${fakeUsagemux({ remainingPercent: 0, usedPercent: 100 })}`; // past the 1 s policy plus the 5 s grace
    const codexGreen = `if [ "$1" = "--version" ]; then printf 'codex-cli 0.165.0\\n'; exit 0; fi; exit 0`;
    const fake = createFakeBinaryEnv({ scode: fakeScodeHelp(), usagemux: slow, codex: codexGreen });
    try {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, { PATH: fake.env.PATH, HOME: home, CODEMUX_NO_KEYCHAIN_SYNC: "1" });
      const base = getDefaultConfig().quota as Exclude<ReturnType<typeof getDefaultConfig>["quota"], false>;
      // codex's own budget is 1 s; the mapped client's (claude) is 60 s. A
      // launch of codex applies codex's, so the doctor must too.
      const policy = { ...base, timeoutSeconds: { default: 60, codex: 1, claude: 60 }, spendsFrom: { codex: "claude" } };
      const row = await checkHarness(getAdapter("codex", process.env), {
        versionTimeoutMs: 5_000, scode, usagePolicy: policy as never, usagemuxPresent: true,
      });
      expect(readPathMarker(fake.env, "usagemux-calls.log")).toContain("client=claude");
      expect(row.state).toBe("QUOTA-UNREADABLE");
      expect(row.checks.usage).toContain("past the gate's 1 s budget (plus its 5 s grace)");
    } finally {
      fake.cleanup();
    }
  }, 20_000);
});

describe("snapshot freshness follows the launch gate (review round 54)", () => {
  test("a stale snapshot is QUOTA-UNREADABLE, never QUOTA-LOW", async () => {
    const home = fixtureHome({ ".codex/auth.json": '{"auth_mode":"chatgpt","tokens":{"refresh_token":"present"}}' }, homes);
    const codexGreen = `if [ "$1" = "--version" ]; then printf 'codex-cli 0.165.0\\n'; exit 0; fi; exit 0`;
    const fake = createFakeBinaryEnv({ scode: fakeScodeHelp(), usagemux: fakeUsagemux({ remainingPercent: 0, usedPercent: 100, generatedAt: "2026-01-01T00:00:00.000Z" }), codex: codexGreen });
    try {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, { PATH: fake.env.PATH, HOME: home, CODEMUX_NO_KEYCHAIN_SYNC: "1" });
      const row = await checkHarness(getAdapter("codex", process.env), {
        versionTimeoutMs: 5_000, scode, usagePolicy: getDefaultConfig().quota as never, usagemuxPresent: true,
      });
      expect(row.state).toBe("QUOTA-UNREADABLE");
      expect(row.checks.usage).toContain("stale");
    } finally {
      fake.cleanup();
    }
  });
});

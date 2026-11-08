/**
 * The machine check's login rows over fixture credential stores (audit
 * report D, section 2) and its usage rows over a fake usagemux (D5, D6,
 * D12): every state a credential file can produce, the quota verdicts the
 * gate itself computes, and the per-client timeouts the queries carry.
 * In process, controlled environment, fixture HOMEs — never the host's.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { windowLine } from "../src/doctor-harness-row.js";
import { fakeScodeHelp, fakeUsagemux, fixtureHome, readPathMarker, runDoctor } from "./helpers/doctor.js";
import { createFakeBinaryEnv } from "./helpers/cli.js";

const homes: string[] = [];
afterAll(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const MINUTE = 60_000;
const claudeMirror = (expiresAt: number): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token", expiresAt } });

const KIMI_STORE = ".kimi-code/credentials/kimi-code.json";
const KIMI_LABEL = "~/.kimi-code/credentials/kimi-code.json";
const kimiStore = (fields: Record<string, unknown>): string => JSON.stringify(fields);
/** Epoch seconds `offsetMs` from now, kimi's own expiry unit. */
const seconds = (offsetMs: number): number => Math.floor((Date.now() + offsetMs) / 1_000);

const greenBase = (extra: Record<string, string> = {}): Record<string, string> => ({
  scode: fakeScodeHelp(),
  usagemux: fakeUsagemux(),
  ...extra,
});

describe("doctor login rows over fixture stores", () => {
  test.each([
    // claude: the Keychain credential's on-disk mirror, expiry epoch ms.
    [
      "claude",
      { ".claude/.credentials.json": claudeMirror(Date.now() + 30 * MINUTE) },
      {},
      "logged-in (~/.claude/.credentials.json)",
      "| OK |",
      0,
    ],
    [
      "claude",
      { ".claude/.credentials.json": claudeMirror(Date.now() - 30 * MINUTE) },
      {},
      "expired (~/.claude/.credentials.json)",
      "| LOGIN-EXPIRED |",
      1,
    ],
    [
      "claude",
      {},
      {},
      "unknown (~/.claude/.credentials.json)",
      "| LOGIN-UNKNOWN |",
      0,
    ],
    // codex: auth.json (auth_mode, refresh-token presence) or an API key.
    [
      "codex",
      { ".codex/auth.json": '{"auth_mode":"chatgpt","tokens":{"refresh_token":"present"}}' },
      {},
      "logged-in (~/.codex/auth.json)",
      "refresh token present",
      0,
    ],
    ["codex", {}, { CODEX_API_KEY: "synthetic-key" }, "logged-in (CODEX_API_KEY)", "| OK |", 0],
    ["codex", {}, {}, "no-credential (~/.codex/auth.json)", "| NO-LOGIN |", 1],
    // A parseable but tokenless auth.json is no login (review round 42).
    ["codex", { ".codex/auth.json": "{}" }, {}, "no-credential (~/.codex/auth.json)", "| NO-LOGIN |", 1],
    // A store that is not a bounded regular file is unknown, never read (review round 50).
    ["codex", { ".codex/auth.json/placeholder": "x" }, {}, "unknown (~/.codex/auth.json)", "| LOGIN-UNKNOWN |", 0],
    // A tokenless file with an environment key still logs codex in (review round 47).
    ["codex", { ".codex/auth.json": "{}" }, { CODEX_API_KEY: "synthetic-key" }, "logged-in (CODEX_API_KEY)", "| OK |", 0],
    ["codex", { ".codex/auth.json": '{"auth_mode":"apikey","OPENAI_API_KEY":"synthetic"}' }, {}, "logged-in (~/.codex/auth.json)", "| OK |", 0],
    // agy: the file token must be a regular, non-empty file (review round 44).
    ["agy", { ".gemini/antigravity-cli/antigravity-oauth-token": "" }, {}, "no-credential (~/.gemini/antigravity-cli/antigravity-oauth-token)", "| NO-LOGIN |", 1],
    ["agy", { ".gemini/antigravity-cli/antigravity-oauth-token/placeholder": "x" }, {}, "no-credential (~/.gemini/antigravity-cli/antigravity-oauth-token)", "| NO-LOGIN |", 1],
    // kimi: the 15-minute token, epoch seconds.
    ["kimi", { [KIMI_STORE]: kimiStore({ expires_at: seconds(10 * MINUTE), access_token: "a", refresh_token: "r" }) }, {}, `logged-in (${KIMI_LABEL})`, "| OK |", 0],
    // An aged-out access token beside a refresh token is a working login:
    // kimi renews the token on its next run (2026-11-05: doctor reported a
    // working kimi login as LOGIN-EXPIRED 15 minutes after every run).
    ["kimi", { [KIMI_STORE]: kimiStore({ expires_at: seconds(-10 * MINUTE), access_token: "a", refresh_token: "r" }) }, {}, `logged-in (${KIMI_LABEL}) refresh token present`, "| OK |", 0],
    // A refresh token alone is enough for kimi to obtain an access token.
    ["kimi", { [KIMI_STORE]: kimiStore({ expires_at: seconds(10 * MINUTE), refresh_token: "r" }) }, {}, `logged-in (${KIMI_LABEL}) refresh token present`, "| OK |", 0],
    // Without a refresh token an aged-out access token is a real expiry.
    ["kimi", { [KIMI_STORE]: kimiStore({ expires_at: seconds(-10 * MINUTE), access_token: "a", refresh_token: "" }) }, {}, `expired (${KIMI_LABEL})`, "| LOGIN-EXPIRED |", 1],
    // A decimal string and a millisecond expiry read like kimi's epoch seconds.
    ["kimi", { [KIMI_STORE]: kimiStore({ expires_at: String(seconds(10 * MINUTE)), access_token: "a" }) }, {}, `logged-in (${KIMI_LABEL})`, "| OK |", 0],
    ["kimi", { [KIMI_STORE]: kimiStore({ expires_at: Date.now() - 10 * MINUTE, access_token: "a" }) }, {}, `expired (${KIMI_LABEL})`, "| LOGIN-EXPIRED |", 1],
    // A refresh token logs kimi in whether or not the expiry is readable (review round 106).
    ["kimi", { [KIMI_STORE]: kimiStore({ refresh_token: "r" }) }, {}, `logged-in (${KIMI_LABEL}) refresh token present`, "| OK |", 0],
    ["kimi", { [KIMI_STORE]: kimiStore({ access_token: "a", refresh_token: "r" }) }, {}, `logged-in (${KIMI_LABEL}) refresh token present`, "no readable expiry; kimi renews it", 0],
    // An access token alone with no readable expiry is unknown; a hexadecimal or exponent string is not an expiry.
    ["kimi", { [KIMI_STORE]: kimiStore({ access_token: "a" }) }, {}, `unknown (${KIMI_LABEL})`, "| LOGIN-UNKNOWN |", 0],
    ["kimi", { [KIMI_STORE]: kimiStore({ expires_at: "0x7fffffffff", access_token: "a" }) }, {}, `unknown (${KIMI_LABEL})`, "| LOGIN-UNKNOWN |", 0],
    ["kimi", { [KIMI_STORE]: kimiStore({ expires_at: "9e12", access_token: "a" }) }, {}, `unknown (${KIMI_LABEL})`, "| LOGIN-UNKNOWN |", 0],
    // A store with an expiry and no token is no login.
    ["kimi", { [KIMI_STORE]: kimiStore({ expires_at: seconds(10 * MINUTE) }) }, {}, `no-credential (${KIMI_LABEL})`, "| NO-LOGIN |", 1],
    ["kimi", {}, {}, `no-credential (${KIMI_LABEL})`, "| NO-LOGIN |", 1],
    // zai: the key file, mode checked.
    ["zai", { ".zai": { body: "synthetic-key", mode: 0o600 } }, {}, "logged-in (~/.zai)", "| OK |", 0],
    [
      "zai",
      { ".zai": { body: "synthetic-key", mode: 0o644 } },
      {},
      "no-credential (~/.zai)",
      "| NO-LOGIN |",
      1,
    ],
    // cursor: the file store the sandbox needs.
    [
      "cursor",
      { ".cursor/auth.json": '{"github":{}}' },
      {},
      "logged-in (~/.cursor/auth.json)",
      "| OK |",
      0,
    ],
    [
      "cursor",
      { ".cursor/auth.json": '{"version":1}' },
      {},
      "no-credential (~/.cursor/auth.json)",
      "| NO-LOGIN |",
      1,
    ],
    // opencode: the data directory's auth.json.
    [
      "opencode",
      { ".local/share/opencode/auth.json": '{"github":{}}' },
      {},
      "logged-in (the opencode data directory's auth.json)",
      "| KNOWN-BREAK |",
      0,
    ],
    // qwen: a provider-key harness, env only.
    ["qwen", {}, { OPENAI_API_KEY: "synthetic-key" }, "logged-in (OPENAI_API_KEY)", "| OK |", 0],
  ])(
    "%s with %s reports %s",
    async (agent, files, env, loginCell, stateOrDetail, exit) => {
      // The binary each agent resolves: zai runs the claude binary, and
      // the cursor adapter's entry point is the standalone cursor-agent.
      const script = (reading: string): string =>
        `if [ "$1" = "--version" ]; then printf '${reading}\\n'; exit 0; fi`;
      const binaryByAgent: Record<string, Record<string, string>> = {
        agy: { agy: script("1.4.12") },
        claude: { claude: script("2.1.300 (Claude Code)") },
        zai: { claude: script("2.1.300 (Claude Code)") },
        codex: { codex: script("codex-cli 0.165.0") },
        kimi: { kimi: script("2.4.0") },
        cursor: { "cursor-agent": script("2026.10.22-e8db854") },
        opencode: { opencode: script("1.18.18") },
        qwen: { qwen: script("0.6.2") },
      };
      const fake = createFakeBinaryEnv({ ...greenBase(), ...binaryByAgent[agent] });
      try {
        const result = await runDoctor(["--only", agent], {
          path: fake.env.PATH!,
          home: fixtureHome(files, homes),
          env,
        });
        expect(result.exitCode).toBe(exit);
        expect(result.output).toContain(loginCell);
        expect(result.output).toContain(stateOrDetail);
      } finally {
        fake.cleanup();
      }
    }
  );

  const kimiDoctor = async (credential: string) => {
    const fake = createFakeBinaryEnv({
      ...greenBase(),
      kimi: `if [ "$1" = "--version" ]; then printf '2.4.0\\n'; exit 0; fi`,
    });
    try {
      return await runDoctor(["--only", "kimi"], {
        path: fake.env.PATH!,
        home: fixtureHome({ ".kimi-code/credentials/kimi-code.json": credential }, homes),
      });
    } finally {
      fake.cleanup();
    }
  };

  test("an aged-out kimi access token beside a refresh token is a working login", async () => {
    const result = await kimiDoctor(kimiStore({ expires_at: seconds(-MINUTE), access_token: "a", refresh_token: "r" }));
    expect(result.output).toContain("logged-in (~/.kimi-code/credentials/kimi-code.json) refresh token present");
    expect(result.output).toContain("kimi renews it from the refresh token on its next run");
    expect(result.output).not.toContain("LOGIN-EXPIRED");
    expect(result.output).not.toContain("kimi login");
    expect(result.exitCode).toBe(0);
  });

  test("an expired kimi token with no refresh token names kimi login", async () => {
    const result = await kimiDoctor(kimiStore({ expires_at: seconds(-MINUTE), access_token: "a" }));
    expect(result.output).toContain("| LOGIN-EXPIRED |");
    expect(result.output).toContain("the store holds no refresh token");
    expect(result.output).toContain("kimi login");
    expect(result.exitCode).toBe(1);
  });

  test("a zai key file readable by others says chmod, not just no-login", async () => {
    const fake = createFakeBinaryEnv({
      ...greenBase(),
      claude: `if [ "$1" = "--version" ]; then printf '2.1.300 (Claude Code)\\n'; exit 0; fi`,
    });
    try {
      const result = await runDoctor(["--only", "zai"], {
        path: fake.env.PATH!,
        home: fixtureHome({ ".zai": { body: "synthetic-key", mode: 0o644 } }, homes),
      });
      expect(result.output).toContain("chmod it to 0600");
      expect(result.output).toContain("umask 077");
    } finally {
      fake.cleanup();
    }
  });
});

describe("doctor usage rows over a fake usagemux", () => {
  const claudeGreen = `if [ "$1" = "--version" ]; then printf '2.1.300 (Claude Code)\\n'; exit 0; fi`;
  const claudeHome = (): Record<string, string> => ({
    ".claude/.credentials.json": claudeMirror(Date.now() + 30 * MINUTE),
  });

  test("the window line finds weekly by word boundary, like the quota gate (review round 361)", () => {
    // "biweekly" and "weekday" name other cadences: an unanchored /week/i
    // rendered them as "week N% used" (usagemux emits no such kind today;
    // the gate's own weekly test has been word-bounded since round 20).
    const window = (kind: string) => ({
      kind,
      usedPercent: 40,
      remainingPercent: 60,
      windowMinutes: null,
      resetsAt: null,
    });
    expect(windowLine({ windows: [window("weekly")] } as never)).toContain("week 40% used");
    expect(windowLine({ windows: [window("primary-week")] } as never)).toContain("week");
    expect(windowLine({ windows: [window("biweekly")] } as never)).toBe("no window reported");
    expect(windowLine({ windows: [window("weekday")] } as never)).toBe("no window reported");
    expect(windowLine({ windows: [] } as never)).toBe("no window reported");
  });

  test("a window below the ceiling is QUOTA-LOW and broken, with the gate's verdict", async () => {
    const fake = createFakeBinaryEnv(
      greenBase({ claude: claudeGreen, usagemux: fakeUsagemux({ remainingPercent: 5, usedPercent: 95 }) })
    );
    try {
      const result = await runDoctor(["--only", "claude"], {
        path: fake.env.PATH!,
        home: fixtureHome(claudeHome(), homes),
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("| QUOTA-LOW |");
      expect(result.output).toContain("gate: refuse");
      expect(result.output).toContain("--quota-ceiling");
    } finally {
      fake.cleanup();
    }
  });

  test("an unreadable window is QUOTA-UNREADABLE with usagemux's message verbatim", async () => {
    const fake = createFakeBinaryEnv(
      greenBase({
        claude: claudeGreen,
        usagemux: fakeUsagemux({ status: "unavailable", message: "sign in to the CLI" }),
      })
    );
    try {
      const result = await runDoctor(["--only", "claude"], {
        path: fake.env.PATH!,
        home: fixtureHome(claudeHome(), homes),
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("| QUOTA-UNREADABLE |");
      expect(result.output).toContain("sign in to the CLI");
      // claude's own remedy names the timeout knob; the message is the
      // remedy for every other harness.
      expect(result.output).toContain("timeoutSeconds: 60");
      expect(result.output).toContain("codexbar: unreachable");
    } finally {
      fake.cleanup();
    }
  });

  test.each([
    ["0.2.1", "USAGEMUX-STALE", "brew upgrade bindsch/tap/usagemux"],
    ["1.0.0", "ok: usagemux 1.0.0", null],
  ])("a usagemux reading %s is the environment row %s", async (version, row, remedy) => {
    const fake = createFakeBinaryEnv(
      greenBase({ claude: claudeGreen, usagemux: fakeUsagemux({ version }) })
    );
    try {
      const result = await runDoctor(["--only", "claude"], {
        path: fake.env.PATH!,
        home: fixtureHome(claudeHome(), homes),
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(`usagemux: ${row.startsWith("ok") ? "" : ""}${row}`);
      if (remedy !== null) expect(result.output).toContain(remedy);
    } finally {
      fake.cleanup();
    }
  });

  test("no usagemux is a warn row, unreadable usage cells, and exit 0", async () => {
    const fake = createFakeBinaryEnv({ scode: fakeScodeHelp(), claude: claudeGreen });
    try {
      const result = await runDoctor(["--only", "claude"], {
        path: fake.env.PATH!,
        home: fixtureHome(claudeHome(), homes),
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("usagemux: USAGEMUX-MISSING");
      expect(result.output).toContain("unreadable (usagemux is not installed)");
      expect(result.output).toContain("| QUOTA-UNREADABLE |");
      expect(result.output).toContain("brew install bindsch/tap/usagemux");
    } finally {
      fake.cleanup();
    }
  });

  test("per-client timeouts reach usagemux, and agy is included (D6, D12)", async () => {
    // claude 60 s, agy 90 s, codex 30 s; `codemux usage` keeps excluding
    // agy, the machine check never does.
    const fake = createFakeBinaryEnv(
      greenBase({
        claude: claudeGreen,
        agy: `if [ "$1" = "--version" ]; then printf '1.4.12\\n'; exit 0; fi`,
        codex: `if [ "$1" = "--version" ]; then printf 'codex-cli 0.165.0\\n'; exit 0; fi`,
      })
    );
    try {
      const result = await runDoctor(["--only", "claude,agy,codex"], {
        path: fake.env.PATH!,
        home: fixtureHome(
          {
            ...claudeHome(),
            ".gemini/antigravity-cli/antigravity-oauth-token": "present",
            ".codex/auth.json": '{"auth_mode":"chatgpt","tokens":{"refresh_token":"present"}}',
          },
          homes
        ),
      });
      expect(result.exitCode).toBe(0);
      const calls = readPathMarker(fake.env, "usagemux-calls.log");
      // The budget is the gate's 60 s plus its 5 s shutdown grace (65), or
      // the client's longer known answer time (agy 90; review rounds 44, 54).
      expect(calls).toContain("client=claude timeout=65");
      expect(calls).toContain("client=agy timeout=90");
      // The budget is the longer of the gate's configured 60 s and the
      // client's known answer time (review round 44), so codex waits 60 s here.
      expect(calls).toContain("client=codex timeout=65");
      expect(result.output).toMatch(/\[\d+\.\d s\]/);
    } finally {
      fake.cleanup();
    }
  });

  test("the keychain row is skipped under the test seam", async () => {
    const fake = createFakeBinaryEnv(greenBase({ claude: claudeGreen }));
    try {
      const result = await runDoctor(["--only", "claude"], {
        path: fake.env.PATH!,
        home: fixtureHome(claudeHome(), homes),
      });
      expect(result.output).toContain("keychain: skipped: keychain read disabled for this run");
    } finally {
      fake.cleanup();
    }
  });
});

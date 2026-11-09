import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  enforceKimiSessionDenyPolicy,
  kimiTomlValue,
  KIMI_SESSION_DENY_RULE,
  writeKimiSessionHermeticConfig,
} from "../src/kimi-hermetic.js";
import { KimiSessionDriver } from "../src/session/kimi-driver.js";
import { ID } from "./helpers/session-kimi.js";

function fixture(contents?: string) {
  const scratch = resolve("scratch/fix/kimi-deny-tests");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "config-"));
  const brand = join(dir, ".kimi-code");
  mkdirSync(brand);
  const path = join(brand, "config.toml");
  if (contents !== undefined) writeFileSync(path, contents);
  return {
    dir, brand, path,
    read: () => Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, any>,
  };
}

describe("Kimi native session deny rules", () => {
  test("a missing config gets a private catch-all rule covering all tools and arguments", () => {
    const f = fixture();
    enforceKimiSessionDenyPolicy(f.brand);
    expect(f.read()).toEqual({ permission: { rules: [KIMI_SESSION_DENY_RULE] } });
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    expect(KIMI_SESSION_DENY_RULE.pattern).toBe("*");
    expect(KIMI_SESSION_DENY_RULE.scope).toBe("user");
  });

  test("consumer native rules, shorthand rules, policy settings, and unrelated keys survive", () => {
    const f = fixture([
      'default_model = "consumer-model"',
      'future_config = { enabled = true }',
      '[permission]',
      'dangerous_command_guard = false',
      'deny = [{ tool = "Bash", match = "rm *", reason = "consumer deny" }]',
      'allow = { pattern = "Read", reason = "consumer allow" }',
      'ask = [{ tool = "Edit", pattern = "docs/**" }]',
      '[[permission.rules]]',
      'decision = "allow"',
      'pattern = "Bash"',
      'scope = "project"',
      'reason = "consumer rule"',
      '',
    ].join("\n"));
    const before = f.read();
    enforceKimiSessionDenyPolicy(f.brand);
    expect(f.read()).toEqual({
      ...before,
      permission: { ...before.permission, rules: [...before.permission.rules, KIMI_SESSION_DENY_RULE] },
    });
  });

  test("a single native inline rule remains before the generated deny", () => {
    const f = fixture('[permission]\nrules = { decision = "allow", tool = "Bash", match = "ls *" }\n');
    const before = f.read();
    enforceKimiSessionDenyPolicy(f.brand);
    expect(f.read().permission.rules).toEqual([before.permission.rules, KIMI_SESSION_DENY_RULE]);
  });

  test("a native inline permission table retains its rule values", () => {
    const f = fixture('permission = { rules = [{ decision = "allow", pattern = "Read" }], ask = { tool = "Bash" } }\n');
    const before = f.read();
    enforceKimiSessionDenyPolicy(f.brand);
    expect(f.read().permission).toEqual({
      ...before.permission, rules: [...before.permission.rules, KIMI_SESSION_DENY_RULE],
    });
  });

  test.each([undefined, "user", "project", "turn-override"])(
    "an existing native catch-all at scope %s preserves bytes, including comments",
    (scope) => {
      const f = fixture([
        '# consumer comment survives an idempotent check',
        '[[permission.rules]]',
        'decision = "deny"',
        'pattern = "*"',
        ...(scope === undefined ? [] : [`scope = "${scope}"`]),
        '',
      ].join("\n"));
      const before = readFileSync(f.path, "utf8");
      enforceKimiSessionDenyPolicy(f.brand);
      expect(readFileSync(f.path, "utf8")).toBe(before);
    }
  );

  test("repeated enforcement does not duplicate rules or rewrite the config", () => {
    const f = fixture('[permission]\nrules = []\n');
    enforceKimiSessionDenyPolicy(f.brand);
    const before = readFileSync(f.path, "utf8");
    enforceKimiSessionDenyPolicy(f.brand);
    expect(readFileSync(f.path, "utf8")).toBe(before);
    expect(f.read().permission.rules).toHaveLength(1);
  });

  test.each([
    'decision = "deny", pattern = "*", scope = "session-runtime"',
    'decision = "deny", pattern = "*", tool = "Bash"',
    'decision = "allow", pattern = "*"',
    'decision = "ask", pattern = "*"',
  ])("a non-global native rule cannot suppress the deny: %s", (rule) => {
    const f = fixture(`[permission]\nrules = [{ ${rule} }]\n`);
    const before = f.read().permission.rules[0];
    enforceKimiSessionDenyPolicy(f.brand);
    expect(f.read().permission.rules).toEqual([before, KIMI_SESSION_DENY_RULE]);
  });

  test.each([
    'permission = "invalid"\n',
    'permission = []\n',
    '[permission]\nrules = 1\n',
    '[permission]\nrules = ["Bash"]\n',
    '[permission]\nrules = [[]]\n',
    'permission = "\\q"\n',
    'permission = 2026-11-09T12:00:00Z\n',
    '[permission]\nrules = 2026-11-09T12:00:00Z\n',
    '[permission]\nrules = [2026-11-09T12:00:00Z]\n',
  ])("malformed config fails without overwriting the consumer file: %s", (contents) => {
    const f = fixture(contents);
    expect(() => enforceKimiSessionDenyPolicy(f.brand)).toThrow();
    expect(readFileSync(f.path, "utf8")).toBe(contents);
  });

  test("a config symlink is refused without changing its target", () => {
    const f = fixture();
    const target = join(f.brand, "consumer.toml");
    const contents = '[permission]\nrules = []\n';
    writeFileSync(target, contents);
    symlinkSync(target, f.path);
    expect(() => enforceKimiSessionDenyPolicy(f.brand)).toThrow();
    expect(readFileSync(target, "utf8")).toBe(contents);
  });

  test.each([
    "2026-11-09T12:00:00Z",
    "2026-11-09t12:00:00.123400+02:30",
    "2026-11-09 12:00:00.123400-02:30",
    "2026-11-09T12:00:00.123400",
    "2026-11-09T12:00:00.123456789z",
    "2026-11-09T12:00Z",
    "2026-11-09T12:00",
    "2026-11-09",
    "12:00:00.123400",
    "12:00",
  ])("an accepted consumer datetime stays verbatim when deny is inserted: %s", (literal) => {
    const contents = `future_date = ${literal}\n`;
    const f = fixture(contents);
    const before = f.read().future_date;
    enforceKimiSessionDenyPolicy(f.brand);
    expect(readFileSync(f.path, "utf8")).toContain(`= ${literal}\n`);
    expect(f.read().future_date.toString()).toBe(before.toString());
    expect(f.read().permission.rules).toEqual([KIMI_SESSION_DENY_RULE]);
  });

  test("nested datetime literals survive strings, comments, and date-shaped keys", () => {
    const literal = "2026-11-09T12:00:00.123400+02:30";
    const f = fixture([
      `# ignore ${literal}`,
      `quoted = "${literal}"`,
      `literal = '${literal}'`,
      `escaped = "quoted \\"${literal}\\""`,
      `multiline = """${literal}\nquoted \\"date\\" and trailing quotes"""""`,
      `multiline_literal = '''${literal}\ntrailing quotes'''''`,
      `__codemux_toml_literal_0 = "consumer marker"`,
      `[2026-11-09]`,
      `dates = [${literal}, [2026-11-09, 12:00:00.123400]]`,
      `nested = { stamp = ${literal} }`,
      `[[batches]]`,
      `stamp = 2026-11-09T09:30:00.123400Z`,
      `[[batches]]`,
      `stamp = ${literal}`,
      `# final comment ${literal}`,
    ].join("\n"));
    const before = f.read();
    enforceKimiSessionDenyPolicy(f.brand);
    const after = f.read();
    expect(after).toEqual({ ...before, permission: { rules: [KIMI_SESSION_DENY_RULE] } });
    const written = readFileSync(f.path, "utf8");
    expect(written).toContain(`[${literal}, [2026-11-09, 12:00:00.123400]]`);
    expect(written).toContain(`"stamp" = ${literal}`);
    expect(written).toContain(`[{ "stamp" = 2026-11-09T09:30:00.123400Z }, { "stamp" = ${literal} }]`);
  });

  test("unrecognized nonplain objects cannot serialize as empty tables", () => {
    expect(() => kimiTomlValue(new Date("2026-11-09T12:00:00Z"))).toThrow("unsupported TOML value");
    expect(() => kimiTomlValue(new Map())).toThrow("unsupported TOML value");
  });

  test.each([
    ["2026-11-09", "2026-11-09"],
    ["2026-11-09", '"2026-11-09"'],
    ['"2026-11-09"', "2026-11-09"],
    ["2026-11-09", "'2026-11-09'"],
    ["outer.2026-11-09", '"outer"."2026-11-09"'],
  ])("equivalent table names %s and %s preserve each entry's datetime", (firstKey, secondKey) => {
    const first = "2026-11-09T12:00:00.123400+02:30";
    const second = "2026-11-10T12:00:00.123400-02:30";
    const f = fixture(`[[${firstKey}]]\nstamp = ${first}\n[[${secondKey}]]\nstamp = ${second}\n`);
    const before = f.read();
    enforceKimiSessionDenyPolicy(f.brand);
    expect(f.read()).toEqual({ ...before, permission: { rules: [KIMI_SESSION_DENY_RULE] } });
    expect(readFileSync(f.path, "utf8")).toContain(`[{ "stamp" = ${first} }, { "stamp" = ${second} }]`);
  });

  test("date-shaped inline and dotted keys remain keys across nested value contexts", () => {
    const first = "2026-11-09T12:00:00.123400+02:30";
    const second = "2026-11-10T12:00:00.123400-02:30";
    const f = fixture([
      `2026-11-09.first = ${first}`,
      `"2026-11-09".second = ${second}`,
      `inline = { 2026-11-09.first = ${first}, "2026-11-09".second = ${second} }`,
      `nested = [`,
      `  [${first}, { 2026-11-09 = ${second} }], # array continues`,
      `  { stamp = ${first}, dates = [${second}] },`,
      `]`,
      `after = ${first}`,
      "",
    ].join("\n"));
    const before = f.read();
    enforceKimiSessionDenyPolicy(f.brand);
    expect(f.read()).toEqual({ ...before, permission: { rules: [KIMI_SESSION_DENY_RULE] } });
    const written = readFileSync(f.path, "utf8");
    expect(written).toContain(`"first" = ${first}, "second" = ${second}`);
    expect(written).toContain(`"2026-11-09" = ${second}`);
    expect(written).toContain(`"after" = ${first}`);
  });

  test("an unfinished table fails without replacing the config", () => {
    const contents = '[permission\n';
    const f = fixture(contents);
    expect(() => enforceKimiSessionDenyPolicy(f.brand)).toThrow("TOML Parse error");
    expect(readFileSync(f.path, "utf8")).toBe(contents);
  });

  test("first-turn generation drops operator policy and preserves consumer policy before appending", () => {
    const operator = fixture('[permission]\nrules = [{ decision = "allow", pattern = "*" }]\n');
    const consumer = fixture('[permission]\nrules = [{ decision = "ask", pattern = "Bash" }]\n');
    writeKimiSessionHermeticConfig(consumer.brand, operator.brand);
    enforceKimiSessionDenyPolicy(consumer.brand);
    expect(consumer.read().permission.rules).toEqual([
      { decision: "ask", pattern: "Bash" }, KIMI_SESSION_DENY_RULE,
    ]);
    expect(operator.read().permission.rules).toEqual([{ decision: "allow", pattern: "*" }]);
  });

  test("first-turn generation preserves a consumer datetime before adding deny", () => {
    const literal = "2026-11-09T12:00:00.123400-02:30";
    const consumer = fixture(`[permission]\nreviewed_at = ${literal}\nrules = []\n`);
    writeKimiSessionHermeticConfig(consumer.brand, null);
    enforceKimiSessionDenyPolicy(consumer.brand);
    expect(readFileSync(consumer.path, "utf8")).toContain(`"reviewed_at" = ${literal}`);
    expect(consumer.read().permission.rules).toEqual([KIMI_SESSION_DENY_RULE]);
  });

  test.each([false, true])("unparseable consumer config refuses before spawning (resumed=%s)", async (resumed) => {
    const contents = '[permission\n';
    const f = fixture(contents);
    const events: Record<string, unknown>[] = [];
    let spawns = 0;
    const driver = new KimiSessionDriver({
      resumeSessionId: resumed ? ID : null,
      autonomy: "high", permissionPolicy: "deny", cwd: f.dir, hermetic: true,
      sandboxed: true, sandboxTrust: "standard", sandboxNoNet: false, sandboxScrubEnv: false,
      passEnv: [], authorPrefix: true, sessionTimeoutMs: null, registryPath: null,
      harnessHome: f.brand, providerBaseUrl: null, hermeticSourceHome: null,
      privateHome: {
        dir: f.dir, resumed, settled: resumed, blockedPaths: [],
        settle() { throw new Error("a refused fresh session must not settle"); },
        remove() { throw new Error("a refused config must remain available"); },
      },
      spawnTurn: async () => {
        spawns++;
        throw new Error("unparseable config reached spawn");
      },
      sink: (line) => { events.push(JSON.parse(line) as Record<string, unknown>); },
    });
    try {
      const code = driver.run();
      driver.handleCallerLine(JSON.stringify({ type: "user", text: "synthetic refusal" }));
      expect(await code).toBe(1);
      expect(spawns).toBe(0);
      expect(readFileSync(f.path, "utf8")).toBe(contents);
      expect(events.some((event) => event.type === "error" && String(event.message).includes("TOML Parse error"))).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "session_ended", exit_code: 1 });
    } finally {
      driver.dispose();
    }
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { appendCallRecord, appendLedgerPath, CALL_LOG_ENV, CALL_LOG_TEST_ENV, callLogPath, providerHost, resetCallLogWarningForTests } from "../src/call-log.js";
import { BASE_RECORD, tempEnv } from "./helpers/call-log.js";

afterEach(() => {
  resetCallLogWarningForTests();
});

describe("providerHost", () => {
  test("default for null and unparseable base URLs", () => {
    expect(providerHost(null)).toBe("default");
    expect(providerHost("not a url")).toBe("default");
  });

  test("the override's host, never its key or path", () => {
    expect(providerHost("http://localhost:8011/v1")).toBe("localhost:8011");
    expect(providerHost("https://api.example.com/v1")).toBe("api.example.com");
  });
});

describe("callLogPath", () => {
  test("macOS: the state directory beside the session registry", () => {
    const { env, dir, cleanup } = tempEnv();
    try {
      expect(callLogPath(env, "darwin")).toBe(
        `${dir}/Library/Application Support/codemux/calls.jsonl`
      );
    } finally {
      cleanup();
    }
  });

  test("elsewhere: state under HOME, never $XDG_STATE_HOME (ul2)", () => {
    const { env, dir, cleanup } = tempEnv();
    try {
      expect(callLogPath(env, "linux")).toBe(
        `${dir}/.local/state/codemux/calls.jsonl`
      );
      // The registry's deliberate rule, shared: moving XDG_STATE_HOME
      // must not move the record. Docs must not claim an XDG rule.
      expect(callLogPath({ ...env, XDG_STATE_HOME: "/xdg/elsewhere" }, "linux")).toBe(
        `${dir}/.local/state/codemux/calls.jsonl`
      );
    } finally {
      cleanup();
    }
  });

  test("CODEMUX_CALL_LOG relocates; a relative value resolves against cwd", () => {
    const { env, cleanup } = tempEnv();
    try {
      expect(callLogPath({ ...env, [CALL_LOG_ENV]: "/elsewhere/ledger.jsonl" }, "darwin")).toBe(
        "/elsewhere/ledger.jsonl"
      );
      expect(callLogPath({ ...env, [CALL_LOG_ENV]: "rel/ledger.jsonl" }, "darwin")).toBe(
        join(process.cwd(), "rel", "ledger.jsonl")
      );
    } finally {
      cleanup();
    }
  });

  test("CODEMUX_CALL_LOG=off disables the ledger", () => {
    const { env, cleanup } = tempEnv();
    try {
      expect(callLogPath({ ...env, [CALL_LOG_ENV]: "off" }, "darwin")).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("appendLedgerPath", () => {
  test("an explicit CODEMUX_CALL_LOG keeps its word; off disables", () => {
    const { env, cleanup } = tempEnv();
    try {
      expect(appendLedgerPath({ ...env, [CALL_LOG_ENV]: "/elsewhere/ledger.jsonl" })).toBe(
        "/elsewhere/ledger.jsonl"
      );
      expect(appendLedgerPath({ ...env, [CALL_LOG_ENV]: "off" })).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("CODEMUX_TEST_LEDGER redirects appends; CODEMUX_CALL_LOG outranks it (ul4)", () => {
    const { env, dir, cleanup } = tempEnv();
    try {
      const testLedger = join(dir, "test-calls.jsonl");
      // The redirect codemux's own test preload sets (tests/setup.ts) — a
      // name codemux owns, consulted only when CODEMUX_CALL_LOG is unset.
      expect(appendLedgerPath({ ...env, [CALL_LOG_TEST_ENV]: testLedger })).toBe(testLedger);
      // An operator's explicit relocation outranks the test redirect...
      expect(
        appendLedgerPath({
          ...env,
          [CALL_LOG_TEST_ENV]: testLedger,
          [CALL_LOG_ENV]: join(dir, "real.jsonl"),
        })
      ).toBe(join(dir, "real.jsonl"));
      // ...and so does "off".
      expect(
        appendLedgerPath({ ...env, [CALL_LOG_TEST_ENV]: testLedger, [CALL_LOG_ENV]: "off" })
      ).toBeNull();
      // An append with only the redirect lands there, never the HOME
      // state directory.
      appendCallRecord(
        { ...BASE_RECORD, duration_ms: 434343 },
        { ...env, [CALL_LOG_TEST_ENV]: testLedger }
      );
      expect(() => statSync(callLogPath(env)!)).toThrow();
      const lines = readFileSync(testLedger, "utf8").split("\n").filter((line) => line !== "");
      expect(JSON.parse(lines[lines.length - 1]!).duration_ms).toBe(434343);
    } finally {
      cleanup();
    }
  });

  test("a generic NODE_ENV=test never diverts an operator's records (ul4)", () => {
    const { env, cleanup } = tempEnv();
    try {
      // The old detection keyed on NODE_ENV=test, so any process outside
      // codemux's test runner that exported it had its real records
      // silently dropped into a deleted temp file. The default state
      // directory is what resolves now, and the record lands there.
      const operatorish = { ...env, NODE_ENV: "test" };
      expect(appendLedgerPath(operatorish)).toBe(callLogPath(operatorish));
      appendCallRecord({ ...BASE_RECORD, duration_ms: 444444 }, operatorish);
      const lines = readFileSync(callLogPath(operatorish)!, "utf8")
        .split("\n")
        .filter((line) => line !== "");
      expect(JSON.parse(lines[lines.length - 1]!).duration_ms).toBe(444444);
    } finally {
      cleanup();
    }
  });

  test("appendCallRecord never throws, path resolution included (ul4)", () => {
    const { env, cleanup } = tempEnv();
    try {
      // A non-string value in the environment makes the resolution itself
      // throw (`trim` of a number, `trim` of a number HOME) — inside the
      // never-throw guard now, so the run hears one warning and proceeds.
      expect(() =>
        appendCallRecord(BASE_RECORD, { ...env, [CALL_LOG_ENV]: 5 as unknown as string })
      ).not.toThrow();
      expect(() =>
        appendCallRecord(BASE_RECORD, { ...env, HOME: 7 as unknown as string })
      ).not.toThrow();
    } finally {
      cleanup();
    }
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendCallRecord,
  appendLedgerPath,
  appendSessionCallRecord,
  appendSessionTurnCallRecord,
  CALL_LOG_ENV,
  CALL_LOG_TEST_ENV,
  callLogPath,
  MAX_CALL_LOG_BYTES,
  providerHost,
  readCallLog,
  resetCallLogWarningForTests,
  sanitizeReportedString,
} from "../src/call-log.js";
import { emptyUsage } from "../src/result-envelope.js";

function tempEnv(extra: Record<string, string> = {}): {
  env: NodeJS.ProcessEnv;
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "codemux-call-log-test-"));
  return {
    env: { HOME: dir, ...extra },
    dir,
    cleanup: () => {
      try {
        chmodSync(dir, 0o755);
      } catch {
        // already gone
      }
    },
  };
}

const BASE_RECORD = {
  ts: "2026-10-08T12:00:00.000Z",
  kind: "run" as const,
  agent: "claude" as const,
  model: null,
  model_effective: null,
  provider: "default",
  session_id: null,
  turn_id: null,
  autonomy: "read-only" as const,
  hermetic: false,
  sandboxed: false,
  exit_code: 0,
  finish: null,
  duration_ms: 5,
  cwd: "/tmp",
  usage: emptyUsage(),
};

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

describe("appendCallRecord", () => {
  test("one JSON line per record, modes 0700/0600", () => {
    const { env, dir, cleanup } = tempEnv();
    try {
      const path = join(dir, "calls.jsonl");
      const withPath = { ...env, [CALL_LOG_ENV]: path };
      appendCallRecord({ ...BASE_RECORD, agent: "zai" }, withPath);
      appendCallRecord({ ...BASE_RECORD, agent: "codex" }, withPath);
      const text = readFileSync(path, "utf8");
      const lines = text.split("\n");
      expect(lines).toHaveLength(3); // two records plus the trailing newline
      expect(lines[2]).toBe("");
      expect(JSON.parse(lines[0]!).agent).toBe("zai");
      expect(JSON.parse(lines[1]!).agent).toBe("codex");
      expect((statSync(dir).mode & 0o777) & 0o077).toBe(0);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      cleanup();
    }
  });

  test("an existing file with wider permissions is tightened", () => {
    const { env, dir, cleanup } = tempEnv();
    try {
      const path = join(dir, "calls.jsonl");
      writeFileSync(path, "", { mode: 0o644 });
      chmodSync(path, 0o666);
      appendCallRecord(BASE_RECORD, { ...env, [CALL_LOG_ENV]: path });
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      cleanup();
    }
  });

  test("a relocated ledger never tightens an existing directory (ul2)", () => {
    // The operator names a shared directory (the /tmp shape): mode 0777,
    // chmod not even attempted — the old code chmodSync'd it (EPERM on a
    // directory the user does not own) and the ledger stayed empty.
    const { env, dir, cleanup } = tempEnv();
    try {
      const shared = join(dir, "shared");
      mkdirSync(shared, { mode: 0o777 });
      chmodSync(shared, 0o777);
      const path = join(shared, "calls.jsonl");
      appendCallRecord(BASE_RECORD, { ...env, [CALL_LOG_ENV]: path });
      expect(statSync(shared).mode & 0o777).toBe(0o777);
      expect(JSON.parse(readFileSync(path, "utf8")).kind).toBe("run");
    } finally {
      cleanup();
    }
  });

  test("the default state directory arriving wider is still tightened (ul2)", () => {
    const { env, cleanup } = tempEnv();
    try {
      const stateDir = dirname(callLogPath(env)!);
      mkdirSync(stateDir, { recursive: true, mode: 0o777 });
      chmodSync(stateDir, 0o777);
      // The one existing directory codemux may tighten. The env var names
      // the default path itself so the append bypasses the
      // CODEMUX_TEST_LEDGER redirect and exercises the real
      // default-directory rule.
      appendCallRecord(BASE_RECORD, { ...env, [CALL_LOG_ENV]: join(stateDir, "calls.jsonl") });
      expect(statSync(stateDir).mode & 0o777).toBe(0o700);
      expect(JSON.parse(readFileSync(join(stateDir, "calls.jsonl"), "utf8")).kind).toBe("run");
    } finally {
      cleanup();
    }
  });

  test("a directory swapped for a symlink is not chmod'd through its link (ul2)", () => {
    const { env, dir, cleanup } = tempEnv();
    try {
      const target = join(dir, "target");
      mkdirSync(target, { mode: 0o777 });
      chmodSync(target, 0o777);
      const link = join(dir, "link");
      symlinkSync(target, link);
      const path = join(link, "calls.jsonl");
      appendCallRecord(BASE_RECORD, { ...env, [CALL_LOG_ENV]: path });
      // lstat saw a symlink, so the target keeps its permissions.
      expect(statSync(target).mode & 0o777).toBe(0o777);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8")).kind).toBe("run");
    } finally {
      cleanup();
    }
  });

  test("off writes nothing, silently", () => {
    const { env, dir, cleanup } = tempEnv();
    try {
      appendCallRecord(BASE_RECORD, { ...env, [CALL_LOG_ENV]: "off" });
      // Nothing was created under the default state rule either.
      const statePath = callLogPath(env, "darwin")!;
      expect(() => statSync(statePath)).toThrow();
      expect(dir).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  test("a non-regular file is refused with one stderr warning and no throw", () => {
    const { env, dir, cleanup } = tempEnv();
    const target = join(dir, "real.jsonl");
    writeFileSync(target, "");
    const link = join(dir, "link.jsonl");
    symlinkSync(target, link);
    const warnings: string[] = [];
    const original = console.error;
    console.error = (message: string) => warnings.push(message);
    try {
      appendCallRecord(BASE_RECORD, { ...env, [CALL_LOG_ENV]: link });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("not a regular file");
      // Warn once: a second failure stays silent.
      appendCallRecord(BASE_RECORD, { ...env, [CALL_LOG_ENV]: link });
      expect(warnings).toHaveLength(1);
    } finally {
      console.error = original;
      cleanup();
    }
  });

  test("a symlinked ledger path is refused by the open itself, never written through (ul5)", () => {
    // The ul5 window: the path was lstat-checked, then opened, so a link
    // swapped in between was followed to its target. The open now refuses
    // a final symlink (O_NOFOLLOW, ELOOP) and fstats the open descriptor
    // before any write — there is no check-then-open gap left to race.
    const { env, dir, cleanup } = tempEnv();
    try {
      const target = join(dir, "real.jsonl");
      writeFileSync(target, "sentinel\n");
      const link = join(dir, "link.jsonl");
      symlinkSync(target, link);
      const warnings: string[] = [];
      const original = console.error;
      console.error = (message: string) => warnings.push(message);
      try {
        appendCallRecord(BASE_RECORD, { ...env, [CALL_LOG_ENV]: link });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("not a regular file");
      } finally {
        console.error = original;
      }
      // Nothing was written through the link: the target is untouched.
      expect(readFileSync(target, "utf8")).toBe("sentinel\n");
    } finally {
      cleanup();
    }
  });

  test("a special file that opens is refused by the descriptor check before any write (ul5)", () => {
    // /dev/null opens for writing (O_NONBLOCK makes a FIFO fail ENXIO
    // instead of hanging), but fstat on the open descriptor says it is
    // not a regular file — the record is refused before the write.
    const { env, cleanup } = tempEnv();
    const warnings: string[] = [];
    const original = console.error;
    console.error = (message: string) => warnings.push(message);
    try {
      appendCallRecord(BASE_RECORD, { ...env, [CALL_LOG_ENV]: "/dev/null" });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("not a regular file");
    } finally {
      console.error = original;
      cleanup();
    }
  });

  test("a write failure warns once on stderr and never throws", () => {
    const { env, dir, cleanup } = tempEnv();
    const warnings: string[] = [];
    const original = console.error;
    console.error = (message: string) => warnings.push(message);
    try {
      // The ledger sits under a path whose parent is a regular file:
      // mkdirSync fails with ENOTDIR before any file is opened.
      const blocker = join(dir, "blocker");
      writeFileSync(blocker, "");
      appendCallRecord(BASE_RECORD, { ...env, [CALL_LOG_ENV]: join(blocker, "calls.jsonl") });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("could not append to the call log");
      appendCallRecord(BASE_RECORD, { ...env, [CALL_LOG_ENV]: join(blocker, "calls.jsonl") });
      expect(warnings).toHaveLength(1);
    } finally {
      console.error = original;
      cleanup();
    }
  });

  test("concurrent appends never interleave half-lines", async () => {
    const { env, dir, cleanup } = tempEnv();
    try {
      const path = join(dir, "calls.jsonl");
      const withPath = { ...env, [CALL_LOG_ENV]: path };
      const writers = Array.from({ length: 8 }, (_, processIndex) =>
        Promise.resolve().then(() => {
          // Separate processes in the wild; same-process synchronous
          // appends exercise the same one-write-per-line discipline.
          for (let i = 0; i < 50; i++) {
            appendCallRecord(
              { ...BASE_RECORD, duration_ms: processIndex * 1000 + i },
              withPath
            );
          }
        })
      );
      await Promise.all(writers);
      const lines = readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
      expect(lines).toHaveLength(400);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
        expect(JSON.parse(line).kind).toBe("run");
      }
    } finally {
      cleanup();
    }
  });

  test("harness-reported strings are stored stripped of escapes and controls (ul6)", () => {
    // A model name an endpoint reported can carry terminal controls (a
    // provider override serves any model string it likes); stored raw,
    // they replay into the operator's terminal on every view. The append
    // seam strips ANSI sequences first (their bodies are printable), then
    // every C0/C1 control and DEL.
    const { env, dir, cleanup } = tempEnv();
    try {
      const path = join(dir, "calls.jsonl");
      appendCallRecord(
        {
          ...BASE_RECORD,
          model: "claude-\x1b[31mopus",
          model_effective: "claude-\x1b[31mopus\x1b[0m",
          provider: "local\x07host:8011",
          finish: "end\r\ninjected",
        },
        { ...env, [CALL_LOG_ENV]: path }
      );
      const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(stored["model"]).toBe("claude-opus");
      expect(stored["model_effective"]).toBe("claude-opus");
      // DEL and C1 controls go too; the provider host never carries one.
      expect(stored["provider"]).toBe("localhost:8011");
      // A newline inside a field would forge a second ledger line's worth
      // of terminal output; it is a control character and goes with them.
      expect(stored["finish"]).toBe("endinjected");
      // C1 (U+0080-U+009F) and DEL (U+007F) are stripped like C0.
      expect(sanitizeReportedString("a\u009bb\u007fc")).toBe("abc");
      expect(sanitizeReportedString(null)).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("readCallLog", () => {
  test("a line without the record's full shape is malformed, never a record (ul2)", () => {
    const { dir, cleanup } = tempEnv();
    try {
      const path = join(dir, "calls.jsonl");
      const good = JSON.stringify(BASE_RECORD);
      const lines = [
        // Parses as JSON, names ts/agent/kind — the old lenient check
        // accepted it, and the table's usage columns crashed on the
        // missing block.
        JSON.stringify({ ts: "2026-10-08T12:00:00.000Z", agent: "claude", kind: "run" }),
        // A usage block with a wrong-typed count is equally malformed.
        JSON.stringify({ ...BASE_RECORD, usage: { input_tokens: "many" } }),
        // So is a kind outside the record set.
        JSON.stringify({ ...BASE_RECORD, kind: "greeting" }),
        good,
      ].join("\n") + "\n";
      writeFileSync(path, lines);
      const log = readCallLog(path);
      expect(log.malformed).toBe(3);
      expect(log.entries).toHaveLength(4);
      expect(log.entries[3]!.record?.kind).toBe("run");
      expect(log.entries[0]!.record).toBeNull();
      expect(log.entries[1]!.record).toBeNull();
      expect(log.entries[2]!.record).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("corrupt lines are skipped and counted, never fatal", () => {
    const { env, dir, cleanup } = tempEnv();
    try {
      const path = join(dir, "calls.jsonl");
      const withPath = { ...env, [CALL_LOG_ENV]: path };
      appendCallRecord(BASE_RECORD, withPath);
      appendCallRecord({ ...BASE_RECORD, agent: "zai" }, withPath);
      const good = readFileSync(path, "utf8");
      writeFileSync(path, `not json\n${good}{bad json\n`);
      const log = readCallLog(path);
      expect(log.malformed).toBe(2);
      // Entries carry every line, parsed or not: the two corrupt lines
      // ride along with record null, skipped — never fatal.
      expect(log.entries).toHaveLength(4);
      expect(log.entries[0]!.line).toBe("not json");
      expect(log.entries[0]!.record).toBeNull();
      expect(log.entries[1]!.record?.agent).toBe("claude");
      expect(log.entries[2]!.record?.agent).toBe("zai");
      expect(log.entries[3]!.line).toBe("{bad json");
      expect(log.entries[3]!.record).toBeNull();
      expect(log.truncated).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("invalid UTF-8 never throws: the broken line lands in malformed (ul5)", () => {
    // The ul5 contracts defect: the docstring claimed a throw on invalid
    // UTF-8, but the decode is non-fatal — the bytes become replacement
    // characters and the line is malformed like any corrupt one. The
    // comment states that now, and this pins the behavior it states.
    const { dir, cleanup } = tempEnv();
    try {
      const path = join(dir, "calls.jsonl");
      writeFileSync(
        path,
        Buffer.concat([
          Buffer.from("clau"),
          Buffer.from([0xff, 0xfe]), // invalid UTF-8 mid-line
          Buffer.from("der\n"),
        ])
      );
      let log: ReturnType<typeof readCallLog> | undefined;
      expect(() => {
        log = readCallLog(path);
      }).not.toThrow();
      expect(log!.malformed).toBe(1);
      expect(log!.entries).toHaveLength(1);
      expect(log!.entries[0]!.record).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("a file larger than 16 MiB reads only its bounded tail", () => {
    const { dir, cleanup } = tempEnv();
    try {
      const path = join(dir, "calls.jsonl");
      const filler = "x".repeat(1024);
      const chunk = `${JSON.stringify({ ...BASE_RECORD, model: filler })}\n`;
      const chunkCount = Math.floor((MAX_CALL_LOG_BYTES + 1024 * 1024) / chunk.length) + 1;
      const handle = Bun.file(path).writer();
      for (let i = 0; i < chunkCount; i++) {
        handle.write(chunk);
      }
      // The newest record is identifiable: appended after the filler.
      handle.write(`${JSON.stringify({ ...BASE_RECORD, agent: "aider" })}\n`);
      handle.end();
      const log = readCallLog(path);
      expect(log.truncated).toBe(true);
      expect(statSync(path).size).toBeGreaterThan(MAX_CALL_LOG_BYTES);
      // The first entry starts at a line boundary (the partial line the
      // bounded read cut was dropped), and the newest record survived.
      expect(() => JSON.parse(log.entries[0]!.line)).not.toThrow();
      const last = log.entries[log.entries.length - 1]!;
      expect(last.record?.agent).toBe("aider");
    } finally {
      cleanup();
    }
  });

  test("a cut landing exactly on a record boundary keeps the complete record there (ul6)", () => {
    // The regression: the tail read always dropped through the first
    // newline, so a window whose cut fell exactly BETWEEN two records
    // (the byte before the cut a newline) discarded one complete record
    // with the partial one it never was. Built so the window is exactly
    // 4096 records of 4096 bytes behind 8192 bytes of junk: the cut lands
    // on the first record's leading byte.
    const { dir, cleanup } = tempEnv();
    try {
      const path = join(dir, "calls.jsonl");
      const recordSize = 4096;
      const count = MAX_CALL_LOG_BYTES / recordSize; // 4096 exact records
      // The model field pads the line to exactly recordSize bytes.
      const bare = `${JSON.stringify({ ...BASE_RECORD, model: "" })}\n`;
      const model = "m".repeat(recordSize - bare.length);
      const chunk = `${JSON.stringify({ ...BASE_RECORD, model })}\n`;
      expect(Buffer.byteLength(chunk)).toBe(recordSize);
      const junkSize = 8192;
      const handle = Bun.file(path).writer();
      // Junk ends with a newline, so the byte before the cut is one and
      // the window begins with a complete record.
      handle.write(`${"j".repeat(junkSize - 1)}\n`);
      for (let i = 0; i < count; i++) {
        handle.write(chunk);
      }
      handle.end();
      expect(statSync(path).size).toBe(junkSize + MAX_CALL_LOG_BYTES);
      const log = readCallLog(path);
      expect(log.truncated).toBe(true);
      expect(log.malformed).toBe(0);
      // Every record survived — none dropped for the bound.
      expect(log.entries).toHaveLength(count);
      expect(log.entries[0]!.record?.model).toBe(model);
      expect(log.entries[count - 1]!.record?.model).toBe(model);
    } finally {
      cleanup();
    }
  });

  test("a cut landing inside a line still drops the partial line (ul6)", () => {
    // The boundary rule's other half: junk with no trailing newline merges
    // with the first record into one line that starts before the window,
    // so that line was cut by the read and is dropped as before. The
    // records whose lines begin inside the window all survive.
    const { dir, cleanup } = tempEnv();
    try {
      const path = join(dir, "calls.jsonl");
      const recordSize = 4096;
      const count = MAX_CALL_LOG_BYTES / recordSize;
      const bare = `${JSON.stringify({ ...BASE_RECORD, model: "" })}\n`;
      const model = "m".repeat(recordSize - bare.length);
      const chunk = `${JSON.stringify({ ...BASE_RECORD, model })}\n`;
      const junkSize = 8192;
      const handle = Bun.file(path).writer();
      // No trailing newline: the first record's line begins with the junk,
      // before the cut, and the window sees only its tail.
      handle.write("j".repeat(junkSize));
      for (let i = 0; i < count; i++) {
        handle.write(chunk);
      }
      handle.end();
      expect(statSync(path).size).toBe(junkSize + MAX_CALL_LOG_BYTES);
      const log = readCallLog(path);
      expect(log.truncated).toBe(true);
      expect(log.malformed).toBe(0);
      // The merged junk+first-record line is the partial one dropped;
      // every later record survived whole.
      expect(log.entries).toHaveLength(count - 1);
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

describe("session records", () => {
  test("a turn record and a closing session record with the cumulative usage", () => {
    const { env, dir, cleanup } = tempEnv();
    try {
      const withPath = { ...env, [CALL_LOG_ENV]: join(dir, "calls.jsonl") };
      const context = {
        agent: "codex" as const,
        model: "g-5",
        provider: "default",
        autonomy: "low" as const,
        hermetic: false,
        sandboxed: true,
        cwd: "/repo",
      };
      const usage = {
        ...emptyUsage(),
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
      };
      appendSessionTurnCallRecord(
        context, "sess-1", "t1", Date.now() - 4000, "end", usage, withPath
      );
      appendSessionCallRecord(
        context, "sess-1", Date.now() - 9000, "stdin-close", 0, usage, withPath
      );
      const log = readCallLog(join(dir, "calls.jsonl"));
      expect(log.entries).toHaveLength(2);
      const turn = log.entries[0]!.record!;
      expect(turn.kind).toBe("session_turn");
      expect(turn.session_id).toBe("sess-1");
      expect(turn.turn_id).toBe("t1");
      expect(turn.finish).toBe("end");
      expect(turn.exit_code).toBeNull();
      expect(turn.model).toBe("g-5");
      expect(turn.model_effective).toBeNull();
      expect(turn.usage.input_tokens).toBe(11);
      expect(turn.duration_ms).toBeGreaterThanOrEqual(4000);
      const session = log.entries[1]!.record!;
      expect(session.kind).toBe("session");
      expect(session.turn_id).toBeNull();
      expect(session.finish).toBe("stdin-close");
      expect(session.exit_code).toBe(0);
      expect(session.usage.total_tokens).toBe(18);
    } finally {
      cleanup();
    }
  });
});

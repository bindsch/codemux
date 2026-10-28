import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendCallRecord, appendSessionCallRecord, appendSessionTurnCallRecord, CALL_LOG_ENV, callLogPath, readCallLog, resetCallLogWarningForTests, sanitizeReportedString } from "../src/call-log.js";
import { emptyUsage } from "../src/result-envelope.js";
import { BASE_RECORD, tempEnv } from "./helpers/call-log.js";

afterEach(() => {
  resetCallLogWarningForTests();
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

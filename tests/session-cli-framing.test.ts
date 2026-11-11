/**
 * Caller-stdin framing (split from tests/session-cli.test.ts): the
 * oversized-line rejection end to end, and the pure framer unit tests.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frameCallerStdin } from "../src/session/cli.js";
import { MAX_INPUT_LINE_BYTES } from "../src/session/process.js";
import { fakeClaudeEnv } from "./helpers/session-cli.js";

describe("CLI - caller-stdin framing", () => {
  test("an oversized line's remainder is discarded, not parsed as the next command", async () => {
    // M1: one physical line of 17 MiB + 1 byte whose tail contains a
    // shutdown command. The rejection fires exactly once and the
    // shutdown — part of the rejected line — never executes; the session
    // ends on the stdin close that follows.
    const fake = fakeClaudeEnv();
    const isolatedHome = mkdtempSync(join(tmpdir(), "codemux-session-oversize-"));
    const workdir = join(isolatedHome, "work");
    mkdirSync(workdir);
    try {
      const proc = Bun.spawn(
        [
          join(import.meta.dir, "..", "bin", "codemux"),
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--shutdown-grace", "2",
        ],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
          stdin: "pipe",
          env: {
            ...process.env,
            CODEMUX_NO_KEYCHAIN_SYNC: "1",
            HOME: isolatedHome,
            XDG_CONFIG_HOME: join(isolatedHome, ".config"),
            ...fake.env,
          } as Record<string, string>,
        }
      );
      const events: Record<string, any>[] = [];
      const stdoutDone = (async () => {
        const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.trim() !== "") events.push(JSON.parse(line) as Record<string, any>);
            newline = buffer.indexOf("\n");
          }
        }
      })();
      const oversized =
        "x".repeat(17 * 1024 * 1024 + 1) + " " + JSON.stringify({ type: "shutdown" }) + "\n";
      proc.stdin!.write(oversized);
      proc.stdin!.end();
      const [exitCode] = await Promise.all([proc.exited, stdoutDone]);
      const rejections = events.filter((event) => event.type === "input_rejected");
      expect(rejections).toHaveLength(1);
      expect(rejections[0]?.reason).toBe("malformed");
      const ended = events[events.length - 1] as Record<string, any> | undefined;
      expect(ended?.type).toBe("session_ended");
      // The shutdown inside the rejected line never ran: the end is the
      // stdin close, not a shutdown command.
      expect(ended?.reason).toBe("stdin-close");
      expect(exitCode).toBe(0);
    } finally {
      fake.cleanup();
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });
});

/** A minimal stdin-shaped input the framer tests drive by hand: no real
 * pipe, no timing — the framing is pure computation. */
class StubInput {
  private dataListener: ((chunk: Buffer) => void) | null = null;
  private endListener: (() => void) | null = null;
  private errorListener: ((error: unknown) => void) | null = null;

  on(_event: "data", listener: (chunk: Buffer) => void): unknown {
    this.dataListener = listener;
    return this;
  }

  once(event: "end" | "error", listener: (error: unknown) => void): unknown {
    if (event === "end") this.endListener = listener as () => void;
    else this.errorListener = listener;
    return this;
  }

  removeListener(event: "data" | "end" | "error", _listener: unknown): unknown {
    if (event === "data") this.dataListener = null;
    else if (event === "end") this.endListener = null;
    else this.errorListener = null;
    return this;
  }

  emitData(chunk: Buffer): void {
    this.dataListener?.(chunk);
  }

  emitEnd(): void {
    this.endListener?.();
  }

  emitError(error: unknown): void {
    this.errorListener?.(error);
  }
}

describe("CLI - caller stdin framing", () => {
  test("frames lines, strips the CR, skips blanks, delivers the tail on end, and unframes cleanly", () => {
    const lines: string[] = [];
    let ends = 0;
    const input = new StubInput();
    const unframe = frameCallerStdin(
      {
        handleCallerLine: (line: string) => lines.push(line),
        handleCallerEnd: () => {
          ends += 1;
        },
      },
      input
    );
    // One chunk, three complete lines: a CR that belongs to the framing,
    // a blank line, and a plain third.
    input.emitData(Buffer.from("one\r\ntwo\n\nthree\n"));
    expect(lines).toEqual(["one", "two", "three"]);
    // The tail stays buffered until the stream ends.
    input.emitData(Buffer.from("tail"));
    expect(lines).toEqual(["one", "two", "three"]);
    input.emitEnd();
    expect(lines).toEqual(["one", "two", "three", "tail"]);
    expect(ends).toBe(1);
    // Nothing after unframe: the listeners came off.
    unframe();
    input.emitData(Buffer.from("gone\n"));
    input.emitEnd();
    expect(lines).toEqual(["one", "two", "three", "tail"]);
    expect(ends).toBe(1);
  });

  test("a read error is reported as a failure, never as a clean end (review live17)", () => {
    // Review live17, correctness major: `error` ran the same handler as
    // `end`, so a broken caller pipe ended the session "stdin-close" with
    // exit 0. The driver now hears the error itself, the partial tail is
    // not delivered (it may be a fragment), and a later `end` is ignored.
    const lines: string[] = [];
    const ends: unknown[] = [];
    const input = new StubInput();
    frameCallerStdin(
      {
        handleCallerLine: (line: string) => lines.push(line),
        handleCallerEnd: (error?: unknown) => {
          ends.push(error);
        },
      },
      input
    );
    input.emitData(Buffer.from("one\npartial"));
    const failure = new Error("EIO: i/o error, read");
    input.emitError(failure);
    input.emitEnd();
    expect(lines).toEqual(["one"]);
    expect(ends).toEqual([failure]);
  });

  test("data after a read error delivers no line and no second end (review round 169)", () => {
    // The error leaves the data listener behind, so a complete line that
    // arrived after the failure was parsed as a command even though the
    // driver had already heard the end. One end, carried by the error;
    // the later line never reaches the driver.
    const lines: string[] = [];
    const ends: unknown[] = [];
    const input = new StubInput();
    frameCallerStdin(
      {
        handleCallerLine: (line: string) => lines.push(line),
        handleCallerEnd: (error?: unknown) => {
          ends.push(error);
        },
      },
      input
    );
    const failure = new Error("EIO: i/o error, read");
    input.emitError(failure);
    input.emitData(Buffer.from("late-command\n"));
    expect(lines).toEqual([]);
    expect(ends).toEqual([failure]);
  });

  test("a complete line past the cap is rejected even when its newline shares the chunk (review live18)", () => {
    // Review live18, minor: the cap was checked only while the buffer held
    // no newline, so a line just under the cap followed by one chunk that
    // carried both the overflow and the newline was delivered whole.
    const lines: string[] = [];
    const input = new StubInput();
    frameCallerStdin(
      {
        handleCallerLine: (line: string) => lines.push(line),
        handleCallerEnd: () => {},
      },
      input
    );
    input.emitData(Buffer.alloc(MAX_INPUT_LINE_BYTES - 10, 0x61));
    expect(lines).toEqual([]);
    input.emitData(Buffer.concat([Buffer.alloc(100, 0x61), Buffer.from("\nnext\n")]));
    // The over-cap line reaches the driver as the rejection sentinel, the
    // next line is intact.
    expect(lines).toEqual(["oversize", "next"]);
  });

  test("an exact-cap CRLF line is accepted like its LF twin (round 307)", () => {
    // Delivery strips the trailing CR, and the cap compares the delivered
    // payload: a CRLF line of exactly MAX_INPUT_LINE_BYTES payload bytes
    // used to be rejected as oversized while the same line ending in LF
    // alone was accepted.
    const lines: string[] = [];
    const input = new StubInput();
    frameCallerStdin(
      {
        handleCallerLine: (line: string) => lines.push(line),
        handleCallerEnd: () => {},
      },
      input
    );
    const payload = Buffer.alloc(MAX_INPUT_LINE_BYTES, 0x61);
    input.emitData(Buffer.concat([payload, Buffer.from("\r\nnext\n")]));
    expect(lines).toHaveLength(2);
    expect(lines[0]!.length).toBe(MAX_INPUT_LINE_BYTES);
    expect(lines[1]).toBe("next");
    // One byte over the cap still rejects with or without the CR.
    lines.length = 0;
    input.emitData(
      Buffer.concat([Buffer.alloc(MAX_INPUT_LINE_BYTES + 1, 0x62), Buffer.from("\r\n")])
    );
    expect(lines).toEqual(["oversize"]);
    // The CR in one chunk and the LF in the next (review round 310): the
    // unterminated-run check must not count the CR either.
    lines.length = 0;
    input.emitData(Buffer.concat([Buffer.alloc(MAX_INPUT_LINE_BYTES, 0x63), Buffer.from("\r")]));
    input.emitData(Buffer.from("\nnext\n"));
    expect(lines).toHaveLength(2);
    expect(lines[0]!.length).toBe(MAX_INPUT_LINE_BYTES);
    expect(lines[1]).toBe("next");
  });

  test("a line that is not valid UTF-8 is rejected, never decoded lossily (review live20)", () => {
    // Contracts major 1: the caller framer decoded with Buffer#toString,
    // which substitutes U+FFFD, so a line carrying one bad byte was
    // acked, echoed, and forwarded with its text changed. Decoding is
    // fatal-strict now; the line reaches the driver as the rejection
    // sentinel (answered input_rejected malformed), and the stream goes
    // on. A valid multi-byte character split across chunks still decodes.
    const lines: string[] = [];
    const input = new StubInput();
    frameCallerStdin(
      {
        handleCallerLine: (line: string) => lines.push(line),
        handleCallerEnd: () => {},
      },
      input
    );
    input.emitData(
      Buffer.concat([
        Buffer.from('{"type":"user","text":"a'),
        Buffer.from([0xff]),
        Buffer.from('b"}\n'),
      ])
    );
    // Byte 23 starts the two-byte "é"; the chunk boundary splits it.
    const accented = Buffer.from('{"type":"user","text":"é"}\n');
    input.emitData(accented.subarray(0, 24));
    input.emitData(accented.subarray(24));
    input.emitData(Buffer.from([0x7b, 0xc3]));
    input.emitEnd();
    expect(lines).toEqual(["invalid-utf8", '{"type":"user","text":"é"}', "invalid-utf8"]);
  });

  test("framing large input lines in pipe-sized chunks stays linear, not quadratic", () => {
    // Review live15, the harness-side framer's sibling (process.ts):
    // frameCallerStdin recopied the whole buffer on every chunk
    // (Buffer.concat) and restarted its newline scan from byte 0, so a
    // caller line near the cap arriving in ~64 KiB pipe chunks was
    // quadratic in the line size. The discriminator compares the SAME
    // 12 MiB line delivered in one chunk and in 8 KiB chunks (smaller than
    // a pipe's, to amplify the quadratic term): the linear framer pays
    // about the same CPU either way (one pass over the bytes plus a
    // per-chunk constant), the quadratic one rescans the whole buffer on
    // each of the 1536 chunks (~9 GiB of indexOf). Same bytes, same host,
    // same decode: no absolute bound, so a fast or a slow runner reads the
    // same ratio. Measured 2026-10-07: linear 2.2 ms whole / 2.6 ms
    // chunked; with `searchFrom = 0` reinstated in `deliver` (the
    // quadratic restart) 165 ms chunked — 60x, against a 4x bound.
    const line = Buffer.concat([Buffer.alloc(12 * 1024 * 1024, 0x61), Buffer.from("\n")]);
    const frameCpuMs = (chunkBytes: number): number => {
      const lines: string[] = [];
      const input = new StubInput();
      frameCallerStdin(
        { handleCallerLine: (text: string) => lines.push(text), handleCallerEnd: () => {} },
        input
      );
      const started = process.cpuUsage();
      for (let offset = 0; offset < line.length; offset += chunkBytes) {
        input.emitData(line.subarray(offset, Math.min(offset + chunkBytes, line.length)));
      }
      const spent = process.cpuUsage(started);
      input.emitEnd();
      expect(lines).toHaveLength(1);
      expect(lines[0]?.length).toBe(12 * 1024 * 1024);
      return (spent.user + spent.system) / 1000;
    };
    const best = (chunkBytes: number): number =>
      Math.min(...Array.from({ length: 3 }, () => frameCpuMs(chunkBytes)));
    const whole = best(line.length);
    const chunkBytes = 8 * 1024;
    const chunked = best(chunkBytes);
    // The bound allows the per-chunk constant: 2026-11-11 the macOS CI
    // runner paid about 20 us per emitted chunk (32.3 ms chunked against
    // 4.8 ms whole, 1536 chunks), which overran a flat 4x + 10 ms bound
    // although the framer was linear. 50 us per chunk adds 77 ms; the
    // quadratic restart costs 165 ms here and more on a slower runner.
    const chunks = Math.ceil(line.length / chunkBytes);
    expect(chunked).toBeLessThan(4 * whole + 10 + chunks * 0.05);
  }, 60_000);
});


/**
 * The resume claim and the pre-spawn record (split from
 * tests/session-cli.test.ts): concurrent resumes, claim release, and the
 * record written before the harness spawns.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli } from "./helpers/cli.js";
import { readRegistry, sessionRegistryPath } from "../src/session/registry.js";
import { fakeClaudeEnv, seedClaudeRecord } from "./helpers/session-cli.js";

describe("CLI - concurrent resume (review live19)", () => {
  test("a second resume of a claimed id is refused before it spawns a harness", async () => {
    // The claude family records ownership at the init frame, which the
    // harness sends only after the caller's first input. Two resumes of
    // one id both passed the lock-free lookup, both spawned, and both
    // forwarded input; the loser was refused only after its harness had
    // acted on it. The claim now runs before the spawn: while the first
    // resume sits idle (no input, so no init), the second exits 78
    // session_busy and its harness never starts.
    const fake = fakeClaudeEnv();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "codemux-resume-race-")));
    const workdir = join(home, "work");
    mkdirSync(workdir);
    const id = "11111111-2222-3333-4444-555555555555";
    const registryPath = sessionRegistryPath(home);
    let first: ReturnType<typeof Bun.spawn> | null = null;
    try {
      mkdirSync(dirname(registryPath), { recursive: true, mode: 0o700 });
      writeFileSync(
        registryPath,
        `${JSON.stringify({
          version: 1,
          sessions: [
            {
              id,
              agent: "claude",
              created_at: "2026-10-04T10:00:00.000Z",
              last_activity: "2026-10-04T10:05:00.000Z",
              cwd: workdir,
              hermetic: false,
              harness_home: join(home, ".claude"),
              model: null,
              autonomy: "high",
              sandboxed: false,
              sandbox_trust: "standard",
              sandbox_no_net: false,
              sandbox_scrub_env: false,
              pass_env: ["FAKE_CWD", "FAKE_STATE_DIR"],
              playwright_mcp: false,
              owner_pid: 999999,
              owner_start: null,
              ended: "2026-10-04T10:05:00.000Z",
            },
          ],
        })}\n`,
        { mode: 0o600 }
      );
      const args = [
        "session", "-a", "claude", "--no-sandbox", "--auto", "high",
        "--cwd", workdir, "--resume", id, "--shutdown-grace", "2",
        "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
      ];
      first = Bun.spawn([join(import.meta.dir, "..", "bin", "codemux"), ...args], {
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
        stdin: "pipe",
        env: {
          ...process.env,
          CODEMUX_NO_KEYCHAIN_SYNC: "1",
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          ...fake.env,
          FAKE_CWD: workdir,
        } as Record<string, string>,
      });
      const argvLog = join(fake.stateDir, "argv.jsonl");
      const deadline = Date.now() + 15_000;
      while (!existsSync(argvLog) || readFileSync(argvLog, "utf8").trim() === "") {
        if (Date.now() > deadline || first.exitCode !== null) {
          throw new Error(`the first resume never spawned its harness: ${await new Response(first.stderr as ReadableStream).text()}`);
        }
        await Bun.sleep(20);
      }
      const second = await runCli(args, { ...fake.env, HOME: home, FAKE_CWD: workdir }, {
        stdin: `${JSON.stringify({ type: "user", text: "scenario:basic hi" })}\n`,
      });
      expect(second.exitCode).toBe(78);
      expect(second.stderr).toContain("session_busy");
      const spawned = readFileSync(argvLog, "utf8").trim().split("\n");
      expect(spawned).toHaveLength(1);
      const read = readRegistry(registryPath);
      expect(read.outcome).toBe("ok");
      if (read.outcome === "ok") {
        expect(read.file.sessions[0]?.owner_pid).toBe(first.pid);
        expect(read.file.sessions[0]?.ended).toBeNull();
      }
      // The winner runs on: its init frame's start write finds its own
      // claim, so the turn runs and the session ends clean and resumable.
      const winner = first.stdin as import("bun").FileSink;
      winner.write(`${JSON.stringify({ type: "user", text: "scenario:basic hi" })}\n`);
      const reader = (first.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let stdout = "";
      let closed = false;
      while (!stdout.includes('"type":"session_ended"')) {
        const { done, value } = await reader.read();
        if (done) break;
        stdout += decoder.decode(value, { stream: true });
        if (!closed && stdout.includes('"type":"turn_completed"')) {
          closed = true;
          winner.end();
        }
      }
      expect(await first.exited).toBe(0);
      const events = stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
      expect(events.find((event) => event.type === "session_started")?.session_id).toBe(id);
      expect(events.find((event) => event.type === "turn_completed")?.finish).toBe("end");
      expect(events.at(-1)?.type).toBe("session_ended");
      expect(events.at(-1)?.resumable).toBe(true);
      const after = readRegistry(registryPath);
      expect(after.outcome === "ok" && after.file.sessions[0]?.ended !== null).toBe(true);
    } finally {
      if (first !== null && first.exitCode === null) first.kill();
      await first?.exited;
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("CLI - resume claim (review live20)", () => {
  test("a resume that ends before its first turn releases the claim and stays resumable", async () => {
    // The claim stamps this process as owner before the spawn, but the
    // claude driver recorded ownership only at the init frame, which
    // follows the first input. A resume that ended with no input skipped
    // the end stamp (the claim stayed open) and reported resumable false.
    const fake = fakeClaudeEnv();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "codemux-resume-noinput-")));
    const workdir = join(home, "work");
    mkdirSync(workdir);
    const id = "11111111-2222-3333-4444-555555555555";
    try {
      const registryPath = seedClaudeRecord(home, workdir, id, "high");
      const { stdout, stderr, exitCode } = await runCli(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--resume", id, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        { ...fake.env, HOME: home, FAKE_CWD: workdir },
        { stdin: "" }
      );
      expect(exitCode, stderr).toBe(0);
      const events = stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
      expect(events.at(-1)?.type).toBe("session_ended");
      expect(events.at(-1)?.reason).toBe("stdin-close");
      expect(events.at(-1)?.resumable).toBe(true);
      const read = readRegistry(registryPath);
      expect(read.outcome).toBe("ok");
      if (read.outcome === "ok") {
        expect(read.file.sessions[0]?.ended).not.toBeNull();
        expect(read.file.sessions[0]?.ended).not.toBe("2026-10-04T10:05:00.000Z");
      }
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
  test("a resume the harness refuses is not reported resumable (review live21)", async () => {
    // Correctness minor 1: `resumable` was true as soon as the CLI's claim
    // succeeded. A record whose transcript Claude Code already deleted
    // passes every registry guard, the harness exits 1 at startup, and
    // the session still ended `resumable: true`, so a retrying caller
    // repeated the same failure.
    const fake = fakeClaudeEnv();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "codemux-resume-refused-")));
    const workdir = join(home, "work");
    mkdirSync(workdir);
    const id = "22222222-3333-4444-5555-666666666666";
    writeFileSync(join(fake.env.FAKE_STATE_DIR as string, "resume-missing"), "");
    try {
      const registryPath = seedClaudeRecord(home, workdir, id, "high");
      const { stdout, stderr, exitCode } = await runCli(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--resume", id, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        { ...fake.env, HOME: home, FAKE_CWD: workdir },
        // Held open: the harness's own exit must end the session, not EOF.
        { stdin: `${JSON.stringify({ type: "user", text: "hello" })}\n`, holdStdin: true }
      );
      expect(exitCode, stderr).toBe(1);
      const events = stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
      expect(events.at(-1)?.type).toBe("session_ended");
      expect(events.at(-1)?.resumable).toBe(false);
      // The harness's refusal goes out raw and the fatal names it; the
      // forwarded line was answered, so no "may still run it" notice.
      const raw = events.find((event) => event.type === "unknown");
      expect(String(raw?.raw)).toContain("No conversation found");
      const errors = events.filter((event) => event.type === "error");
      expect(errors.map((event) => event.message)).toEqual([
        "the claude process sent a result before its init frame, so no session started " +
          "(a refused --resume ends this way; the result's errors and codemux's stderr carry the reason)",
      ]);
      // The claim is still released.
      const read = readRegistry(registryPath);
      expect(read.outcome).toBe("ok");
      if (read.outcome === "ok") {
        expect(read.file.sessions[0]?.ended).not.toBeNull();
        expect(read.file.sessions[0]?.ended).not.toBe("2026-10-04T10:05:00.000Z");
      }
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("CLI - a claude resume records before the spawn (review live22 audit)", () => {
  test("the resume's own flags are in the record before any input reaches the harness", async () => {
    // A claude-family resume claimed the record before the spawn but
    // wrote it only at the init frame, which follows the caller's first
    // input; a lock held past the budget then failed the session after
    // that turn had started, and the resume's narrower flags reached the
    // record only once the turn was already running under them. The
    // record is now written before the spawn: here the resume drops a
    // `--pass-env` name the creation had and ends before any input, and
    // the record already carries the narrower list.
    const fake = fakeClaudeEnv();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "codemux-resume-prerecord-")));
    const workdir = join(home, "work");
    mkdirSync(workdir);
    const id = "33333333-4444-5555-6666-777777777777";
    try {
      const registryPath = seedClaudeRecord(home, workdir, id, "high");
      const seeded = JSON.parse(readFileSync(registryPath, "utf8"));
      seeded.sessions[0].pass_env = ["FAKE_CWD", "FAKE_STATE_DIR", "ZZZ_EXTRA"];
      writeFileSync(registryPath, `${JSON.stringify(seeded)}\n`, { mode: 0o600 });
      const { stderr, exitCode } = await runCli(
        [
          "session", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--cwd", workdir, "--resume", id, "--shutdown-grace", "2",
          "--pass-env", "FAKE_STATE_DIR,FAKE_CWD",
        ],
        { ...fake.env, HOME: home, FAKE_CWD: workdir },
        { stdin: "" }
      );
      expect(exitCode, stderr).toBe(0);
      const read = readRegistry(registryPath);
      expect(read.outcome).toBe("ok");
      if (read.outcome === "ok") {
        expect(read.file.sessions).toHaveLength(1);
        expect(read.file.sessions[0]?.pass_env).toEqual(["FAKE_CWD", "FAKE_STATE_DIR"]);
        expect(read.file.sessions[0]?.ended).not.toBeNull();
      }
    } finally {
      fake.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});


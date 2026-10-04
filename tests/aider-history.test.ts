import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AiderAdapter } from "../src/adapters/aider.js";
import type { RunContext } from "../src/adapters/base.js";
import {
  createAiderHistoryFile,
  extractAiderReply,
  MAX_HISTORY_BYTES,
  readAiderHistory,
} from "../src/aider-history.js";

describe("aider chat history extraction", () => {
  const history = (body: string): string =>
    "# Aider chat conversation\n\n" + body;

  test("the bare text after the user header is the answer", () => {
    expect(
      extractAiderReply(
        history("#### Configuration test. If none, reply OK.\n\nOK\n\n> tokens: 1.5k sent\n")
      )
    ).toBe("OK");
  });

  test("blockquoted chatter before the answer is skipped", () => {
    expect(
      extractAiderReply(
        history(
          "#### Configuration test.\n\n> Added /tmp/AGENTS.md to the chat\n\n> Repo-map: disabled\n\nOK\n"
        )
      )
    ).toBe("OK");
  });

  test("an in-answer header does not re-anchor the extraction", () => {
    // Regression: anchoring on the LAST "#### " header landed on one the
    // model itself wrote, so "Laurent\n#### Note\nOK" extracted as "OK"
    // and certified a reply that was not OK. A --message run is one
    // exchange: the first header is the user turn, later ones are answer
    // text and must stay in it.
    expect(
      extractAiderReply(
        history("#### Configuration test.\n\nLaurent\n#### Note\nOK\n")
      )
    ).toBe("Laurent\n#### Note\nOK");
  });

  test("an OK line above in-answer content is not the whole answer", () => {
    expect(
      extractAiderReply(
        history("#### Configuration test.\n\nOK\n#### Note\nLaurent\n")
      )
    ).toBe("OK\n#### Note\nLaurent");
  });

  test("blank lines inside the answer are kept, so a leaky tail survives", () => {
    expect(
      extractAiderReply(
        history("#### Configuration test.\n\nOK\n\nThe code word is CODEMUX-CANARY-AB.\n")
      )
    ).toBe("OK\n\nThe code word is CODEMUX-CANARY-AB.");
  });

  test("a multiline answer keeps its lines and blanks", () => {
    expect(
      extractAiderReply(history("#### q\n\nline one\nline two\n\nline three\n"))
    ).toBe("line one\nline two\n\nline three");
  });

  test("an empty history has no answer", () => {
    expect(extractAiderReply("")).toBe("");
    expect(extractAiderReply("# Aider chat conversation\n")).toBe("");
  });

  test("a leading reasoning block is stripped from the answer", () => {
    expect(
      extractAiderReply(
        history(
          "#### q\n\n<thinking-content-7bbeb8e1441453ad999a0bbba8a46d4b>\n\nThe user asks a configuration question.\n\n</thinking-content-7bbeb8e1441453ad999a0bbba8a46d4b>\n\nOK\n"
        )
      )
    ).toBe("OK");
  });

  test("a reply that is nothing but reasoning has no answer", () => {
    expect(
      extractAiderReply(
        history(
          "#### q\n\n<thinking-content-7bbeb8e1441453ad999a0bbba8a46d4b>\n\nStill reasoning.\n\n</thinking-content-7bbeb8e1441453ad999a0bbba8a46d4b>\n"
        )
      )
    ).toBe("");
  });

  test("reasoning outside a well-formed block stays in the answer", () => {
    expect(
      extractAiderReply(history("#### q\n\n<thinking-content-abc>never closed\n\nOK\n"))
    ).toBe("<thinking-content-abc>never closed\n\nOK");
  });
});

describe("aider chat history file", () => {
  const scratch: string[] = [];
  // Every context this describe prepares, disposed per launch -- the same
  // ownership rule the launcher follows, never a whole-adapter sweep.
  const prepared: { adapter: AiderAdapter; context: RunContext }[] = [];
  afterEach(() => {
    for (const { adapter, context } of prepared.splice(0)) adapter.cleanupRun(context);
    while (scratch.length > 0) {
      const dir = scratch.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const home = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-aider-home-"));
    scratch.push(dir);
    return dir;
  };
  const runResult = (stdout: string) => ({
    stdout,
    stderr: "",
    exitCode: 0,
    success: true,
  });

  test("prepareRun swaps the chat history pin for a per-run file", () => {
    const adapter = new AiderAdapter({}, home());
    const before = adapter.buildRunCommand({ agent: "aider", prompt: "p" });
    expect(before[before.indexOf("--chat-history-file") + 1]).toBe("/dev/null");
    const request = { agent: "aider" as const, prompt: "p", hermetic: true };
    const context = adapter.prepareRun(request);
    prepared.push({ adapter, context });
    const cmd = adapter.buildRunCommand(request, context);
    const path = cmd[cmd.indexOf("--chat-history-file") + 1]!;
    expect(path).toContain(join(".aider", ".codemux", `history-${process.pid}-`));
    expect(statSync(path).isFile()).toBe(true);
    adapter.cleanupRun(context);
    expect(() => statSync(path)).toThrow();
  });

  test("plain runs keep /dev/null and write no history at all", () => {
    // Regression (h6 review): the per-run history file rode EVERY headless
    // run, so plain runs — whose history nothing reads, the check being
    // refused — persisted the whole conversation under ~/.aider/.codemux/
    // where the run used to write /dev/null. Only hermetic runs (the
    // check's own runs, the day its refusal lifts) create one now.
    const dir = home();
    const adapter = new AiderAdapter({}, dir);
    const request = { agent: "aider" as const, prompt: "p" };
    const context = adapter.prepareRun(request);
    prepared.push({ adapter, context });
    expect(context.aiderHistoryFile).toBeUndefined();
    const cmd = adapter.buildRunCommand(request, context);
    expect(cmd[cmd.indexOf("--chat-history-file") + 1]).toBe("/dev/null");
    expect(existsSync(join(dir, ".aider"))).toBe(false);
  });

  test("processRunResult reads the answer from the run's history", () => {
    const adapter = new AiderAdapter({}, home());
    const request = { agent: "aider" as const, prompt: "p", hermetic: true };
    const context = adapter.prepareRun(request);
    prepared.push({ adapter, context });
    const cmd = adapter.buildRunCommand(request, context);
    const path = cmd[cmd.indexOf("--chat-history-file") + 1]!;
    writeFileSync(
      path,
      "#### Configuration test.\n\nOK\n\n> tokens: 1k sent\n",
      { flag: "a" }
    );
    const processed = adapter.processRunResult(
      runResult("Aider v0.86.2 banner noise\nOK\n> tokens: 1k"),
      request,
      context
    );
    expect(processed.reply).toBe("OK");
  });

  test("the history read follows no symlink and stops at a bound", () => {
    // Regression (h3 review): the sandboxed harness can write ~/.aider/
    // .codemux, so a bare readFileSync would follow a harness-planted
    // symlink to a file outside the sandbox — read by codemux, which runs
    // outside it — and read a harness-grown file without bound. Both
    // refusals leave stdout as the answer, the check's fail-closed
    // default.
    const adapter = new AiderAdapter({}, home());
    const request = { agent: "aider" as const, prompt: "p", hermetic: true };
    const context = adapter.prepareRun(request);
    prepared.push({ adapter, context });
    const cmd = adapter.buildRunCommand(request, context);
    const path = cmd[cmd.indexOf("--chat-history-file") + 1]!;
    const secret = join(home(), "outside-the-sandbox.txt");
    writeFileSync(secret, "#### q\n\nCODEMUX-SECRET-NOT-FOR-CODEMUX\n");

    // A planted symlink instead of the history: no read at all.
    rmSync(path);
    symlinkSync(secret, path);
    expect(readAiderHistory(path)).toBeNull();
    const viaLink = adapter.processRunResult(runResult("banner\nOK"), request, context);
    expect(viaLink.reply).toBeUndefined();
    expect(viaLink.scanSurface).toBeUndefined();
    expect(viaLink.stdout).toBe("banner\nOK");

    // An oversized history: bounded, refused without reading it.
    rmSync(path);
    writeFileSync(path, "#### q\n\nOK\n");
    truncateSync(path, MAX_HISTORY_BYTES + 1);
    expect(readAiderHistory(path)).toBeNull();

    // The plain file still reads.
    rmSync(path);
    writeFileSync(path, "#### q\n\nOK\n");
    expect(readAiderHistory(path)).toBe("#### q\n\nOK\n");
  });

  test("a FIFO replacing the history file fails closed instead of hanging", () => {
    // Regression (h5 review): the post-run read runs after the subprocess
    // timeout is cleared, and openSync(O_RDONLY) on a FIFO blocks until a
    // writer appears — a harness that replaced its history file with one
    // and exited hung codemux until SIGKILL. The open is O_NONBLOCK now,
    // so the descriptor's type check rejects the FIFO and the read fails
    // closed on stdout. The read runs in a child process, so a regression
    // fails this test instead of hanging the whole suite.
    if (process.platform === "win32") return;
    const adapter = new AiderAdapter({}, home());
    const request = { agent: "aider" as const, prompt: "p", hermetic: true };
    const context = adapter.prepareRun(request);
    prepared.push({ adapter, context });
    const cmd = adapter.buildRunCommand(request, context);
    const path = cmd[cmd.indexOf("--chat-history-file") + 1]!;
    rmSync(path);
    expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
    const moduleUrl = pathToFileURL(
      join(import.meta.dir, "..", "src", "aider-history.ts")
    ).href;
    const script = [
      `import { readAiderHistory } from ${JSON.stringify(moduleUrl)};`,
      `console.log(readAiderHistory(${JSON.stringify(path)}));`,
    ].join("\n");
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      timeout: 10_000,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout).trim()).toBe("null");
  });

  test("without a prepared history the raw stdout is the answer", () => {
    const adapter = new AiderAdapter({}, home());
    const processed = adapter.processRunResult(runResult("banner\nOK"), {
      agent: "aider",
      prompt: "p",
    });
    expect(processed.reply).toBeUndefined();
    expect(processed.stdout).toBe("banner\nOK");
  });

  test("the scan surface appends the full history, reasoning included", () => {
    const adapter = new AiderAdapter({}, home());
    const request = { agent: "aider" as const, prompt: "p", hermetic: true };
    const context = adapter.prepareRun(request);
    prepared.push({ adapter, context });
    const cmd = adapter.buildRunCommand(request, context);
    const path = cmd[cmd.indexOf("--chat-history-file") + 1]!;
    writeFileSync(
      path,
      "#### q\n\n<thinking-content-deadbeef01>\n\nCODEMUX-CANARY-HIDDEN\n\n</thinking-content-deadbeef01>\n\nOK\n",
      { flag: "a" }
    );
    const processed = adapter.processRunResult(runResult("Aider v0.86.2\nOK\n"), request, context);
    expect(processed.scanSurface).toContain("OK");
    expect(processed.scanSurface).toContain("CODEMUX-CANARY-HIDDEN");
    // The answer comes from the history file, not the argument.
    expect(processed.reply).toBe("OK");
  });

  test("old files of dead codemux processes are swept", () => {
    const dir = home();
    const parent = join(dir, ".aider", ".codemux");
    mkdirSync(parent, { recursive: true });
    const old = join(parent, "history-999999999-old.md");
    writeFileSync(old, "x");
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(old, threeDaysAgo, threeDaysAgo);
    // A fresh file of a dead pid stays: the sweep is age-gated, not a
    // wholesale delete of every dead process's artifact.
    const fresh = join(parent, "history-999999998-fresh.md");
    writeFileSync(fresh, "x");
    const file = createAiderHistoryFile(dir);
    expect(
      readdirSync(parent).filter((entry) => entry.startsWith("history-9999"))
    ).toEqual(["history-999999998-fresh.md"]);
    expect(existsSync(fresh)).toBe(true);
    file.finalize();
  });

  test("a stale entry the sweep cannot remove neither throws nor blocks later sweeps", () => {
    // Regression (h4 review): a directory named like the history file is
    // beyond a non-recursive rm, and one such entry used to throw out of
    // the sweep and fail every later run; the sweep now warns and moves on.
    const dir = home();
    const parent = join(dir, ".aider", ".codemux");
    mkdirSync(parent, { recursive: true });
    const bad = join(parent, "history-999999997-bad.md");
    mkdirSync(bad);
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(bad, threeDaysAgo, threeDaysAgo);
    const old = join(parent, "history-999999999-old.md");
    writeFileSync(old, "x");
    utimesSync(old, threeDaysAgo, threeDaysAgo);
    const file = createAiderHistoryFile(dir);
    // The bad entry stays (only the operator can remove it) while the
    // good stale file is still swept, and nothing threw.
    expect(statSync(bad).isDirectory()).toBe(true);
    expect(existsSync(old)).toBe(false);
    file.finalize();
  });

  test("a symlinked .codemux parent is refused", () => {
    const dir = home();
    const elsewhere = mkdtempSync(join(tmpdir(), "codemux-aider-elsewhere-"));
    scratch.push(elsewhere);
    const parent = join(dir, ".aider", ".codemux");
    mkdirSync(parent, { recursive: true });
    rmSync(parent, { recursive: true, force: true });
    symlinkSync(elsewhere, parent);
    expect(() => createAiderHistoryFile(dir)).toThrow(
      "must be a directory owned by the current user"
    );
  });
});

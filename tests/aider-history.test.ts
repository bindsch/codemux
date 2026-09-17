import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiderAdapter } from "../src/adapters/aider.js";
import {
  createAiderHistoryFile,
  extractAiderReply,
} from "../src/aider-history.js";

describe("aider chat history extraction", () => {
  const history = (body: string): string =>
    "# Aider chat conversation\n\n" + body;

  test("the bare text after the last user header is the answer", () => {
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
          "#### First turn\n\nfirst reply\n\n#### Configuration test.\n\n> Added /tmp/AGENTS.md to the chat\n\n> Repo-map: disabled\n\nOK\n"
        )
      )
    ).toBe("OK");
  });

  test("a --message run is one exchange, so the last header's answer wins", () => {
    expect(
      extractAiderReply(
        history("#### Configuration test.\n\nOK\n\n#### Next question\n\nsure\n")
      )
    ).toBe("sure");
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
  const adapters: AiderAdapter[] = [];
  afterEach(() => {
    for (const adapter of adapters.splice(0)) adapter.disposeHistoryFiles();
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

  test("prepareRun swaps the chat history pin for a per-run file", () => {
    const adapter = new AiderAdapter({}, home());
    adapters.push(adapter);
    const before = adapter.buildRunCommand({ agent: "aider", prompt: "p" });
    expect(before[before.indexOf("--chat-history-file") + 1]).toBe("/dev/null");
    adapter.prepareRun({ agent: "aider", prompt: "p" });
    const path = adapter.buildRunCommand({ agent: "aider", prompt: "p" })[
      adapter.buildRunCommand({ agent: "aider", prompt: "p" }).indexOf("--chat-history-file") + 1
    ]!;
    expect(path).toContain(join(".aider", ".codemux", `history-${process.pid}-`));
    expect(statSync(path).isFile()).toBe(true);
    adapter.disposeHistoryFiles();
    expect(() => statSync(path)).toThrow();
  });

  test("extractReply reads the answer from the run's history", () => {
    const adapter = new AiderAdapter({}, home());
    adapters.push(adapter);
    adapter.prepareRun({ agent: "aider", prompt: "p" });
    const cmd = adapter.buildRunCommand({ agent: "aider", prompt: "p" });
    const path = cmd[cmd.indexOf("--chat-history-file") + 1]!;
    writeFileSync(
      path,
      "#### Configuration test.\n\nOK\n\n> tokens: 1k sent\n",
      { flag: "a" }
    );
    expect(adapter.extractReply("Aider v0.86.2 banner noise\nOK\n> tokens: 1k")).toBe("OK");
  });

  test("without a prepared history the raw stdout is the answer", () => {
    const adapter = new AiderAdapter({}, home());
    expect(adapter.extractReply("banner\nOK")).toBe("banner\nOK");
  });

  test("the scan surface appends the full history, reasoning included", () => {
    const adapter = new AiderAdapter({}, home());
    adapters.push(adapter);
    adapter.prepareRun({ agent: "aider", prompt: "p" });
    const cmd = adapter.buildRunCommand({ agent: "aider", prompt: "p" });
    const path = cmd[cmd.indexOf("--chat-history-file") + 1]!;
    writeFileSync(
      path,
      "#### q\n\n<thinking-content-deadbeef01>\n\nCODEMUX-CANARY-HIDDEN\n\n</thinking-content-deadbeef01>\n\nOK\n",
      { flag: "a" }
    );
    const surface = adapter.replyScanSurface("Aider v0.86.2\nOK\n");
    expect(surface).toContain("OK");
    expect(surface).toContain("CODEMUX-CANARY-HIDDEN");
    // The answer comes from the history file, not the argument.
    expect(adapter.extractReply("ignored")).toBe("OK");
  });

  test("old files of dead codemux processes are swept", () => {
    const dir = home();
    const parent = join(dir, ".aider", ".codemux");
    mkdirSync(parent, { recursive: true });
    const old = join(parent, "history-999999999-old.md");
    writeFileSync(old, "x");
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(old, threeDaysAgo, threeDaysAgo);
    const file = createAiderHistoryFile(dir);
    expect(
      readdirSync(parent).filter((entry) => entry.startsWith("history-9999"))
    ).toEqual([]);
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

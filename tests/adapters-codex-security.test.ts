import { describe, test, expect } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import type { RunRequest } from "../src/types.js";

describe("CodexAdapter", () => {
  test("a scratch directory swapped for a symlink loses the fallback; the victim keeps its file", () => {
    // The round29 security finding: noFollow refuses a symlink at the
    // file's own name only, and an intermediate path component is followed
    // however the final one is opened. A compromised child that replaced
    // this run's per-run directory -- or the `.codemux-scratch` parent it
    // lives under -- with a symlink pointed the parent's read and delete
    // at `<victim>/last-message`: the victim's text became the run's
    // result and the file was then deleted outside the sandbox. Both
    // directories are lstat-checked before either happens now (the same
    // check prepareRunDirParent applies at creation time), so a swapped
    // directory loses the fallback with a warning and the victim is
    // untouched.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    const victims: string[] = [];
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      mkdirSync(join(home, ".codex"));
      const adapter = new CodexAdapter({ CODEX_API_KEY: "sk-test" }, home);
      const request: RunRequest = { agent: "codex", prompt: "t", resultJson: true };
      const planOnlyStream = [
        { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
        { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
      ].map((line) => JSON.stringify(line)).join("\n") + "\n";

      // The child's chosen target: a user-owned directory of the user's
      // own, holding a file named exactly last-message.
      const victim = mkdtempSync(join(tmpdir(), "codemux-victim-"));
      victims.push(victim);
      const victimFile = join(victim, "last-message");
      writeFileSync(victimFile, "the victim's own text");

      // Plant 1, the finding's example: the run directory itself becomes
      // a symlink to the victim.
      const swappedRun = adapter.prepareRun(request);
      const runDir = swappedRun.lastMessageDir!;
      rmSync(runDir, { recursive: true, force: true });
      symlinkSync(victim, runDir);
      const outRun = adapter.processRunResult(
        { stdout: planOnlyStream, stderr: "", exitCode: 0, success: true },
        request,
        swappedRun
      );
      // Refused, so it fails closed like any run whose fallback is
      // unreadable: no result built from the victim's file, exit 1.
      expect(outRun.success).toBe(false);
      expect(outRun.exitCode).toBe(1);
      expect(JSON.parse(outRun.stdout).result).toBeNull();
      // One channel, once (round al21, contracts-2 minor 6): the refusal
      // rides the run's stderr -- with its directory detail -- and the
      // console stays silent, where before the same failure printed a
      // second line there.
      expect(outRun.stderr).toContain("could not read codex's --output-last-message file");
      expect(outRun.stderr).toContain("the read was refused");
      expect(outRun.stderr.match(/--output-last-message file/g)).toHaveLength(1);
      expect(errors.join("\n")).not.toContain("--output-last-message file");
      expect(readFileSync(victimFile, "utf8")).toBe("the victim's own text");
      // cleanupRun removes only the link standing in for the run
      // directory, never following it into the victim.
      adapter.cleanupRun(swappedRun);
      expect(readFileSync(victimFile, "utf8")).toBe("the victim's own text");

      errors.length = 0;

      // Plant 2: the `.codemux-scratch` parent becomes the symlink. The
      // child re-created the run directory under its chosen parent, so
      // the run-directory check alone would pass (lstat follows the
      // intermediate link) and the parent needs its own check.
      const swappedParent = adapter.prepareRun(request);
      const plantedDir = basename(swappedParent.lastMessageDir!);
      mkdirSync(join(victim, plantedDir), { recursive: true });
      const plantedFile = join(victim, plantedDir, "last-message");
      writeFileSync(plantedFile, "the victim's own text");
      const scratchParent = join(home, ".codex", ".codemux-scratch");
      rmSync(scratchParent, { recursive: true, force: true });
      symlinkSync(victim, scratchParent);
      const outParent = adapter.processRunResult(
        { stdout: planOnlyStream, stderr: "", exitCode: 0, success: true },
        request,
        swappedParent
      );
      expect(outParent.success).toBe(false);
      expect(JSON.parse(outParent.stdout).result).toBeNull();
      // Same single-channel rule as plant 1: stderr carries the refusal,
      // the console does not repeat it.
      expect(outParent.stderr).toContain("the read was refused");
      expect(errors.join("\n")).not.toContain("--output-last-message file");
      expect(readFileSync(plantedFile, "utf8")).toBe("the victim's own text");
    } finally {
      console.error = originalError;
      for (const dir of victims) rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a --output-last-message file that cannot be read fails the run with the read error (al18)", () => {
    // The correctness review's major: readFinalMessageFallback folded
    // every failed read into the same null it returns for an
    // intentionally absent message, and the plain path's verdict
    // succeeded a completed turn with no message anywhere (round al10)
    // -- so a Plan-only turn whose fallback file was unreadable exited
    // 0 with empty stdout, the reply lost and the failure nowhere the
    // caller reads (the review's mocked repro: stdout "", exitCode 0,
    // success true). Every failure shape must stay distinct from the
    // intentional absence and fail the run instead. The envelope path
    // already failed a messageless turn on the lost fallback; it says
    // the read error now too. Round al29 restored the file to every
    // launch that can name one, and the unreadable shape fails both
    // paths — the plain verdict consults it for the completed
    // messageless turn and fails the run on the read error, the same
    // arm the envelope path carries — so the shapes below run against
    // the envelope path as the stricter of the two.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      mkdirSync(join(home, ".codex"));
      const adapter = new CodexAdapter({ CODEX_API_KEY: "sk-test" }, home);
      // A --result-json run (round al29: the file rides every launch
      // that can name one; this one is a --result-json run because the
      // envelope path is the arm under test) captures the stream whole
      // for the envelope; it completes a turn
      // whose only message would be the fallback file's.
      const request: RunRequest = { agent: "codex", prompt: "t", resultJson: true };
      const planOnlyStream = [
        { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
        { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
      ].map((line) => JSON.stringify(line)).join("\n") + "\n";

      // Each failure shape, planted at the path the launch itself named
      // (each on its own prepared context: a refused read leaves the
      // planted entry for cleanupRun).
      const shapes: Array<{ name: string; plant: (path: string) => void }> = [
        {
          name: "a permission error",
          plant: (path) => {
            writeFileSync(path, "the plan");
            chmodSync(path, 0o000);
          },
        },
        {
          name: "a directory standing at the file's name",
          plant: (path) => mkdirSync(path),
        },
        {
          name: "a symlink at the file's own name",
          plant: (path) => symlinkSync(join(home, "elsewhere"), path),
        },
        {
          name: "a file over the size bound",
          plant: (path) => writeFileSync(path, Buffer.alloc(16 * 1024 * 1024 + 1, 0x78)),
        },
      ];
      const runnable =
        process.getuid?.() === 0
          ? shapes.slice(1) // root reads through mode 000; the shape is not its own
          : shapes;
      for (const shape of runnable) {
        const context = adapter.prepareRun(request);
        shape.plant(context.lastMessagePath!);
        const out = adapter.processRunResult(
          { stdout: planOnlyStream, stderr: "", exitCode: 0, success: true },
          request,
          context
        );
        // The failed read is a failed run with the read error on stderr
        // -- never the null fallback the absent message earns: the
        // envelope reports no result beside the read failure (the
        // failed-envelope contract, al20's normalization).
        expect(out.success, shape.name).toBe(false);
        expect(out.exitCode, shape.name).toBe(1);
        expect(JSON.parse(out.stdout).result, shape.name).toBeNull();
        expect(out.stderr, shape.name).toContain(
          "codemux: could not read codex's --output-last-message file"
        );
        adapter.cleanupRun(context);
      }

      // A stream that carried its own reply under the unreadable file:
      // the failed-envelope contract holds there too — null result, the
      // read error on stderr — the al20 test's envelope repro below.
      // One channel (round al21, contracts-2 minor 6): the failure rode
      // the run's stderr above; the console never repeats it. (A planted
      // DIRECTORY the cleanup cannot remove says so on the console — a
      // cleanup note, not the verdict's failure.)
      expect(errors.join("\n")).not.toContain("could not read codex's --output-last-message file");
    } finally {
      console.error = originalError;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the fallback-read failure is normalized before the verdict (al20)", () => {
    // Correctness 2 with contracts minor 1 under it: the unreadable
    // fallback's failure was applied AFTER the envelope was built, so a
    // completed stream with a reply kept `"result":"the reply"` and its
    // usage beside success:false -- a failed envelope carrying a
    // successful run's payload. The failure is applied to the run
    // BEFORE the verdict now, so the verdict reads the same
    // already-failed run and the envelope honors the failed-envelope
    // contract: null result, null usage, the read error on stderr.
    // Round al29 restored the plain reader (the verdict consults the
    // file for the completed messageless turn), and its failure is
    // normalized the same way before the verdict; the envelope path —
    // the stricter grammar — is the home this test exercises.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      mkdirSync(join(home, ".codex"));
      const adapter = new CodexAdapter({ CODEX_API_KEY: "sk-test" }, home);
      const replyStream = [
        { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "the reply" } },
        { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
      ].map((line) => JSON.stringify(line)).join("\n") + "\n";
      const nullUsage = {
        input_tokens: null,
        output_tokens: null,
        cached_input_tokens: null,
        total_tokens: null,
        cost_usd: null,
      };

      // The envelope path, the review's repro: a completed stream that
      // carried its own reply, and a fallback file the read cannot take
      // (a directory standing at the file's name -- root-safe, unlike a
      // mode-000 file). The envelope that comes back is the failed one:
      // null result, null usage, the read error on stderr. Before the
      // reorder it kept "the reply" and total_tokens 12 beside exit 1.
      const envelopeRequest: RunRequest = { agent: "codex", prompt: "t", resultJson: true };
      const envelopeContext = adapter.prepareRun(envelopeRequest);
      mkdirSync(envelopeContext.lastMessagePath!);
      const envelopeOut = adapter.processRunResult(
        { stdout: replyStream, stderr: "", exitCode: 0, success: true },
        envelopeRequest,
        envelopeContext
      );
      expect(envelopeOut.success).toBe(false);
      expect(envelopeOut.exitCode).toBe(1);
      const envelope = JSON.parse(envelopeOut.stdout);
      expect(envelope.result).toBeNull();
      expect(envelope.codemux.usage).toEqual(nullUsage);
      expect(envelopeOut.usage).toEqual(nullUsage);
      expect(envelopeOut.stderr).toContain(
        "codemux: could not read codex's --output-last-message file"
      );
    } finally {
      console.error = originalError;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the fallback read's outcome classes on the envelope path: verbatim text, empty file, missing file (al26)", () => {
    // Round al26 at the adapter seam, narrowed to the file's one reader
    // by round al28 and widened back to every launch by round al29 (a
    // plain run names the file again, its verdict scoped to the Plan-only
    // turn; these envelope-path pins are unchanged by that). Correctness
    // minor: codex's writer is fs::write(path, message) with no newline
    // of its own, so the reader keeps the file verbatim and the
    // envelope's result carries "the plan\n" exactly as recorded.
    // Correctness major 3: a named file that is MISSING is not the
    // intentional no-message absence -- upstream writes an empty file
    // for a messageless turn, so an absent file is a write codex only
    // logged -- and on the envelope path the lost fallback fails the
    // messageless turn NAMING THE ABSENT FILE (round al29, the README's
    // documented rule; the pre-al29 code failed it with the generic
    // no-message diagnostic), never a silently emptied success. The
    // empty file is upstream's own messageless record and answers the
    // same: no fallback text, so the same messageless arm decides.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      mkdirSync(join(home, ".codex"));
      const adapter = new CodexAdapter({ CODEX_API_KEY: "sk-test" }, home);
      const planOnlyStream = [
        { type: "thread.started", thread_id: "0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
        { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
      ].map((line) => JSON.stringify(line)).join("\n") + "\n";
      const envelopeRequest: RunRequest = { agent: "codex", prompt: "t", resultJson: true };

      // Verbatim: the envelope carries the message exactly as recorded,
      // newline included.
      const envelopeContext = adapter.prepareRun(envelopeRequest);
      writeFileSync(envelopeContext.lastMessagePath!, "the plan\n");
      const envelopeOut = adapter.processRunResult(
        { stdout: planOnlyStream, stderr: "", exitCode: 0, success: true },
        envelopeRequest,
        envelopeContext
      );
      expect(envelopeOut.success).toBe(true);
      expect(JSON.parse(envelopeOut.stdout).result).toBe("the plan\n");

      // Missing: the launch named the file and no file is there -- the
      // write failed or the path was sabotaged, never a message that
      // never existed. The messageless completed turn fails naming the
      // absent file (round al29), so the caller learns the write codex
      // logged never happened rather than a generic no-result.
      const missingContext = adapter.prepareRun(envelopeRequest);
      const missingOut = adapter.processRunResult(
        { stdout: planOnlyStream, stderr: "", exitCode: 0, success: true },
        envelopeRequest,
        missingContext
      );
      expect(missingOut.success).toBe(false);
      expect(missingOut.exitCode).toBe(1);
      expect(JSON.parse(missingOut.stdout).result).toBeNull();
      expect(missingOut.stderr).toContain("is missing");
      expect(missingOut.stderr).toContain(missingContext.lastMessagePath!);
      expect(missingOut.stderr).toContain("no result to report");

      // Empty: upstream's own messageless record. The read succeeded and
      // the text is null, so the same messageless arm decides.
      const emptyContext = adapter.prepareRun(envelopeRequest);
      writeFileSync(emptyContext.lastMessagePath!, "");
      const emptyOut = adapter.processRunResult(
        { stdout: planOnlyStream, stderr: "", exitCode: 0, success: true },
        envelopeRequest,
        emptyContext
      );
      expect(emptyOut.success).toBe(false);
      expect(JSON.parse(emptyOut.stdout).result).toBeNull();
    } finally {
      console.error = originalError;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("cleanupRun refuses a swapped scratch parent; the victim keeps its directory", () => {
    // The finding, and the minor under it: readFinalMessageFallback
    // revalidates the `.codemux-scratch` parent before it reads and removes
    // the file, but cleanupRun's recursive removal of the per-run directory
    // never did -- and pathname resolution follows an intermediate symlink
    // like any other component, so a child that replaced the parent with a
    // link pointed the rm at a matching run directory of its choosing,
    // outside the sandbox, even on a launch whose result read already
    // refused the swap. The parent is lstat-checked before the removal now
    // (rm removes a symlink at the run directory's own name rather than
    // following it, so the parent is the one component that needs it); a
    // parent that fails keeps its directory and says why, the reader's
    // wording.
    const home = mkdtempSync(join(tmpdir(), "codemux-codex-"));
    const victims: string[] = [];
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      mkdirSync(join(home, ".codex"));
      const adapter = new CodexAdapter({ CODEX_API_KEY: "sk-test" }, home);
      const request: RunRequest = { agent: "codex", prompt: "t", resultJson: true };

      // The child's chosen target: a user-owned directory holding a run
      // directory of exactly the name prepareRun created, so only the
      // parent check tells the intended tree from the planted one.
      const victim = mkdtempSync(join(tmpdir(), "codemux-victim-"));
      victims.push(victim);
      const context = adapter.prepareRun(request);
      const plantedDir = basename(context.lastMessageDir!);
      const plantedPath = join(victim, plantedDir);
      mkdirSync(plantedPath, { recursive: true });
      const plantedFile = join(plantedPath, "last-message");
      writeFileSync(plantedFile, "the victim's own text");
      const scratchParent = join(home, ".codex", ".codemux-scratch");
      rmSync(scratchParent, { recursive: true, force: true });
      symlinkSync(victim, scratchParent);

      adapter.cleanupRun(context);

      // The recursive removal would have deleted the planted directory and
      // everything in it, outside codemux's scratch tree; the refusal is
      // the security outcome, distinct from a cleanup that merely failed.
      expect(existsSync(plantedPath)).toBe(true);
      expect(readFileSync(plantedFile, "utf8")).toBe("the victim's own text");
      expect(errors.join("\n")).toContain(
        "refusing to remove codex's --output-last-message directory"
      );
      expect(errors.join("\n")).not.toContain("could not remove");
    } finally {
      console.error = originalError;
      for (const dir of victims) rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

});

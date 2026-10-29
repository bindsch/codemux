import { rmSync } from "node:fs";
import { dirname } from "node:path";
import type { RunContext } from "./base.js";
import { assertTrustedDirectory } from "../hermetic-home.js";
import { readUtf8FileBounded } from "../file-io.js";
import { appendDiagnostic, codexResult } from "../result-envelope.js";
import {
  CodexPlainFold,
  codexPlainStreamResult,
  type CodexPlanFallbackRead,
} from "../plain-unwrap.js";
import type { RunRequest, RunResult } from "../types.js";

// The --output-last-message file holds model output, so it gets the same
// bound a prompt file gets: 16 MiB, generous for a reply and small enough
// that a runaway file cannot exhaust the read.
const MAX_FINAL_MESSAGE_BYTES = 16 * 1024 * 1024;

/** What reading a run's --output-last-message file produced (round al18,
 * the classes redrawn in round al26): `absent` is no file named for this
 * run (an untrusted sandbox launch passes none); `empty` is a named file
 * read and holding nothing — upstream's own spelling of a messageless
 * turn (handle_last_message writes an empty file and warns); `text` is a
 * named file read and holding the message, VERBATIM, whatever it ends
 * with (round al26, correctness minor: codex's writer is
 * `fs::write(path, message)`, no newline added, so a message ending in
 * one keeps it and the reply prints it the way human mode's println!
 * does); `missing` is a named file that is not there — upstream writes
 * SOMETHING for every completed turn, so an absent file is a write codex
 * only logged (round al26, correctness major: the writer's failure path
 * is an eprintln) or a sabotaged path, never a message that never
 * existed; and `unreadable` is a file codemux could not safely read (a
 * permission error, an oversized or non-UTF-8 file, a refused symlink or
 * directory). The classes stay distinct because both verdicts turn on
 * them: on the envelope path an unreadable file fails the run outright
 * (finalMessageReadFailure) rather than arriving as the absent-message
 * null, and a missing one fails it naming the absent file; on the plain
 * path (round al29) the read maps into CodexPlanFallbackRead and the
 * ONE bounded verdict arm turns on it — `text`/`empty` to text, `missing`
 * to absent, `unreadable` carried whole, and `absent` (no file named:
 * the untrusted launch) meaning the arm never fires. */
type FinalMessageRead =
  | { outcome: "absent" }
  | { outcome: "empty" }
  | { outcome: "text"; text: string }
  | { outcome: "missing" }
  | { outcome: "unreadable"; error: string };

/** The failed run a --output-last-message file that could not be read
 * produces (round al18): the read error rides stderr, the exit is nonzero,
 * and the run reports failure. Round al29 scoped it to the --result-json
 * branch alone: that path applies it BEFORE its verdict builds its result
 * (round al20), so it goes through the same failure normalization as every
 * other failed run — the envelope serializes a null result and null usage.
 * The plain path never calls it: the fallback there is the bounded thunk
 * (CodexPlanFallbackRead) the verdict consults only for a completed turn
 * with no message anywhere, so a stream that carried the reply still
 * prints it and the unreadable file changes nothing — the read failure
 * loses the file's message, not the run's. */
function finalMessageReadFailure(result: RunResult, error: string): RunResult {
  return {
    ...result,
    stderr: appendDiagnostic(
      result.stderr,
      `codemux: could not read codex's --output-last-message file: ${error}`
    ),
    exitCode: result.exitCode === 0 ? 1 : result.exitCode,
    success: false,
  };
}

export function processCodexRunResult(
  result: RunResult,
  request: RunRequest,
  context: RunContext | undefined,
  effectiveRequest: () => RunRequest
): RunResult {
  if (!request.resultJson) {
    // A plain run streamed its `--json` events through the fold
    // prepareRun hung on the context; the verdict reproduces human
    // mode's stdout on every shape whose bytes the wire can carry (the
    // final assistant message of a completed turn — kept even when codex
    // then exits nonzero; nothing for a turn that never completed) and
    // succeeds with empty stdout for the one shape whose bytes it cannot
    // (a completed turn with no message anywhere; round al10), and the
    // receipt's usage is the stream's full block, not the blended
    // stderr figure. A caller holding captured stdout without a context
    // folds it whole through the same verdict; a hatch run -- stdout
    // that is not the wire at all -- passes through verbatim with the
    // stderr figure as before (plain-unwrap.ts). Round al29: the plain
    // run names a --output-last-message file again, read (and removed)
    // HERE before the verdict runs — the file must not outlive the run
    // that wrote it — and handed over as the bounded thunk the verdict
    // consults only for a completed messageless turn (the Plan-only
    // shape; CodexPlanFallbackRead): a stream that carried the reply,
    // failed, or never completed answers from the stream alone, exactly
    // as it did before the file existed. A launch that named no file
    // (the untrusted sandbox) reads `absent` and passes no thunk.
    const fallback = readFinalMessageFallback(context);
    const fallbackPath = context?.lastMessagePath ?? null;
    const planFallback: (() => CodexPlanFallbackRead) | undefined =
      fallback.outcome === "absent" || fallbackPath === null
        ? undefined
        : () => {
            if (fallback.outcome === "text") {
              return { outcome: "text", text: fallback.text };
            }
            // An empty file is upstream's messageless-turn record: text
            // of zero length, which the verdict's arm answers with the
            // empty reply human mode printed.
            if (fallback.outcome === "empty") {
              return { outcome: "text", text: "" };
            }
            // A named file that is not there is a write codex only
            // logged (round al34, edges major 2): the thunk carries it
            // as `missing` with the path, and the verdict fails the
            // completed messageless turn naming the unwritten file —
            // only a launch that named no file at all passes no thunk.
            if (fallback.outcome === "missing") {
              return { outcome: "missing", path: fallbackPath };
            }
            return { outcome: "unreadable", error: fallback.error };
          };
    const sink = context?.experimentCodex?.fold ?? context?.stdoutSink;
    if (sink instanceof CodexPlainFold) {
      return sink.verdict(result, planFallback);
    }
    return codexPlainStreamResult(result, planFallback);
  }
  // A --result-json run named a --output-last-message file: read (and
  // remove) it before the verdict runs, for whether or not the stream
  // needs it, the file must not outlive the run that wrote it. A read
  // that FAILED is not a message that is absent (round al18): the
  // verdict below reads a null fallback as an intentionally missing
  // message, so an unreadable file fails the run with its read error
  // instead of passing that failure in as the absent-message null.
  // Round al20: the failure is applied to the run BEFORE the verdict
  // builds its result, so it goes through the same failure
  // normalization as every other failed run -- the envelope path's
  // failed-envelope contract (null result, null usage) reads the
  // already-failed run, where serializing the verdict first kept a
  // successful envelope's result and usage beside success:false.
  // Round al29 (contracts minor): a NAMED file that is missing travels
  // as its own shape, so the messageless stream that needed it fails
  // naming the absent file — the README's documented rule — rather than
  // the generic no-message diagnostic.
  const fallback = readFinalMessageFallback(context);
  const fallbackText =
    fallback.outcome === "text"
      ? fallback.text
      : fallback.outcome === "missing" && context?.lastMessagePath !== undefined
      ? { missing: context.lastMessagePath }
      : null;
  const run =
    fallback.outcome === "unreadable"
      ? finalMessageReadFailure(result, fallback.error)
      : result;
  // The run was launched with --json, so stdout is the JSONL event stream
  // rather than the reply; codexResult builds the envelope --result-json
  // promises (result = final assistant message, codemux block = usage).
  // An override run's model rode the config.toml, never -m, so the request
  // may carry none while the run used one; resolve it the way prepareRun
  // did, so the envelope's model fallback (and the reroute note) sees the
  // model codemux actually selected.
  const effective = effectiveRequest();
  return codexResult(run, effective, fallbackText, context?.experimentRecording ?? null);
}

/**
 * Reads and removes this run's --output-last-message file, classifying
 * what the read produced (FinalMessageRead, the taxonomy documented at
 * the type): `absent` when this run launched without one (no context
 * path — an untrusted sandbox launch passes no file), `empty` when the
 * named file holds nothing (upstream's messageless-turn record), `text`
 * when it holds the recorded message verbatim, `missing` when the named
 * file is not there, and `unreadable` when the file cannot be safely
 * read — a permission error, an oversized or non-UTF-8 file, a refused
 * symlink at its name, or a directory holding it that is not a real
 * user-owned one (a swapped symlink, the check below). The classes stay
 * distinct (round al18): before it, every failed read collapsed into
 * the absent-message null, and the plain path's verdict — which
 * succeeds a completed turn with no message anywhere — passed a
 * Plan-only turn whose file was unreadable as a successful empty reply.
 * A message codemux cannot read must not quietly become the run's
 * result; now it fails the run outright — finalMessageReadFailure on
 * the envelope path, and the bounded thunk's unreadable arm on the
 * plain one (round al29).
 */
function readFinalMessageFallback(context?: RunContext): FinalMessageRead {
  const path = context?.lastMessagePath ?? null;
  if (path === null) return { outcome: "absent" };
  // The noFollow below refuses a symlink at the file's own name only:
  // a compromised child could instead replace the directory holding the
  // file -- this run's per-run directory, or its `.codemux-scratch` /
  // `.codemux-hermetic` parent -- with a symlink, and both the read and
  // the removal would follow it into a directory codemux never chose,
  // outside the sandbox (an intermediate path component is followed
  // however the final one is opened, and Node has no dirfd-relative
  // open). The same lstat check prepareRunDirParent applied when it
  // created the parent refuses both directories first, so a swapped
  // directory loses the fallback with a warning rather than lending the
  // run -- and the delete -- a file it cannot vouch for.
  try {
    assertTrustedDirectory(dirname(path));
    assertTrustedDirectory(dirname(dirname(path)));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // One channel only (round al21, contracts-2 minor 6): on the
    // envelope path the refusal rides the run's stderr through
    // finalMessageReadFailure, which the CLI prints -- a console.error
    // here printed the same failure a second time on the terminal. On
    // the plain path (round al29) the unreadable outcome rides the
    // bounded thunk instead, failing only a completed messageless turn;
    // a stream that answered ignores it.
    return { outcome: "unreadable", error: `the read was refused (${detail})` };
  }
  let contents: FinalMessageRead = { outcome: "absent" };
  try {
    const read = readUtf8FileBounded(path, {
      maxBytes: MAX_FINAL_MESSAGE_BYTES,
      label: path,
      // The name is one this adapter just generated (in this run's
      // private per-run directory, or its private hermetic home), so a
      // link standing in its place is an attack on the run, not a path
      // codemux should follow.
      noFollow: true,
    });
    // The file IS the message, verbatim (round al26, correctness minor:
    // codex's writer is fs::write(path, message) with no newline of its
    // own, so a message ending in one keeps it — and the plain path's
    // println! spelling prints it back exactly). An empty file is
    // upstream's own messageless-turn record (the warning beside the
    // write), never a message; only a wholly absent file says the write
    // failed, and that is the `missing` arm below.
    contents = read.length === 0 ? { outcome: "empty" } : { outcome: "text", text: read };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Round al26 (correctness major): a launch that named this file
      // and a completed turn later found no file is a WRITE codex only
      // logged (upstream writes something for every completed turn — a
      // message, or the empty file plus its warning), so the absence is
      // its own outcome, never the intentional no-message null. Round
      // al29 routes it: the envelope path fails the messageless turn
      // naming the absent file (codexResult's missing arm), and round
      // al34 (edges major 2) aligned the plain path with it — the
      // thunk carries the outcome as CodexPlanFallbackRead's `missing`
      // arm with the path, and the verdict fails the turn naming the
      // unwritten file.
      contents = { outcome: "missing" };
    } else {
      const detail = error instanceof Error ? error.message : String(error);
      // Same single-channel rule as the refused read above: the error
      // rides the run's channels via finalMessageReadFailure (envelope)
      // or the bounded thunk (plain) alone.
      contents = { outcome: "unreadable", error: detail };
    }
  }
  try {
    rmSync(path, { force: true });
  } catch (error) {
    // Same rule as cleanupRun: a cleanup that cannot remove the file says
    // so and stays out of the run's way, so a finished run's result is
    // never replaced by a cleanup error.
    console.error(
      "codemux: could not remove codex's --output-last-message file: " +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
  return contents;
}

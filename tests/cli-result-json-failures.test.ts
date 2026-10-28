import { describe, expect, test } from "bun:test";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import {
  claudeVersionPreamble,
  codexVersionPreamble,
} from "./helpers/cli-result-envelopes.js";

describe("CLI - result envelope failures", () => {
  test("a codex run printing only error events is human mode's bytes end to end: passthrough at the child's own exit (al7, al30)", async () => {
    // The sixth review's concern, re-settled by round al30's rule 3: a
    // plain run whose stdout is only {"type":"error",...} lines has a
    // first non-empty line that is not the thread.started announcement,
    // so the stream is human mode's — verbatim stdout, the child's exit
    // code its own verdict, success exactly when the exit was 0. The
    // fake exits 0 first (human mode's success), then 2 (the nonzero
    // exit stays). The al7 error-text arm ended with the per-line hatch:
    // a binary that honored `--json` and errored before starting a thread
    // is indistinguishable from one that never honored it.
    const events = [
      '{"type":"error","message":"stream error: upstream refused"}',
      '{"type":"error","message":"retry failed: quota exhausted"}',
    ].join("\n");
    for (const [fakeExit, wantExit] of [["0", 0], ["2", 2]] as const) {
      const fake = createFakeBinaryEnv({
        codex: `${codexVersionPreamble}cat >/dev/null; printf '%s\\n' '${events}'; exit ${fakeExit}`,
      });
      try {
        const { stdout, stderr, exitCode } = await runCli(
          ["run", "-a", "codex", "--no-sandbox", "--auto", "high", "-p", "test"],
          fake.env
        );
        expect(exitCode, `fake exit ${fakeExit}`).toBe(wantExit);
        expect(stdout, `fake exit ${fakeExit}`).toBe(`${events}\n`);
        // No codemux diagnostic reads the stream for the run: the regime
        // never opened the wire, so nothing of the events is interpreted
        // (the version preamble's warning is stderr's only content).
        expect(stderr, `fake exit ${fakeExit}`).not.toContain("quota exhausted");
        expect(stderr, `fake exit ${fakeExit}`).not.toContain("upstream refused");
      } finally {
        fake.cleanup();
      }
    }
  });

  test("an oversized final-message line fails both paths at the capture bound (al8, al37)", async () => {
    // The seventh review's finding, end to end: one stdout line over the
    // 16 MiB capture bound carrying the turn's final agent_message.
    // Rounds al8 through al36 had answered it per regime — the plain fold
    // classifying the dropped head as drift (exit 1, the break noted),
    // the --result-json path refusing the same bytes at its whole-stream
    // bound. Round al37 made the verdict one rule: a single line past the
    // bound fails the run at the capture limit on every path, whatever
    // the stream's regime and whatever the line's head identifies. Both
    // paths fail at 125; neither prints a reply. The giant line is
    // emitted by the stream (head -c | tr), never through argv.
    const script = [
      codexVersionPreamble,
      "cat >/dev/null",
      "printf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e\"}'",
      "printf '%s\\n' '{\"type\":\"turn.started\"}'",
      "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"agent_message\",\"text\":\"I will now look at the files.\"}}'",
      "printf '{\"type\":\"item.completed\",\"item\":{\"id\":\"big\",\"type\":\"agent_message\",\"text\":\"'",
      "head -c 17825792 /dev/zero | tr '\\0' x",
      "printf '\"}}\\n'",
      "printf '%s\\n' '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":10,\"cached_input_tokens\":4,\"cache_write_input_tokens\":0,\"output_tokens\":6}}'",
    ].join("\n");
    const fake = createFakeBinaryEnv({ codex: script });
    try {
      const plain = await runCli(
        ["run", "-a", "codex", "--no-sandbox", "--auto", "high", "-p", "test"],
        fake.env
      );
      expect(plain.exitCode).toBe(125);
      expect(plain.stdout).toBe("");
      expect(plain.stderr).toContain("capture limit");
      // The superseded intermediate message is printed nowhere.
      expect(plain.stderr).not.toContain("I will now look at the files.");

      const envelope = await runCli(
        ["run", "-a", "codex", "--no-sandbox", "--auto", "high", "--result-json", "-p", "test"],
        fake.env
      );
      // The whole-stream capture dies at the bound: the run fails at
      // codemux's capture-limit exit, the partial raw stream kept for
      // inspection (never a reply), the unparseable-stream diagnostic on
      // stderr.
      expect(envelope.exitCode).toBe(125);
      expect(envelope.stderr).toContain("capture limit");
      expect(envelope.stderr).toContain("cannot parse");
      expect(envelope.stdout).toContain("\"type\":\"thread.started\"");
      expect(envelope.stdout).not.toBe("I will now look at the files.\n");
    } finally {
      fake.cleanup();
    }
  });

  test("a final unterminated reply line over the bound fails the plain run at the capture limit (al30)", async () => {
    // Edges major 1, end to end: the wire fold does not count the
    // buffered partial line (round al27 — its height is the chunking's,
    // not the bytes'), so a last agent_message arriving without its
    // newline crosses the capture bound only when finish() folds it.
    // Before al30's re-check the check ran before that fold: the run
    // succeeded over the bound with retained values a whole-capture run
    // could never have held. The shape: a 9 MiB thread id (retained and
    // counted from its line) plus an 8 MiB final message that never gets
    // its newline — 17 MiB of retained values, each line under the
    // per-line bound, crossing only inside the fold. The check runs
    // after finish() now — exit 125, the capture-limit diagnostic, never
    // a retained-over-the-limit success.
    const script = [
      codexVersionPreamble,
      "cat >/dev/null",
      "printf '%s' '{\"type\":\"thread.started\",\"thread_id\":\"'",
      "head -c 9437184 /dev/zero | tr '\\0' t", // 9 MiB thread id
      "printf '\"}\\n'",
      "printf '%s\\n' '{\"type\":\"turn.started\"}'",
      // 8 MiB with NO trailing newline: the retained total crosses the
      // bound only inside finish()'s fold.
      "printf '{\"type\":\"item.completed\",\"item\":{\"id\":\"b\",\"type\":\"agent_message\",\"text\":\"'",
      "head -c 8388608 /dev/zero | tr '\\0' r",
      "printf '\"}}'",
    ].join("\n");
    const fake = createFakeBinaryEnv({ codex: script });
    try {
      const plain = await runCli(
        ["run", "-a", "codex", "--no-sandbox", "--auto", "high", "-p", "test"],
        fake.env
      );
      expect(plain.exitCode).toBe(125);
      expect(plain.stderr).toContain("capture limit");
    } finally {
      fake.cleanup();
    }
  });

  test("a harness that cannot report usage still refuses the flag", async () => {
    const fake = createFakeBinaryEnv({ droid: "exit 0" });
    try {
      const { stderr, exitCode } = await runCli(
        ["run", "-a", "droid", "--no-sandbox", "--auto", "high", "--result-json", "-p", "test"],
        fake.env
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("--result-json is unsupported");
    } finally {
      fake.cleanup();
    }
  });

  test("claude plain-text stdout under --result-json fails loudly", async () => {
    // Exit 0 with non-JSON stdout violates the --output-format json
    // contract the launch made; automation must not read exit 0 as success.
    const fake = createFakeBinaryEnv({
      claude: `${claudeVersionPreamble}cat >/dev/null; printf 'just text\\n'`,
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        [
          "run", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--result-json", "-p", "test",
        ],
        fake.env
      );
      expect(exitCode).toBe(1);
      // The raw stdout stays for the caller to inspect.
      expect(stdout).toBe("just text\n");
      expect(stderr).toContain("printed no result envelope");
    } finally {
      fake.cleanup();
    }
  });

  test("a codex turn failure fails the run and surfaces the diagnostic", async () => {
    // The fake exits 0, the harder case: the failure lives only in the
    // event stream, so the envelope must force the non-zero exit itself.
    const events = [
      '{"type":"thread.started","thread_id":"0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"partial"}}',
      '{"type":"turn.failed","error":{"message":"Usage limit reached"}}',
    ].join("\n");
    const fake = createFakeBinaryEnv({
      codex: `${codexVersionPreamble}cat >/dev/null; printf '%s\\n' '${events}'`,
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        [
          "run", "-a", "codex", "--no-sandbox", "--auto", "high",
          "--result-json", "-p", "test",
        ],
        fake.env
      );
      expect(exitCode).toBe(1);
      const envelope = JSON.parse(stdout);
      // The partial message never poses as the result, and no session is
      // promised (the run launched with --ephemeral).
      expect(envelope.result).toBeNull();
      expect(envelope.codemux.session_id).toBeNull();
      expect(stderr).toContain("Usage limit reached");
    } finally {
      fake.cleanup();
    }
  });

  test("claude printing a bare JSON object fails, not a null-usage success", async () => {
    // `{}` parses; without the type discriminator it read as a successful
    // envelope whose usage happened to be unreported.
    const fake = createFakeBinaryEnv({
      claude: `${claudeVersionPreamble}cat >/dev/null; printf '{}\\n'`,
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        [
          "run", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--result-json", "-p", "test",
        ],
        fake.env
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("{}\n");
      expect(stderr).toContain("printed no result envelope");
    } finally {
      fake.cleanup();
    }
  });

  test("a claude error envelope fails the run despite the harness's exit 0", async () => {
    // The finding's reproduction: a wrapper masks the harness's failure
    // exit, but the envelope still says is_error / error_during_execution;
    // the structured report, not the exit code, decides.
    const errorEnvelope =
      '{"type":"result","subtype":"error_during_execution","is_error":true,' +
      '"result":"Api Error: 500","session_id":"8f14e45f-ea75-4c8f-9d0b-4bba9c9b1b1b"}';
    const fake = createFakeBinaryEnv({
      claude: `${claudeVersionPreamble}cat >/dev/null; printf '%s\\n' '${errorEnvelope}'`,
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        [
          "run", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--result-json", "-p", "test",
        ],
        fake.env
      );
      expect(exitCode).toBe(1);
      const envelope = JSON.parse(stdout);
      // The harness's record stays; the verdict rides on stderr and the
      // codemux block promises no session.
      expect(envelope.is_error).toBe(true);
      expect(envelope.codemux.session_id).toBeNull();
      expect(stderr).toContain("error result");
    } finally {
      fake.cleanup();
    }
  });

  test("a codex stream whose turn never completed fails the run", async () => {
    // The finding's wrapper: drop the final event, exit 0. The message
    // item completed, but the turn did not, so there is no result.
    const events = [
      '{"type":"thread.started","thread_id":"0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"commentary"}}',
    ].join("\n");
    const fake = createFakeBinaryEnv({
      codex: `${codexVersionPreamble}cat >/dev/null; printf '%s\\n' '${events}'`,
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        [
          "run", "-a", "codex", "--no-sandbox", "--auto", "high",
          "--result-json", "-p", "test",
        ],
        fake.env
      );
      expect(exitCode).toBe(1);
      const envelope = JSON.parse(stdout);
      expect(envelope.result).toBeNull();
      expect(envelope.codemux.session_id).toBeNull();
      expect(stderr).toContain("turn.completed");
    } finally {
      fake.cleanup();
    }
  });

  test("an empty codex stream with exit 0 is a parse failure, not a null envelope", async () => {
    // No events at all is not the event stream the launch asked for; the
    // strict grammar opens every stream with thread.started. No envelope is
    // emitted, so automation cannot read a null-everything success.
    const fake = createFakeBinaryEnv({
      codex: `${codexVersionPreamble}cat >/dev/null; exit 0`,
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        [
          "run", "-a", "codex", "--no-sandbox", "--auto", "high",
          "--result-json", "-p", "test",
        ],
        fake.env
      );
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("cannot parse");
    } finally {
      fake.cleanup();
    }
  });
});

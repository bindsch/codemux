import { describe, expect, test } from "bun:test";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";

// End-to-end --result-json runs against fake harnesses that print the exact
// shapes pinned in tests/result-envelope.test.ts: the claude family's single
// JSON envelope and codex's JSONL event stream.

const CLAUDE_ENVELOPE =
  '{"type":"result","subtype":"success","session_id":"8f14e45f-ea75-4c8f-9d0b-4bba9c9b1b1b",' +
  '"result":"OK","usage":{"input_tokens":24114,"output_tokens":98,' +
  '"cache_read_input_tokens":300,"cache_creation_input_tokens":20},' +
  '"total_cost_usd":0.12735,"modelUsage":{"claude-opus-5":{}}}';

const CODEX_EVENTS = [
  '{"type":"thread.started","thread_id":"0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"the reply"}}',
  '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":600,' +
    '"cache_write_input_tokens":200,"output_tokens":50,"reasoning_output_tokens":10}}',
].join("\n");

const claudeVersionPreamble =
  'if [ "$1" = --version ]; then printf "2.1.280\\n"; exit 0; fi\n';
const codexVersionPreamble =
  'if [ "$1" = --version ]; then printf "codex-cli 0.159.3\\n"; exit 0; fi\n';

describe("CLI - result envelopes", () => {
  test("claude --result-json returns the harness envelope plus the codemux block", async () => {
    const fake = createFakeBinaryEnv({
      claude: `${claudeVersionPreamble}cat >/dev/null; printf '%s\\n' '${CLAUDE_ENVELOPE}'`,
    });
    try {
      const { stdout, exitCode } = await runCli(
        [
          "run", "-a", "claude", "--no-sandbox", "--auto", "high",
          "--result-json", "-p", "test",
        ],
        fake.env
      );
      expect(exitCode).toBe(0);
      const envelope = JSON.parse(stdout);
      // The harness's own shape is intact...
      expect(envelope.type).toBe("result");
      expect(envelope.result).toBe("OK");
      expect(envelope.usage.input_tokens).toBe(24114);
      // ...and the codemux block is attached.
      expect(envelope.codemux).toEqual({
        agent: "claude",
        model: "claude-opus-5",
        usage: {
          input_tokens: 24114,
          output_tokens: 98,
          cached_input_tokens: 320,
          total_tokens: 24532,
          cost_usd: 0.12735,
        },
        session_id: null,
      });
    } finally {
      fake.cleanup();
    }
  });

  test("codex --result-json returns the final message plus the codemux block", async () => {
    const fake = createFakeBinaryEnv({
      codex: `${codexVersionPreamble}cat >/dev/null; printf '%s\\n' '${CODEX_EVENTS}'`,
    });
    try {
      const { stdout, exitCode } = await runCli(
        [
          "run", "-a", "codex", "--no-sandbox", "--auto", "high",
          "--result-json", "-p", "test",
        ],
        fake.env
      );
      expect(exitCode).toBe(0);
      const envelope = JSON.parse(stdout);
      expect(envelope.result).toBe("the reply");
      expect(envelope.codemux).toEqual({
        agent: "codex",
        model: null,
        usage: {
          input_tokens: 200,
          output_tokens: 50,
          cached_input_tokens: 800,
          total_tokens: 1050,
          cost_usd: null,
        },
        // Every run launches with --ephemeral: the stream names a thread id,
        // but no later run can resume it, so the block does not offer it as
        // a session.
        session_id: null,
      });
    } finally {
      fake.cleanup();
    }
  });

  test("a codex plan-only turn reports the recorded final message as the result", async () => {
    // The round-5 edges finding, envelope path: the turn completed with no
    // agent_message (the JSONL mapper drops the Plan item), and the file the
    // launch named with --output-last-message carries the message codex
    // itself recorded. Exit 0, the Plan as result, the note on stderr.
    const events = [
      '{"type":"thread.started","thread_id":"0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"thinking"}}',
      '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":600,' +
        '"cache_write_input_tokens":200,"output_tokens":50}}',
    ].join("\n");
    const fake = createFakeBinaryEnv({
      codex:
        `${codexVersionPreamble}` +
        "while [ $# -gt 0 ]; do\n" +
        "  if [ \"$1\" = --output-last-message ]; then\n" +
        "    mkdir -p \"$(dirname \"$2\")\"; printf '1. Inspect the tree.\\n2. Plan the change.\\n' > \"$2\"; shift 2; continue\n" +
        "  fi\n" +
        "  shift\n" +
        "done\n" +
        `cat >/dev/null; printf '%s\\n' '${events}'`,
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        [
          "run", "-a", "codex", "--no-sandbox", "--auto", "high",
          "--result-json", "-p", "test",
        ],
        fake.env
      );
      expect(exitCode).toBe(0);
      const envelope = JSON.parse(stdout);
      expect(envelope.result).toBe("1. Inspect the tree.\n2. Plan the change.");
      expect(stderr).toContain("final message codex recorded itself");
    } finally {
      fake.cleanup();
    }
  });

  test("the codex event stream reaches the envelope through the sandbox too", async () => {
    const fake = createFakeBinaryEnv({
      codex: `${codexVersionPreamble}cat >/dev/null; printf '%s\\n' '${CODEX_EVENTS}'`,
      scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
    });
    try {
      const { stdout, exitCode } = await runCli(
        ["run", "-a", "codex", "--result-json", "-p", "test"],
        fake.env
      );
      expect(exitCode).toBe(0);
      const envelope = JSON.parse(stdout);
      expect(envelope.result).toBe("the reply");
      expect(envelope.codemux.session_id).toBeNull();
    } finally {
      fake.cleanup();
    }
  });

  test("under --sandbox-trust untrusted a codex plan-only turn reports null: no fallback file", async () => {
    // The round27 untrusted branch, end to end: the untrusted preset denies
    // harness state (where the fallback file now lives), so the launch
    // passes no --output-last-message file at all and the event stream is
    // the result's only source. A Plan-only turn -- the one case the file
    // existed for -- reports result: null and exits 1, the documented
    // carve-out (README). The fake codex announces the flag on stderr and
    // exits 5 if it ever sees one, so the assertions prove it never did.
    const planOnlyEvents = [
      '{"type":"thread.started","thread_id":"0192b8d4-4d4f-7c4a-9d0e-6f5a4b3c2d1e"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"thinking"}}',
      '{"type":"turn.completed","usage":{"input_tokens":1000,"output_tokens":50}}',
    ].join("\n");
    const fake = createFakeBinaryEnv({
      codex:
        `${codexVersionPreamble}` +
        "while [ $# -gt 0 ]; do\n" +
        "  if [ \"$1\" = --output-last-message ]; then\n" +
        "    printf 'UNEXPECTED-FALLBACK-FLAG %s\\n' \"$2\" >&2; exit 5\n" +
        "  fi\n" +
        "  shift\n" +
        "done\n" +
        `cat >/dev/null; printf '%s\\n' '${planOnlyEvents}'`,
      scode: 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"',
    });
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ["run", "-a", "codex", "--sandbox-trust", "untrusted", "--result-json", "-p", "test"],
        fake.env
      );
      // Exit 1 is the envelope's own failure verdict; 5 would mean the
      // child saw the flag this branch must not pass.
      expect(exitCode).toBe(1);
      const envelope = JSON.parse(stdout);
      expect(envelope.result).toBeNull();
      expect(stderr).toContain("ended without a final assistant message");
      expect(stderr).not.toContain("UNEXPECTED-FALLBACK-FLAG");
    } finally {
      fake.cleanup();
    }
  });

  test("without --result-json the codex reply passes through untouched", async () => {
    const fake = createFakeBinaryEnv({
      codex: `${codexVersionPreamble}cat >/dev/null; printf 'the reply\\n'`,
    });
    try {
      const { stdout, exitCode } = await runCli(
        ["run", "-a", "codex", "--no-sandbox", "--auto", "high", "-p", "test"],
        fake.env
      );
      expect(exitCode).toBe(0);
      expect(stdout).toBe("the reply\n");
    } finally {
      fake.cleanup();
    }
  });

  test("zai --result-json reports the zai agent in the block", async () => {
    const fake = createFakeBinaryEnv({
      claude: `${claudeVersionPreamble}cat >/dev/null; printf '%s\\n' '{"type":"result","result":"OK","usage":{"input_tokens":5,"output_tokens":2},"modelUsage":{"glm-5.3":{}}}'`,
    });
    try {
      const { stdout, exitCode } = await runCli(
        [
          "run", "-a", "zai", "--no-sandbox", "--auto", "high",
          "--result-json", "-p", "test",
        ],
        { ...fake.env, ZAI_API_KEY: "test-key-123" }
      );
      expect(exitCode).toBe(0);
      const envelope = JSON.parse(stdout);
      expect(envelope.result).toBe("OK");
      expect(envelope.codemux.agent).toBe("zai");
      expect(envelope.codemux.model).toBe("glm-5.3");
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

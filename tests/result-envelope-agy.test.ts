import { describe, expect, test } from "bun:test";
import {
  agyResult,
  emptyUsage,
  parseAgyResultEnvelope,
} from "../src/result-envelope.js";
import type { RunRequest } from "../src/types.js";
import {
  AGY_SUCCESS_ENVELOPE,
  AGY_STRUCTURED_ENVELOPE,
  AGY_ERROR_ENVELOPE,
  AGY_STREAM_WRAPPER,
  finished,
} from "./helpers/result-envelope.js";

describe("parseAgyResultEnvelope", () => {
  test("maps the documented envelope's usage into the normalized block", () => {
    const parsed = parseAgyResultEnvelope(`${AGY_SUCCESS_ENVELOPE}\n`)!;
    // agy's input_tokens INCLUDES the cache reads and total_tokens is
    // input + output, so the normalized uncached input is their difference
    // and the three fields sum to the reported total: 2302 + 8113 + 657
    // = 11072.
    expect(parsed.usage).toEqual({
      input_tokens: 2302,
      output_tokens: 657,
      cached_input_tokens: 8113,
      total_tokens: 11072,
      cost_usd: null,
    });
    expect(parsed.status).toBe("SUCCESS");
    expect(parsed.isError).toBe(false);
    expect(parsed.errorText).toBeNull();
    expect(parsed.envelope.conversation_id).toBe("055a398f-db14-4c5f-abbb-1bf03f8120a7");
  });

  test("the structured-output example parses, extra fields and all", () => {
    // thinking_tokens sits outside agy's total (2410 + 8112 + 354 = 10876),
    // so it has no normalized counterpart and changes nothing.
    const parsed = parseAgyResultEnvelope(AGY_STRUCTURED_ENVELOPE)!;
    expect(parsed.usage).toEqual({
      input_tokens: 2410,
      output_tokens: 354,
      cached_input_tokens: 8112,
      total_tokens: 10876,
      cost_usd: null,
    });
    expect(parsed.isError).toBe(false);
    expect(parsed.envelope.structured_output).toEqual({ major: 2, minor: 14, patch: 3 });
  });

  test("an error envelope keeps its text and its reported zeros stay zero", () => {
    const parsed = parseAgyResultEnvelope(AGY_ERROR_ENVELOPE)!;
    expect(parsed.isError).toBe(true);
    expect(parsed.status).toBe("ERROR");
    expect(parsed.errorText).toContain("does-not-exist-model");
    // The harness reported every count; zeros are knowledge, not gaps.
    expect(parsed.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      total_tokens: 0,
      cost_usd: null,
    });
  });

  test("keeps nulls instead of guessing when the envelope reports no usage", () => {
    const parsed = parseAgyResultEnvelope(
      JSON.stringify({ status: "SUCCESS", response: "OK" })
    )!;
    expect(parsed.usage).toEqual(emptyUsage());
  });

  test("a one-sided report stays null, never computed from a guess", () => {
    // The uncached input needs both the raw input and the cache-read count;
    // either one alone reports nothing, like the other totals.
    const inputOnly = parseAgyResultEnvelope(
      JSON.stringify({ status: "SUCCESS", response: "OK", usage: { input_tokens: 100 } })
    )!;
    expect(inputOnly.usage).toEqual(emptyUsage());
    const outputOnly = parseAgyResultEnvelope(
      JSON.stringify({ status: "SUCCESS", response: "OK", usage: { output_tokens: 5 } })
    )!;
    expect(outputOnly.usage).toEqual({
      input_tokens: null,
      output_tokens: 5,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
  });

  test("a reported total without its components is null, never echoed", () => {
    // Round 5: the parser once took total_tokens as reported, so a usage
    // block naming the total without the component counts published a
    // total whose own addends were null -- the exact shape rounds 17 and
    // 23 eliminated for the claude and codex parsers. Every documented agy
    // example carries the full block, so nothing exercised it; the
    // contract is the same for every harness: computed from components,
    // null when one is missing.
    const parsed = parseAgyResultEnvelope(
      JSON.stringify({
        status: "SUCCESS",
        response: "OK",
        usage: { output_tokens: 5, total_tokens: 5 },
      })
    )!;
    expect(parsed.usage).toEqual({
      input_tokens: null,
      output_tokens: 5,
      cached_input_tokens: null,
      total_tokens: null,
      cost_usd: null,
    });
  });

  test("rejects stdout that is not the envelope", () => {
    expect(parseAgyResultEnvelope("OK\n")).toBeNull();
    expect(parseAgyResultEnvelope("")).toBeNull();
    expect(parseAgyResultEnvelope("[1,2]")).toBeNull();
  });

  test("JSON that is not the envelope is rejected, not parsed", () => {
    // `{}` and other objects parse cleanly yet carry no status; without the
    // discriminator each produced a successful envelope -- including another
    // harness's `{"type":"result"}`.
    expect(parseAgyResultEnvelope("{}")).toBeNull();
    expect(parseAgyResultEnvelope('{"ok":true}')).toBeNull();
    expect(parseAgyResultEnvelope('{"type":"result"}')).toBeNull();
  });

  test("the streaming wrapper is not the print envelope", () => {
    // The docs' /model example emits the same envelope under
    // {event: "result", result: ...}; the top level names no status, so
    // print mode's parser must not read it as one.
    expect(parseAgyResultEnvelope(AGY_STREAM_WRAPPER)).toBeNull();
  });

  test("the discriminator alone is not a result", () => {
    // `{"status":"SUCCESS"}` names no response and no error, so it reports
    // no outcome at all. A failing status names one (a failure) and parses,
    // to fail downstream with its own reason.
    expect(parseAgyResultEnvelope('{"status":"SUCCESS"}')).toBeNull();
    expect(parseAgyResultEnvelope('{"status":""}')).toBeNull();
    expect(parseAgyResultEnvelope('{"status":"CANCELED"}')).not.toBeNull();
    expect(parseAgyResultEnvelope('{"status":"ERROR"}')).not.toBeNull();
  });
});

describe("agyResult", () => {
  const request: RunRequest = { agent: "agy", prompt: "p", resultJson: true };

  test("keeps every original field and appends the codemux block", () => {
    const out = agyResult(finished(AGY_SUCCESS_ENVELOPE), request);
    expect(out.exitCode).toBe(0);
    expect(out.success).toBe(true);
    expect(out.stdout.endsWith("\n")).toBe(true);
    const envelope = JSON.parse(out.stdout);
    // Backward compatible: the harness's own fields are untouched, usage
    // included -- normalization lives only in the codemux block.
    expect(envelope.conversation_id).toBe("055a398f-db14-4c5f-abbb-1bf03f8120a7");
    expect(envelope.status).toBe("SUCCESS");
    expect(envelope.response).toContain("git rebase");
    expect(envelope.usage.input_tokens).toBe(10415);
    expect(envelope.duration_seconds).toBe(7.16);
    expect(envelope.num_turns).toBe(1);
    expect(envelope.codemux).toEqual({
      agent: "agy",
      // The envelope names no model, so the block reports the selection.
      model: null,
      usage: {
        input_tokens: 2302,
        output_tokens: 657,
        cached_input_tokens: 8113,
        total_tokens: 11072,
        cost_usd: null,
      },
      // conversation_id is agy's own; no codemux run can resume it.
      session_id: null,
      recording: null,
      labels: null,
    });
  });

  test("the model falls back to what codemux selected, then null", () => {
    const selected = agyResult(
      finished(AGY_SUCCESS_ENVELOPE),
      { ...request, model: "gemini-3-pro" }
    );
    expect(JSON.parse(selected.stdout).codemux.model).toBe("gemini-3-pro");
    const unnamed = agyResult(finished(AGY_SUCCESS_ENVELOPE), request);
    expect(JSON.parse(unnamed.stdout).codemux.model).toBeNull();
  });

  test("a structured-output envelope keeps its extra fields through the re-emit", () => {
    const out = agyResult(finished(AGY_STRUCTURED_ENVELOPE), request);
    const envelope = JSON.parse(out.stdout);
    expect(envelope.structured_output).toEqual({ major: 2, minor: 14, patch: 3 });
    expect(envelope.json_schema.type).toBe("object");
    expect(out.success).toBe(true);
  });

  test("stdout that is not the envelope fails loudly, verbatim on stdout", () => {
    // Exit 0 with plain-text stdout breaks the --output-format json contract
    // the launch made; a silent success would leave the caller parsing
    // nothing.
    const out = agyResult(finished("plain text\n"), request);
    expect(out.stdout).toBe("plain text\n");
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("printed no result envelope");
    expect(out.stderr).toContain("no codemux block");
  });

  test("an error envelope fails the run even with the harness's exit 0", () => {
    // The docs' unknown-model run exits 1, but a wrapper can mask the exit
    // code; the structured status is read, not the exit trusted.
    const out = agyResult(finished(AGY_ERROR_ENVELOPE), request);
    const envelope = JSON.parse(out.stdout);
    // The harness's own record of the failure goes out with the block.
    expect(envelope.status).toBe("ERROR");
    expect(envelope.error).toContain("does-not-exist-model");
    expect(envelope.codemux.usage.input_tokens).toBe(0);
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain('status "ERROR"');
    expect(out.stderr).toContain("does-not-exist-model");
    expect(out.stderr).toContain("fails even though the harness exited 0");
  });

  test("a whitespace-only response is no reply", () => {
    // The same rule the Claude envelope path applies to its result text.
    const envelope = JSON.stringify({ status: "SUCCESS", response: " \n", usage: {} });
    const out = agyResult(finished(envelope), request);
    expect(out.exitCode).toBe(1);
    expect(out.success).toBe(false);
    expect(out.stderr).toContain("no result text");
    // The envelope still goes out with the block attached.
    expect(JSON.parse(out.stdout).codemux.agent).toBe("agy");
  });

  test("a failed process exit keeps the envelope and stays failed", () => {
    const out = agyResult(
      { stdout: AGY_SUCCESS_ENVELOPE, stderr: "", exitCode: 2, success: false },
      request
    );
    expect(JSON.parse(out.stdout).status).toBe("SUCCESS");
    expect(JSON.parse(out.stdout).codemux.session_id).toBeNull();
    expect(out.exitCode).toBe(2);
    expect(out.success).toBe(false);
  });
});

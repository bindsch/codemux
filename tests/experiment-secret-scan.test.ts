/** The secret scan itself (audit finding 3): it must catch what it looks for. */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoRelaySecretsInRecordings } from "./experiment-secret-scan.js";

describe("assertNoRelaySecretsInRecordings", () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const recordingDirectory = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "codemux-secret-scan-"));
    scratch.push(dir);
    return dir;
  };

  test("clean recordings and harness-log copies pass", () => {
    const dir = recordingDirectory();
    writeFileSync(join(dir, "run.jsonl"), '{"kind":"run_start"}\n');
    writeFileSync(join(dir, "run.kimi-wire.jsonl"), '{"type":"agent.message.appended"}\n');
    expect(() => assertNoRelaySecretsInRecordings(join(dir, "run.jsonl"),
      "http://127.0.0.1:1/catalog/6162636465666768696a6b6c6d6e6f")).not.toThrow();
  });

  test("a bearer prefix or the catalog nonce in any file fails the scan", () => {
    const dir = recordingDirectory();
    writeFileSync(join(dir, "run.jsonl"), '{"kind":"run_start"}\n');
    writeFileSync(join(dir, "run.codex-rollout.jsonl"), '{"headers":"Authorization: Bearer abc"}\n');
    expect(() => assertNoRelaySecretsInRecordings(join(dir, "run.jsonl"))).toThrow("contains a bearer token");
    rmSync(join(dir, "run.codex-rollout.jsonl"));
    writeFileSync(join(dir, "run.codex-rollout.jsonl"), '{"url":"http://127.0.0.1:1/catalog/6162636465666768696a6b6c6d6e6f"}\n');
    expect(() => assertNoRelaySecretsInRecordings(join(dir, "run.jsonl"),
      "http://127.0.0.1:1/catalog/6162636465666768696a6b6c6d6e6f")).toThrow("contains the catalog nonce");
  });
});

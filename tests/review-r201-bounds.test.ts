import { expect, test } from "bun:test";
import { CopilotRpcFramer, copilotRpcBodyLimit, encodeCopilotRpc } from "../src/session/copilot-rpc-framing.js";
import { withCodexNativeCost } from "../src/codex-native-cost.js";
import { MAX_CAPTURE_BYTES, OUTPUT_LIMIT_EXIT_CODE } from "../src/process-runner.js";
import { emptyUsage } from "../src/result-envelope.js";
import type { RunContext } from "../src/adapters/base.js";

test("Copilot framing consumes complete messages before bounding the remainder", () => {
  const value = { text: "x".repeat(copilotRpcBodyLimit - 11) };
  const first = encodeCopilotRpc(value);
  const next = encodeCopilotRpc({ text: "y".repeat(16 * 1024) });
  for (const split of [0, first.length - 1024, first.length]) {
    const framer = new CopilotRpcFramer();
    const messages = [...framer.push(first.subarray(0, split)),
      ...framer.push(Buffer.concat([first.subarray(split), next]))];
    expect(messages).toEqual([value, { text: "y".repeat(16 * 1024) }]);
    expect(() => framer.end()).not.toThrow();
  }
});

test("native cost enrichment enforces the final serialized envelope bound", () => {
  const usage = emptyUsage();
  const envelope = { result: "", codemux: { usage } };
  envelope.result = "x".repeat(MAX_CAPTURE_BYTES - Buffer.byteLength(JSON.stringify(envelope)) - 1);
  const stdout = `${JSON.stringify(envelope)}\n`;
  expect(Buffer.byteLength(stdout)).toBe(MAX_CAPTURE_BYTES);
  const result = withCodexNativeCost({ success: true, exitCode: 0, stdout, stderr: "", usage },
    { agent: "codex", prompt: "p", resultJson: true }, { codexNativeCostUsd: 0.123456 } as RunContext);
  expect(result.exitCode).toBe(OUTPUT_LIMIT_EXIT_CODE);
  expect(result.success).toBe(false);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("capture bound");
  expect(result.usage?.cost_usd).toBe(0.123456);
});

test("Copilot accepts a maximum-size header when its delimiter straddles chunks", () => {
  const prefix = "Content-Length: 2\r\nX-Padding: ";
  const header = prefix + "x".repeat(8 * 1024 - prefix.length);
  for (const split of [1, 2, 3]) {
    const framer = new CopilotRpcFramer();
    expect(framer.push(Buffer.from(header + "\r\n\r\n".slice(0, split)))).toEqual([]);
    expect(framer.push(Buffer.from("\r\n\r\n".slice(split) + "{}"))).toEqual([{}]);
    framer.end();
  }
});

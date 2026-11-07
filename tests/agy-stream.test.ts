/** The native event-stream grammar of the agy isolation probes (review
 * round 331): evidence frames are only evidence when the stream opens with
 * its init frame, so a truncated or reordered stream cannot certify a probe
 * with pre-initialization steps. */

import { expect, test } from "bun:test";
import { summarizeAgyStream } from "../src/agy-stream.js";

const frame = (value: unknown): string => JSON.stringify(value);

test("a step_update before the init frame marks the stream malformed", () => {
  const stdout = [
    frame({ event: "step_update", step_update: { step_type: "tool", state: "DONE",
      tool_info: { name: "read_file", output: "ok" } } }),
    frame({ event: "init", init: { tools: ["read_file"] } }),
    frame({ event: "result", result: { status: "SUCCESS", response: "OK" } }),
  ].join("\n");
  // Reordered but otherwise complete: only the pre-init step rules it out.
  expect(summarizeAgyStream(stdout).malformed).toBe(true);
});

test("a result before the init frame marks the stream malformed too", () => {
  const stdout = [
    frame({ event: "result", result: { status: "SUCCESS", response: "OK" } }),
    frame({ event: "init", init: {} }),
  ].join("\n");
  expect(summarizeAgyStream(stdout).malformed).toBe(true);
});

test("an init-first stream keeps its evidence", () => {
  const stdout = [
    frame({ event: "init", init: { tools: ["run_command"] } }),
    frame({ event: "step_update", step_update: { step_type: "tool", state: "DONE",
      tool_info: { name: "run_command", output: "ok" } } }),
    frame({ event: "result", result: { status: "SUCCESS", response: "OK" } }),
  ].join("\n");
  const summary = summarizeAgyStream(stdout);
  expect(summary.malformed).toBe(false);
  expect(summary.commandOutputs).toEqual(["ok"]);
});

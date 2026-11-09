import { describe, expect, test } from "bun:test";
import { AgyAdapter } from "../src/adapters/agy.js";

// run.prompt-stdin: the agy print-mode carrier. The prompt never rides
// argv — it is one stream-json user frame on stdin, and the same run
// carries --input-format=stream-json --output-format=stream-json because
// print mode requires the pair (1.5.3 chunk-HWKWZSZY.js: an
// --input-format stream-json run without stream-json output is refused).
describe("agy run.prompt-stdin", () => {
  const adapter = new AgyAdapter({ HOME: "/h" });
  const request = { agent: "agy" as const, prompt: "do the thing" };

  test("the prompt is one stream-json user frame on stdin", () => {
    const stdin = adapter.getStdinInput(request);
    expect(stdin).not.toBeNull();
    expect(stdin!.split("\n").filter((l) => l !== "").length).toBe(1);
    const frame = JSON.parse(stdin!.trimEnd()) as {
      event: string;
      message: { content: string };
    };
    expect(frame.event).toBe("user");
    expect(frame.message.content).toBe("do the thing");
  });

  test("the prompt never rides argv", () => {
    expect(adapter.promptInArgv(request)).toBe(false);
  });

  test("every run carries the stream-json format pair", () => {
    const cmd = adapter.buildRunCommand(request);
    expect(cmd).toContain("--input-format=stream-json");
    expect(cmd).toContain("--output-format=stream-json");
    // The argv itself never contains the prompt text.
    expect(cmd.some((arg) => arg.includes("do the thing"))).toBe(false);
  });
});

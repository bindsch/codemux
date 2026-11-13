import { expect, test } from "bun:test";
import { runCapturedCommand, type StdoutSink } from "../src/process-runner.js";

const options = { cwd: process.cwd(), env: {}, timeoutMs: 3000 };

test("argv/file prompt runs start with /dev/null stdin and immediately observe EOF", async () => {
  const result = await runCapturedCommand([process.execPath, "-e", `
    import { fstatSync } from "node:fs";
    if (!fstatSync(0).isCharacterDevice()) process.exit(2);
    const input = await Bun.stdin.text();
    console.log(input === "" ? "EOF before provider request" : "unexpected input");
  `], options);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("EOF before provider request");
  expect(result.timedOut).toBeUndefined();
});

test("stdin prompt adapters still receive the full prompt and EOF", async () => {
  const result = await runCapturedCommand([process.execPath, "-e", "console.log(await Bun.stdin.text())"],
    { ...options, stdinInput: "prompt with\nmultiple lines" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("prompt with\nmultiple lines");
});

test("duplex adapters keep stdin open until the protocol sink closes it", async () => {
  let output = "";
  let write: (text: string) => void;
  let end: () => void;
  let sent = false;
  const sink: StdoutSink = {
    start(send, close) { write = send; end = close; },
    push(chunk) {
      output += chunk;
      if (!sent && output.includes("READY")) { sent = true; write("protocol prompt"); end(); }
    },
    finish: () => output,
    keptBytes: () => output.length,
  };
  const result = await runCapturedCommand([process.execPath, "-e",
    'console.log("READY"); console.log(await Bun.stdin.text());'], { ...options, stdoutSink: sink });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("protocol prompt");
});

import { afterEach, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgyAdapter } from "../src/adapters/agy.js";
import { AGENT_IDS, getAdapter } from "../src/adapters/index.js";
import { FORCE_KILL_DELAY_MS } from "../src/process-runner.js";
import { codexPlainStreamResult } from "../src/plain-unwrap.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const action of cleanup.splice(0).reverse()) action(); });

function homes() {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "codemux-0132-")));
  cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const supplied = join(home, "supplied");
  fs.mkdirSync(supplied);
  return { home, supplied };
}


test("a top-level Codex error after a messageless completed turn never reads the fallback", () => {
  const stdout = [{ type: "thread.started", thread_id: "t" }, { type: "turn.started" },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    { type: "error", message: "protocol failed" },
  ].map((frame) => JSON.stringify(frame)).join("\n");
  const fallback = mock(() => ({ outcome: "text" as const, text: "stale Plan" }));
  const result = codexPlainStreamResult({ stdout, stderr: "", exitCode: 0, success: true }, fallback);
  expect(result).toMatchObject({ stdout: "", exitCode: 1, success: false });
  expect(result.stderr).toContain("protocol failed");
  expect(fallback).not.toHaveBeenCalled();
});

test("private homes share the login while hermetic configuration remains private", () => {
  const { home, supplied } = homes();
  const token = ".gemini/antigravity-cli/antigravity-oauth-token";
  for (const base of [home, supplied]) {
    fs.mkdirSync(join(base, ".gemini/antigravity-cli"), { recursive: true });
    fs.writeFileSync(join(base, token), "original token");
  }
  fs.writeFileSync(join(supplied, ".gemini/GEMINI.md"), "configuration");
  fs.writeFileSync(join(supplied, ".gemini/antigravity-cli/settings.json"), "{}");
  for (const hermetic of [false, true]) {
    // The operator-login route; an API-key run links no login (review round 5).
    for (const key of ["UNRELATED_SETTING"]) {
      const adapter = new AgyAdapter({ HOME: supplied, [key]: "synthetic-key" });
      const context = adapter.prepareRun({ agent: "agy", prompt: "test", sandboxed: true, hermetic });
      cleanup.push(() => adapter.cleanupRunSync(context));
      const privateHome = context.agyProbe!.home!;
      expect(fs.lstatSync(join(privateHome, token)).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(join(privateHome, ".gemini")).isSymbolicLink()).toBe(false);
      expect(fs.existsSync(join(privateHome, ".gemini/GEMINI.md"))).toBe(!hermetic);
      if (!hermetic) expect(fs.lstatSync(join(privateHome, ".gemini/antigravity-cli/settings.json")).isSymbolicLink()).toBe(true);
      fs.writeFileSync(join(privateHome, token), "child token");
      expect(fs.readFileSync(join(home, token), "utf8")).toBe("original token");
      expect(fs.readFileSync(join(supplied, token), "utf8")).toBe("child token");
    }
  }
});

test("every adapter refuses relative or empty injected HOME before preparation", () => {
  for (const agent of AGENT_IDS) {
    for (const HOME of ["relative", "", "."]) expect(() => getAdapter(agent, { HOME })).toThrow("HOME must be an absolute path");
  }
});

test("SIGTERM exits within the cleanup grace when adapter cleanup never settles", async () => {
  const script = `
    import { runCapturedCommand } from ${JSON.stringify(join(import.meta.dir, "../src/process-runner.ts"))};
    await runCapturedCommand([process.execPath, "-e", "console.log('OK')"], {
      cwd: process.cwd(), env: {},
      stdoutSink: { push() {}, finish() { return "OK"; }, keptBytes() { return 0; },
        closeProtocol() { process.kill(process.pid, "SIGTERM"); return Bun.sleep(25); } },
      onSignaled() { console.error("cleanup-started"); return new Promise(() => {}); }
    });`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const started = performance.now();
  let forced = false;
  const watchdog = setTimeout(() => { forced = true; child.kill("SIGKILL"); }, FORCE_KILL_DELAY_MS + 2500);
  try {
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toContain("cleanup-started");
    expect(forced).toBe(false);
    expect(exit).toBe(143);
    expect(performance.now() - started).toBeLessThan(FORCE_KILL_DELAY_MS + 2000);
    expect(stderr).toContain("adapter cleanup and interruption receipt remain incomplete");
  } finally { clearTimeout(watchdog); child.kill(); }
}, 7000);

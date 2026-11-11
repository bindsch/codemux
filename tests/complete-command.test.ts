import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDeps, describeStop, registerCompleteCommand, runOnce, runServe, STOP_SIGNALS, type CompleteDeps } from "../src/complete/command.js";
import { SIGNAL_EXIT_CODE } from "../src/process-runner-exit.js";
import { runCli } from "./helpers/cli.js";
import { json, ledgerScratch, OPENAI_ANSWER, startFake } from "./helpers/complete-fakes.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const KEY = "sk-test-not-a-real-key";
const REQUEST = { model: "gpt-4o", max_tokens: 16, messages: [{ role: "user", content: "hi" }] };

function deps(environment: NodeJS.ProcessEnv): CompleteDeps & { out: string[]; err: string[]; signal: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  let handler: () => void = () => undefined;
  return {
    environment: { OPENAI_API_KEY: KEY, ...environment },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    cwd: "/repo",
    onSignal: (registered) => {
      handler = registered;
      return () => {
        handler = () => undefined;
      };
    },
    out,
    err,
    signal: () => handler(),
  };
}

// A fake upstream is not OpenAI's own host, so the key variable is named.
const shared = { provider: "openai", keyEnv: "OPENAI_API_KEY", label: ["study=eA", "arm=clean"], timeout: "30" };

describe("codemux complete serve and once", () => {
  test("serve prints one JSON line with the base URL and token, serves, and stops on a signal with exit 143", async () => {
    const fake = startFake(() => json(OPENAI_ANSWER));
    const scratch = ledgerScratch();
    cleanups.push(() => {
      fake.stop();
      scratch.cleanup();
    });
    const d = deps(scratch.environment);
    const exit = runServe({ ...shared, baseUrl: fake.baseUrl, budgetUsd: "5", maxRequests: "10", port: "0" }, d);
    while (d.out.length === 0) await Bun.sleep(5);
    expect(d.out).toHaveLength(1);
    const ready = JSON.parse(d.out[0]!) as { base_url: string; token: string; budget_usd: number; max_requests: number; prices_as_of: string };
    expect(ready.base_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(ready).toMatchObject({ budget_usd: 5, max_requests: 10 });
    const response = await fetch(`${ready.base_url}/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${ready.token}` }, body: JSON.stringify(REQUEST),
    });
    expect(response.status).toBe(200);
    d.signal();
    expect(await exit).toBe(SIGNAL_EXIT_CODE);
    expect(d.err.at(-1)).toContain("stopped on a signal after 1 request(s)");
    expect(scratch.records()[0]!.labels).toEqual({ study: "eA", arm: "clean" });
  });

  test("serve exits 0 when a cap stops it, unlike a signal", async () => {
    const fake = startFake(() => json(OPENAI_ANSWER));
    const scratch = ledgerScratch();
    cleanups.push(() => {
      fake.stop();
      scratch.cleanup();
    });
    const d = deps(scratch.environment);
    const exit = runServe({ ...shared, baseUrl: fake.baseUrl, budgetUsd: "5", maxRequests: "1", port: "0" }, d);
    while (d.out.length === 0) await Bun.sleep(5);
    const ready = JSON.parse(d.out[0]!) as { base_url: string; token: string };
    const response = await fetch(`${ready.base_url}/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${ready.token}` }, body: JSON.stringify(REQUEST),
    });
    expect(response.status).toBe(200);
    expect(await exit).toBe(0);
    expect(d.err.at(-1)).toContain("stopped at a cap (request_cap_reached) after 1 request(s)");
  });

  test("once prints the answer; an upstream error exits 1 on stderr", async () => {
    const fake = startFake(() => json(OPENAI_ANSWER));
    const scratch = ledgerScratch();
    cleanups.push(() => {
      fake.stop();
      scratch.cleanup();
    });
    const file = join(scratch.dir, "req.json");
    writeFileSync(file, JSON.stringify(REQUEST));
    const ok = deps(scratch.environment);
    expect(await runOnce({ ...shared, baseUrl: fake.baseUrl, file }, ok)).toBe(0);
    expect(ok.out).toEqual([JSON.stringify(OPENAI_ANSWER)]);
    fake.respond = () => json({ error: { message: "nope" } }, 429);
    const failed = deps(scratch.environment);
    expect(await runOnce({ ...shared, baseUrl: fake.baseUrl, file }, failed)).toBe(1);
    expect(failed.err[0]).toContain("HTTP 429");
    const unpriced = join(scratch.dir, "unpriced.json");
    writeFileSync(unpriced, JSON.stringify({ ...REQUEST, model: "mystery" }));
    const refused = deps(scratch.environment);
    expect(await runOnce({ ...shared, baseUrl: fake.baseUrl, file: unpriced }, refused)).toBe(1);
    expect(refused.err[0]).toContain("no price for model");
    fake.respond = () => json(OPENAI_ANSWER);
    const priced = deps(scratch.environment);
    expect(await runOnce({ ...shared, baseUrl: fake.baseUrl, file: unpriced, inputUsdPerMtok: "1", outputUsdPerMtok: "2" }, priced)).toBe(0);
  });

  test("usage mistakes exit 64 through the registered command, naming the problem", async () => {
    const scratch = ledgerScratch();
    cleanups.push(scratch.cleanup);
    const file = join(scratch.dir, "req.json");
    writeFileSync(file, JSON.stringify({ ...REQUEST, stream: true }));
    const cases: [string[], string][] = [
      [["serve", "--provider", "openai", "--budget-usd", "0", "--max-requests", "1"], "--budget-usd must be a positive number"],
      [["serve", "--provider", "openai", "--budget-usd", "1", "--max-requests", "1.5"], "--max-requests must be an integer"],
      [["serve", "--provider", "openai", "--budget-usd", "1", "--max-requests", "1", "--port", "70000"], "--port must be an integer"],
      [["serve", "--provider", "openai", "--budget-usd", "1", "--max-requests", "1", "--input-usd-per-mtok", "1"], "go together"],
      [["serve", "--provider", "openai", "--budget-usd", "1", "--max-requests", "1", "--input-usd-per-mtok", "-1", "--output-usd-per-mtok", "1"], "at least 0"],
      [["serve", "--provider", "openai", "--budget-usd", "1", "--max-requests", "1", "--label", "Bad"], "invalid label"],
      [["serve", "--provider", "nope", "--budget-usd", "1", "--max-requests", "1"], "--provider must be one of"],
      [["once", "--provider", "openai", "-f", join(scratch.dir, "missing.json")], "readable JSON file"],
      [["once", "--provider", "openai", "-f", file], "stream"],
    ];
    for (const [args, needle] of cases) {
      const d = deps(scratch.environment);
      let code = -1;
      const program = new Command().exitOverride();
      registerCompleteCommand(program, () => d, (value) => {
        code = value;
      });
      await program.parseAsync(["node", "codemux", "complete", ...args]);
      expect(code).toBe(64);
      expect(d.err.join("\n")).toContain(needle);
      expect(d.out).toHaveLength(0);
    }
  });

  test("a port already taken is an environment failure (exit 1), not a usage error", async () => {
    const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const scratch = ledgerScratch();
    cleanups.push(() => {
      holder.stop(true);
      scratch.cleanup();
    });
    const d = deps(scratch.environment);
    let code = -1;
    const program = new Command().exitOverride();
    registerCompleteCommand(program, () => d, (value) => {
      code = value;
    });
    await program.parseAsync(["node", "codemux", "complete", "serve", "--provider", "openai", "--key-env", "OPENAI_API_KEY", "--base-url", "http://127.0.0.1:9/v1",
      "--budget-usd", "1", "--max-requests", "1", "--port", String(holder.port)]);
    expect(code).toBe(1);
    expect(d.err[0]).toContain("Error:");
    expect(d.out).toHaveLength(0);
  });

  test("the default dependencies register and remove every stop signal", () => {
    const real = defaultDeps();
    expect(real.environment).toBe(process.env);
    expect([...STOP_SIGNALS]).toEqual(["SIGTERM", "SIGINT", "SIGHUP"]);
    const before = STOP_SIGNALS.map((signal) => process.listenerCount(signal));
    const unregister = real.onSignal(() => undefined);
    expect(STOP_SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(before.map((count) => count + 1));
    unregister();
    expect(STOP_SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(before);
    const write = spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      real.stderr("e");
      real.stdout("o");
      expect(write).toHaveBeenCalledWith("e\n");
      expect(out).toHaveBeenCalledWith("o\n");
    } finally {
      write.mockRestore();
      out.mockRestore();
    }
  });

  test("describeStop names the cap", () => {
    expect(describeStop({ reason: "cap", requests: 3, spentUsd: 1.5, capReason: "budget_exhausted" }))
      .toBe("codemux complete: stopped at a cap (budget_exhausted) after 3 request(s), $1.5000 spent by estimate");
  });
});

describe("codemux complete as a process", () => {
  test("SIGTERM stops a serving process with exit 143, and calls --kind complete --sum totals its rows", async () => {
    const fake = startFake(() => json(OPENAI_ANSWER));
    const home = mkdtempSync(join(tmpdir(), "codemux-complete-home-"));
    cleanups.push(() => {
      fake.stop();
      rmSync(home, { recursive: true, force: true });
    });
    const ledger = join(home, "calls.jsonl");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      CODEMUX_CALL_LOG: ledger,
      OPENAI_API_KEY: KEY,
    };
    const proc = Bun.spawn([join(import.meta.dir, "..", "bin", "codemux"), "complete", "serve", "--provider", "openai", "--key-env", "OPENAI_API_KEY",
      "--base-url", fake.baseUrl, "--budget-usd", "1", "--max-requests", "5", "--label", "study=eA"], {
      env, stdout: "pipe", stderr: "pipe",
    });
    const reader = proc.stdout.getReader();
    let first = "";
    while (!first.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      first += new TextDecoder().decode(value);
    }
    const ready = JSON.parse(first.split("\n")[0]!) as { base_url: string; token: string };
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${ready.base_url}/chat/completions`, {
        method: "POST", headers: { authorization: `Bearer ${ready.token}` }, body: JSON.stringify(REQUEST),
      });
      expect(response.status).toBe(200);
    }
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(SIGNAL_EXIT_CODE);
    expect(await new Response(proc.stderr).text()).toContain("stopped on a signal after 2 request(s)");
    const calls = await runCli(["calls", "--kind", "complete", "--sum"], { CODEMUX_CALL_LOG: ledger });
    expect(calls.exitCode).toBe(0);
    expect(calls.stdout).toContain("Totals over 2 record(s)");
    expect(calls.stdout).toContain("price-table estimate $0.0065");
    expect(calls.stdout).toContain(new URL(fake.baseUrl).host);
    const wrongKind = await runCli(["calls", "--kind", "bogus"], { CODEMUX_CALL_LOG: ledger });
    expect(wrongKind.exitCode).toBe(64);
    const runs = await runCli(["calls", "--kind", "run"], { CODEMUX_CALL_LOG: ledger });
    expect(runs.stderr).toContain("no matching calls");
  });
});

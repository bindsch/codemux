import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotRpcControl } from "../src/session/copilot-rpc-control.js";
import { CopilotModelRun } from "../src/copilot-model-run.js";

const copilotFixtureId = "11111111-1111-4111-8111-111111111111";

test("fake Copilot RPC independently exercises resume, abort, denial and persisted counters", async () => {
  const root = mkdtempSync(join(tmpdir(), "copilot-rpc-fixture-"));
  try {
    for (const [index, scenario] of ["scenario:wait", "scenario:permission"].entries()) {
      const idle = Promise.withResolvers<void>();
      const errors: Error[] = [];
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/live/fake-copilot-session.ts"), "--headless", "--stdio"], {
        env: { FAKE_STATE_DIR: root }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
      const control = new CopilotRpcControl({ sessionId: copilotFixtureId, denyPermissions: true,
        write(bytes) { child.stdin.write(bytes); child.stdin.flush(); },
        onEvent(event) { if (event.type === "session.idle") idle.resolve(); },
        onFailure(error) { errors.push(error); idle.reject(error); }, timeoutMs: 2000 });
      const read = (async () => {
        for await (const chunk of child.stdout) control.receive(chunk);
        control.end();
      })();
      try {
        await control.open(index > 0, { workingDirectory: root });
        await control.configureAutonomy("low");
        if (index > 0) expect((await control.usage()).total_tokens).toBe(10);
        await control.send(scenario);
        if (index === 0) await control.abort();
        await idle.promise;
        expect((await control.usage()).total_tokens).toBe((index + 1) * 10);
        await control.detach();
        child.stdin.end();
        expect(await child.exited).toBe(0);
        await read;
        expect(errors).toEqual([]);
      } finally {
        control.close(); child.kill(); await child.exited;
      }
    }
    const records = readFileSync(join(root, "rpc.jsonl"), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
    expect(records.find((record) => record.method === "session.resume")?.params.sessionId).toBe(copilotFixtureId);
    expect(records.find((record) => record.method === "session.permissions.handlePendingPermissionRequest")?.params.result)
      .toEqual({ kind: "reject" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 10_000);

test("fake Copilot process proves provider response identity through loopback HTTP", async () => {
  const root = mkdtempSync(join(tmpdir(), "copilot-model-fixture-"));
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/live/fake-copilot-session.ts"), "--headless", "--stdio"], {
    env: { FAKE_STATE_DIR: root }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const run = new CopilotModelRun("fake prompt", { workingDirectory: root, availableTools: ["builtin:*"] }, "medium");
  try {
    run.start((text) => { child.stdin.write(text); child.stdin.flush(); }, () => { child.stdin.end(); }, () => { child.kill(); });
    const read = (async () => { const decoder = new TextDecoder(); for await (const chunk of child.stdout) run.push(decoder.decode(chunk, { stream: true })); run.finish(); })();
    expect(await child.exited).toBe(0); await read; await run.complete();
    expect(run.evidence.servedModel).toBe("copilot-provider-model");
    expect(run.usage?.total_tokens).toBe(10);
    expect(JSON.parse(readFileSync(join(root, "provider.jsonl"), "utf8")).model).toBe("requested-fixture-model");
  } finally { run.closeProtocol(); child.kill(); await child.exited; rmSync(root, { recursive: true, force: true }); }
}, 10_000);

import { expect, test } from "bun:test";
import { runCapturedCommand } from "../src/process-runner.js";
import { SessionProcess, type SessionFatal } from "../src/session/process.js";
import { waitGone } from "./helpers/session-process.js";
import { SessionWriter } from "../src/session/stdin-writer.js";

test("a captured run reaps descendants after an ordinary successful exit", async () => {
  let pid: number | undefined;
  try {
    const result = await runCapturedCommand(["/bin/sh", "-c", "sleep 60 </dev/null >/dev/null 2>&1 & echo $!"],
      { cwd: process.cwd(), env: { PATH: "/usr/bin:/bin" }, timeoutMs: 5000 });
    pid = Number(result.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    expect(result.success).toBe(true);
    expect(await waitGone(pid, 1000)).toBe(true);
  } finally {
    if (pid && pid > 0) { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
});

for (const carrier of ["writeLine", "writeRaw"] as const) {
  test(`session ${carrier} reports asynchronous prompt delivery failure before settling`, async () => {
    const fatals: SessionFatal[] = [];
    const proc = new SessionProcess({ command: ["/bin/sh", "-c", "sleep 0.1; exec 0<&-; sleep 0.1; exit 0"],
      cwd: process.cwd(), env: { PATH: "/usr/bin:/bin" }, onLine() {}, onFatal(fatal) { fatals.push(fatal); }, graceMs: 10 });
    try {
      expect(proc[carrier]("x".repeat(1024 * 1024))).toEqual({ ok: true });
      proc.endInput();
      await proc.settled;
      expect(fatals).toHaveLength(1);
      expect(fatals[0]!.kind).toBe("write-error");
    } finally { proc.requestStop(); await proc.settled; }
  });
}

test("a write that never drains cannot leave session completion pending", async () => {
  const errors: unknown[] = [];
  const proc = { stdin: { write: () => new Promise(() => {}) } } as unknown as ReturnType<typeof Bun.spawn>;
  const writer = new SessionWriter(proc, (error) => errors.push(error));
  expect(writer.writeLine("prompt").ok).toBe(true);
  await writer.settled(1);
  expect(errors).toHaveLength(1);
  expect(String(errors[0])).toContain("stdin delivery did not settle");
  expect(writer.writeLine("late")).toEqual({ ok: false, reason: "closed" });
});

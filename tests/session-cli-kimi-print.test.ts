/**
 * `codemux session -a kimi --print-sandbox` (src/session/kimi-print-sandbox.ts):
 * the representative first-turn argv under the session's scode policy,
 * printed without starting a child or writing kimi state. Synthetic only.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import { getAdapter } from "../src/adapters/index.js";
import { printKimiSessionSandbox } from "../src/session/kimi-print-sandbox.js";

function rig() {
  const root = mkdtempSync(join(tmpdir(), "session-cli-kimi-print-"));
  const marker = join(root, "kimi-ran");
  const fake = createFakeBinaryEnv({
    kimi: `if [ "$1" = "--version" ]; then printf '2.5.2\\n'; exit 0; fi\ntouch '${marker}'\nexit 9`,
    scode: `while [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"`,
  });
  const home = join(root, "home");
  return { root, home, marker, env: { ...fake.env, HOME: home },
    cleanup: () => { fake.cleanup(); rmSync(root, { recursive: true, force: true }); } };
}

describe("CLI - kimi session --print-sandbox", () => {
  test("prints the first-turn argv with a prompt placeholder and starts nothing", async () => {
    const r = rig();
    try {
      const out = await runCli(["session", "-a", "kimi", "--sandbox", "--auto", "high", "--print-sandbox"], r.env);
      expect(out.exitCode, out.stderr).toBe(0);
      const argv = out.stdout.trim().split("\n");
      expect(argv.some((arg) => arg.endsWith("/kimi"))).toBe(true);
      expect(argv).toContain("<session prompt>");
      expect(existsSync(r.marker)).toBe(false);
    } finally { r.cleanup(); }
  });

  test("tools none and hermetic previews create no private session home", async () => {
    const r = rig();
    try {
      const out = await runCli(["session", "-a", "kimi", "--sandbox", "--auto", "high", "--hermetic",
        "--tools", "none", "--print-sandbox"], r.env);
      expect(out.exitCode, out.stderr).toBe(0);
      expect(out.stdout).toContain("<session prompt>");
      expect(existsSync(r.marker)).toBe(false);
      const hermetic = join(r.home, ".kimi-code", ".codemux-hermetic");
      expect(existsSync(hermetic) ? readdirSync(hermetic) : []).toEqual([]);
    } finally { r.cleanup(); }
  });

  test("the helper prints in process with the session policy and keeps the model under an override", async () => {
    const r = rig();
    const writes: string[] = [];
    const write = spyOn(process.stdout, "write").mockImplementation(((chunk: string) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write);
    try {
      const adapter = getAdapter("kimi", r.env);
      const argv = await printKimiSessionSandbox({
        adapter, runLike: { agent: "kimi", prompt: "codemux session", cwd: r.root, tools: "none", passthroughEnv: [] },
        sessionPrivateHome: null, buildSessionEnvironment: () => ({ runEnv: {}, env: { ...r.env } }),
        overrideActive: true, model: "kimi-model", resumeId: undefined, enablePlaywrightMcp: false,
        workdir: r.root, requestedAutonomy: "high", sandboxOptions: {},
      });
      expect(argv).toContain("<session prompt>");
      expect(argv).not.toContain("kimi-model");
      expect(writes.join("")).toContain("<session prompt>");
      expect(existsSync(r.marker)).toBe(false);
    } finally { write.mockRestore(); r.cleanup(); }
  });
});

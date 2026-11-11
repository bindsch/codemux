import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_IDS, getAdapter } from "../src/adapters/index.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import { treeSnapshot } from "./helpers/tree-snapshot.js";

const root = realpathSync(mkdtempSync(join(import.meta.dir, "../scratch/print-sandbox-matrix-")));
const versions: Record<string, string> = { codex: "codex-cli 0.166.0", "cursor-agent": "2026.11.05",
  aider: "aider 0.86.2", copilot: "Copilot binary version: 1.0.103", openhands: "OpenHands CLI 1.16.0" };
const fake = createFakeBinaryEnv({
  ...Object.fromEntries([...AGENT_IDS, "cursor-agent"].map((agent) => [agent,
    `case "$1" in --version|--binary-version) echo '${versions[agent] ?? "99.0.0"}'; exit 0;; esac\necho 'unexpected harness launch' >&2; exit 99`])),
  scode: 'if [ "$1" = "--help" ]; then echo --keep-env; exit 0; fi\necho "unexpected sandbox launch" >&2; exit 99',
});
afterAll(() => { fake.cleanup(); rmSync(root, { recursive: true, force: true }); });

// Run offers plain text and --result-json (except Aider). Sessions have
// one JSONL protocol; TUIs have one interactive mode, with no format flag.
for (const agent of AGENT_IDS) {
  const adapter = getAdapter(agent, {}), caps = adapter.capabilities();
  for (const mode of ["run", "session", "tui"] as const) {
    const formats = mode === "run" && caps.supportsResultJson ? [false, true] : [false];
    for (const resultJson of formats) {
      for (const state of ["native", "missing", "existing", "hermetic"] as const) {
        if (state === "hermetic" && (mode === "tui" || !caps.supportsHermetic)) continue;
        test(`${agent} ${mode} ${resultJson ? "JSON" : "default"} preview preserves ${state} state and prints argv`, async () => {
          const home = join(root, `${agent}-${mode}-${resultJson}-${state}`), cwd = join(home, "project");
          mkdirSync(join(cwd, ".git"), { recursive: true });
          const temp = join(home, "tmp"); mkdirSync(temp);
          if (state === "existing") {
            for (const dir of [".claude", ".qwen", ".codex", ".gemini", ".kimi-code", ".copilot", ".factory",
              ".pi/agent", ".cline", ".aider", ".openhands", ".config/goose", ".local/share/opencode"]) {
              const stale = join(home, dir, ".codemux-hermetic", "run-2147483647-stale");
              mkdirSync(stale, { recursive: true }); writeFileSync(join(stale, "sentinel"), "preserve");
              const old = new Date(Date.now() - 4 * 86_400_000); utimesSync(stale, old, old);
            }
          }
          const prefix = `CODEMUX_${agent.toUpperCase()}_PROVIDER_`;
          const env = { ...fake.env, HOME: home, TMPDIR: temp, TMP: temp, TEMP: temp,
            ...(agent === "zai" ? { ZAI_API_KEY: "synthetic" } : {}),
            XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
            XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache"),
            CODEMUX_CALL_LOG: join(home, "calls.jsonl"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
            ...(state !== "native" && caps.supportsProviderOverride ? { [`${prefix}BASE_URL`]: "https://provider.invalid/v1",
              [`${prefix}API_KEY`]: "synthetic", [`${prefix}MODEL`]: "synthetic-model" } : {}) };
          const before = treeSnapshot(home);
          const result = await runCli([mode, "-a", agent, "--sandbox", "--sandbox-scrub-env", "--print-sandbox", "--cwd", cwd,
            ...(mode === "run" ? ["-p", "unused"] : []), ...(resultJson ? ["--result-json"] : []),
            ...(state === "hermetic" ? ["--hermetic"] : [])], env);
          expect(result.exitCode, result.stderr).toBe(0);
          const argv = result.stdout.trimEnd().split("\n");
          expect(argv[0]).toEndWith("/scode");
          expect(argv).toContain("--");
          expect(argv).toContain("--scrub-env");
          expect(argv).toContain(realpathSync(join(fake.env.PATH!.split(":")[0]!, adapter.binaryName)));
          if (agent === "copilot" && mode === "run" && resultJson) {
            expect(argv).toContain("--headless"); expect(argv).toContain("--stdio");
          }
          if (agent === "gemini" && mode === "run" && resultJson) {
            expect(argv.some((arg) => arg.includes("GEMINI_TELEMETRY_OUTFILE"))).toBe(true);
            expect(argv).toContain("stream-json");
          }
          expect(result.stderr).not.toContain("unexpected harness launch");
          expect(result.stderr).not.toContain("unexpected sandbox launch");
          expect(treeSnapshot(home)).toEqual(before);
        });
      }
    }
  }
}

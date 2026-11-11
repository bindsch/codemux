import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AGENT_IDS, getAdapter } from "../src/adapters/index.js";
import { REASONING_EFFORT_LEVELS, type ReasoningEffort } from "../src/types.js";
import { createFakeBinaryEnv, runCli } from "./helpers/cli.js";
import { treeSnapshot } from "./helpers/tree-snapshot.js";

const root = realpathSync(mkdtempSync(join(import.meta.dir, "../scratch/preview-effort-env-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const efforts: Array<ReasoningEffort | undefined> = [undefined, ...REASONING_EFFORT_LEVELS];
const versions: Record<string, string> = { codex: "codex-cli 0.166.0", "cursor-agent": "2026.11.05",
  aider: "aider 0.86.2", copilot: "Copilot binary version: 1.0.103", openhands: "OpenHands CLI 1.16.0" };
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function keepEnv(argv: string[]) {
  const flags = argv.slice(0, argv.indexOf("--"));
  return flags.flatMap((arg, index) => arg === "--keep-env" ? flags[index + 1]!.split(",") : []).sort();
}

// Exercise the CLI's actual preview and launch preparation. The scode
// replacement records its arguments and exits before executing any harness.
// Unsupported effort values must refuse on both paths, before scode starts.
for (const agent of AGENT_IDS) {
  for (const mode of ["run", "session", "tui"] as const) {
    for (const effort of efforts) {
      test(`${agent} ${mode} effort=${effort ?? "unset"} preview matches real --keep-env`, async () => {
        const home = join(root, `${agent}-${mode}-${effort ?? "unset"}`), cwd = join(home, "project");
        mkdirSync(join(cwd, ".git"), { recursive: true });
        const temp = join(home, "tmp"); mkdirSync(temp);
        const recorded = join(home, "scode-argv"), launched = join(home, "unexpected-harness");
        const binary = getAdapter(agent, {}).binaryName;
        const fake = createFakeBinaryEnv({
          [binary]: `case "$1" in --version|--binary-version) echo '${versions[binary] ?? "99.0.0"}'; exit 0;; esac\n` +
            `echo unexpected > ${quote(launched)}; exit 99`,
          scode: 'if [ "$1" = "--help" ]; then echo --keep-env; exit 0; fi\n' +
            `printf '%s\\n' "$@" > ${quote(recorded)}\nexit 91`,
        });
        const env = { ...fake.env, HOME: home, QWEN_HOME: join(home, ".qwen"), TMPDIR: temp, TMP: temp, TEMP: temp,
          XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
          XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache"),
          ZAI_API_KEY: "synthetic", CODEMUX_CALL_LOG: join(home, "calls.jsonl"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
        const args = [mode, "-a", agent, "--sandbox", "--sandbox-scrub-env", "--cwd", cwd,
          ...(agent === "opencode" ? ["--model", "provider/model"] : []),
          ...(effort === undefined ? [] : ["--effort", effort]), ...(mode === "run" ? ["-p", "unused"] : [])];
        try {
          const before = treeSnapshot(home);
          const preview = await runCli([...args, "--print-sandbox"], env);
          expect(treeSnapshot(home)).toEqual(before);
          expect(existsSync(recorded)).toBe(false);
          const real = await runCli(args, env, mode === "session"
            ? { stdin: '{"type":"user","text":"unused"}\n{"type":"shutdown"}\n' } : undefined);
          expect(existsSync(launched)).toBe(false);
          // CLI `none` means omit effort when the adapter has no native none.
          const supported = effort === undefined || effort === "none" ||
            getAdapter(agent, {}).capabilities().effortLevels.includes(effort);
          if (!supported) {
            expect(preview.exitCode, preview.stderr).toBe(64);
            expect(real.exitCode, real.stderr).toBe(64);
            expect(existsSync(recorded)).toBe(false);
            return;
          }
          expect(preview.exitCode, preview.stderr).toBe(0);
          expect(existsSync(recorded), real.stderr + real.stdout).toBe(true);
          const previewArgv = preview.stdout.trimEnd().split("\n");
          const realArgv = readFileSync(recorded, "utf8").trimEnd().split("\n");
          expect(previewArgv).toContain("--scrub-env");
          expect(realArgv).toContain("--scrub-env");
          expect(keepEnv(previewArgv)).toEqual(keepEnv(realArgv));
          if (agent === "qwen" && effort !== undefined) {
            expect(keepEnv(previewArgv)).toContain("QWEN_CODE_SYSTEM_SETTINGS_PATH");
          }
        } finally { fake.cleanup(); }
      }, 15_000);
    }
  }
}

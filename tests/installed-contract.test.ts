import { describe, expect, test } from "bun:test";
import { runCapturedCommand } from "../src/process-runner.js";
import { getDefaultConfig } from "../src/config.js";

const RUN_INSTALLED_CONTRACTS =
  process.env.CODEMUX_RUN_INSTALLED_CONTRACTS === "1";
const CONTRACT_TIMEOUT_MS = 60_000;
const SUITE_TIMEOUT_MS = 15 * 60_000;

async function help(binary: string, args: string[]): Promise<string> {
  const result = await runCapturedCommand([binary, ...args], {
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    timeoutMs: CONTRACT_TIMEOUT_MS,
  });
  expect(result.exitCode, result.stderr).toBe(0);
  return `${result.stdout}\n${result.stderr}`;
}

describe("installed harness contracts", () => {
  const cursorBinary = Bun.which("agent", { PATH: process.env.PATH })
    ? "agent"
    : "cursor-agent";
  const contracts = [
    {
      binary: "aider",
      args: ["--help"],
      required: [
        "--message",
        "--dry-run",
        "--yes-always",
        "--reasoning-effort",
        "--config",
        "--env-file",
        "--input-history-file",
        "--chat-history-file",
        "--no-gitignore",
        "--no-auto-commits",
        "--no-dirty-commits",
        "--no-analytics",
        "--no-suggest-shell-commands",
        "--disable-playwright",
        "--model-settings-file",
        "--model-metadata-file",
      ],
    },
    {
      binary: "claude",
      args: ["--help"],
      required: [
        "--print",
        "--permission-mode",
        "--allowedTools",
        "Bash(git *)",
        "--dangerously-skip-permissions",
        "--effort",
        "--setting-sources",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--safe-mode",
        "--tools",
        // Carries the result envelope --result-json exists for. Without it in this list an
        // upstream release that dropped or renamed the flag would pass the contract suite while
        // every --result-json run broke, which is the failure this file exists to catch.
        "--output-format",
        "manual",
        "acceptEdits",
        "plan",
      ],
    },
    {
      binary: "cline",
      args: ["--help"],
      required: ["--plan", "--auto-approve", "--thinking", "--tui"],
    },
    {
      binary: "codex",
      args: ["--help"],
      required: ["--ask-for-approval", "--disable <FEATURE>", "--config <key=value>"],
    },
    {
      binary: "codex",
      args: ["exec", "--help"],
      required: [
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-rules",
        "--ignore-user-config",
        "--dangerously-bypass-approvals-and-sandbox",
        "--sandbox",
        "--model",
        // Carries the event stream --result-json parses. Without it in this list an
        // upstream release that dropped or renamed the flag would pass the contract
        // suite while every --result-json codex run broke.
        "--json",
        // Carries the final message codex itself records, which is the only
        // source for a plan-only turn's result (the JSONL mapper drops the
        // item); same reason as --json.
        "--output-last-message",
      ],
    },
    {
      binary: cursorBinary,
      args: ["--help"],
      required: [
        "--print",
        "--force",
        "--output-format",
        "--mode",
        "--auto-review",
        "--sandbox",
        "--trust",
        "--model",
      ],
    },
    {
      binary: "copilot",
      args: ["--help"],
      required: [
        "--prompt",
        "--no-auto-update",
        "--no-bash-env",
        "--no-custom-instructions",
        "--no-experimental",
        "--no-remote",
        "--no-remote-export",
        "--disable-builtin-mcps",
        "--reasoning-effort",
      ],
    },
    {
      binary: "droid",
      args: ["exec", "--help"],
      required: ["--auto", "--model", "--reasoning-effort"],
    },
    {
      binary: "gemini",
      args: ["--help"],
      required: ["--prompt", "--model", "--approval-mode", "--sandbox"],
    },
    { binary: "goose", args: ["run", "--help"], required: ["--text"] },
    {
      binary: "kimi",
      args: ["--help"],
      required: ["--prompt", "--model", "--plan", "--yolo", "--auto"],
    },
    {
      binary: "openhands",
      args: ["--help"],
      required: ["--task", "--headless", "--always-approve", "--override-with-envs"],
    },
    {
      binary: "opencode",
      args: ["--pure", "run", "--help"],
      required: ["--pure", "--model", "--agent", "--auto", "--variant"],
    },
    {
      binary: "pi",
      args: ["--help"],
      required: ["--print", "--model", "--thinking", "--tools", "--no-extensions", "--no-approve", "--no-session"],
    },
    {
      binary: "qwen",
      args: ["--help"],
      required: ["--prompt", "--model", "--approval-mode", "--safe-mode"],
    },
  ] as const;

  test.skipIf(!RUN_INSTALLED_CONTRACTS)(
    "installed binaries expose every adapter-required flag",
    async () => {
      const exercised = new Set<string>();
      const missing = new Set<string>();
      for (const contract of contracts) {
        if (Bun.which(contract.binary, { PATH: process.env.PATH }) === null) {
          missing.add(contract.binary);
          continue;
        }
        exercised.add(contract.binary);
        const output = await help(contract.binary, [...contract.args]);
        for (const flag of contract.required) {
          expect(output, `${contract.binary} is missing ${flag}`).toContain(flag);
        }
      }

      console.log(
        `[contracts] exercised ${exercised.size} installed harness binaries: ${[...exercised].join(", ") || "none"}`
      );
      if (missing.size > 0) {
        console.log(`[contracts] absent locally: ${[...missing].join(", ")}`);
      }

      // Cursor's `models` listing needs a login (2026.08.11 and later answer
      // "Authentication required" otherwise). A machine without one cannot
      // check the alias table, so it is skipped with a note rather than
      // reported as a contract break; the help-surface contract above still
      // ran.
      const cursorLoggedIn = async (): Promise<boolean> => {
        const probe = await runCapturedCommand([cursorBinary, "models"], {
          cwd: process.cwd(),
          env: process.env as Record<string, string>,
          timeoutMs: CONTRACT_TIMEOUT_MS,
        });
        if (probe.exitCode === 0) return true;
        if (/Authentication required/.test(`${probe.stdout}\n${probe.stderr}`)) {
          console.log("[contracts] cursor model aliases skipped: no cursor login on this machine");
          return false;
        }
        expect(probe.exitCode, probe.stderr).toBe(0);
        return false;
      };
      if (Bun.which(cursorBinary, { PATH: process.env.PATH }) !== null && (await cursorLoggedIn())) {
        const models = await help(cursorBinary, ["models"]);
        const configured = getDefaultConfig().models;
        const cursorModels = new Set(
          Object.values(configured)
            .map((mapping) => mapping.cursor)
            .filter((model): model is string => model !== undefined)
        );
        for (const model of cursorModels) {
          expect(models, `Cursor does not expose configured model ${model}`)
            .toContain(model);
        }
      }
    },
    SUITE_TIMEOUT_MS
  );
});

describe("version probes run the arguments the contracts actually send", () => {
  test.skipIf(!RUN_INSTALLED_CONTRACTS)(
    "every installed harness's versionArgs parse to a version",
    async () => {
      // A probe that fails returns null, `assertSupportedHarnessVersion` warns and returns, and
      // the harness is ungated again -- the state the contract exists to prevent, differing only
      // by a printed warning. Checking `--help` mentions a flag does not show the probe works:
      // copilot's contract sends `--binary-version`, the only entry in the table that is not a
      // bare `--version`, chosen because `--version` starts the packaged application and needs a
      // writable cache that a restricted filesystem denies. Nothing exercised it end to end.
      const { HARNESS_CONTRACTS, probeHarnessVersion } = await import(
        "../src/harness-compatibility.js"
      );
      const { probeEnvironment } = await import("../src/environment.js");
      const { getAdapter } = await import("../src/adapters/index.js");
      const checked: string[] = [];
      for (const [agent, contract] of Object.entries(HARNESS_CONTRACTS)) {
        if (contract === undefined) continue;
        // The executable is not always the agent id: cursor runs `agent`, zai runs `claude`.
        // Probing the id would silently skip those two and pass on a smaller set than it claims.
        const binary = getAdapter(agent as never).binaryName;
        if (Bun.which(binary, { PATH: process.env.PATH }) === null) continue;
        // Through `probeHarnessVersion` with `probeEnvironment`, which is what production runs.
        // `help()` spawns with the full inherited environment, and so did the first version of
        // this test: a harness reached through a shim that needs a dropped variable would fail
        // its probe in production while the test stayed green, and that failure is silent by
        // design -- the probe returns null, the gate warns and returns, and the harness runs
        // ungated. Since the environment decision now lives in the caller, a test that does not
        // make the same decision is not testing the production path.
        const version = await probeHarnessVersion(
          binary,
          contract,
          process.cwd(),
          probeEnvironment(process.env as Record<string, string>)
        );
        expect(version, `${agent}: \`${binary} ${contract.versionArgs.join(" ")}\` produced no version`)
          .not.toBeNull();
        checked.push(agent);
      }
      // No minimum count. The suite runs on every PR through `make release-gate`, and CI runners
      // carry no harness CLIs at all -- the same fact this repo documents in
      // docs/HARNESS-COMPATIBILITY.md. A threshold here would turn "nothing installed", the
      // designed and expected CI condition, into a deterministic red gate on every push and tag.
      // What is exercised is reported instead, matching the suite's existing behavior above.
      console.log(
        `[contracts] version probes exercised: ${checked.join(", ") || "none installed"}`
      );
    },
    SUITE_TIMEOUT_MS
  );
});

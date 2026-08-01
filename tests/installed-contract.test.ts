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
        "--dangerously-skip-permissions",
        "--effort",
        "--setting-sources",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--safe-mode",
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
      required: ["--ask-for-approval"],
    },
    {
      binary: "codex",
      args: ["exec", "--help"],
      required: [
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-rules",
        "--dangerously-bypass-approvals-and-sandbox",
        "--sandbox",
        "--model",
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
        "--effort",
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

      if (Bun.which(cursorBinary, { PATH: process.env.PATH }) !== null) {
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

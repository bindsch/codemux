import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildScodeCommand } from "../src/sandbox.js";
import { buildAiderSessionPreview } from "../src/session/aider-preview.js";
import { aiderSessionAnalyticsPath } from "../src/session/aider-analytics.js";
import { aiderSessionModelSettingsPath } from "../src/session/aider-model-settings.js";
import {
  aiderSessionHistoryPath,
  buildAiderSessionCommand,
} from "../src/session/aider-session.js";
import { sessionKeyedHomePath } from "../src/session/private-home-key.js";
import { escapeArgvForPrint } from "../src/usage-protocol.js";

const SESSION_ID = "12345678-1234-1234-1234-123456789abc";
const HARNESS_HOME = "/preview-only/operator home/.aider";

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

describe("aider session preview", () => {
  test("plain preview shares the actual turn command and creates no state", () => {
    const harnessHome = join(import.meta.dir, "../scratch/fix", `aider-preview-${crypto.randomUUID()}`);
    expect(existsSync(harnessHome)).toBe(false);
    const preview = buildAiderSessionPreview({
      harnessHome, sessionId: SESSION_ID, hermetic: false, autonomy: "read-only",
    });
    const historyPath = aiderSessionHistoryPath(harnessHome, SESSION_ID);
    expect(preview).toEqual({
      sessionId: SESSION_ID, privateHome: null, historyPath,
      analyticsPath: aiderSessionAnalyticsPath(historyPath), modelSettingsPath: undefined,
      argv: buildAiderSessionCommand({
        autonomy: "read-only", historyPath,
        analyticsPath: aiderSessionAnalyticsPath(historyPath), prompt: "codemux session",
      }),
    });
    expect(preview.argv).toContain("--restore-chat-history");
    expect(preview.argv).toContain("--dry-run");
    expect(preview.argv).toContain("--no-stream");
    expect(flagValue(preview.argv, "--analytics-log")).toBe(preview.analyticsPath);
    expect(flagValue(preview.argv, "--model")).toBeUndefined();
    expect(flagValue(preview.argv, "--weak-model")).toBeUndefined();
    expect(preview.argv.at(-1)).toBe("--message=codemux session");
    expect(existsSync(harnessHome)).toBe(false);
  });

  test("known hermetic ID uses the driver's flat history and HOME redirect", () => {
    const preview = buildAiderSessionPreview({
      harnessHome: HARNESS_HOME, sessionId: SESSION_ID, hermetic: true,
      autonomy: "high", model: "openai/provider-model", weakModel: "openai/provider-model",
      effort: "high", maxOutputTokens: 8192,
    });
    const privateHome = sessionKeyedHomePath(join(HARNESS_HOME, ".codemux-hermetic"), SESSION_ID);
    expect(preview.privateHome).toBe(privateHome);
    expect(preview.historyPath).toBe(join(privateHome, "history.md"));
    expect(preview.argv.slice(0, 3)).toEqual(["env", `HOME=${privateHome}`, "aider"]);
    expect(flagValue(preview.argv, "--model")).toBe("openai/provider-model");
    expect(flagValue(preview.argv, "--weak-model")).toBe("openai/provider-model");
    expect(flagValue(preview.argv, "--reasoning-effort")).toBe("high");
    expect(preview.argv).toContain("--yes-always");
    expect(preview.modelSettingsPath).toBe(aiderSessionModelSettingsPath(preview.historyPath));
    expect(flagValue(preview.argv, "--model-settings-file")).toBe(preview.modelSettingsPath);
    expect(preview.argv.filter((arg) => arg === "--model-settings-file")).toHaveLength(1);
  });

  test("deny and tool removal are retained for a representative resumed turn", () => {
    const preview = buildAiderSessionPreview({
      harnessHome: HARNESS_HOME, sessionId: SESSION_ID, hermetic: true,
      autonomy: "high", permissionPolicy: "deny", tools: "none",
    });
    expect(preview.argv.slice(0, 4)).toEqual([
      "env", `HOME=${preview.privateHome}`, "AIDER_YES_ALWAYS=false", "aider",
    ]);
    expect(preview.argv).not.toContain("--yes-always");
    expect(flagValue(preview.argv, "--chat-mode")).toBe("ask");
    expect(preview.argv).toContain("--no-git");
    expect(flagValue(preview.argv, "--map-tokens")).toBe("0");
    expect(preview.argv).toEqual(buildAiderSessionCommand({
      autonomy: "high", permissionPolicy: "deny", tools: "none",
      historyPath: preview.historyPath, analyticsPath: preview.analyticsPath,
      hermeticEnvAssignments: [`HOME=${preview.privateHome}`], prompt: "codemux session",
    }));
  });

  test("fresh IDs remain distinct without minting or recording inside the helper", () => {
    const first = buildAiderSessionPreview({
      harnessHome: HARNESS_HOME, sessionId: SESSION_ID, hermetic: false, autonomy: "low",
    });
    const second = buildAiderSessionPreview({
      harnessHome: HARNESS_HOME, sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      hermetic: false, autonomy: "low",
    });
    expect(first.historyPath).not.toBe(second.historyPath);
    expect(first.argv).not.toContain("--dry-run");
    expect(first.argv).not.toContain("--yes-always");
    expect(buildAiderSessionPreview({
      harnessHome: HARNESS_HOME, sessionId: SESSION_ID, hermetic: false, autonomy: "low",
    })).toEqual(first);
  });

  test("sandbox formatting preserves the representative child command", () => {
    const preview = buildAiderSessionPreview({
      harnessHome: HARNESS_HOME, sessionId: SESSION_ID, hermetic: true,
      autonomy: "medium", model: "native/model", maxOutputTokens: 42,
    });
    // Synthetic executable paths: this pure formatter starts no resolver or child.
    const command = buildScodeCommand(preview.argv, "/preview-only/work", "medium",
      { trust: "standard", noNet: true, scrubEnv: true }, "/preview-only/scode");
    expect(command.slice(-preview.argv.length)).toEqual(preview.argv);
    expect(command[0]).toBe("/preview-only/scode");
    expect(command).toContain("--no-net");
    expect(command.map(escapeArgvForPrint).join("\n")).toContain("--message=codemux session");
  });

  test.each(["../escape", "", SESSION_ID.toUpperCase()])("refuses an invalid ID: %s", (sessionId) => {
    expect(() => buildAiderSessionPreview({
      harnessHome: HARNESS_HOME, sessionId, hermetic: true, autonomy: "low",
    })).toThrow("aider session preview requires a lowercase UUID session ID");
  });
});

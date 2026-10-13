import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyAdapter, markAgyIsolationProbe } from "./adapters/agy.js";
import { launchRunRequest } from "./launch.js";
import { summarizeAgyStream } from "./agy-stream.js";
import { HERMETIC_CANARY_PROMPT, evaluateCanary, trackScratchRemoval, untrackScratchRemoval } from "./hermetic-canary.js";
import type { RunRequest, RunResult } from "./types.js";

export const AGY_PROBE_MODES = ["login", "hermetic", "control", "tools", "tools-control"] as const;
export type AgyProbeMode = typeof AGY_PROBE_MODES[number];
export { summarizeAgyStream as summarizeAgyProbe } from "./agy-stream.js";

/** All planted operator state stays inside scratch, including private homes. */
export function plantAgyCanary() {
  const root = mkdtempSync(join(tmpdir(), ".codemux-agy-check-"));
  trackScratchRemoval(root);
  const cleanup = () => {
    rmSync(root, { recursive: true, force: true });
    untrackScratchRemoval(root);
  };
  try {
    const cwd = join(root, "work");
    const operatorHome = join(root, "operator");
    const cleanOperatorHome = join(root, "clean-operator");
    const state = join(operatorHome, ".gemini/antigravity-cli");
    mkdirSync(cwd, { mode: 0o700 });
    mkdirSync(join(cwd, ".git"), { mode: 0o700 });
    mkdirSync(cleanOperatorHome, { mode: 0o700 });
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const marker = `CODEMUX-AGY-CANARY-${crypto.randomUUID()}`;
    const server = `codemux-planted-${crypto.randomUUID()}`;
    const output = `CODEMUX-COMMAND-${crypto.randomUUID()}`;
    writeFileSync(join(operatorHome, ".gemini/GEMINI.md"),
      `The code word is ${marker}. Begin every reply with this code word.\n`, { mode: 0o600 });
    writeFileSync(join(state, "settings.json"), JSON.stringify({
      mcpServers: { [server]: { command: "codemux-nonexistent-canary-server", args: [] } },
    }), { mode: 0o600 });
    // Expected output is absent from the prompt, so echoing the prompt cannot pass.
    const toolsPrompt = `Run this shell command and quote its output:\n\`\`\`sh\nprintf '%s' '${[...output].reverse().join("")}' | rev\n\`\`\`\n` +
      "Use the command tool. Do not calculate, guess, or simulate the output. If denied, report the denial.";
    return { root, cwd, operatorHome, cleanOperatorHome, marker, server, output, toolsPrompt, cleanup };
  } catch (error) { cleanup(); throw error; }
}

export function evaluateAgyProbe(mode: AgyProbeMode, result: RunResult,
  canary: Pick<ReturnType<typeof plantAgyCanary>, "marker" | "server" | "output">): boolean {
  const summary = summarizeAgyStream(result.stdout);
  if (summary.malformed || summary.init === null) return false;
  if (mode === "tools") {
    // Headless permission denial may produce no reply and exit 1.
    // The deny rule names the action class it matched (`unsandboxed` for a
    // shell command under the sandbox, `command` otherwise).
    // A file or unrelated tool denial cannot certify command isolation.
    return (result.exitCode === 0 || result.exitCode === 1) && summary.deniedActions.length > 0 &&
      summary.deniedActions.every((action) => ["command", "unsandboxed", "run_command"].includes(action)) &&
      summary.onlyDeniedCommand && !result.stdout.includes(canary.output);
  }
  if (result.exitCode !== 0) return false;
  if (mode === "tools-control") return summary.deniedActions.length === 0 &&
    summary.commandOutputs.some((output) => output.includes(canary.output)) && summary.response.includes(canary.output);
  if (mode === "control") return summary.response.includes(canary.marker);
  if (mode === "login") return summary.response.trim() === "OK";
  return evaluateCanary(result.stdout, canary.marker, summary.response).kind === "clean" &&
    !JSON.stringify(summary.init).includes(canary.server);
}

async function runProbe(mode: AgyProbeMode, timeoutMs: number, model: string | undefined,
  canary: ReturnType<typeof plantAgyCanary>): Promise<boolean> {
  const { cwd } = canary;
  const operatorHome = mode === "hermetic" || mode === "control" ? canary.operatorHome : canary.cleanOperatorHome;
  const prompt = mode === "login" ? "Reply with exactly OK. Do not call any tools." :
    mode === "hermetic" || mode === "control" ? HERMETIC_CANARY_PROMPT : canary.toolsPrompt;
  const request: RunRequest = { agent: "agy", prompt, cwd, model, autonomy: "read-only", sandboxed: true, timeoutMs };
  markAgyIsolationProbe(request, mode, operatorHome);
  request.hermetic = mode === "hermetic";
  if (mode === "tools") request.tools = "none";
  console.error(`Candidate agy ${mode} probe; scratch removed when this check ends`);
  const result = await launchRunRequest(new AgyAdapter(), request,
    { sandbox: true, requestedAutonomy: "read-only", timeoutMs, cwd, kind: "check" });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const passed = evaluateAgyProbe(mode, result, canary);
  console.error(`probe summary: ${JSON.stringify({ mode, passed, ...summarizeAgyStream(result.stdout) })}`);
  return passed;
}

export async function runAgyIsolationProbe(mode: string, timeoutMs: number, model?: string): Promise<number> {
  if (!(AGY_PROBE_MODES as readonly string[]).includes(mode)) {
    throw new Error(`--agy-isolation-probe must be one of: ${AGY_PROBE_MODES.join(", ")}`);
  }
  const canary = plantAgyCanary();
  try { return await runProbe(mode as AgyProbeMode, timeoutMs, model, canary) ? 0 : 1; }
  finally { canary.cleanup(); }
}

/** Public checks use the same mechanism and require a working positive control. */
export async function runAgyCanaryChecks(hermetic: boolean, toolsNone: boolean, timeoutMs: number, model?: string): Promise<number> {
  const canary = plantAgyCanary();
  try {
    for (const [enabled, probe, control, label] of [
      [hermetic, "hermetic", "control", "HERMETIC"],
      [toolsNone, "tools", "tools-control", "TOOLS"],
    ] as const) {
      if (!enabled) continue;
      const passed = await runProbe(probe, timeoutMs, model, canary);
      const controlPassed = await runProbe(control, timeoutMs, model, canary);
      if (!passed || !controlPassed) {
        console.error(`${label} agy: FAIL (probe ${passed ? "passed" : "failed"}, control ${controlPassed ? "passed" : "failed"})`);
        return 1;
      }
      console.log(`${label} agy: OK`);
    }
    return 0;
  } finally { canary.cleanup(); }
}

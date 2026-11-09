import { dirname, join, parse } from "node:path";
import { lstatSync } from "node:fs";
import type { ProjectSettingsRequest } from "./claude-project-settings.js";
import { UsageRefusalError } from "./validation.js";

/** Gemini 0.60.0 loads .gemini/settings.json and policies from cwd while
 * GEMINI_CLI_HOME relocates the user settings and integrations. Workspace
 * deny rules precede built-in yolo approvals (chunk-M6NSK26M.js
 * getPolicyTier; chunk-OCLZG6C5.js _doLoadSettings; 2026-11-09). */
export function validateGeminiProjectSettings(request: ProjectSettingsRequest): void {
  const refuse = (message: string): never => {
    throw new UsageRefusalError(`--experiment-project-settings ${message}`);
  };
  if (!request.hermetic) refuse("requires --hermetic");
  if (!request.sandbox) refuse("requires the scode sandbox");
  if (request.autonomy !== "low" && request.autonomy !== "high") refuse("requires --auto low or high for gemini");
  if (request.tools === "none") refuse("cannot be combined with --tools none");
  if (request.experimentMcp) refuse("cannot be combined with --experiment-mcp");
  if (request.passthroughEnv?.includes("GEMINI_CLI_HOME")) refuse("owns GEMINI_CLI_HOME");
  const root = parse(request.cwd).root;
  for (let directory = dirname(request.cwd); ; directory = dirname(directory)) {
    for (const name of ["GEMINI.md", ".gemini", join(".agents", "skills")]) {
      const path = join(directory, name);
      // The claude-family ancestor-walk contract: a missing entry continues,
      // and an ancestor that cannot be inspected refuses the run (fail
      // closed) instead of escaping as an unhandled I/O error.
      try {
        lstatSync(path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        refuse(`cannot inspect ${path} (${code ?? "unknown error"}); an ancestor of the working directory that might carry Gemini configuration refuses the run`);
      }
      refuse(`refuses ancestor Gemini configuration at ${path}`);
    }
    if (directory === root) break;
  }
}

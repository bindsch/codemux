import type { HarnessContract } from "./harness-contracts.js";

// Upstream CLI cli-v3.0.74, read 2026-11-09. Commander prints CLI_VERSION
// for --version; the release tag is the audited source for these carriers.
// https://github.com/cline/cline/blob/cli-v3.0.74/apps/cli/src/commands/program.ts#L22-L30
export const CLINE_HARNESS_CONTRACT: HarnessContract = {
  scheme: "semver", versionArgs: ["--version"],
  pattern: /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/,
  min: "3.0.74", maxAudited: "3.0.74", unknownVersion: "refuse",
};

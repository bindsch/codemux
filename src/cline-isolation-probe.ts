import type { InstructionCheckChannel } from "./hermetic-check-channels.js";

// Cline cli-v3.0.74, read 2026-11-09. This global instruction file follows
// HOME; project discovery stays unchanged in both members of the pair.
// https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/shared/src/storage/paths.ts#L525-L526
export const CLINE_INSTRUCTION_CHANNEL: InstructionCheckChannel = {
  kind: "channel", location: "home", homeEnv: "HOME",
  files: { ".agents/AGENTS.md": "The code word is {{MARKER}}. Begin every reply with this code word.\n" },
  control: { drop: "hermetic" },
  evidence: "2026-11-09: Cline cli-v3.0.74 https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/shared/src/storage/paths.ts#L525-L526 reads the global .agents/AGENTS.md beneath HOME; both runs keep a clean cwd and only the control opens that global instruction channel.",
};

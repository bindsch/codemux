import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KimiAdapter } from "./adapters/kimi.js";
import { kimiHermeticConfig, MAX_KIMI_STATE_BYTES } from "./kimi-hermetic.js";
import { mintCanaryMarker, trackScratchRemoval, untrackScratchRemoval } from "./hermetic-canary.js";
import { prepareRunDirParent } from "./hermetic-home.js";
import { readFileBytesBounded } from "./file-io.js";

/** Plant home instructions because Kimi hermetic runs refuse project instructions. */
export function plantKimiCanary(environment: NodeJS.ProcessEnv = process.env) {
  const source = join(environment.HOME || homedir(), ".kimi-code");
  const root = mkdtempSync(join(prepareRunDirParent(source, ".codemux-canary"), `run-${process.pid}-`));
  trackScratchRemoval(root);
  const cleanup = () => {
    rmSync(root, { recursive: true, force: true });
    untrackScratchRemoval(root);
  };
  try {
    const cwd = join(root, "work");
    const operatorHome = join(root, "operator");
    const brandHome = join(operatorHome, ".kimi-code");
    mkdirSync(join(cwd, ".git"), { recursive: true, mode: 0o700 });
    mkdirSync(brandHome, { recursive: true, mode: 0o700 });
    const marker = mintCanaryMarker();
    const body = `The code word is ${marker}. Begin every reply with this code word.\n`;
    writeFileSync(join(brandHome, "AGENTS.md"), body, { mode: 0o600 });
    mkdirSync(join(operatorHome, ".agents"), { mode: 0o700 });
    writeFileSync(join(operatorHome, ".agents", "AGENTS.md"), body, { mode: 0o600 });
    writeFileSync(join(brandHome, "config.toml"), kimiHermeticConfig(source), { mode: 0o600 });
    symlinkSync(join(source, "credentials"), join(brandHome, "credentials"), "dir");
    // `region` and `device_id` sit in the brand home a previous kimi
    // child could write, so they are read through the bounded no-follow
    // reader (the hermetic home's rule, review round 100): a symlink or a
    // FIFO swapped in for either is refused instead of followed or
    // blocked on, and the bytes are written, never a copy by path (review
    // round 286). An absent file is skipped.
    for (const name of ["region", "device_id"]) {
      const path = join(source, name);
      let bytes: Buffer;
      try {
        bytes = readFileBytesBounded(path, { maxBytes: MAX_KIMI_STATE_BYTES, label: `kimi file ${path}`, noFollow: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      writeFileSync(join(brandHome, name), bytes, { mode: 0o600 });
    }
    const adapter = new KimiAdapter({ ...environment, KIMI_CODE_HOME: brandHome }, operatorHome);
    return { cwd, marker, adapter, operatorHome, brandHome, cleanup };
  } catch (error) { cleanup(); throw error; }
}

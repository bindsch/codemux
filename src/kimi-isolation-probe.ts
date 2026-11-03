import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KimiAdapter } from "./adapters/kimi.js";
import { kimiHermeticConfig } from "./kimi-hermetic.js";
import { mintCanaryMarker, trackScratchRemoval, untrackScratchRemoval } from "./hermetic-canary.js";
import { prepareRunDirParent } from "./hermetic-home.js";

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
    for (const name of ["region", "device_id"]) {
      if (existsSync(join(source, name))) copyFileSync(join(source, name), join(brandHome, name));
    }
    const adapter = new KimiAdapter({ ...environment, KIMI_CODE_HOME: brandHome }, operatorHome);
    return { cwd, marker, adapter, operatorHome, brandHome, cleanup };
  } catch (error) { cleanup(); throw error; }
}

import type { ProjectSettingsSessionDir } from "../claude-project-config.js";
import type { SessionPrivateHome } from "./private-home-types.js";

/** Abort cleanup removes only directories created by this invocation. */
export function abandonFreshSessionDirectories(
  project: ProjectSettingsSessionDir | null,
  projectResumed: boolean,
  privateHome: SessionPrivateHome | null,
  privateHomeResumed: boolean
): void {
  if (project !== null && !projectResumed) project.remove();
  if (privateHome === null || privateHomeResumed) return;
  try {
    privateHome.remove();
  } catch (error) {
    console.error(
      `codemux: cannot remove the fresh hermetic session home ${privateHome.dir} ` +
        `(${error instanceof Error ? error.message : String(error)}); the stale sweep removes it later`
    );
  }
}

/**
 * The run context a hermetic kimi session hands the adapter's env
 * assembly for every turn (adapters/kimi.ts getRunEnv refuses a hermetic
 * launch whose context carries no home). The path fields read through
 * getters so they follow the private home's settle rename: the launcher
 * caches the turn environment before the driver may settle, so a plain
 * value would name the run-shaped directory after the rename. The values
 * carry no home paths into the child environment; the redirect rides the
 * driver's own argv prefix. `finalize` is a no-op: the home belongs to
 * the session, not to one turn.
 */
import { join } from "node:path";
import type { RunContext } from "../adapters/base.js";
import { kimiPrivateBrandHome, kimiPrivateSkillsDir } from "../kimi-hermetic.js";
import type { SessionPrivateHome } from "./private-home-types.js";

export function kimiHermeticTurnContext(home: SessionPrivateHome): RunContext {
  return {
    kimiHermeticHome: {
      get home(): string {
        return home.dir;
      },
      get kimiHome(): string {
        return kimiPrivateBrandHome(home.dir);
      },
      get skillsDir(): string {
        return kimiPrivateSkillsDir(home.dir);
      },
      // Never named by the session's argv (the run path's --agent-file
      // has no session spelling); the shape requires it.
      agentFile: join(home.dir, "agent.md"),
      finalize: () => {},
    },
  };
}

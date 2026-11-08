/** Kimi's brand-home resolution: where a run of kimi reads config.toml,
 * skills and its store from, and the rules a passed-through
 * KIMI_CODE_HOME must satisfy. The adapter (kimi.ts) delegates to these
 * functions; the refusals are UsageRefusalError, exit 64, on every path
 * that shares them. */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { UsageRefusalError } from "../validation.js";

/** The user home a run sees: the seam, else $HOME, else the account home. */
export function kimiEffectiveHome(
  environment: NodeJS.ProcessEnv,
  homeDirectory?: string
): string {
  if (homeDirectory !== undefined && !isAbsolute(homeDirectory)) {
    throw new Error("Kimi home directory must be an absolute path");
  }
  const home = homeDirectory ?? environment.HOME;
  return home && isAbsolute(home) ? home : homedir();
}

/**
 * The brand home whose `.codemux/` holds the generated agent file: the one
 * a plain run of this request reads config.toml, skills and agents from.
 * The sanitized child environment drops KIMI_CODE_HOME unless the operator
 * passes it through with --pass-env, in which case both kinds of run use
 * that directory. The value is read exactly as the child receives it --
 * the session boundary's belief (round al11), applied to the run path
 * (round al21, contracts-2 minor 7): kimi reads the variable without
 * trimming, so a padded value names a real (differently spelled)
 * directory to the child, and a trimmed copy here placed the generated
 * agent file under a spelling the child never reads. An empty value is
 * refused rather than treated as unset (round al16, the session's rule):
 * kimi's own resolver preserves an empty KIMI_CODE_HOME and places its
 * store under the working directory, so no default codemux could fall
 * back to names the directory the child actually uses. A value that names
 * no existing directory is refused too, on every run that passes the
 * variable through (round al29, correctness major 5; the TUI path joined
 * in round al30, contracts minor — validateTuiRequest ran the model and
 * project checks but not this one, so `codemux tui -a kimi` launched with
 * a typo'd home where the same run was refused): the child reads its
 * config, skills and store from that directory whatever the run kind, so
 * a passed-through value is the operator naming their real brand home,
 * and a missing one is a typo kimi would paper over by creating a fresh,
 * empty store. The DEFAULT home carries no such check: it legitimately
 * does not exist before kimi's own first run.
 */
export function kimiRealBrandHome(
  environment: NodeJS.ProcessEnv,
  passthroughEnv: readonly string[] | undefined,
  effectiveHome: string
): string {
  const passedThrough = passthroughEnv?.includes("KIMI_CODE_HOME") ?? false;
  const configured = environment.KIMI_CODE_HOME;
  if (!passedThrough || configured === undefined) {
    return join(effectiveHome, ".kimi-code");
  }
  if (configured === "") {
    throw new UsageRefusalError(
      "KIMI_CODE_HOME must not be empty when passed through; kimi's own " +
        "resolver preserves an empty value and places its store under the " +
        "working directory — unset the variable or give it an absolute " +
        "path"
    );
  }
  if (!isAbsolute(configured)) {
    throw new UsageRefusalError("KIMI_CODE_HOME must be an absolute path");
  }
  let stat: ReturnType<typeof statSync> | null;
  try {
    stat = statSync(configured);
  } catch {
    stat = null;
  }
  if (stat === null || !stat.isDirectory()) {
    throw new UsageRefusalError(
      "KIMI_CODE_HOME must be an existing directory when passed through; " +
        "the value names no directory here — kimi would create a fresh, " +
        "empty store under it instead of reading the brand home the " +
        "operator meant, so the typo fails the launch rather than " +
        "silently forking the store. Create the directory or unset the " +
        "variable"
    );
  }
  return configured;
}

/**
 * The brand home a finished run's result processing reads: the hermetic
 * home when one was prepared, else the launch-time rule above — except
 * that a failed experiment run, or a passed-through directory that no
 * longer exists between spawn and result, answers the default home
 * under the effective home instead. Result time never re-refuses what
 * launch time validated (review round 372, item 4): a run that already
 * executed and spent quota keeps its result rather than reading as a
 * launch failure, the same fallback the experiment path's failure arm
 * used.
 */
export function kimiResultBrandHome(
  environment: NodeJS.ProcessEnv,
  passthroughEnv: readonly string[] | undefined,
  homeDirectory: string | undefined,
  hermeticHome: string | undefined,
  failure: boolean
): string {
  if (hermeticHome !== undefined) return hermeticHome;
  const effectiveHome = kimiEffectiveHome(environment, homeDirectory);
  if (failure) return join(effectiveHome, ".kimi-code");
  try {
    return kimiRealBrandHome(environment, passthroughEnv, effectiveHome);
  } catch {
    return join(effectiveHome, ".kimi-code");
  }
}

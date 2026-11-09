import { findKimiWireLog, MAX_KIMI_WIRE_BYTES, readBoundedKimiFile } from "../kimi-wire-log.js";
import { UsageRefusalError } from "../validation.js";

/** Kimi 2.5.2 profileActiveToolsKey is replayable: profile.bind installs
 * activeToolNames, tools.set_active_tools replaces it, and reset removes it.
 * Check the same native state before resume rather than re-supplying the
 * creation-only --agent-file option. Default profiles can omit the list. */
export function assertKimiResumeTools(brandHome: string, sessionId: string, tools: "none" | "default" = "default"): void {
  let source: string;
  try { source = readBoundedKimiFile(findKimiWireLog(brandHome, sessionId), MAX_KIMI_WIRE_BYTES); }
  catch (error) {
    if (tools === "default") return;
    throw new UsageRefusalError(`kimi cannot verify --tools none for the resumed session: ${error instanceof Error ? error.message : error}`);
  }
  let active: unknown;
  for (const line of source.split(/\r?\n/).filter((entry) => entry.trim() !== "")) {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; }
    catch { throw new UsageRefusalError("kimi cannot verify the resumed tool policy: malformed native wire log"); }
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      throw new UsageRefusalError("kimi cannot verify the resumed tool policy: invalid native wire record");
    }
    if (event.type === "profile.bind") active = event.activeToolNames;
    else if (event.type === "tools.set_active_tools") active = event.names;
    else if (event.type === "tools.reset_active_tools") active = undefined;
  }
  const nativeNone = Array.isArray(active) && active.length === 0;
  if ((tools === "none") !== nativeNone) {
    throw new UsageRefusalError(`kimi resumed session has ${nativeNone ? "no tools" : "its original tools"}; resume with --tools ${nativeNone ? "none" : "default"}`);
  }
}

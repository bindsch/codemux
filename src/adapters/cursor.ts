import { BaseAdapter } from "./base.js";
import { assertNoCursorProjectExecutionConfig } from "../project-safety.js";
import { validateWorkingDirectory } from "../validation.js";
import type {
  AdapterCapabilities,
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
} from "../types.js";

/**
 * The explicit opt-in for the desktop `cursor agent` entry point: the
 * variable must be set to `cursor` in codemux's environment AND the name
 * must be passed through (`--pass-env CODEMUX_CURSOR_ENTRY`). The passthrough
 * is the authorization: it is argv the operator typed, not something a
 * repository, shell profile, or direnv can inject, and without it the
 * desktop entry is refused at launch validation -- before the version gate
 * could execute anything -- even when the variable itself is set.
 */
export const CURSOR_ENTRY_ENV = "CODEMUX_CURSOR_ENTRY";

/**
 * One of the entries a launch may run. By default -- and exactly as in
 * 0.6.0 -- the standalone `agent` (Cursor's shipped CLI) wins, then the
 * legacy `cursor-agent` alias; neither resolving means "not installed".
 * The desktop `cursor agent` subcommand is not in that chain at all: the
 * Cursor.app 3.23.12 launcher downloads and runs
 * `https://cursor.com/install` when `~/.local/bin/cursor-agent` is absent
 * and runs `cursor-agent update` when the installed build is older than it
 * wants, before exec-ing that same `~/.local/bin/cursor-agent` -- so
 * invoking it may install or update software outside any sandbox, and
 * codemux must never do that on its own initiative. It runs only under the
 * CURSOR_ENTRY_ENV opt-in, where the operator has accepted that behavior:
 * with the opt-in, the trust check applies to the `cursor` binary resolved
 * against the requested working directory, and the version gate probes
 * `cursor agent --version` only after that check and only inside the
 * launch path -- never in `isAvailable`, `list`, `doctor`, `verify`, or the
 * installed-contract suite. The flag surface is the same for every entry
 * (`cursor agent --help` is byte-identical to `agent --help` apart from the
 * usage line); the entry only decides the argv prefix, the name the gate
 * and trust check resolve, and the version probe's arguments (see the
 * cursor contract in harness-compatibility.ts). Resolution itself is
 * spawn-free either way.
 */
interface CursorEntry {
  readonly name: "cursor" | "agent" | "cursor-agent";
  readonly prefix: readonly string[];
}

const AGENT_ENTRY: CursorEntry = { name: "agent", prefix: ["agent"] };
const CURSOR_AGENT_ENTRY: CursorEntry = {
  name: "cursor",
  prefix: ["cursor", "agent"],
};
const LEGACY_ALIAS_ENTRY: CursorEntry = {
  name: "cursor-agent",
  prefix: ["cursor-agent"],
};

export class CursorAdapter extends BaseAdapter {
  readonly id: AgentId = "cursor";

  private readonly cursorBinary: string | null;
  private readonly agentBinary: string | null;
  private readonly aliasBinary: string | null;
  private readonly desktopOptIn: boolean;

  constructor(
    findBinary: (name: string) => string | null = (name) =>
      Bun.which(name, { PATH: process.env.PATH }),
    env: Record<string, string | undefined> = process.env
  ) {
    super();
    this.cursorBinary = findBinary("cursor");
    this.agentBinary = findBinary("agent");
    this.aliasBinary = findBinary("cursor-agent");
    this.desktopOptIn = env[CURSOR_ENTRY_ENV] === "cursor";
  }

  get binaryName(): string {
    return this.entry().name;
  }

  private entry(): CursorEntry {
    // The opt-in selects the desktop entry outright, standalone builds
    // included: an operator who set it asked for the wrapper's entry, not
    // the binary the wrapper would forward to. When the opt-in names a
    // `cursor` that does not resolve, the default chain answers instead.
    if (this.desktopOptIn && this.cursorBinary !== null) {
      return CURSOR_AGENT_ENTRY;
    }
    if (this.agentBinary !== null) return AGENT_ENTRY;
    if (this.aliasBinary !== null) return LEGACY_ALIAS_ENTRY;
    // The name the "harness not found" error reports.
    return AGENT_ENTRY;
  }

  override isAvailable(): boolean {
    // Spawn-free: `list`, `doctor`, and `verify` ask this for every adapter
    // and must not launch anything. The desktop `cursor` counts as installed
    // only under the opt-in; without it a desktop-only machine reports
    // cursor as not installed, exactly as before the desktop entry existed.
    return (
      this.agentBinary !== null ||
      this.aliasBinary !== null ||
      (this.desktopOptIn && this.cursorBinary !== null)
    );
  }

  capabilities(): AdapterCapabilities {
    return {
      supportsNonInteractive: true,
      supportsInteractive: true,
      supportsModel: true,
      supportsAutonomy: true,
      autonomyLevels: ["read-only", "low", "medium", "high"],
      supportsEffort: false,
      effortLevels: [],
    };
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    switch (level) {
      case "read-only":
        return ["--mode", "plan"];
      case "low":
        return [];
      case "medium":
        return ["--auto-review"];
      case "high":
        return ["--force"];
    }
  }

  /**
   * The desktop entry runs only when the operator named the opt-in on the
   * command line. The variable being set is not enough, however it was
   * populated: a shell profile or repository-controlled environment must not
   * turn codemux into something that executes an installer-capable wrapper,
   * so a launch whose request did not pass the name through is refused with
   * both fixes named rather than silently falling back. Launch validation
   * runs before the version gate on every launch path, so this refusal also
   * precedes the gate's `cursor agent --version` probe -- the wrapper cannot
   * execute against an invocation the operator did not authorize. Static
   * diagnostics never see the refusal at all: verify constructs its
   * adapters against an explicitly empty environment view (see
   * STATIC_WIRING_ENV in src/verify.ts), so the desktop entry is not even
   * selected there and an exported variable cannot fail a wiring check.
   */
  private assertDesktopEntryAuthorized(
    passthroughEnv: readonly string[] = []
  ): void {
    if (this.entry().name !== "cursor") return;
    if (passthroughEnv.includes(CURSOR_ENTRY_ENV)) return;
    throw new Error(
      `CODEMUX_CURSOR_ENTRY=cursor selects Cursor's desktop entry, whose wrapper may install or ` +
        `update the agent on first use; codemux runs it only when the operator names it: ` +
        `add --pass-env ${CURSOR_ENTRY_ENV}, or unset ${CURSOR_ENTRY_ENV} to use the standalone entries`
    );
  }

  buildRunCommand(request: RunRequest): string[] {
    const cmd = [
      ...this.entry().prefix,
      "--print",
      "--output-format",
      "text",
      "--trust",
    ];
    if (request.sandboxed) {
      cmd.push("--sandbox", "disabled");
    }
    if (request.model) {
      cmd.push("--model", request.model);
    }
    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }
    return cmd;
  }

  override getStdinInput(request: RunRequest): string | null {
    return request.prompt;
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoCursorProjectExecutionConfig(
      validateWorkingDirectory(request.cwd) ?? process.cwd()
    );
    this.assertDesktopEntryAuthorized(request.passthroughEnv);
  }

  override validateTuiRequest(
    model?: string,
    cwd?: string,
    autonomy: AutonomyLevel = "read-only",
    effort?: ReasoningEffort,
    passthroughEnv: readonly string[] = [],
    enablePlaywrightMcp = false
  ): void {
    super.validateTuiRequest(
      model,
      cwd,
      autonomy,
      effort,
      passthroughEnv,
      enablePlaywrightMcp
    );
    assertNoCursorProjectExecutionConfig(
      validateWorkingDirectory(cwd) ?? process.cwd()
    );
    this.assertDesktopEntryAuthorized(passthroughEnv);
  }

  buildTuiCommand(
    model?: string,
    autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    sandboxed?: boolean
  ): string[] {
    const cmd: string[] = [...this.entry().prefix];
    if (sandboxed) {
      cmd.push("--trust", "--sandbox", "disabled");
    }
    if (model) {
      cmd.push("--model", model);
    }
    if (autonomy) {
      cmd.push(...this.mapAutonomy(autonomy));
    }
    return cmd;
  }

}

import { existsSync } from "node:fs";
import { join } from "node:path";
import { withStreamScanSurface } from "../stream-marker-scan.js";
import { BaseAdapter, type RunContext } from "./base.js";
import { assertNoCursorProjectExecutionConfig } from "../project-safety.js";
import { appendDiagnostic } from "../result-envelope.js";
import {
  readProviderOverride,
  requireProviderOverride,
  type ProviderOverride,
} from "../provider-override.js";
import { assertProviderCap } from "../provider-override.js";
import { cursorResult, parseCursorResultEnvelope } from "../result-envelope/cursor.js";
import { UsageRefusalError, validateWorkingDirectory } from "../validation.js";
import type {
  AdapterCapabilities,
  AgentId,
  AutonomyLevel,
  ReasoningEffort,
  RunRequest,
  RunResult,
} from "../types.js";
import { fileStoreLoginState, loginHome, type LoginState } from "../harness-health.js";

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
const CREDENTIAL_STORE_ENV = "AGENT_CLI_CREDENTIAL_STORE";
const AUTHENTICATION_HINT = "codemux: cursor's default login lives in the macOS Keychain, which the sandbox blocks; " +
  "log in once with the file store (AGENT_CLI_CREDENTIAL_STORE=file cursor-agent login), " +
  "pass an API key or auth token, or run with --no-sandbox";

/**
 * One of the entries a launch may run. By default the standalone
 * `cursor-agent` wins, then the `agent` alias; neither resolving means
 * "not installed". `cursor-agent` is the name Cursor's own installer lays
 * down (`~/.local/bin/cursor-agent`) and the name scode's known-harness
 * list carries; scode 0.6.0 dropped the bare `agent` name from that list
 * (the surface was too generic to keep), so a sandboxed launch of `agent`
 * warns that its sandbox behavior is untested -- the alias stays only as
 * a fallback for machines where `cursor-agent` does not resolve. The
 * desktop `cursor agent` subcommand is not in that chain at all: the
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

const STANDALONE_ENTRY: CursorEntry = {
  name: "cursor-agent",
  prefix: ["cursor-agent"],
};
const DESKTOP_ENTRY: CursorEntry = {
  name: "cursor",
  prefix: ["cursor", "agent"],
};
const AGENT_ALIAS_ENTRY: CursorEntry = { name: "agent", prefix: ["agent"] };

export class CursorAdapter extends BaseAdapter {
  readonly id: AgentId = "cursor";

  private readonly cursorBinary: string | null;
  private readonly agentBinary: string | null;
  private readonly standaloneBinary: string | null;
  private readonly desktopOptIn: boolean;
  private readonly credentialFile: string | null;

  constructor(
    findBinary: ((name: string) => string | null) | undefined = undefined,
    env: Record<string, string | undefined> = process.env
  ) {
    super(env);
    findBinary ??= (name) => Bun.which(name, { PATH: env.PATH ?? "" });
    this.cursorBinary = findBinary("cursor");
    this.agentBinary = findBinary("agent");
    this.standaloneBinary = findBinary("cursor-agent");
    this.desktopOptIn = env[CURSOR_ENTRY_ENV] === "cursor";
    // Static checks omit HOME and skip file-store selection.
    this.credentialFile = env.HOME === undefined ? null : join(env.HOME, ".cursor", "auth.json");
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
      return DESKTOP_ENTRY;
    }
    if (this.standaloneBinary !== null) return STANDALONE_ENTRY;
    if (this.agentBinary !== null) return AGENT_ALIAS_ENTRY;
    // The name the "harness not found" error reports.
    return STANDALONE_ENTRY;
  }

  override isAvailable(): boolean {
    // Spawn-free: `list`, `doctor`, and `verify` ask this for every adapter
    // and must not launch anything. The desktop `cursor` counts as installed
    // only under the opt-in; without it a desktop-only machine reports
    // cursor as not installed, exactly as before the desktop entry existed.
    return (
      this.standaloneBinary !== null ||
      this.agentBinary !== null ||
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
      // No effort carrier: the model string's bracket overrides
      // ('claude-opus-4-8[context=1m,effort=high,fast=false]', --model
      // help) are syntax, not a flag; their parameter ids are server-side
      // per model, and an invalid combination is silently dropped
      // ("Invalid parameter combination for ${model}; falling back to
      // default variant", sanitizeParametersForModelChange, 483.index.js;
      // cursor 2026.11.05, read 2026-11-09) — not fail-closed, so the
      // tier cannot ride it.
      supportsEffort: false,
      effortLevels: [],
      // No hermetic carrier: rules also load server-side from the
      // account (user_rules, cloud_instructions), which no flag or
      // private home removes (docs/isolation.md, cursor row).
      supportsResultJson: true,
      // `--allowed-tools <tool>` is an allowlist validated against the
      // proto's tool names: an unknown or renamed name aborts with exit 1
      // before any run, so `reflect_tool_call` (a no-op answer tool in
      // the 2026.11.05 descriptor, "|32 reflect_tool_call #25 tool") is a
      // fail-closed `--tools none` carrier.
      supportsToolSelection: true,
      // CURSOR_API_ENDPOINT and CURSOR_API_KEY ride the environment: the
      // agent command registers `-e, --endpoint <url>` with
      // `.env("CURSOR_API_ENDPOINT")` and `--api-key <key>` with
      // CURSOR_API_KEY (index.js option factories, 2026.11.05).
      supportsProviderOverride: true,
    };
  }

  /**
   * The provider override, validated: cursor's agent command needs a
   * base URL and a key (the model may come from `--model` instead of the
   * variable). Both token caps are refused: the model string's bracket
   * overrides carry `context`, `effort` and `fast` only — no output or
   * context cap key — and their values are server-defined per model with
   * a silent fallback on invalid combinations (the effort evidence
   * above), so no cap can ride the override verifiably.
   */
  private validatedProvider(): (ProviderOverride & { baseUrl: string; apiKey: string }) | null {
    const override = readProviderOverride("cursor", this.environment);
    if (override === null) return null;
    const noCapSurface =
      "cursor 2026.11.05 carries no token-budget surface: the model string's bracket " +
      "overrides accept context, effort and fast only, and an invalid combination is " +
      "silently dropped server-side, so no cap can ride the override";
    assertProviderCap("cursor", override, "maxOutputTokens", noCapSurface);
    assertProviderCap("cursor", override, "maxContextTokens", noCapSurface);
    return requireProviderOverride("cursor", override, [
      "baseUrl",
      "apiKey",
    ]) as ProviderOverride & { baseUrl: string; apiKey: string };
  }

  /** The model id the run requests: the request's, else the override's. */
  private modelFor(model: string | undefined): string | undefined {
    return model ?? this.validatedProvider()?.model;
  }

  override mapAutonomy(level: AutonomyLevel): string[] {
    // Low builds no flag because the default state IS low: in --print with
    // neither --force ("Force allow commands unless explicitly denied")
    // nor --auto-review, a command that needs approval is rejected
    // ("User Rejected"; headless asks are skipped — "Questions skipped in
    // headless mode" — and "Switch mode requires approval",
    // cursor-agent 2026.11.05 index.js/1706.index.js, read 2026-11-08).
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
   * adapters against a PATH-only environment view (see
   * staticWiringEnv in src/verify.ts), so the desktop entry is not even
   * selected there and an exported variable cannot fail a wiring check.
   */
  private assertDesktopEntryAuthorized(
    passthroughEnv: readonly string[] = []
  ): void {
    if (this.entry().name !== "cursor") return;
    if (passthroughEnv.includes(CURSOR_ENTRY_ENV)) return;
    // A caller mistake (the missing --pass-env opt-in), so the 64 every
    // other pre-launch refusal of this class carries — a plain Error here
    // read as a launch failure (exit 1) to any script following the docs.
    throw new UsageRefusalError(
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
      // Every run launches on the stream-json wire, plain runs included:
      // the text format prints only the buffer after the last tool call
      // (`de`, 1706.index.js result writer), so a tool-using run exited 0
      // with stdout "\n" while its reply rode the result line's `result`
      // (K, the full accumulated text) on the stream and json wires —
      // the usage events the ledger sums ride stream-json only
      // (src/result-envelope/cursor.ts, cursor 2026.11.05, read
      // 2026-11-09).
      "stream-json",
      "--trust",
    ];
    if (request.sandboxed) {
      cmd.push("--sandbox", "disabled");
    }
    const model = this.modelFor(request.model);
    if (model) {
      cmd.push("--model", model);
    }
    if (request.web === false) {
      // --exclude-tools parses a comma-separated list validated against
      // the proto ToolCall oneof field names, aborting with exit 1 on any
      // unknown value ("Invalid --exclude-tools value(s): ${s}. Expected
      // one of: ${r.join(", ")}", 1706.index.js option module) — fail
      // closed. web_search_tool_call and web_fetch_tool_call are the live
      // web tools (proto descriptor, index.js class lo at offset 5173140;
      // the renderer pairs them with "Searched web" and "Fetched";
      // fetch_tool_call is a legacy entry no renderer prints), so `--no-web`
      // removes exactly the two.
      cmd.push(
        "--exclude-tools",
        "web_search_tool_call,web_fetch_tool_call"
      );
    }
    if (request.tools === "none") {
      // "Allow only proto ToolCall oneof tool(s) for this session"
      // (--allowed-tools help): an allowlist, so a tool a later build
      // adds stays excluded, and reflect_tool_call is the one no-op entry
      // — the model may call it and it answers nothing. Values are
      // validated against the proto names with exit 1 on any unknown
      // name (1706.index.js), so a renamed tool fails the run instead of
      // quietly restoring the tool set.
      cmd.push("--allowed-tools", "reflect_tool_call");
    }
    if (request.autonomy) {
      cmd.push(...this.mapAutonomy(request.autonomy));
    }
    return cmd;
  }

  override getStdinInput(request: RunRequest): string | null {
    return request.prompt;
  }

  override getRunEnv(request: RunRequest, _context?: RunContext): Record<string, string> {
    const override = this.validatedProvider();
    // The override names outrank the passthrough: the operator asked
    // codemux to route this run, so the child receives the override's
    // endpoint and key whatever the environment carried.
    if (override !== null) {
      return {
        ...this.credentialStoreEnv(request.sandboxed, request.passthroughEnv),
        CURSOR_API_ENDPOINT: override.baseUrl,
        CURSOR_API_KEY: override.apiKey,
      };
    }
    return this.credentialStoreEnv(request.sandboxed, request.passthroughEnv);
  }

  override getTuiEnv(
    _model?: string,
    _autonomy?: AutonomyLevel,
    _effort?: ReasoningEffort,
    sandboxed?: boolean,
    passthroughEnv?: readonly string[]
  ): Record<string, string> {
    // The sandboxed TUI needs the same file-store selection as the run
    // path: the sandbox blocks cursor's Keychain login either way (review
    // round 381 — the TUI built its environment from getEnv + getTuiEnv
    // alone and failed authentication inside the sandbox). The provider
    // override rides the same environment variables the run path sets —
    // CURSOR_API_ENDPOINT and CURSOR_API_KEY reach an interactive child
    // unchanged (the option factories read them from process.env), so an
    // interactive session under an override routes like a run does.
    const override = this.validatedProvider();
    const store = this.credentialStoreEnv(sandboxed, passthroughEnv);
    if (override === null) return store;
    return {
      ...store,
      CURSOR_API_ENDPOINT: override.baseUrl,
      CURSOR_API_KEY: override.apiKey,
    };
  }

  private credentialStoreEnv(
    sandboxed?: boolean,
    passthroughEnv?: readonly string[]
  ): Record<string, string> {
    if (
      !sandboxed || process.platform !== "darwin" ||
      // The passthrough is the authorization (argv the operator typed, the
      // desktop-entry rule above): a passed-through name set to ANY value,
      // an empty string included, is the operator's hand on this name and
      // suppresses the file-store selection (review round 361). A name
      // passed through but not set carries nothing to preserve.
      (passthroughEnv?.includes(CREDENTIAL_STORE_ENV) &&
        this.environment[CREDENTIAL_STORE_ENV] !== undefined) ||
      this.credentialFile === null ||
      !existsSync(this.credentialFile)
    ) return {};
    return { [CREDENTIAL_STORE_ENV]: "file" };
  }

  override validateRunRequest(request: RunRequest): void {
    super.validateRunRequest(request);
    assertNoCursorProjectExecutionConfig(
      validateWorkingDirectory(request.cwd) ?? process.cwd()
    );
    this.assertDesktopEntryAuthorized(request.passthroughEnv);
    // Surface a half-configured override before launch, the droid/pi rule:
    // the caps refuse here and a missing baseUrl or apiKey names the fix.
    this.validatedProvider();
  }

  override processRunResult(result: RunResult, request: RunRequest, context?: RunContext): RunResult {
    // Both paths replace the stream-json capture with the answer; the
    // hermetic check scans the whole capture (stream-marker-scan.ts).
    return withStreamScanSurface(this.processStreamResult(result, request), result.stdout, context?.stdoutSink);
  }

  private processStreamResult(result: RunResult, request: RunRequest): RunResult {
    if (request.resultJson) {
      // Every run launches with --output-format stream-json, so stdout
      // ends in the result object; cursorResult re-emits it with the
      // codemux block. The authentication hint rides the same failure
      // diagnostics.
      const envelope = cursorResult(result, request);
      if (
        !request.sandboxed || process.platform !== "darwin" ||
        result.exitCode === 0 || !result.stderr.includes("Authentication required")
      ) return envelope;
      return {
        ...envelope,
        stderr: appendDiagnostic(envelope.stderr, AUTHENTICATION_HINT),
      };
    }
    // A plain run launched on the same stream-json wire, so its stdout
    // also ends in the result line: rewrite it to the complete answer —
    // every assistant segment, the ones before tool calls included, a
    // blank line between two (lane AN1), where the text format printed
    // only the trailing buffer — and
    // record the usage so the ledger is never empty. No new failure rule
    // rides here: a run whose stdout carried no result line keeps its
    // stdout and its exit status as the run path judges them.
    const parsed = parseCursorResultEnvelope(result.stdout);
    const rewritten: RunResult = parsed === null
      ? result
      : {
        ...result,
        stdout: `${parsed.answer ?? ""}\n`,
        usage: parsed.usage,
        servedModel: null,
      };
    if (
      !request.sandboxed || process.platform !== "darwin" ||
      result.exitCode === 0 || !result.stderr.includes("Authentication required")
    ) return rewritten;
    return { ...rewritten, stderr: appendDiagnostic(rewritten.stderr, AUTHENTICATION_HINT) };
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
    // The override rides environment variables an interactive child reads
    // too (getTuiEnv sets the same CURSOR_API_ENDPOINT/CURSOR_API_KEY
    // pair the run path does), so a session under an override routes like
    // a run does — validatedProvider here surfaces a half-configured
    // override before the launch.
    this.validatedProvider();
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


  /** The cursor login read: the file store the sandbox needs. */
  override loginState(): LoginState {
    return fileStoreLoginState(
      join(loginHome(this.environment), ".cursor", "auth.json"),
      "~/.cursor/auth.json"
    );
  }
}

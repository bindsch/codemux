import type { AgentId, AutonomyLevel } from "./types.js";

/**
 * Declared compatibility between this Codemux release and each upstream harness.
 *
 * Codemux translates autonomy levels into harness-native flags, and those flags
 * only mean what we think they mean for the versions we audited. Upstream can
 * keep a flag while changing what it enforces: OpenCode 1.18.18 replaced its
 * per-tool deny map with a rules list whose resolved base is allow-all, so
 * `--agent build` kept working while quietly losing its gate. Flag-presence
 * tests cannot see that, which is why compatibility is declared here.
 *
 * Three tiers, because "newer than we audited" is not the same as "broken":
 *
 *   below `min`          refuse. These releases enforce a policy this Codemux
 *                        no longer translates correctly.
 *   through `maxAudited` run silently. Exercised against this release.
 *   above `maxAudited`   run, but warn. Upstream ships patches that change
 *                        nothing, and stranding the user on every one of them
 *                        makes Codemux unusable.
 *
 * A refusal above `maxAudited` requires a `breaks` entry: something we actually
 * determined, not something we inferred from a version number. Breaks are
 * scoped to the autonomy levels they remove enforcement from, so a change that
 * costs `low` its gate does not also block `read-only`.
 */

export const ALLOW_UNTESTED_ENV = "CODEMUX_ALLOW_UNTESTED_HARNESS";

/**
 * A determined breaking change: what upstream altered, from which version, and
 * which autonomy levels stop being enforceable because of it.
 */
export interface HarnessBreak {
  /** First upstream version exhibiting the change. */
  from: string;
  /** What changed, in terms of what Codemux relies on. */
  note: string;
  /** Autonomy levels whose enforcement this removes. */
  affects: readonly AutonomyLevel[];
  /**
   * When true, the affected levels stay available if the run is sandboxed:
   * scode still supplies the boundary the harness stopped supplying. When the
   * run is not sandboxed, Codemux refuses.
   */
  mitigatedBySandbox: boolean;
}

export interface HarnessContract {
  /** `semver` for major.minor.patch; `calendar` for rolling YYYY.MM.DD builds. */
  scheme: "semver" | "calendar";
  versionArgs: readonly string[];
  pattern: RegExp;
  min: string;
  maxAudited: string;
  breaks?: readonly HarnessBreak[];
  /**
   * What a version the probe cannot read means for this harness. "warn"
   * (the default): wrapper scripts, shims, and vendored builds legitimately
   * report no version, so the gate says the contract is unconfirmed and
   * continues. "refuse": an unreadable version on THIS harness is a
   * below-`min` release rather than an unknown build -- the contract asserts
   * every release at or above `min` answers its probe -- and the tier
   * table's below-`min` rule applies instead: refuse, downgraded to a
   * warning by CODEMUX_ALLOW_UNTESTED_HARNESS like every refusal.
   */
  unknownVersion?: "warn" | "refuse";
  /**
   * Per-entry version arguments, when the probe depends on which entry
   * point resolved. Cursor is the case: the adapter runs `cursor-agent` or
   * the `agent` alias by default, and `cursor` (the `agent` subcommand
   * of the desktop CLI) only under the CODEMUX_CURSOR_ENTRY opt-in; only
   * the last needs the subcommand -- `cursor --version` reports the
   * desktop app's own semver (3.23.12), which never matches this
   * contract's calendar pattern, while `cursor agent --version` reports
   * the agent build the contract audits. The argument is the entry-point
   * name that resolved (the adapter's `binaryName`), never the resolved
   * executable's basename: the gate probes the canonical path, and the
   * standard Homebrew `cursor` symlink resolves into the Cursor.app
   * bundle as `code`, so a basename test probes the desktop app's version,
   * misses the pattern, and warns past the floor -- even for a below-floor
   * agent build. Absent, `versionArgs` runs for every entry point.
   */
  versionArgsFor?: (entryName: string) => readonly string[];
}

/**
 * Audited 2026-08-15 against the binaries installed on the release machine.
 * `maxAudited` is the version actually exercised, not a guess at what works.
 * Bump it and docs/HARNESS-COMPATIBILITY.md together.
 */
export const HARNESS_CONTRACTS: Readonly<Partial<Record<AgentId, HarnessContract>>> = {
  agy: {
    // Pinned 2026-10-04 against 1.2.14, the installed release, by probing
    // the binary's flag surface and the official docs
    // (https://antigravity.google/docs/cli/overview,
    // https://antigravity.google/docs/cli/headless). The mapping leans on
    // 1.2.14 flag behavior worth restating: the enum flags (`--effort`,
    // `--mode`, `--input-format`, `--output-format`) accept only
    // `--flag=value`, an unrecognized `--mode` value warns and continues
    // with the default mode rather than failing, and `--disable-slash-commands`
    // covers only slash-command and skill expansion in print mode.
    scheme: "semver",
    versionArgs: ["--version"],
    pattern: /^(\d+\.\d+\.\d+)/,
    min: "1.2.14",
    maxAudited: "1.2.14",
  },
  aider: {
    scheme: "semver",
    versionArgs: ["--version"],
    pattern: /aider (\d+\.\d+\.\d+)/,
    min: "0.86.0",
    maxAudited: "0.86.2",
  },
  claude: {
    scheme: "semver",
    versionArgs: ["--version"],
    pattern: /^(\d+\.\d+\.\d+)/,
    min: "2.1.220",
    maxAudited: "2.1.223",
  },
  codex: {
    scheme: "semver",
    versionArgs: ["--version"],
    pattern: /codex-cli (\d+\.\d+\.\d+)/,
    min: "0.146.0",
    maxAudited: "0.147.0",
  },
  copilot: {
    // Added 2026-09-21 with the --effort to --reasoning-effort audit. Copilot dropped a flag alias
    // between patch releases, so an unpinned version is not a safe default here: without an entry
    // `assertSupportedHarnessVersion` returns immediately and nothing records that the autonomy
    // contract is unconfirmed. Autonomy is what makes that matter -- a dropped --allow-tool would
    // fail closed on an unknown option, but silently, with no warning that the audit is stale.
    scheme: "semver",
    // `--binary-version`, not `--version`. Copilot's `--version` starts the packaged application
    // and needs a writable extraction cache first; under a restricted filesystem it fails, the
    // probe returns null, and (before the refuse-on-null rule below) the gate warned and allowed
    // the run -- so the contract stopped being enforced exactly where enforcement matters most.
    // `--binary-version` reports the
    // version without launching, and needs no cache: verified 2026-09-21 against 1.0.85, which
    // prints "Copilot binary version: 1.0.85". No --no-auto-update is needed because nothing is
    // launched.
    //
    // No compatibility gap, verified against upstream releases 2026-09-21: `--reasoning-effort`
    // is the canonical flag and has existed since v1.0.4 ("Add --reasoning-effort CLI flag to set
    // reasoning effort level"). `--effort` was only ever a shorthand alias, added in v1.0.10
    // ("Add --effort as a shorthand alias for --reasoning-effort") and since dropped -- 1.0.85's
    // help lists no `--effort`. So codemux was emitting the alias, not the flag, and every release
    // at or above `min` accepts what it emits now.
    versionArgs: ["--binary-version"],
    pattern: /Copilot binary version: (\d+\.\d+\.\d+)/,
    // `min` is the floor below which a release enforces a policy this Codemux no longer
    // translates, per the tier definition above. It is not a floor for every feature. The
    // 2026-09-21 audit was flag-surface only and found one change: the `--effort` shorthand alias
    // is gone. That affects no autonomy mapping.
    //
    // The floor is 1.0.77, the version the ledger recorded before this audit. Three other values
    // were tried and each is wrong in a way a reviewer correctly named, which is the signal that
    // `HarnessContract` cannot express this case rather than that one of them is right:
    //
    //   0.0.0   no refusal, but an effort run on an old release then emits `--reasoning-effort`,
    //           which arrived in 1.0.4. The gate calls the version supported and hands the harness
    //           an option it cannot parse.
    //   1.0.4   enforces that flag, and silently blesses 1.0.4 through 1.0.76 -- roughly seventy
    //           releases nobody audited -- because `[min, maxAudited]` is the run-silently band.
    //           The module's own OpenCode note is precisely that case: a flag surviving while its
    //           gate did not.
    //   1.0.77  refuses those same releases instead of blessing them.
    //
    // The tie-breaker is recoverability. A refusal is visible and the operator can override it
    // with CODEMUX_ALLOW_UNTESTED_HARNESS after checking upstream themselves. A false "supported"
    // offers nothing to override: it is the gate being confidently wrong, and the run proceeds as
    // though the autonomy contract were confirmed. The residual cost is refusing releases more
    // than seventy patches behind anything this repo records, with an escape hatch.
    //
    // No fallback. `--binary-version` arrived in 1.0.3, so 1.0.0 through 1.0.2 report nothing;
    // a null reading is therefore either a release below this floor or a probe that cannot vouch
    // for itself, and both are refused (unknownVersion below) rather than warned through -- the
    // tier table's below-min rule with the same override as every refusal, closing the hole this
    // floor could not close while null meant warn. Falling back to `--version` looked like the
    // fix and is worse: bare, it lets copilot auto-update and report
    // a cached newer version while the launch, which passes --no-auto-update, runs the bundled
    // older one, so the gate approves a version that never runs. With --no-auto-update it may hit
    // an unknown option on exactly the releases it serves, which cannot be checked from here.
    min: "1.0.77",
    maxAudited: "1.0.85",
    // 1.0.3, the release `--binary-version` arrived in, is below this contract's floor, so a
    // copilot that cannot answer the probe is a below-floor release: warn-and-continue here
    // would let 1.0.0 through 1.0.2 run without the documented override, exactly the tier the
    // floor exists to refuse.
    unknownVersion: "refuse",
  },
  cursor: {
    scheme: "calendar",
    versionArgs: ["--version"],
    // The adapter runs the standalone `cursor-agent`, then the `agent`
    // alias (scode 0.6.0 dropped the bare `agent` name from its
    // known-harness list, so a sandboxed `agent` launch warns that its
    // sandbox behavior is untested), and touches `cursor agent` (the
    // desktop CLI's subcommand) only under the CODEMUX_CURSOR_ENTRY
    // opt-in -- the desktop
    // wrapper installs or updates `~/.local/bin/cursor-agent` before
    // forwarding to it, so codemux never executes it on its own initiative,
    // not from diagnostics and not from the installed-contract suite (see
    // the CursorEntry comment in adapters/cursor.ts). Under the opt-in the
    // gate's probe is operator-authorized and ordered: the `cursor` binary
    // passes the trusted-executable check resolved against the run's
    // working directory first, and only then does `cursor agent --version`
    // run, inside the launch path alone. `agent --version` and
    // `cursor-agent --version` report the agent build the calendar pattern
    // matches; `cursor --version` reports the desktop app's semver (3.23.12
    // on the machine this was verified) and never does, so that entry probes
    // through the subcommand. The selector keys on the entry NAME, not the
    // resolved executable's basename: the gate hands it the canonical path,
    // and the standard Homebrew `cursor` symlink resolves into the
    // Cursor.app bundle as `code`, which a basename test would probe with
    // bare `--version` -- reading the desktop semver, missing the calendar
    // pattern, and warning past the floor even for a below-floor agent
    // build. Verified 2026-10-04 against cursor 3.23.12 /
    // agent build 2026.08.11-e8db854, whose `cursor agent --help` is
    // byte-identical to `agent --help` apart from the usage line.
    versionArgsFor: (entryName) =>
      entryName === "cursor" ? ["agent", "--version"] : ["--version"],
    pattern: /^(\d{4}\.\d{2}\.\d{2})/,
    min: "2026.07.23",
    maxAudited: "2026.08.11",
  },
  droid: {
    scheme: "semver",
    versionArgs: ["--version"],
    pattern: /^(\d+\.\d+\.\d+)/,
    min: "0.186.0",
    maxAudited: "0.186.0",
  },
  kimi: {
    scheme: "semver",
    versionArgs: ["--version"],
    pattern: /^(\d+\.\d+\.\d+)/,
    min: "0.31.0",
    maxAudited: "0.31.1",
  },
  openhands: {
    scheme: "semver",
    versionArgs: ["--version"],
    // The banner reports the SDK version; the CLI version follows "OpenHands CLI".
    pattern: /OpenHands CLI (\d+\.\d+\.\d+)/,
    min: "1.16.0",
    maxAudited: "1.16.0",
  },
  opencode: {
    scheme: "semver",
    versionArgs: ["--version"],
    pattern: /^(\d+\.\d+\.\d+)/,
    min: "1.18.10",
    maxAudited: "1.18.18",
    breaks: [
      {
        // Reported upstream, not reproduced locally: the version this machine
        // reports has been observed changing between invocations (1.18.11 and
        // 1.18.18 from identical commands), so the boundary below is recorded
        // on the report rather than on a local repro.
        from: "1.18.18",
        note:
          "the per-tool deny map became a rules list whose resolved base rule is " +
          '{"permission":"*","action":"allow","pattern":"*"}, and the old deny ' +
          "shorthand is ignored, so `--agent build` no longer gates writes or " +
          "execution on its own",
        // read-only already requires scode, and high is auto-approve by design.
        affects: ["low", "medium"],
        mitigatedBySandbox: true,
      },
    ],
  },
  zai: {
    scheme: "semver",
    versionArgs: ["--version"],
    pattern: /^(\d+\.\d+\.\d+)/,
    min: "2.1.220",
    maxAudited: "2.1.223",
  },
};

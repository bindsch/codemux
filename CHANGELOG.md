# Changelog

User-visible changes by release. Dates below are the original development
cutoff dates, not GitHub publication dates. For example, 0.12.0 was published
October 13 after its October 12 cutoff; 0.11.0, 0.7.1, 0.6.0, and 0.5.0 were
published one day after their listed dates, and 0.3.0 on August 12.
Version 0.1.0 is an untagged initial version.

Released sections are consolidated without changing their release scope.
**Correction** labels identify inaccurate earlier wording. The dated
[release-note archive](https://github.com/bindsch/codemux/blob/main/docs/archive/release-notes.md) links the complete
immutable notes and engineering evidence.

## [Unreleased]

### Changed

- A run's answer is now every assistant message the agent wrote after the
  prompt, in order, with a blank line between messages, on every harness
  (parity feature `run.answer-complete`). It used to be the final message
  only on most harnesses, so findings written before a later tool call were
  lost: a zai run returned only the tail of its answer, and a cursor run
  that ended on a tool call printed an empty line. Plain runs print the
  complete answer; `--result-json` puts it in the answer field.
- New `--result-json` block fields: `codemux.final_message` (the last
  assistant message alone, or an empty string when the run ended on a tool
  call) and `codemux.truncated` (the harness reported a
  max-tokens or length stop on the last message; stderr then carries one
  line). Agy's stream-json carries no intermediate text, so its answer stays
  the result response (a declared limitation).
- Plain runs of Gemini, Qwen, Copilot, Droid, Goose, Pi, and OpenHands now
  launch on the harness's structured stream and print the answer when the
  run ends instead of streaming the harness's text output. Plain runs of
  Claude and Z.AI move from `--output-format json` to
  `--output-format stream-json --verbose`; they printed at the end before
  and still do.
- Session turns carry every message of the turn: the Cline and Gemini ACP
  drivers split text at tool calls, the Codex driver keeps commentary
  messages, the Aider driver keeps reflected replies, and Droid turns read
  `stream-json`.

### Fixed

- `codemux check --hermetic` scans every event of a structured stream for
  the planted marker, tool results and tool inputs included, on every
  harness whose plain run prints an answer assembled from that stream
  (Claude, Z.AI, Codex, Cursor, Gemini, Qwen, Copilot, OpenCode, Cline, and
  OpenHands, as Droid, Goose, Pi, and Kimi already did). A marker that
  reached the model only through a tool result used to vanish with the
  shed event, and the check could certify a leaking run clean.

## [2.0.0] - 2026-10-31

The curated list below names every user-visible change. The long
implementation narrative behind it is preserved in the
[2.0.0 detail notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-2.0.0-details.md).

### Breaking

- Every pre-launch refusal of a caller mistake exits 64 on every command
  (run, tui, check, session, calls, usage, verify); environment failures
  before a launch — the named agent not installed, a spawn path that
  cannot be resolved — still exit 1. It was 1 on run for the prompt
  refusals (no prompt, an unreadable or empty `-f` file, a malformed,
  empty, oversized, or terminal `-f -` read; tui and check take no caller
  prompt), and on run, tui, and check for the sandbox policy option
  rules (`--sandbox-block`, `--sandbox-account`, `--sandbox-account-id`),
  the capability and combination refusals (`--enable-playwright-mcp`,
  `--no-web`), `--print-sandbox` without `--sandbox` on `run`, and the
  `--timeout`/`--pass-env`/`--auto`/`--effort`/`--tools` value errors.
  Scripts that tested for 1 must test for 64.
- A pre-launch quota gate is on by default when usagemux is installed: run,
  tui, check, and session query usagemux about the client the agent spends
  from and refuse with exit 64 when the primary usage window — or a
  week-long tier window — is below the ceiling. Set `quota:
  false` or pass `--no-quota-gate` to disable it.
- `codemux usage` without `-a` now queries every default client except agy,
  and its exit contract changed: 0 for a parsed snapshot, 1 for a usagemux
  that exits nonzero (an unreadable query, whatever its stdout held), 69 for
  an absent or untrusted usagemux, 1 for parse failures (an
  untrusted binary used to surface as a generic 1).
- The redirect stubs `docs/HARNESS-COMPATIBILITY.md` and `docs/HERMETIC.md`
  are gone (refusals now name docs/harnesses.md and docs/isolation.md), and
  dated reports moved under `docs/archive/`; update any links to them.
- Source installs need Bun 1.4.4 or newer (was 1.3.14), the Bun CI now
  provisions and Homebrew installs. Bun 1.3 rejects TOML datetime values in
  Kimi configurations and answers the experiment MCP relay's chunked and
  reset connections differently.

### Added

- Parity (W1): Cline runs accept provider overrides, JSON results, stdin prompts, private hermetic settings, and selective web denial. Codex adds writable tool removal through its native model catalog. Zai accepts explicit provider overrides across run, TUI, and session paths. Synthetic tests cover the native settings and reporting contracts.

- Parity (XM): Qwen experiment MCP runs and paired checks use a private relay configuration, exact provider-log verification, and native call records. Agy and OpenHands now refuse with dated evidence of their native inventory and schema limitations. Qwen's tool exclusions cover its complete built-in registry.

- Sessions accept `--harness-home <dir>` for a persistent caller-owned Claude, ZAI, or Codex home. Login hard links, resume checks, sandbox blocks, and synthetic canaries preserve caller settings and skills; `--final` keeps the directory. The registry pins caller-owned mode independently of its path. Older binaries that reject the new `caller_owned_home` field cannot resume these records.

- Parity (W2): Qwen runs deny every built-in tool through `--exclude-tools` and attach the Playwright server through inline `--mcp-config`; its sessions resume the minted `--session-id` ledger with per-turn tool exclusion and a tested Playwright carrier. OpenHands runs load a repository's own `.openhands` hooks under `--experiment-project-settings` and plant the Playwright server in a hermetic run's private `mcp.json`; its session driver, conversation identity, and resume carrier land in-tree pending registration. Agy prompts ride stream-json stdin and its sandboxed runs plant the Playwright server in the probe home's `mcp_config.json`. Every remaining Qwen, Agy, and OpenHands gap except experiment MCP is a recorded harness limitation with dated upstream evidence.
- Parity (W3): Copilot gains provider token caps, stdin prompts, and native token reporting; Gemini gains plain tool removal, web-tool denial, stdin prompts, output caps, and provider model evidence; Pi gains a verified soft USD cap and built-in web-tool denial. All three support TUI provider overrides and tested session lifecycles, experiment MCP on run and check, Playwright MCP on run and sessions, native session interrupt, session tools, and sandbox previews; Copilot and Gemini add experiment project settings, and Pi keeps plain provider-override sessions on its native session store.
- Parity (W4): Droid's TUI carries model, effort, and provider overrides through a private settings file, its runs deny the two web tools, and its session turns reapply the tools allowlist; Goose prompts ride stdin, its token caps ride environment aliases, and its session turns reapply `--no-profile` and can carry the Playwright server per turn; Cursor runs and sessions report usage from the stream-json per-call events, and its TUI carries provider overrides. Every remaining Droid, Goose, and Cursor gap is a recorded harness limitation with dated upstream evidence.
- Parity (W5): integrated Aider session interruption, tools, deny policy, and sandbox previews; OpenCode session homes, resume/final cleanup, tools, Playwright, TUI effort, and experiment MCP run/check. Ordinary OpenCode served-model reporting remains null because pure mode blocks response-observer plugins and native telemetry can report the requested model.
- Session drivers (cursor, droid, pi, qwen, gemini, copilot, goose) and hermetic aider
  sessions: the seven agents gain `codemux session` through one shared turn-per-process
  engine — one harness process per caller input, codemux-minted session ids where the
  harness has none of its own (cursor, pi, qwen, gemini, copilot, aider) and adopted
  native ids where it does (droid, goose), `--resume` under each agent's own id shape,
  and hermetic sessions on droid, pi, gemini, copilot, and goose through per-session
  private homes under each harness's state root (goose requires the provider override;
  qwen's safe mode is its whole hermetic claim, so it keeps no home; cursor runs plain
  sessions only), each home removed by `--final` or the stale sweep; aider sessions
  turn hermetic the same way, their chat history inside the private home. Aider, droid,
  pi, gemini, copilot, goose, and qwen accept provider overrides under each agent's own
  rules (pi's override session requires `--hermetic` plus `--model`).
- Feature-parity gate: declare every adapter feature; check capability tables, refusals, docs,
  and probe applicability; fail release checks on undocumented limits and unresolved gaps.
- Uniform autonomy carriers and served model: `codemux autonomy` and `list --json`
  (`autonomyCarrier`) print what carries each level on a headless launch (native flag,
  harness default, fed stdin, env var, or scode alone); every `session_started` and
  `turn_completed` reports `model_served` and `model_served_source` — provider or harness
  on claude, zai, and codex, declared null on agy, kimi, opencode, and aider — and
  `model_alias`, the `-m` value as typed when it resolved through `config.models` (null
  otherwise), which also rides the run envelope, every call-ledger line (session turns
  gain the model that served them as `model_effective`), and the registry record;
  `list --json` gains `sessionServedModel` per agent; opencode sessions report the
  resolved model id on `session_started` while the per-turn argv keeps the
  provider-prefixed wire id; a provider quota refusal after the spawn closes its ledger
  line as `provider-quota-refused`.
- Run parity (gemini, copilot, cline, goose, openhands, aider): gemini, copilot, goose, and
  openhands gain `--result-json` over their json output wires (openhands and copilot report no
  token usage on the wire, so their envelopes carry null usage fields); gemini, copilot, goose,
  openhands, and aider gain `--hermetic` through private homes or XDG redirects, each with the
  clean-working-directory refusal for the instruction files its harness loads from the tree
  (goose and openhands require a provider override, since nothing rides into their private
  homes); gemini gains `--tools none` through a deny-all settings file in its private home and
  copilot through a sentinel `--available-tools` value (aider and cline keep their documented
  harness limitations); gemini and goose gain provider overrides (GOOGLE_GEMINI_BASE_URL with
  GEMINI_API_KEY, and goose's OPENAI_HOST/OPENAI_BASE_PATH pair); goose gains `--effort` over
  GOOSE_THINKING_EFFORT with none mapping to off (gemini and openhands have no effort carrier
  at their installed versions, so `--effort` stays refused there); cline keeps both refusals as
  the documented limitation its absent binary leaves.
- Run parity (cursor, droid, pi, qwen): cursor gains `--result-json` over its json result line,
  `--tools none` through the validated `--allowed-tools reflect_tool_call` allowlist, and a provider
  override over CURSOR_API_ENDPOINT/CURSOR_API_KEY (effort stays refused: bracket overrides are
  silently dropped server-side); droid gains `--hermetic` through a private HOME with a hard-linked
  login and `--result-json` over `exec --output-format json`; pi gains `--hermetic` through a private
  agent directory plus `--no-context-files` and `--result-json` over its `--mode json` event wire;
  qwen gains `--effort` over a per-run system settings file, a provider override over the
  OPENAI_API_KEY/OPENAI_BASE_URL/OPENAI_MODEL trio with an output-token cap, `--result-json` over
  `--output-format json`, and a `--hermetic` claim on its always-on safe mode.
- Approval channel: session capabilities report ask support and harness evidence; Codex asks above
  read-only with native file-request correlation. `--permission-policy deny` immediately denies
  Claude/ZAI/Codex requests and applies native rules to hermetic Kimi/OpenCode/agy sessions.
  `permission_response` aliases `permission_decision` with the same validation and autonomy ceiling.
- Hermetic sessions (core, claude, zai, opencode): `codemux session --hermetic` means the
  same thing on every agent whose hermetic run is verified — none of the operator's
  instructions, skills, hooks, MCP servers, or permission rules load, the harness's state
  lives in a per-session private home that persists across turns and `--resume`, and the
  home is reported as `session_started.private_home` and removed by `--final` (now the
  flag's own requirement, not the project-settings mode's) or the two-day sweep, widened to
  session keys that are not UUIDs; claude and zai run the hermetic argv inside a private
  `CLAUDE_CONFIG_DIR` keyed by the session id — the same directory both isolation modes
  share, carrying the credential copy, with the operator's real config root blocked for the
  session's children — and a resume whose home went missing is refused as policy (78),
  never silently remade; opencode rides the run path's hermetic environment prefix on every
  turn's argv, keeps no session-keyed home (the real data directory carries the login, so
  `private_home` reports null), and under `--experiment-project-settings` adds the
  repository's own config to that prefix and drops `--pure`; `--final` removes a codex,
  kimi, or agy home after the session's children settle, leaving the record to answer a
  later resume of a fresh session with the same 78 refusal.
- Hermetic sessions (agy): `codemux session -a agy --hermetic` runs the whole session —
  turns, resume, and token refresh — in a per-session private HOME under the probe root,
  with the run path's login selection (API key, else a mode 0600 copy of the file token,
  else the Keychain item copied into a private keychain) created once at the first
  command and verified on `--resume` against the arm a `.codemux-login` marker names
  (the surviving key, the token file, or the item findable in the private mirror — never
  the mirror file's existence); no operator state is linked and no
  settings.json is written, so the caller's own policy file in the private home is the
  only one loaded, the spawn carries the same `env HOME=… XDG_*=…` prefix a run carries,
  the home settles onto `session-<conversation id>` at a resumable end and is reported as
  `session_started.private_home`, and an abandoned fresh home is removed at a
  non-resumable end or swept once its owner process is gone.
- Hermetic sessions (codex, kimi): `codemux session --hermetic` runs codex and kimi
  sessions in a per-session private home that persists across turns and `--resume` —
  codex spawns its app-server with the home as HOME and CODEX_HOME, the private
  config.toml carrying the file login store (`codex app-server` 0.166.0 accepts `-c`
  overrides; the session passes none, the config file carries the setting), and kimi
  wraps every turn in the run path's env prefix over the private
  HOME and KIMI_CODE_HOME with an empty private `--skills-dir`, generating the private
  brand home's config.toml once at the first turn from the operator's allowlisted
  config, where a caller-placed config joins the merge with its `[[permission.rules]]`
  kept whole; the home settles onto `session-<id>` before the registry record is
  released, is reported as `session_started.private_home`, and is keyed in the
  registry's `harness_home` so a resume refuses a home that went missing.
- Hermetic session canary: `codemux check --hermetic --session -a <agent>` drives five
  sessions of the same build — a hermetic one-turn question over planted instruction
  files, a control without `--hermetic` that must leak the planted code word, the
  first session resumed with `--resume` and `--final`, whose end must remove the private
  home, and a caller-owned `--harness-home` session started and resumed, which must load
  a planted private skill — planting per harness the way the run canary does (kimi and agy through their
  redirected operator homes), and cleaning up every planted file and reported private
  home, failure included; the live gate runs it as probe K (label "hermetic session") on
  every harness with both a session driver and the hermetic capability, with a
  `5 × --timeout + 30` second outer deadline, and other harnesses keep an UNSUPPORTED
  cell naming the missing half.
- `codemux run --max-budget-usd <amount>` passes a spend threshold to a
  headless `claude` or `zai` run as Claude Code's own flag, and to a `pi` run
  through a private extension that caps pi's verified native USD estimates (a
  positive amount with at most ten integer digits and two fraction digits, so
  it reaches the harness as written; every other agent refuses the flag before
  launch, and so do tui and session, where upstream applies it to `--print`
  runs only). The
  threshold is soft: Claude Code stops the run once its client-side estimate
  of the spend, at Anthropic's prices, passes it, so the final cost can exceed
  the amount and a Z.AI run's estimate is not its provider's billing. `list
  --json` reports the new `budgetLimit` capability.
- Experiment MCP on Codex and Kimi through an authenticated loopback HTTP
  relay, with explicit result-header opt-ins (`codex-wall-time`,
  `kimi-wall-time`), a per-run model catalog override for Codex, and held
  tool calls served over SSE after two seconds. Codex needs CLI 0.165.0 or
  later; Kimi needs 2.3.2 or later.
- Hermetic Kimi runs: private homes, a filtered config keeping
  `default_provider`, shared credential refreshes, project-customization
  refusals, and a paired home-instruction canary; every hermetic Kimi child
  also turns off the startup update check and the repeat breaker.
- `run --experiment-project-settings` (claude, zai, opencode) applies a
  fixture repository's own rules inside a hermetic run while the operator's
  user memory, settings, skills, plugins, and hooks stay out;
  `session --hermetic --experiment-project-settings` (claude, zai) gives a
  resumable session the same isolation, keyed by the native session id, and
  `--final` removes the directory when that session ends.
- `session --permission-policy deny` answers every permission request with an
  immediate deny recorded as `permission_denied`, so a session with no human
  on the input never waits. Every deny a session sends carries Claude Code's
  own rejection text, and a caller decision may supply its own denial
  message.
- `run --print-sandbox` and `session --print-sandbox` run the version
  preflights and the quota gate, then print the scode argv the launch would
  exec, one argument per line with control characters escaped, and exit 0
  without starting the harness run or recording anything.
- `run --sandbox-block <path>` and `session --sandbox-block <path>`
  (repeatable, absolute) pass extra scode `--block` paths through to the
  sandbox, on top of the blocks codemux attaches itself.
- Plain Kimi runs record usage: every kimi headless run launches with
  `--output-format stream-json` and unwraps reply and usage, while stdout
  keeps the plain-reply contract.
- `--result-json` for OpenCode, built over the same `--format json` stream
  plain runs already fold: reply, summed usage, and costs, with a null total
  when any component is unknown.
- `list` and `doctor` print `result-json` and `sessions` capability labels,
  and doctor reports a version-contract verdict per installed harness from
  the local version probe.
- The live gate probes every verified capability of every installed harness
  (result JSON, hermetic checks, tools-none, one session turn, one
  experiment run, an opt-in provider override) plus a zero-quota
  version-contract column and a `codemux usage --json` check.
- `make installed-layout` (part of `make release-gate`) verifies the
  Homebrew-shaped symlink tree: `--version`, `list`, and `--help` through
  the prefix symlink, and every installed docs link resolving inside the
  keg.

### Changed

- The audited ceilings move to the versions the 2026-11-06 to 2026-11-08
  live gates passed on: agy 1.5.3, claude and zai 2.1.317, codex 0.166.0,
  kimi 2.5.2 (docs/harnesses.md records the evidence per harness). droid 0.221.0 stays at
  0.186.0 for lack of credentials on the release machine.
- The live-gate report has one row per harness and probe with
  PASS/FAIL/SKIP/UNSUPPORTED, keeps harness `Warning:` lines in the row
  note, stamps the binary's `--version`, and fails the release on a stale
  version contract unless `--allow-stale-contracts` is passed.
- CI installs scode on both runners, fails the macOS runner when the sandbox
  contract skips, echoes the `[contracts] exercised` summary, and pins bun to
  the `packageManager` version in `package.json`.
- `doctor` probes every installed harness's version in parallel with a
  ten-second bound per probe instead of serially.
- The coverage floor is per file (at least 80 percent line and function over
  `src/` and `scripts/`, with evidence-based waivers), and
  `tests/file-size.test.ts` fails on any `.ts` file over 500 lines.
- `codemux tui -a pi` passes `--no-approve` at every autonomy level, as
  the headless path does: the flag is pi's project-trust switch (it ignores
  project-local files such as `.pi/SYSTEM.md`), not an approval grant.
- Codex autonomy flags changed shape on `run`, `tui`, and `session`: the
  approval policy now rides the `-c approval_policy="never"|"untrusted"`
  config override instead of `-a never|untrusted`, because codex's root
  parser drops `-a` before `exec` and `untrusted` was never a valid `-a`
  value. The sandbox mode flags (`-s read-only` and friends) are unchanged.

### Fixed

- Empty or whitespace-only answers fail on every agent: zero-exit runs become exit 1, report `Error: <agent> exited 0 with an empty answer`, mark JSON envelopes with `codemux.empty_answer: true` and `codemux.finish: "empty-answer"`, and record `finish: "empty-answer"` in the call ledger. Successful session turns without assistant text complete as `failed` with reason `empty answer`. There is no opt-out.
- The launcher starts on Ubuntu 26.04, whose `/usr/bin/stat` is uutils coreutils: its `--version` names "uutils coreutils", which the dialect check read as BSD, so every `stat` candidate was refused with `no trusted stat found`.

Earlier 2.0.0 fixes are preserved in [part 1](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-2.0.0-fixes-1.md), [part 2](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-2.0.0-fixes-2.md), [part 3](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-2.0.0-fixes-3.md).

### Upgrade notes

- The session registry gains `sandbox_block`, `project_settings`, and `final` (all three
  new in 2.0.0). Version 2.0.0 reads older records; a
  pre-2.0.0 binary's stricter validator reads a whole 2.0.0-written registry
  as corrupt, backs it up beside the registry, and starts empty, so every
  recorded resume disappears from the active registry. Upgrade every
  co-installed binary before running a 2.0.0 session; the backup copy
  survives beside the registry.
- Scripts that branch on exit codes: pre-launch refusals are 64 everywhere,
  and `codemux usage` exits 69 only for an absent or untrusted usagemux.
- Wrappers around kimi plain runs see `--output-format stream-json` in the
  child argv; stdout is unchanged.
- Operators who do not want the quota gate: set `quota: false` in the config
  file or pass `--no-quota-gate`.
- Links to `docs/HARNESS-COMPATIBILITY.md`, `docs/HERMETIC.md`, or the dated
  reports must be retargeted to docs/harnesses.md, docs/isolation.md, and
  docs/archive/.

## Earlier releases

## [0.15.1] - 2026-10-28

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#0151---2026-10-28).

## [0.15.0] - 2026-10-28

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#0150---2026-10-28).

## [0.14.2] - 2026-10-25

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#0142---2026-10-25).

## [0.14.1] - 2026-10-19

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#0141---2026-10-19).

## [0.14.0] - 2026-10-18

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#0140---2026-10-18).

## [0.13.6] - 2026-10-15

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#0136---2026-10-15).

## [0.13.5] - 2026-10-15

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#0135---2026-10-15).

## [0.13.4] - 2026-10-13

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#0134---2026-10-13).

## [0.13.3] - 2026-10-13

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#0133---2026-10-13).

## [0.13.2] - 2026-10-13

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#0132---2026-10-13).

## [0.13.1] - 2026-10-13

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#0131---2026-10-13).

## [0.13.0] - 2026-10-13

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#0130---2026-10-13).

## [0.12.0] - 2026-10-12

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#0120---2026-10-12).

## [0.11.0] - 2026-10-08

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#0110---2026-10-08).

## [0.10.0] - 2026-10-08

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#0100---2026-10-08).

## [0.9.0] - 2026-10-07

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#090---2026-10-07).

## [0.8.0] - 2026-10-07

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#080---2026-10-07).

## [0.7.1] - 2026-10-05

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#071---2026-10-05).

## [0.7.0] - 2026-10-04

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#070---2026-10-04).

## [0.6.1] - 2026-10-04

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#061---2026-10-04).

## [0.6.0] - 2026-10-03

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#060---2026-10-03).

## [0.5.2] - 2026-09-17

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#052---2026-09-17).

## [0.5.1] - 2026-09-15

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#051---2026-09-15).

## [0.5.0] - 2026-08-21

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#050---2026-08-21).

## [0.4.0] - 2026-08-15

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#040---2026-08-15).

## [0.3.1] - 2026-08-13

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#031---2026-08-13).

## [0.3.0] - 2026-08-04

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#030---2026-08-04).

## [0.2.1] - 2026-08-02

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#021---2026-08-02).

## [0.2.0] - 2026-08-02

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#020---2026-08-02).

## [0.1.0] - 2026-02-24

See the [archived release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.0.0.md#010---2026-02-24).

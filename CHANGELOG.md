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

### Fixed

- Codex 0.167+ sessions detach an idle thread with `thread/unsubscribe` and wait for its reply before closing stdin. Live 0.167.1 probes exited 0 instead of reaching the silent 45-second exit-1 watchdog. Codex 0.166 and unknown versions keep EOF shutdown; nonzero child exits still fail. The app-server initialization notification now uses `initialized`. The audited ceiling remains 0.166.0 because experiment-MCP evidence is incomplete; see [the shutdown audit](https://github.com/bindsch/codemux/blob/main/docs/codex-shutdown.md).
- Codex sessions repair native rollout paths after moving a hermetic or provider-override home, including homes left by earlier versions. Resume preserves the selected history and excludes replayed historical usage from the new session's accounting.

## [2.0.2] - 2026-11-14

### Fixed

- Harness executable exceptions use exact-file `--allow-ro` grants with scode 0.6.7+, including executables in blocked stores or the account home under a synthetic `HOME`. Strict and untrusted executable checks accept these grants; strict and untrusted also permit resolved executables behind nested `env` wrappers outside system roots. Older scode keeps writable grants and strict refusals. Caller blocks and refusals for writable state covering code remain in force. The minimum scode version is unchanged.
- Sessions now end successfully when codemux must SIGTERM or SIGKILL a lingering child after caller-requested shutdown with no open turn. Exit 143 from a stopped wrapper follows the same rule. A warning names the kill; the raw child outcome and resume rules are preserved. Unrequested nonzero exits and deaths with an open turn still fail.
- Runs whose adapters need no stdin now spawn with closed stdin, so argv/file prompt carriers such as Kimi do not wait for EOF before contacting their provider. Prompt streams, protocol exchanges, and Aider's repeating declines retain their pipes.
- Live-gate provider quota refusals become SKIP with a reason even when earlier diagnostics fill the report's warning limit. This includes agy's `RESOURCE_EXHAUSTED (code 429)` response. Other failures remain FAIL.
- Gemini, Copilot, and Cline experiment recordings now emit `model_tool_result` and `result_comparison` once per verified call, after delivery and terminal checks pass. Probe G checks Gemini's opted-in untrusted-context wrapper; Copilot and Cline retain bare content. Goose remains unchanged because its stored ledger does not prove that a model request consumed the result.

### Changed

- CI builds scode v0.6.7 (commit `2e36094`) instead of v0.6.6.

## [2.0.1] - 2026-11-11

### Added

- `--sandbox-strict` on run, session, tui, and plain check passes scode's deny-default policy with explicit state grants. It refuses env-wrapped executables outside system read grants with exit 64 instead of granting writable access to code; nested wrappers follow the same rule. Runtime grants preserve launcher isolation blocks. Strict requires sandboxing, composes with trust presets, and is recorded for session resume. Resume refuses a strict-mode mismatch. Every harness has argv or refusal coverage, including Qwen's session preview. Live support is conditional; see the declared strict limitations before relying on a successful preview.

- Session records now include `sandbox_strict`. Older binaries reject the new record shape; do not share a registry with an older codemux installation.

- `--print-sandbox` preparation uses representative artifact paths without creating or sweeping harness state. This includes provider preflights, effort settings, private session homes, and TUI configuration. Strict runtime path canonicalization failures retain exit 64 in sessions.

- `codemux complete serve|once`: brokered raw chat completions for
  measurement harnesses that run their own agent loop. A loopback-only
  OpenAI chat-completions server with a per-run bearer token forwards to
  Anthropic (translated field for field, or refused), OpenAI, OpenRouter, or
  an OpenAI-compatible endpoint. The API key comes only from a named
  environment variable, and OAuth subscription tokens are refused; a
  `--base-url` off the provider's own host needs `--key-env`. Every
  `serve` request passes request and dollar caps priced from a dated table
  (`src/complete/prices.ts`, checked against the provider pages on
  2026-11-10) and writes a ledger row of kind `complete`; an answer whose
  cost cannot be known stops the server. `once` sends one non-streaming
  request without a dollar cap. Ambient proxy variables are ignored;
  `--proxy` explicitly selects an HTTP(S) proxy for HTTPS upstreams.
  A stop signal exits 143, a cap 0 after accepted responses drain.
  See [complete](https://github.com/bindsch/codemux/blob/main/docs/complete.md).
- `codemux calls --kind <kind>` filters by record kind;
  `codemux calls --kind complete --sum` totals brokered completions, with
  the price-table estimate on its own line.

### Changed

- `codemux session --shutdown-grace` defaults to 30 s, up from 10 s. Claude Code 2.1.317 sometimes needs over 10 s to exit after a completed turn, and a SIGTERM in that window left it hung until SIGKILL, so the session ended as a harness failure.
- Version and capability probes preserve natural exit status until their configured deadline. Only a leader still running at that deadline can succeed from complete stdout, marked `stoppedAfterOutput: true`, before its whole process group is terminated. Cursor's version probe defaults to five seconds to bound its exit hang; other harnesses retain the 30-second default. Cursor model listings require their table footer. Incomplete output and capture errors remain failures. A leader's own signal or nonzero exit remains a failure when descendants retain its pipes.

- `codemux session --harness-home` refuses with exit 64 a `--pass-env` name
  the caller home sets or clears: `HOME`, `USERPROFILE`, the XDG roots, and
  the agent's own redirects and flags, such as `CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`, and Goose's `GOOSE_DISABLE_KEYRING`. It used to replace the
  caller's value without notice. `codemux check --hermetic --session`
  refuses the same names before its first session.

### Fixed

- OpenCode experiment runs accept OpenCode's tool-free title request, which omits `tools`. Only a classified title turn may omit the array, and a failed title request no longer fails the run; main turns still require the exact tool inventory. A compaction or project-copy-name turn fails with a diagnostic that names the agent. OpenCode and Pi experiment recordings now include `model_tool_result` and `result_comparison`, which the live gate's experiment probe requires. OpenCode, Pi, and Qwen write both only once the run's checks pass, so a failed run never claims an unchanged result.
- `--harness-home` sessions can launch a harness whose executable sits inside its own blocked operator store, as OpenCode's `~/.opencode/bin/opencode` and Kimi's `~/.kimi-code/bin/kimi` do. The sandbox grants the executable file only, not its directory. The same grant covers an executable in the account home when the caller's `HOME` differs from it, because scode then blocks the account home.
- The live gate's session probe reports a failed session's own `error` and `session_ended` events instead of only quota warnings. Its OpenCode `--harness-home` arm seeds the caller home with the authenticated model preference, as a real caller home holds one; without it OpenCode chose a model the subscription did not include.
- Cursor provider overrides refuse before launch with exit 64 on run, check, session, and TUI. Cursor 2026.11.05 still sends its account credential to `DashboardService/GetMe` and has no carrier for a provider model request, so the override cannot isolate a run.
- Session IDs reject path separators and dot segments for every harness. Private-home creation, relocation, and cleanup enforce containment under the recorded parent.
- Stale-session cleanup preserves resumable homes when the freshness scan exceeds its entry limit or cannot read the whole tree.
- Droid, Qwen, Copilot, and Gemini session turns preserve structured error verdicts even when the harness exits zero or supplies no error text.
- Legacy `qwen-coder` refuses unsupported `--hermetic` and `--no-web` restrictions. Qwen's configured model is no longer reported as provider identity or used to verify provider overrides.
- Cline reports unknown input and total token counts when its cache counters exceed input. Budget help describes the enforced soft spend threshold.
- Goose sessions read the native startup banner and pretty JSON transcript, retaining the session identity and reported totals across turns.
- Adapter previews build argv and environment values without creating files, linking credentials, sweeping stale directories, or registering cleanup hooks. Pi budget and TUI previews follow the same rule. Copilot result previews show the RPC command used by execution.
- A staging-file permission failure closes the opened descriptor before returning the error.
- Result parsers clear earlier replies at new user turns. Pi and Cursor keep missing token measurements unknown, and Pi, Cursor, and Goose preserve unknown or overflowing usage sums.
- Session prompt delivery failures reach the fatal outcome even when a buffered write initially succeeds. Cursor sessions honor native result failures.
- Goose and OpenHands sessions drain accepted turns during spawn-time EOF or shutdown without writing prompts to stdin; their argv and task-file carriers already deliver the prompt.
- Captured runs terminate remaining process-group descendants after normal exit.
- Correct Qwen hermetic help, provider model restrictions, Antigravity effort handling, TUI Playwright isolation, and stale session cleanup references.
- Cline history reads reuse the session's pinned executable, environment, and sandbox. Executable trust checks follow nested `env` wrappers through to the harness.
- Cline, Gemini, and Copilot ignore asynchronous replies after their owning turn or session ends.
- Test preloads replace inherited ledger and state paths. Session registry defaults honor the current `HOME`.
- Monthly and other longer quota windows cannot trigger weekly warnings through a misleading label.
- Correct result-model attribution, Claude/Z.AI request-ID limits, Qwen override requirements, and shipped session capability evidence.
- Reject repository-local executables under names beginning with two dots, including symlink targets.
- OpenHands sessions clean up only their own turn's prompt file, including failed spawns. Conversation failures fail runs and turns; recovered tool errors no longer do.
- Pi and Cline MCP bridges accept tools without the optional description. Cline delivery evidence uses the same empty-string default.
- Gemini and Cline sessions preserve original ACP lines in `raw`. All session tool inputs remain objects; missing or non-object native inputs become `{}` with the native value retained in `raw`.
- Gemini and Copilot terminal errors fail even when their diagnostic message is missing.
- Copilot and Gemini sessions preserve accepted prompts and successful responses while caller EOF or `shutdown` drains the active turn.
- Gemini, Copilot, and Pi sessions reject prompts that exceed their serialized transport limits with `text_too_long`, leaving the session usable.
- Pi MCP cleanup waits for server termination after protocol or write errors and escalates to SIGKILL when needed.
- Pi MCP handles pipe errors, server notifications, and unsupported server requests without an unhandled stream error. Cleanup releases inherited pipes after the server exits.
- Codex termination during post-run cost collection stops the metadata child, records interruption, and exits 143 instead of reporting success.
- Plain Copilot experiments return answer text without JSON duplication; plain Qwen experiments discard partial answers after failure.
- Pi session model discovery advertises its provider-reported evidence. Correct capability, accounting, effort, provider, and persistence references.
- Agy stale-lock recovery observes its retry delay and deadline when a leftover reclaim file blocks recovery.
- Copilot RPC accepts valid consecutive frames and maximum-size headers regardless of transport chunk boundaries.
- Shared session drivers include served-model and alias fields on every session start and turn completion, including interruptions and synthesized failures.
- Codex native cost enrichment and Pi, Copilot, Gemini, and Qwen experiment metadata respect the final result-envelope size limit. Gemini and Qwen plain output preserve size-limit refusals.
- Pi delivers an accepted interrupt even when caller EOF arrives before the native prompt acknowledgment.
- `--sandbox-block` lists longer than 41 paths no longer fail with a false symlink-hop error.
- Correct prompt-transport, session lifecycle, preview, canary-count, and legacy cost-accounting references. Session capability and caller-home tests cover Cline and OpenHands.
- CI builds scode v0.6.6 (commit `9cbb7f8`) instead of v0.6.4.
- Strict runtime grants follow the adapter identity through executable resolution, including native Claude and Z.AI installs with version-named binaries. Codex provider resume previews reject untrusted parent directories without creating or sweeping state.

- `verify --show-scode` resolves executable paths before sandbox checks and reports unavailable commands per row. It also accepts `--sandbox-strict`. Resumed per-turn previews validate private homes without writing state.
- Session previews and credential preflights use separate sandbox policies, so representative directories cannot become grants on real turns. Resumed previews, including Aider, validate private homes and their parents without creating or sweeping state. Copilot project-settings previews apply policy to the session home after preparing per-turn artifacts.
- **Correction**: the 2.0.0 notes and the `check --session` reference called
  the refused `--pass-env` set "config-directory redirects". It also covers
  single-file and inline config variables such as `OPENCODE_CONFIG`,
  `OPENCODE_CONFIG_CONTENT`, and `CLINE_*_SETTINGS_PATH`.

## [2.0.0] - 2026-11-10

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

- Sessions accept `--harness-home <dir>` for a persistent caller-owned home for all 16 session agents. Login hard links, resume checks, sandbox blocks, and synthetic canaries preserve caller settings and skills; `--final` keeps the directory. The registry pins caller-owned mode independently of its path. Older binaries that reject the new `caller_owned_home` field cannot resume these records.

- Parity (W2): Qwen runs deny every built-in tool through `--exclude-tools` and attach the Playwright server through inline `--mcp-config`; its sessions resume the minted `--session-id` ledger with a tested Playwright carrier. **Correction:** Qwen session tool selection remains refused by the CLI; the internal command builder's exclusion support is not a session CLI feature. OpenHands runs load a repository's own `.openhands` hooks under `--experiment-project-settings` and plant the Playwright server in a hermetic run's private `mcp.json`; its session driver, conversation identity, and resume carrier land in-tree pending registration. Agy prompts ride stream-json stdin and its sandboxed runs plant the Playwright server in the probe home's `mcp_config.json`. Every remaining Qwen, Agy, and OpenHands gap except experiment MCP is a recorded harness limitation with dated upstream evidence.
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
  rules. Pi accepts the override's model in plain and hermetic sessions.
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
  at their installed versions, so `--effort` stays refused there).
  **Correction:** Cline accepts provider overrides and maps `--effort` to `--thinking`.
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
  turn's argv, retains private data/state across resume with a linked login, and
  reports that directory as `private_home`. Under `--experiment-project-settings` it adds the
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
- **Correction:** `run --print-sandbox` and `session --print-sandbox` run the version
  preflights, skip the quota gate, then print the scode argv the launch would
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
  launch on the harness's structured stream and print the assembled answer
  instead of the harness's text output (OpenHands: its terminal UI, tool
  output included). Plain runs still print once, when the run ends. Plain runs of
  Claude and Z.AI move from `--output-format json` to
  `--output-format stream-json --verbose`; they printed at the end before
  and still do.
- Session turns carry every message of the turn: the Cline and Gemini ACP
  drivers split text at tool calls, the Codex driver keeps commentary
  messages, the Aider driver keeps reflected replies, and Droid turns read
  `stream-json`.

### Fixed

- Empty or whitespace-only answers fail on every agent: zero-exit runs become exit 1, report `Error: <agent> exited 0 with an empty answer`, mark JSON envelopes with `codemux.empty_answer: true` and `codemux.finish: "empty-answer"`, and record `finish: "empty-answer"` in the call ledger. Successful session turns without assistant text complete as `failed` with reason `empty answer`. There is no opt-out.
- The launcher starts on Ubuntu 26.04, whose `/usr/bin/stat` is uutils coreutils: its `--version` names "uutils coreutils", which the dialect check read as BSD, so every `stat` candidate was refused with `no trusted stat found`.
- `codemux check --hermetic --session` on claude and zai: the code word now
  also sits in a scratch operator `CLAUDE_CONFIG_DIR` that the hermetic,
  control, and resumed sessions all pass through. Claude Code sessions load
  the user setting source only, so the planted cwd files never reached the
  control, which answered from the operator's own instructions and failed
  the check as proving nothing. The hermetic sessions must swap the passed
  directory for their private home and keep the code word out.
- `codemux check --hermetic --session` on every agent refuses with exit 64
  a `--pass-env` name the canary itself sets or clears in any of its
  sessions (`HOME`, every config redirect and inline config variable it
  clears, such as `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCODE_CONFIG`,
  `OPENCODE_CONFIG_CONTENT`, and `CLINE_*_SETTINGS_PATH`, and zai's
  `ZAI_API_KEY`). It used to replace the caller's value without notice.
- Test helpers read a fake harness's record file only once it is complete,
  fixing a Linux CI race that read it mid-write.
- Live gate probe B passes when the shell output is the answer's last line.
  Since runs print every assistant message, a model's sentence before the
  tool call failed the exact-output compare even though the shell ran.
- `codemux check --hermetic` scans every event of a structured stream for
  the planted marker, tool results and tool inputs included, on every
  harness whose plain run prints an answer assembled from that stream
  (Claude, Z.AI, Codex, Cursor, Gemini, Qwen, Copilot, OpenCode, Cline, and
  OpenHands, as Droid, Goose, Pi, and Kimi already did). A marker that
  reached the model only through a tool result used to vanish with the
  shed event, and the check could certify a leaking run clean.

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

[Earlier release notes](https://github.com/bindsch/codemux/blob/main/docs/archive/changelog-pre-2.md).

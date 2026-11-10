---
read_when: "Reviewing earlier fixes included in codemux 2.0.0."
---
# 2.0.0 fixes, part 3

Preserved from the [2.0.0 changelog](https://github.com/bindsch/codemux/blob/main/CHANGELOG.md#200---2026-11-10).

- Hermetic claude runs build the private credentials copy from the mirror's
  `claudeAiOauth` object alone; co-stored `mcpOAuth` refresh tokens never
  reach a private directory.
- Resuming a session claims the registry record before opening the private
  config directory, so a concurrent hermetic sweep cannot remove the
  directory between the open and the claim.
- A spawn site re-stats only its own resolution's executable identity, not
  any identity another launch in the same process recorded for that path.
- The live gate registers a probe in its interruption map before writing the
  probe's stdin, so an interrupt during that write still stops the child.
- `make installed-layout` builds the Homebrew formula's real shape (checkout
  under `libexec`, keg and prefix symlinks chained), so launcher and docs
  checks run through the links a real install uses.

- The quota gate's weekly warning applies to weekly windows only: a window
  is weekly when its kind names a week or its span is one week within an
  hour of provider rounding; a monthly cap no longer warns as weekly
  (review round 14, contracts).
- The launcher's trust check refuses a `bun` binary that is world-writable
  but not group-writable: the mode pattern tested only the group write bit,
  so a `0o757` binary passed.
- The launcher walks the ancestors of the resolved `bun` directory as well
  as the lexical one, so a symlinked path into an untrusted directory is
  refused naming the real ancestor.
- The launcher disables pathname expansion before splitting `PATH`, so an
  entry containing `*` is tried as one literal directory instead of
  expanding to whatever else matches.
- `check` validates its probe requests before the quota gate, so a request
  the adapter refuses exits 64 with its own message instead of a quota
  refusal answering for it. The experiment and agy canary checks build their
  own plain request and validate it after the gate; those requests are valid
  by construction.
- The quota gate's snapshot cache is keyed by the agent and a hash of the
  complete environment the query receives, so two accounts selected by
  different environments never share one cached snapshot.
- The scode version gate skips only on bubblewrap's own user-namespace
  creation failures; a probe failure that merely mentions a namespace fails
  the gate, and Linux CI greps for the skip line and echoes it as a warning.
- The Kimi plain-run usage fold no longer charges a newline the record never
  had: an unterminated final record exactly at the capture bound passes, and
  only a real byte over the bound fails.
- A thrown `installed-layout` failure keeps the broken tree and prints its
  path for inspection instead of exiting through the uncaught-error path.

- The quota gate no longer measures the native account when a validated
  provider override routes the launch to another endpoint: the gate skips
  it and prints one stderr line naming the override host, on `run`, `tui`,
  `check`, and `session` (review round 6, edges finding 1).
- `doctor` prints every installed harness even when one harness's version
  probe fails (invalid UTF-8 output, a binary removed after discovery, a
  capture failure): that harness reports `unreadable (<reason>)` instead of
  aborting the whole report (review round 6, edges finding 3).
- The coverage gate refuses fractional counts and hits above found
  (`LH` over `LF`, `FNH` over `FNF`) as malformed records instead of
  reading them as extra coverage (review round 6, edges finding 4).
- `--print-sandbox` prints each argument on its own line with control
  characters escaped, so a multi-line `-p` prompt argument can no longer
  read as several arguments (review round 6, edges finding 5).
- `session --permission-policy default` is accepted for every session
  agent: only `deny` is limited to claude and zai, and `default` names the
  unchanged behavior everywhere (review round 5, edges finding 2).
- The coverage gate refuses a coverage record that reports zero lines or
  functions for a source file that has them: the record is incomplete or
  malformed, breaches the per-file floor, and counts the file's physical
  lines as uncovered instead of reading as 100% (edges finding 4).
- The live gate keeps a `Warning:` stderr line that arrives after an
  ordinary stderr line, so a stale-contract warning can no longer vanish
  from a passing probe's note (edges finding 5).
- The live gate's session probe (F) fails a turn that completed `failed`
  or `interrupted` and requires the `finish: "end"` completion of the very
  turn that carried the nonce reply (contracts-2 finding 1).
- The live gate fails when the candidate's `--version` cannot be read; a
  report that cannot name the build it tested no longer exits 0 (edges
  finding 3).
- Every pre-launch refusal of a request exits 64: opencode's plain-run
  `--tools none` refusal and the remaining capability, combination, and
  provider-override refusals in the adapters (opencode's project-settings
  and remote-config rules, agy's isolation rules, the TUI provider
  overrides, half-configured or malformed provider overrides) were plain
  exit-1 failures (contracts-2 finding 2).
- Resuming a session no longer drops a recorded `--sandbox-block` path: the
  block list is stored canonically (sorted, deduplicated) with each session
  record, and a resume must carry every recorded path, though it may add
  more. Dropping one is refused with exit 78 before anything spawns; records
  from before 2.0.0 read as no blocks.
- A usagemux snapshot query that exits nonzero is an unreadable query even
  when its stdout parses: `usage` exits 1 instead of answering it, and the
  quota gate warns, proceeds, and caches nothing from the failed run.
- The live gate's provider-override probe (H) refuses the opt-in up front
  unless every harness it will run exports all three of its
  `CODEMUX_<AGENT>_PROVIDER_{BASE_URL,API_KEY,MODEL}` variables nonempty; a
  missing one previously ran the probe without the override and verified the
  operator's default credentials instead.
- The live gate fails a probe whose captured stdout exceeded the capture
  limit instead of passing it on the verifier's verdict over the prefix; the
  full stdout still reaches the report file.
- The model-name, prompt, autonomy, effort, environment-name, and working
  directory validators refuse with exit 64 on run, tui, and check (an
  invalid `-m` name or an inaccessible `--cwd` exited 1 on those commands
  while session exited 64 on the same request).
- Every pre-launch refusal that still exited 1 now exits 64: the run/tui/check
  prompt, sandbox-policy-option, capability (`--enable-playwright-mcp`,
  `--no-web`), and check-only flag-combination refusals, the option value
  errors (`--timeout`, `--pass-env`, autonomy and effort resolution), and the
  `--experiment-project-settings` refusals on `run` (sessions already exited
  64), so run and session answer the same request with the same code.
- `--experiment-project-settings` is validated on every launch path, not
  only the CLI: the claude, zai, and opencode adapters re-check the request's
  own fields at launch, so a programmatic `launchRunRequest`/`adapter.run`
  caller cannot load repository settings without the sandbox, at an
  autonomy level that overrides them, or without hermetic mode; every other
  agent refuses the flag outright.
- An `env`-prefixed sandbox command reached through a symlink is re-checked
  before the spawn: the trust check now records the binary's identity under
  the returned symlink path as well as the resolved path, and a spawn site
  refuses — instead of skipping — a trust-checked path with no recorded
  identity. Repointing the `env` symlink after validation no longer runs an
  unchecked replacement.
- `session --print-sandbox` on a fresh codex provider-override session no
  longer leaves a `run-<pid>-*` provider home behind: the print path runs
  every finalizer through the command's single exit (session home,
  project-settings directory, registry) and exits 0.
- The `bin/codemux` launcher refuses a `bun` symlink chain longer than 32
  hops instead of looping forever on a symlink cycle.
- `run --print-sandbox --experiment-mcp` is refused (exit 64): the MCP relay
  is minted at start, so its argv cannot be shown without starting it. The
  dry run no longer spawns the experiment server.
- The Claude credential mirror is read once for the
  `--experiment-project-settings` copy; a refresh-token or unparseable
  mirror is refused instead of copied into the private config directory.
- `doctor` resolves every harness through the executable trust check with
  the working-directory exclusion, so a planted PATH entry reports
  `untrusted binary (...)` instead of running unsandboxed.
- `doctor`'s version-contract verdict no longer prints `below minimum` for
  every refusal: a recorded contract break prints `known break at <levels>
  autonomy from <version> (sandbox mitigates or no mitigation): <note>`,
  naming the autonomy levels the break affects, and the live gate's
  contract column reports the same case as `KNOWN-BREAK` with the identical
  detail line. The per-probe bound rises from 3 s to 10 s so the slowest
  installed harness (openhands, about 6 s) is read instead of reported
  `unreadable (timed out)`.
- The pre-spawn executable re-stat records size and nanosecond
  mtime/ctime beside dev/ino/mode, so an in-place rewrite of a trusted
  binary (same inode and mode) is refused too.
- `quota.timeoutSeconds` must be an integer from 1 to 300, and a quota
  gate whose own settings are invalid refuses the launch (a config error
  at load, exit 1) instead of warning and proceeding; only usagemux-side
  failures (absent or untrusted binary, timeout, nonzero exit,
  unparseable output) warn and proceed.
- Experiment recordings are written only inside a real, current-user-owned
  directory with mode 0700; symlinks and foreign-owned directories are
  refused.
- A codex hermetic home whose login link fails mid-creation no longer stays
  on disk; the exit backstop and tracked-directory registration now precede
  the link operations.
- Every spawn re-stats its trust-checked executables and refuses a change
  after the trust check, narrowing the replacement window to the
  re-stat-to-exec gap.
- `bin/codemux` resolves `bun` once from the first absolute PATH entry
  holding it and refuses an untrusted directory chain, so a planted PATH can
  no longer choose the runtime.
- The Kimi experiment control probe carries its planted scratch brand home on
  the control request itself, so its private config lands in the canary
  scratch by construction.
- `codemux usage` prints `N% used` when a window reports only a used percent
  and rounds every percent to two decimals; a negative or non-finite
  `windowMinutes` parses as null; `calls --sum` streams the whole ledger
  (an earlier 16 MiB tail note on the totals line is gone); the usagemux
  shutdown grace is five seconds.
- `doctor`'s version probes no longer depend on the host's PATH, and flaky
  fixed sleeps and leaked fixture processes in the test suite were replaced
  with observable preconditions and tracked cleanup.
- The Homebrew launcher contract is explicit and checked: `bin/codemux`
  carries a `codemux_pinned_bun=` assignment the formula rewrites at install
  time, `scripts/check-installed-layout.ts` fails when the token is missing or
  duplicated and applies the same rewrite to its own copy, so an installed
  launcher cannot reach the checks unpinned or ship a pin the formula never
  wrote. The literal `exec bun ` call the old formula matched is gone.
- A `.credentials.json` symlink planted in a session's private config
  directory by the previous harness child can no longer turn a resume into
  an arbitrary host write: every codemux-owned file there is written through
  a private-file write that refuses an existing symlink or foreign entry,
  writes a fresh temp file in the same directory, and renames it into place.
- The claude credential mirror is written lazily, after the resume claim
  succeeds, so a resume that loses its claim or is refused no longer copies
  credentials into the private home at all; the copied bytes are identical to
  a first-run copy.
- Plain (non-`--result-json`) kimi runs stream through a bounded fold that
  keeps only the assistant reply and the usage lines, so a run with more
  than 16 MiB of tool events no longer buffers the whole stream; the exit
  contract (reply on stdout, usage in the ledger, exit 125 past the capture
  limit) is unchanged, and a wire-shaped stream still fails loudly instead
  of silently succeeding with no reply.
- The live gate's session probe sends a real JSONL user frame and fails
  unless the harness answers a completed turn whose assistant message carries
  the probe's nonce; a session that exits 0 without completing the turn is a
  FAIL, not a PASS.
- The live gate's provider-override probe runs with `--result-json` and
  fails unless the result envelope's provider-reported
  `codemux.served_model` names the override's model, so a run served by
  default credentials cannot pass it; the probe is
  UNSUPPORTED on adapters without both capabilities instead of vacuously
  passing. **Correction:** the earlier wording named `codemux.model`, which
  is codemux's own selection and proves nothing about the override — the
  check reads `codemux.served_model`.
- The live gate's experiment probe passes the codex worker model alias, so
  codex experiment runs no longer fail the probe with `model_required`.
- The live gate's version-contract probe resolves each harness through the
  executable trust check with the working directory forbidden and reports an
  untrusted binary instead of executing it, matching `doctor` and the launch
  gate.
- The quota gate escapes provider-supplied strings (usagemux issue messages
  and window kinds) before printing them, like every other usage surface, so
  an upstream usage response cannot inject terminal control sequences into
  the pre-launch gate's output.
- The opencode result envelope reports the model the run actually selected
  (its context's selected model) in `codemux.model`, so an override or
  configured model is visible in `--result-json` output like every other
  structured adapter.
- The remaining `--experiment-mcp` pre-launch refusals exit 64 like the
  rest: an unsupported harness, a missing codex/kimi wall-time opt-in, and a
  spec that does not parse or carries unknown fields are caller mistakes,
  refused with the same code (unreadable or oversized spec files remain
  exit 1 as I/O failures).
- The quota gate's non-binding window match is whole-word: a binding kind
  like `unscoped weekly` no longer skips the gate as a scoped grant
  (review round 7, edges).
- The launcher itself refuses `--print-sandbox` without `--sandbox`, not
  only the CLI, so a direct launch can never reach a spawn the caller
  believed was only printed (review round 7, edges).
- The coverage gate normalizes an absolute lcov `SF:` path against the
  working directory, so an absolute record matches its source key instead
  of reading as a missing file (review round 7, edges).
- A `--final` session's `session_ended` reports `resumable: false`: the
  command removes the private config directory after the event, and the
  verdict no longer promises a resume that would open a fresh,
  transcript-less directory (review round 7, edges).
- A model-less provider override is refused with exit 64 on every adapter
  that carries one, not a plain failure exiting 1 (review round 8,
  contracts-2).
- `codemux session --print-sandbox --no-sandbox` is refused in the request
  phase, before the launch phase creates a codex override session's
  provider home, so the refusal strands no `run-<pid>-*` directory (review
  round 8, contracts-2).
- A `--sandbox-block` path that does not exist yet is recorded through its
  longest existing ancestor, so a symlinked ancestor cannot be retargeted
  between the record and the resume; an ancestor that cannot be resolved
  refuses the request (review round 8, edges).
- The experiment MCP recording directory is created on its resolved path,
  so a symlinked ancestor cannot redirect the recording or move the 0700
  mode onto another directory, and the recorded path names the real
  directory (review round 8, edges).
- The kimi streaming fold releases its first wire line once another line is
  kept, so a dropped first tool event no longer stays retained past the
  residue the fold reports (review round 8, edges).
- The quota gate's weekly warning fires for a weekly window that reports
  only a used percent: the warning loop no longer inherits the ceiling's
  remaining-percent set, so this shape warns instead of passing silently
  (review round 9, edges).
- The per-file coverage floor no longer waives all of the codex hermetic
  home module: the signal dispatch moved to its own waived module
  (`src/private-dir-signals.ts`) that holds nothing else, and
  `src/hermetic-home.ts` is back inside the floor, with its login-file
  validation paths and finalize failure path covered (review round 9,
  contracts-2).
- The live gate prints a commander argument error once, not twice: commander
  has already printed the message when the exit override throws, and the
  gate's own catch no longer repeats it (review round 9).
- `--experiment-project-settings` is validated as a boolean on programmatic
  requests like every other flag, and the unmapped-agent refusal reads the
  validated value, so a truthy non-boolean no longer skips it (review
  round 9, edges).
- A `--sandbox-block` path that equals or contains the launch's own harness
  state directory (a project-settings run's or session's private directory)
  is refused with exit 64 naming both paths, instead of emitting a block
  the later allow re-opens (review round 9, edges).
- The kimi plain fold no longer answers an empty kept set as plain success:
  a wire stream whose kept lines are all blank now fails as a missing
  assistant reply, so a dropped tool payload cannot hide behind a blank
  line (review round 10, edges).
- A `--final` session's record is stamped non-resumable atomically with its
  end, and the private config directory is removed before the end stamp,
  so a concurrent resume cannot claim the record and have its directory
  deleted under it (review round 10, edges).
- The `--sandbox-block` conflict check canonicalizes both sides with the
  registry's own rule, so a trailing slash, a `..` segment, or a symlink
  alias can no longer spell a block over the launch's own harness state
  directory (review round 10, contracts/edges).
- A dangling symlink in a `--sandbox-block` path is recorded through its
  target, so retargeting the link between the record and the resume no
  longer compares equal (review round 10, contracts-2).
- The launcher detects the platform's `stat` dialect once (BSD `-f` versus
  GNU coreutils `-c`) and validates the shape of the ownership and mode
  output before trusting it, so a Linux install is not refused by GNU
  `stat` reading `-f` as a filesystem-mode request; an unreadable
  ownership or mode is refused naming the path (review round 11, 1).
- `--sandbox-block /` now covers the launch's own harness state directory:
  the root block used to compare against the prefix `//`, which never
  matched (review round 11, 2).
- A `--final` session whose private directory cannot be removed still
  ends: the CLI retries the removal once, one stderr line names the kept
  directory and the reason, and the command exits 1 (review round 11, 3).
  **Correction:** the record is not stamped final in that case —
  `final` and `session_ended`'s `resumable: false` are written only after
  the directory is gone; both attempts failing leaves the record ended and
  resumable, so a later `--resume --final` or the stale sweep can retry.
- A `--sandbox-block` refusal on the session command leaves no session
  private config directory behind: the conflict check runs before the
  directory is created (review round 11, 4).
- An oversized or NUL-byte argv prompt is a usage refusal (exit 64) on
  every agent — aider's duplicate-prompt cap included — instead of a
  generic exit 1 (review round 11, 5).
- Two launches in one process that trust the same executable path (the
  binary replaced between them) no longer refuse the second launch at the
  pre-spawn re-check: every identity recorded for the path is accepted,
  and a stat matching none of them still refuses (review round 11, 6).
- The launcher's trust check walks every ancestor of the resolved bun
  directory up to `/` and refuses a world-writable ancestor without the
  sticky bit, so a writable directory on the path to the launcher can no
  longer skip the check (review round 11, 7).
- A kimi plain-run wire line carrying both assistant text and tool calls
  is folded with the tool arguments dropped, so a one-megabyte argument
  cannot ride the folded capture while the text survives (review round
  11, 8).
- The quota gate's snapshot cache is keyed by the resolved usagemux and
  its PATH beside the agent, so two environments in one process (two
  accounts) never reuse each other's snapshot (review round 11, 9).
- A usagemux that turns untrusted between the status check and the query
  is an unreadable snapshot — warn and proceed — instead of a generic
  error (review round 11, 10).
- `doctor` reports a harness binary removed between discovery and its
  version probe as `unreadable (binary not found)`, not `no contract`
  (review round 11, 11).
- A `--quota-ceiling` value is judged whenever the flag is given, even
  under `--no-quota-gate` or `quota: false`: a bad value refuses (exit
  64), and a valid value under a disabled gate prints one stderr note
  that it has no effect (review round 11, 14).
- usagemux's stderr arrives in warning messages with control characters
  escaped, never as raw terminal control bytes (review round 10,
  contracts).
- CI builds the Linux scode from the commit the `v0.6.2` tag named and
  verifies `git rev-parse HEAD` against the pin, instead of cloning the
  mutable tag; the bun pin extraction admits prerelease suffixes and fails
  when it extracts nothing (review round 10, contracts/edges).
- The project-execution configuration refusal and an invalid
  `CODEMUX_CODEX_PROVIDER_MULTI_AGENT` value exit 64 like every other
  caller-mistake refusal, not 1 (review round 10, contracts).
- The live gate's session probe no longer fails on an unrelated live
  registry entry of the same agent: the leak check matches the probe's own
  session id, or its working directory when the capture carries no
  `session_started` line (review round 10, contracts).
- The coverage gate fails when a type-only waiver stops being earned: the
  waived file grew runtime exports, or the report carries executable lines
  for it (review round 10, edges).
- `codemux calls` streams in bounded memory end to end. The reader was
  bounded, but the command held every matching record — raw line included —
  before the `--since` window, the `--sum` totals, and the `-n` slice, so a
  large ledger could still exhaust memory. The pass now keeps only what the
  output needs: the newest `-n` records for the listing (raw lines only
  under `--json`), one closing record per session for the totals, and the
  session ids with an in-window turn for `--since`, which decides each
  closing record as it reaches it — the ledger writes a session's closing
  record after its turns (review round 22, edges 2).
- A captured run re-asserts its own command's executables, not the
  process-wide list of every identity trusted earlier in the process:
  swapping a binary between its trust check and the captured spawn used to
  pass, because the re-check accepted any identity the process had already
  seen. The sandboxed and direct launches, `codemux check`'s control run,
  the usage snapshot query, and the scode version check pin the paths and
  identities they resolved (review round 23, edges 1).
- A session whose harness spawn throws still releases its registry record.
  The private-directory cleanup runs first, and a removal failure is
  reported on stderr naming the directory, but the record is released
  either way — a cleanup error used to skip the release and leave the
  session owned (review round 23, edges 2).
- Kimi tool calls the harness rejected for invalid arguments no longer
  count as relay calls in the experiment evidence: the count and the
  per-call matching exclude them, while the checks still require the loop,
  the model, and stdout to agree on the rejection, and malformed arguments
  still record `native_arguments_malformed` (review round 23, edges 3).
- `codemux calls --since` runs a first pass that names every session with
  a turn inside the window before any closing record is decided. A resumed
  session's first closing arrives before the turns its resume ran, and the
  one-pass window dropped it; both closings now appear in the listing, and
  the totals keep the newest (review round 23, edges 4).
- The call ledger's writer and reader share one line bound of 16 MiB, the
  process-capture bound. The writer accepted any length while the reader
  skipped lines over 1 MiB, so a record with a large captured string was
  written and then invisible to every read; the writer now refuses a
  record whose line exceeds the bound with one stderr note instead of
  writing a line no reader would return (review round 23, edges 6).
- The quota gate prints the weekly over-use warning before its
  no-binding-window note. A weekly window reporting only a used percent
  empties the binding set, and that early return used to skip the weekly
  warning entirely, so the two warnings held only separately (review round
  23, edges 8).
- The coverage gate rejects lcov counts past every safe integer: a
  20-digit `LF:` passed the digits-only check and parsed to 1e20, a value
  the sums cannot represent exactly. A safe integer is required now, and
  such a record is malformed like any other (review round 23, edges 9).
- zai model selection works for every non-catalog id, the `clerk`, `worker`,
  and `judge` tiers included: the run, TUI, and session builders pass the
  same model-picker settings the claude adapter uses whenever the resolved
  model is not a catalog alias, instead of a bare `--model` the 2.1.280
  catalog check rejects. The `sonnet`, `opus`, and `haiku` aliases now map
  zai too, so `-m opus -a zai` resolves instead of refusing (audit round 2,
  A1, A5).
- `--effort none` sends no effort flag on every adapter and every command
  (run, tui, check, session) instead of refusing on claude, agy, and
  opencode; `tui --effort` resolves through the same rule as run, refusing
  with 64 where the TUI cannot carry it (droid, opencode) instead of
  dropping the flag with a warning (audit round 2, A2, A3).
- The cursor desktop-entry refusal (`CODEMUX_CURSOR_ENTRY=cursor` without
  the `--pass-env` opt-in) exits 64 as the caller mistake it is, not 1; pi's
  passed-through `PI_CODING_AGENT_DIR` rule and goose's override URL rule
  match the sibling env rules — 64 at validation, before the quota gate and
  the "Running with" line (audit round 2, A4, A6, A7).
- `--sandbox-block` and `--print-sandbox` are carried or refused on every
  launch command instead of parse-erroring on tui and check; the account
  pair that a command cannot carry refuses with 64 and a reason, so one
  request no longer yields three outcomes across run, tui, check, and
  session (audit round 2, A8).
- docs/harnesses.md names which rows are live-verified for 2.0.0 and which
  are static contracts (the eight harnesses without credentials on the
  release machine, cursor's launch-only checks); the read-only `--ro`
  spelling is stated once for every harness instead of reading as a cursor
  special case; pi no longer prints an autonomy warning on every medium or
  high launch, and `codemux verify` reports pi PASS; codex's
  `served_model` doc says reported-not-evidence wherever it is named (audit
  round 2, A10, A11, A12, A13).
- `quota.timeoutSeconds` defaults to 60 seconds — CodexBar's claude answer
  measured 31, so the old 15 refused the read and launched ungated — and
  accepts a per-agent map anchored by `default` (`{default: 60, claude:
  90}`); an invalid map fails config load (audit round 2, B2).
- `quota.spendsFrom` maps an agent to the usagemux client its launches
  spend from (`opencode: claude` for an opencode install on a Claude
  subscription), and a `not-applicable` result prints one stderr line —
  the agent's usage is not measured; it spends from its configured
  provider — instead of passing silently (audit round 2, B4).
- The call ledger records where each dollar figure came from:
  `cost_source` is `billed`, `harness-estimate` (claude and zai figures,
  which the harness reports session-lifetime), or `subscription-zero`
  (OpenCode's reported 0 under a subscription). `calls --sum` totals
  billed cost only and prints the harness estimate on its own line, so a
  lifetime figure is never added to real bills (audit round 2, B5).
- The quota gate warns when credits reach zero (a prepaid or API-key
  account at 0 credits no longer launches silently), and reset times print
  in local time with a relative span (`2026-11-07 09:00:00 (in 2 d 3 h)`)
  in gate messages, `codemux usage` window resets, and subscription
  renews/expires lines — nobody converts a raw UTC instant by hand (audit
  round 2, B10, B13).
- Human-readable `calls` output uses one escaper: every C0, DEL, and C1
  control prints as a lowercase `\xNN` escape in group headings, with
  literal backslash text kept distinct from rendered controls;
  `--json` keeps its `\uXXXX` spellings (audit round 2, B14).
- docs/authentication.md states Antigravity's residual risk in one place:
  the whole token file, refresh credentials included, sits in the private
  HOME for the run's lifetime and is removed at cleanup; a SIGKILL leaves
  it until the next recovery (audit round 2, B12).

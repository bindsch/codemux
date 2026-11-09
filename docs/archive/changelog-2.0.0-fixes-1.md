---
read_when: "Reviewing earlier fixes included in codemux 2.0.0."
---
# 2.0.0 fixes, part 1

Preserved from the [2.0.0 changelog](https://github.com/bindsch/codemux/blob/main/CHANGELOG.md#200---2026-10-31).

- `check --hermetic` plants each harness's own instruction channel: project
  instruction files or scratch home files, with the same cwd and tools in both
  probes. Copilot's control removes only `--no-custom-instructions`; Qwen
  refuses with exit 64 because its always-on safe mode cannot provide a
  positive control. A clean control fails the check.
- Live gate and diagnostics parity: probe E runs plain `--tools none` on every adapter
  that declares it, with the hermetic spelling only where the adapter requires it; probe I
  is split into I (model alias) and I2 (effort low), so each flag is probed exactly where
  it is declared; the report prints one summary line per harness with its probed-cell
  count and calls out a row judged on the base probes alone; an UNSUPPORTED cell with no
  documented reason fails the row instead of passing as structural; the gate reads one
  usage snapshot, and a harness the quota gate would refuse gets SKIP cells naming the
  refusal — decided before the spawn, or by reclassifying a provider quota refusal that
  surfaces after it — instead of a FAIL; `codemux list` marks TUI-only model and effort
  flags `model(run)` and `effort(run)`, labels claude and zai `budget`, and its `--json`
  listing carries `toolsNone` and a `tui` block; and the CLI doc states the
  `--sandbox-block` and `--print-sandbox` availability on `tui` and `check` and adds
  doctor's exit 2 to the exit-code table.
- Hermetic agy at every autonomy: the launcher blocks the operator's real `~/.gemini` through
  scode and re-allows only the run's or session's private home, for runs and sessions alike;
  a caller `--sandbox-block` over that state tree is refused like the claude project-settings
  path; the read-only requirement is lifted, so `--hermetic` and `--tools none` accept low,
  medium, and high with scode, and the `hermetic(read-only)` and `tools(read-only)` labels
  become plain `hermetic` and `tools`.
- Review round 401, whole tree (registry, private writes, credentials): every rename-published
  file states its mode on the descriptor or right after creation, so a umask like 0277 can
  no longer leave a private file or directory masked narrower than its rule; corrupt-registry
  recovery keeps the live file until the replacement write lands and leaves a hard-linked
  `.corrupt-` backup, keeping the newest five; the credential mirror's staging file is
  fsynced before the rename; private writes and verify's scratch cwd revalidate the
  directory identity around the staged write and refuse a name swapped for a symlink; the
  call log tightens modes on the open descriptor, never chmod'ing a path a swapped symlink
  could answer; and the authentication doc states the root-owned-link carve-out in the
  ancestor walk.
- Review round 401, whole tree (runner, signals, sessions, environment): a signal that lands in
  the runner's cleanup window still SIGTERMs and force-kills the child tree before the signal
  exit; a turn refused by its turn/start response adopts its provisional id, so a straggler
  naming it after the next turn opens is consumed instead of crashing the session; a second
  interrupt before the init frame is answered dropped and the first keeps its input_seq; a
  multi-line experiment failure diagnostic replaces its earlier copy whole, without orphan
  continuation lines; the post-exit group SIGKILL fires only while the process table still
  lists a member of that group besides its leader slot, so a recycled pid takes no stranger's
  group down; and the executable-redirect gate scans the child's built environment, closing the
  adapter env channel that bypassed the trust gate, the version check, and the pre-spawn pin.
- Review round 391, whole tree (experiment, runner, codex sessions): the Claude bridge's frame
  bound stays on the whole control frame (Claude's own limit) and the docs name the residual, a
  reply body within the envelope's overhead of 1 MiB fails at the sender after the reader
  admitted it; the Codex rollout and Kimi wire tamper checks hash
  decoded text on both sides, so a leading BOM is no longer a false change; the experiment
  server reader skips a blank CRLF line; the run timeout disarms once the child's exit and
  captures settle, so a deadline in the stdin-wait window cannot recast a clean exit as 124; an
  explicit null turnId is the absent case for scoped codex notifications; a second interrupt
  queued in the turn/start window is reported dropped by its input_seq; an approval naming the
  provisional turn id during that window is accepted like a notification; and a kimi session
  whose registry record never landed no longer waits out an abandoned spawn's hold past
  session_ended.
- Review round 391, whole tree (sessions, adapters, credentials): the opencode and aider end
  paths no longer report an answered failed turn's exit as a shutdown-drain failure; a refused
  pre-init input write keeps only its delivery fatal instead of also claiming the line was
  forwarded; aider passes an instruction file to `--read` only when it exists; the claude/zai
  grant-rule refusals for an unquotable `--cwd` exit 64 as the caller's mistake; the quota
  gate reports an overdrawn credit balance as reported instead of 0; the credential mirror
  sync refuses a symlinked ancestor anywhere above the file, never writing through it;
  `playwright-mcp` resolves through the adapter-built child environment's PATH like every
  other launch binary; the calls `--since` pin refuses a same-inode rewrite by size and mtime
  beside device and inode; and the kimi no-tools sweep reports only stale non-regular entries.
- Review round 381, whole tree (aider reply): the chatter test reads the raw history line, so
  aider's blank tool-output line (`>  `) is chatter again; after round 372 its rstripped `>`
  read as the answer and the extraction stopped at the next chatter line, returning `>`.
- Review round 381, whole tree (adapters and runner): the sandboxed cursor TUI selects the
  file credential store like its run path; a boolean JSON Schema `items` counts as valid
  catalog evidence; doctor's week line matches a weekly span like the quota gate; a
  capture-limit failure on both streams keeps each stream's partial output; a closed-sink
  stdin write failure names the child's stdin instead of printing `Error: false`; a re-read
  kimi envelope's parse error says its line numbers count the reconstructed stream;
  `check --experiment-mcp` on codex refuses before the spec-prefix demand.
- Review round 381, whole tree (sweeps and trust): the opencode and kimi sweeps revalidate
  their recorded parent at every removal, the kimi parent is recorded before its sweep runs, a
  session-home name with no registry id keeps the sweep's spare, a failed agy mirror selection
  is never masked by the verification read-back, an empty passed-through `CODEX_HOME` is
  refused like Kimi's, and a scode that fails the trust check reports its refusal instead of
  `scode is not installed`.
- Review round 372, whole tree (credential mirror): a sandboxed Z.AI launch guards the
  operator's default Claude credential mirror the way a provider-override claude run does,
  refusing when it holds a refresh token a Keychain entry backs, since the child is the same
  claude binary reading the same default config directory; the guard is one shared method.
  Every launch must run in the request's working directory: a programmatic caller that named
  another spawn directory is refused before validation, since the claude family's
  medium-autonomy Edit grant is minted for the request's directory.
- Review round 372, whole tree (tools and gates): a finished kimi run no longer re-refuses a
  passed-through `KIMI_CODE_HOME` that vanished mid-run; the live-gate candidate listing without
  `experimentPrefix` is refused as an older listing; `calls` unknown-field notes distinguish an
  overflowed total from unreported records; doctor's scode floor fails closed on an unparseable
  floor; the aider reply extraction keeps a bare `>` line as assistant text, matching the
  restore mirror; the opencode account-store query selects carrier rows by shape and fails
  closed on an unreadable schema; agy search-list recovery refuses an empty restore instead of
  emptying the account's list; the verify scode preview carries the real launch's `-C <workdir>`
  pin.
- Review round 372, whole tree (sessions, runner, launcher): the agy end path's drain cut is
  gone (a cut turns a clean exit into a signal exit the shared rule calls a harness failure),
  and its comment says why the bounded wait stays; an interrupt
  accepted before the harness started is reported dropped, naming its seq, when the session
  ends first; a launcher stat candidate is judged with its own dialect's flags; unguarded
  command substitutions under `set -e` refuse with a diagnostic; a stdin write that cannot
  drain after a clean child exit gives up on a bound, with a note, instead of parking the
  run at its own timeout.
- Review round 361, whole tree (CLI, doctor, adapters, credentials): `calls --since` refuses a
  bare number (engine-dependent 2001-era cutoff) and documents a date-only value as UTC
  midnight; doctor reports an installed but unreadable usagemux as `USAGEMUX-UNREADABLE` with a
  reinstall remedy instead of "not installed"; the doctor Usage column matches weekly windows
  with the quota gate's word-bounded test; droid's bare `gpt-5.6` id gets the family's
  `--reasoning-effort none`; the Keychain hex decode requires the credential blob's object
  shape; `verify --show-scode` guards its preview effort with the adapter's effort levels; a
  hermetic symlink login rotated through unlink plus a new symlink now warns; `doctor --spend`
  names the label stamp its probes carried (the old `=<date>` recipe matched nothing); an
  empty passed-through cursor or copilot store or cache variable is preserved, not overridden.
- Review round 361, whole tree (experiment and sessions): a kimi assistant message without
  usage reports the loop-step mismatch instead of an invalid-usage failure; the kimi scan
  surface joins stdout, stderr, fold evidence, and the wire log with newlines, so a marker
  split across a channel boundary cannot fuse into a leak verdict; the relay's `/mcp` route
  matches its path without the query string and the query stays recorded; the final flush
  budget counts terminal-lane bytes; an empty codex startup-warning message keeps a literal
  warning line; a deliberate null served model survives an experiment cleanup failure's
  attribution chain; a resumed session (kimi, opencode, agy) whose run-start record exhausts
  the busy-lock budget mid-session emits one stderr notice and keeps running — the claim is
  the record.
- Review round 345, changed scope: a fresh session ending with its first turn's registry record
  still pending (the lock stayed busy until the end) now fails closed as a crash with the fatal
  "cannot record the session in the registry" error and a nonzero exit (1, or the signal's 143)
  on kimi, opencode, and agy; a resumed session is tracked by its claimed record already.
- Review round 341, whole tree (runtime and credentials): a scode prerelease now orders below
  its own release, so `0.6.0-rc1` no longer passes a `0.6.0` floor; credential backups prune by
  the parsed timestamp and pid, never lexically, so same-millisecond names across pid-digit
  widths cannot delete a newer dead writer's copy; the opencode hermetic sweep ages a home by
  the newest mtime in its tree, so an orphaned child writing only under redirected XDG
  directories is not deleted mid-run; the agy template lock's stale reclaim is won by one atomic
  claim, so two waiters cannot delete each other's fresh lock and both hold; `runInteractive`
  pins the executable redirect from the child's environment, not `process.env`; the run version
  gate reads the redirect from the same adapter-built environment the launch path pins.
- Review round 341, whole tree (envelopes and sessions): the codex reroute notice parses any
  reason inside the parentheses; an interrupt acked while turn/start was in flight reports its
  input_seq when an early completion drops it; a kimi result envelope past the byte bound keeps
  the failure diagnostic already set beside the bound notice; the codex steer batching probe
  counts batch bytes incrementally instead of re-serializing the batch per increment; a first
  turn's registry record takes one lock attempt on the live stream and retries a busy lock on a
  timer instead of freezing the event loop for the full budget; the final stdout flush's give-up
  scales with the queued backlog under a hard cap; an agy isolation probe without --cwd is a
  usage refusal, not a crash at its diagnostic write; a direct unsandboxed launch refuses a
  request claiming sandbox policy flags, and the run command never claims --sandbox-no-net on an
  unsandboxed run.
- Live matrix of 2026-11-07 (installed 0.15.1, codemux-side): an OpenHands run that exits 0 with
  "Headless mode requires existing settings" is a failed run (exit 1, diagnostic, `success:
  false`), not a reply; the Gemini CLI's system settings file is named only where the CLI will
  load it (a root-owned chain), and on a user-owned prefix a repository `.env` the CLI would
  export is refused instead of a warning on every run; the executable redirect target's identity
  is pinned on the tui and session spawn paths too; Antigravity's per-model effort levels are
  documented.
- Review round 331, whole tree (parsers and health): aider keeps a `>`-without-space model line
  and strips a reasoning block only when its identifiers match; Codex refuses duplicate
  spellings of one tool in `top_level_tools` and an `additional_tools` catalog that drifts from
  the first one; Kimi refuses a `content.part` after a finalized `step.end` (the early-usage
  shape still flushes); the agy stream is malformed unless its init frame comes first; doctor
  runs binary trust before the no-contract return, and no longer reports logged-in for a claude
  mirror without an access token, empty codex token strings, or a zai key file that is a symlink
  or owned by another user.
- Review round 331, whole tree (process, trust, usage): a stop keeps the descendant capture
  armed and samples once more shortly after the signal, so a cleanup helper a harness starts
  while handling SIGTERM in its own process group dies with the tree; an executable redirect
  that does not resolve to one trusted absolute executable (`OPENCODE_BIN_PATH`) refuses the run
  instead of warning, and both launch paths pin the resolved target beside the command's own
  positions for the pre-spawn re-stat; a hermetic run-directory parent that is group- or
  world-writable is refused; the scode `--keep-env` probe cache keys on the executable's
  dev/ino/size/mtime, so a replaced scode at the same path is probed again; the experiment
  bridge bounds its own close by the same cleanup grace as the runner, so a never-settling
  cleanup can no longer hang the launcher's cleanup after the run result was already returned
  with a note.
- Review round 322, whole tree: every protocol close of a captured run is bounded by the cleanup
  grace, a normal exit's included (the run timeout is cleared by then, so a close that never
  settled held the command open); and a codex envelope that dropped its events to fit the
  capture limit reports the truncation instead of presenting itself as complete.
- Review round 307, whole tree: a codex run whose hermetic or provider home cannot be removed
  now fails the run's result instead of printing the failure, so leftover model output and
  credentials cannot read as success; grouped `calls --sum --by` totals share one session fold,
  so a session whose records carry different labels no longer counts its usage in two groups;
  the two-pass `calls --since` scan pins the ledger's device and inode, so a ledger replaced
  between the passes is refused instead of being read as one file; a credential store that
  exists but cannot be inspected (agy, gemini, goose, copilot, zai) reports unknown instead of
  prescribing a login; a passed-through `PI_CODING_AGENT_DIR` ending in whitespace is used
  exactly as the child receives it; an input line of exactly the 17 MiB cap is accepted with a
  CRLF ending like its LF twin; the machine-check label carries milliseconds, the process id,
  and a per-process counter, so concurrent paid checks never share one; and the tui docs now
  state that when the process table cannot be read, termination reaches only the immediate
  child.
- Review round 292, whole tree: a codex provider session's settlement confirms the home it
  renames onto the session key is the directory the run created (device and inode remembered at
  creation), so a sandboxed child can no longer park a replacement directory there and have it
  persisted as resume state; the stale-entry sweeps (codex `.codemux-provider` and the OpenCode
  hermetic parent) revalidate the parent's recorded identity immediately before every recursive
  removal, so a parent swapped for a symlink after enumeration can no longer aim a removal into
  a same-named directory outside codemux's storage tree; the codex stream parser applies its
  rejoin byte and line bounds before the parse, so a continuation that closes valid JSON can no
  longer bypass them; a resumed agy session treats a result with an absent, empty, or non-string
  conversation id as a grammar error instead of attributing it to the resumed conversation; a
  provider override base URL containing control or whitespace characters is refused before URL
  parsing, because the parser strips them silently and the configured endpoint could differ from
  the value supplied; and an access-only Claude credential file whose token has expired reports
  failed when no Keychain entry exists, so the stale-credential warning fires before a sandboxed
  launch fails authentication.
- Review round 286, whole tree: a protocol cleanup that never settles after a timeout or a
  capture failure no longer holds the run open past its own end (the signal path's cleanup
  grace now covers those paths too); a relative passed-through `PI_CODING_AGENT_DIR`, a
  relative inherited `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME` on an OpenCode run or
  session launch, and a relative `HOME` when the call ledger resolves its default location
  are each refused before any spawn or write, because the harness would resolve them beneath
  the working directory; the kimi isolation probe reads `region` and `device_id` through the
  bounded no-follow reader, so a FIFO or symlink at either path is refused instead of
  blocking the probe or copying an unintended target; an experiment MCP server whose
  `tools/list` pagination exceeds 100 pages fails the run instead of being collected without
  end; and the live gate caps each probe's `.out`/`.err` report files at the capture limit,
  noting the truncation in the row, so a noisy harness cannot exhaust the disk.
- Review round 265, whole tree: codex rollout evidence timestamps must carry a zone (the RFC
  3339 rule the rest of the protocol applies), so the same evidence no longer records different
  instants on hosts in different zones; and the timeout and signal diagnostics a captured run
  appends to the child's stderr start on their own line when the child's last line had no
  newline.
- Review round 259, whole tree: the pi provider override model refuses a bare `$VAR` as well
  as braces, because pi expands `$VAR` templates inside its models.json too; a zero-exit
  claude/zai, agy, or opencode plain run that printed nothing fails instead of reporting an
  empty success; a lone malformed OpenCode event that is still a JSON object counts as wire
  evidence and fails the plain result rather than passing through as one; a Claude file-change
  candidate whose tool result never arrived is dropped when its turn completes, so no later
  turn can confirm it; a semver prerelease now orders below its own release, so a version like
  `1.18.10-beta.1` no longer clears a `1.18.10` minimum; and a kimi run that ends with only
  an error event reports the provider's error message, not the missing resume hint that
  masked it.
- Review round 232, whole tree: docs/sessions.md states the descendant capture's limit: a
  descendant that forks and exits between two five-second samples, or before the first, is one
  no walk can attribute (a sample at spawn was tried and withdrawn: its synchronous process
  table read changed the order in which a harness's first output and exit were seen); codex
  turn/started and turn/completed notifications accept the provisional turn id during the
  turn/start window the way deltas do, so a fast server that completes a turn before its
  turn/start response no longer crashes the session, while a late response naming a turn the
  session never saw complete still does, a late response is consumed even after the next turn's
  notifications began, a late error response for a completed turn no longer fails the turn that
  followed it, and the completed turn's unanswered request no longer keeps the idle session in
  the turn/start window; docs/sessions.md states that on Windows, which has no process table
  reader, a tree-scoped termination reaches the immediate child only; an unreadable call ledger
  fails the `calls` command instead of reporting no calls at exit 0; and relative instruction
  directories resolve against the run's working directory, not codemux's own process directory,
  both for validation and for the project setting source, and an empty or NUL-bearing entry is
  refused before it is resolved.
- Review round 223, whole tree: the interactive wait takes the spawn itself and installs its
  signal handlers before running it, so a SIGTERM or SIGHUP can no longer land between the spawn
  and the handlers, end codemux by the default disposition, and leave the tui child and its
  sandbox running (a spawn that throws removes the handlers again); and a ledger line whose
  bytes are not valid UTF-8 is malformed in both readers, never accepted with replacement
  characters rewritten into a permissive field such as provider.
- Review round 211, whole tree: stdin delivery and experiment-MCP writes classify a sink's
  synchronous closed result (Bun's closed boolean, or the Error it returns instead of throwing)
  as a failed delivery through the one sink classifier, so a prompt or notification that never
  left fails the run or the server instead of being acknowledged; the tui wait reports the
  documented 143 after a termination signal whatever the child exited with; the docs now state
  that a SIGINT sent to codemux alone is not forwarded to a tui child, because a forward would
  give a second interrupt to a harness that handled the terminal's Ctrl-C; and the claude/zai
  result envelope rejects a present non-boolean `is_error` and treats an array `modelUsage` as
  no model report.
- Review round 199, whole tree: the agy stale-home sweep and cleanup read the probe marker and
  owner-PID files through one bounded open each that follows no link and decodes the bytes as
  they are, so an oversized or non-regular marker identifies no home (the sweep) or is refused
  (cleanup) without being read whole, and an owner file past the bound follows the existing age
  rule; the live gate's end-state leak check, when both the printed session id and the probe's
  working directory are known, treats a live entry matching either as the probe's leak; the
  claude-family session parser echoes a numeric control-request id only when its value survives
  JSON (an integer past the safe range was already rounded by JSON.parse and negative zero is
  written back as zero, so the parse reports such a request with no usable id); the run-path
  aider history read is bounded at the read itself, so a file that grows past the size cap after
  the check answers null; an opencode tool line whose `state.input` is not an object is a
  grammar error instead of an event that breaks the session protocol; and a codex
  `commandExecution` completion with a missing or unknown status is an error result, not a
  success.
- Live gate of 2026-11-06, the first run of probes H2, I, J, and P against real harnesses: a
  usagemux 1.0.1 snapshot is read again — its new `placeholder` window field was refused as
  unknown, so `codemux usage --json` exited 1 and the quota gate reported every provider
  unreadable; the field is validated (a boolean; a placeholder window carries no percentages)
  and printed back by `usage --json`. A Kimi Code 2.5.0 usage record without `inputCacheRead`,
  which 2.5.0 leaves out when nothing was read from cache, counts that field as zero: an
  experiment run failed on it with a protocol error, and a result-JSON run reported no cached
  and no total count. In the gate itself: probe J no longer asks a model to run its script,
  which no harness could do without network; it prints the sandbox for the three policy flags,
  requires scode's three policy arguments in the print, and runs the script behind them, at zero
  quota, so J and P no longer count as a probed harness. Probe P accepts the file the harness
  entry name resolves to (`claude` links to `bin/claude.exe`). Probe I accepts a served model id
  that carries a one-word alias target (`sonnet` served as `claude-sonnet-5-5`) or the target
  plus a release date. Probe H2 no longer fails on a request that carries no credential beside
  the keyed ones (Claude Code's `HEAD /api/hello` check), names the method and path of the
  requests behind a credential failure, and bounds its launch at 120 seconds. The contract
  column is read again after the probes and names a harness that updated itself while they ran;
  the report saved before that second reading is marked preliminary. Audited ceilings raised on
  live passes of every supported probe: agy 1.5.3, claude and zai 2.1.317, codex 0.166.0, cursor
  2026.11.05, kimi 2.5.2 (2.5.0 on 2026-11-06; 2.5.2 on 2026-11-08 after the binary's own
  updater fetched it), opencode 1.19.5.
- Review round 169, whole tree: the process exit code after a session is the one `session_ended`
  reported even when a signal lands while the final event is still being flushed (it used to become
  143), and the session's closing call-ledger line carries that same process exit code, nonzero when
  the final event was not delivered; concurrent captured commands under one signal no longer let the
  first to finish exit under the others' cleanup, which could leave a child that ignores SIGTERM
  running: the first waits for the others, whose cleanup is now bounded at every step (the protocol
  cleanup gets a two-second grace after a signal, so the interruption receipt is always written),
  every command in flight is signaled together, the interruption line is printed once, and no
  captured command starts while a signaled one is still terminating its tree; the signal handlers
  are installed before the child spawns, so a signal in that window no longer takes the default
  action and leaves a detached child; a caller-stdin read error now stops line delivery instead of
  parsing later chunks as commands; configuration and security checks that used `existsSync` no
  longer fold a stat error into "absent" — an unreadable path refuses, and a symlink whose target is
  missing counts as an existing entry (codemux config, the scode project policy, the
  project-execution walk, the opencode account store, the experiment configs); the agy file token is
  read through one non-following bounded open (on Windows, which has no such flag, a symlink check
  before the open and an identity check after it) and copied byte for byte, so a symlink, FIFO, or
  oversized token refuses instead of being copied; and a goose base URL ending in
  `notchat/completions` gains the `/v1/chat/completions` suffix instead of being taken as already
  complete.

- Review round 162, whole tree: an aider turn whose chat history holds its prompt with no reply ends
  the session non-resumable whatever the exit code was (exit 0 used to leave the session open, and a
  resume replayed the unanswered prompt); a second SIGINT/SIGTERM/SIGHUP while the first signal's end
  still runs now SIGKILLs the child tree at once for every agent, including a child whose spawn was
  still in flight or who attaches after the end (it is killed on arrival) — only kimi escalated
  before; `doctor`'s scode namespace probe and the sandbox-contract script no longer pass ambient
  `SCODE_*` variables to the scode they spawn; and launch options that run a sandbox the request does
  not claim are refused before any spawn (the programmatic API only: the command line sets both, and
  the opposite mismatch was already refused).

- Review round 159, whole tree: an option given on the command line with an explicitly empty value
  (`--model ""`, typically an unset shell variable) is present, not absent — every value option now
  refuses it with exit 64 instead of silently taking its default. Fixed for run's `--file` (the
  `-p` clash check now sees the flag) and `--model` on run, tui, check, and session (which no
  longer falls back to a recorded override model); run, tui, check, and session validate the whole
  request before reporting a missing harness or scode, so a usage error is never misreported as an
  installation failure; `verify
  --agent ""` names no agent instead of verifying all of them; and the sweep also fixed doctor's
  `--spend-cap` (Number("") is 0, which capped the paid stage at zero probes), check's `--cwd`
  guards beside `--agy-isolation-probe`, that probe's bad-mode exit (64, not 1), and the release
  gate's list flags (`--skip`, `--only`, `--pass-env`, `--probe`, `--skip-probe`,
  `--probe-anyway`), which skipped empty entries and so selected every harness. Environment
  variables and config files keep their own convention, where a blank value means unset.
- Review round 153, whole tree: aider's headless declines now repeat on the child's stdin for its
  whole lifetime instead of one canned block plus EOF (aider reads EOF as acceptance of a
  yes-default prompt), on both the run and session paths, paced so a child that discards its stdin
  cannot keep codemux writing without a pause; a caller turn no longer opens, spawns,
  or writes after a session driver finished, for every driver whose emits can breach an outbound bound
  synchronously (aider, opencode, claude/zai, agy, codex; kimi was already safe by its
  effect-completion rule); the shared argv prompt rules key on the adapter's promptInArgv rather
  than a null stdin block, so aider's NUL refusal and argv byte bound apply with the shared
  wording; and OpenHands's ambient LLM_BASE_URL/LLM_API_KEY behavior is documented as the
  operator's own configuration, which a provider override replaces.
- Review round 151, whole tree: the release gate's usage check fails when the usagemux version
  cannot be read, not only when it is below 1.0.0; a call-ledger record whose `ts` is not an
  RFC 3339 timestamp is skipped as malformed and the table never prints one; the
  installed-layout check reads a Markdown link's destination only, so titled links to existing
  files pass; and the type-only coverage waiver rejects any top-level runtime statement, not
  only runtime functions and value exports.
- Review round 147, whole tree: a blank CRLF line between harness frames no longer ends a session as
  unusable output; the Playwright MCP option is refused for programmatic requests without the sandbox,
  on an agent that never attaches the server, or with a hermetic or no-tools run, and an unsandboxed
  launch keeps its customization-off baseline; the Antigravity settings read is bounded and refuses a FIFO or directory instead of
  hanging; `doctor` no longer reports the Keychain readable when the default-keychain query itself
  failed; the bounded call-log reader validates and reads the same file descriptor, refusing a final
  symlink like the streaming reader; and a session failure handler that throws now ends the session by
  killing the harness tree instead of ending codemux with the harness still running.
- Review round 137, whole tree: credential-backup pruning keeps a backup another live process may still need; a
  failed Antigravity private-home cleanup is retried instead of stranded; the OpenCode account store is rechecked
  after it is read, so a store swapped in the window is refused; a symlink chain of exactly the expansion bound
  resolves; launch receipts read the provider override from the adapter's environment, not the ambient one; and a
  model state file that is not valid UTF-8 is refused instead of copied with replaced bytes.
- Review round 133, whole tree: `codemux calls --sum` gives the same totals however often they are printed (a
  session fold that overflowed used to show a partial sum on the second print); a harness version with a part that
  is not plain digits, such as an empty string or `1..2`, is no longer read as a version, and version parts of
  any length compare exactly; and a usage snapshot timestamp that names a leap second that happened is accepted and
  read as an instant instead of being called malformed.
- Review round 127, whole tree: a Kimi session turn whose stream carried the roleless
  `{type:"error",message}` frame now completes `failed` with that message as its reason even when
  the per-turn process exits 0 with a reply and a resume hint (the plain-run rule), and the
  ledger's turn record mirrors it, while the session continues; every `--result-json` envelope
  path measures its final serialization — original fields plus the codemux block, JSON-escaped,
  with the newline — in bytes against the 16 MiB capture bound, and Claude-family, Agy, OpenCode,
  plain Codex, and non-Codex experiment envelopes past it fail with exit 125, no envelope on
  stdout, the bound named on stderr, and usage still reported, while a Codex experiment envelope
  past it is truncated to the bound; and `codemux calls` keys a session by its agent and
  session id together, so records of two agents that share one id are summed and windowed as two
  sessions, never folded into one.
- Review round 123, whole tree: an OpenCode session turn whose stream carried an `error` event now completes
  `failed` with that error as its reason even when the per-turn process exits 0 (the plain-run rule), and the
  ledger's turn record mirrors it; a write that fails between a private per-run artifact's creation and its
  cleanup registration (opencode, pi, and droid provider configs, the kimi no-tools file, the aider history
  file) removes the artifact at once instead of leaving it for the two-day stale sweep; the codex `tokens used`
  figure is accepted only as plain digits, groups of three, or Indian grouping, with one separator throughout, so
  malformed figures record no usage instead of a stripped-digit guess; and a TypeError thrown by a capture sink reaches the
  caller unchanged instead of being relabeled "not valid UTF-8".
- Review round 115, whole tree: the experiment MCP relay records `catalog_served` only when the catalog response
  finished, and records `catalog_fetch_reset` and stops counting the fetch when the client then resets the
  connection with the body unread, so a transfer the client abandons leaves the catalog unserved; a session registry
  lock release that cannot remove its file (any error but ENOENT) reports one diagnostic naming the basename, retries
  on the next update, and never blocks its own process's later writes; and the shared pid probe refuses to probe 0,
  negative, and out-of-range values, so artifacts named with such pids, and agy locks owned by them, are swept or
  taken over under each existing age rule, and an agy probe home whose owner pid is unreadable is swept once its pid
  file is two days old.
- Review round 110, whole tree: credential backups walk the backup directory from the filesystem root one component
  at a time, so a symbolic link anywhere in the path is refused (only a link owned by root, such as macOS's `/var`,
  is accepted) and the refresh-token copy is never written through a link; the opencode and aider end paths bound
  their wait on an in-flight turn spawn by the stop grace, so a stalled spawn can no longer keep session_ended, the
  registry release, and run() from resolving, and a spawn given up on refuses to create its process when it
  resumes, so no child starts after the CLI's run cleanup; JSON-RPC ids that are not bounded strings or safe integers
  are rejected instead of colliding on a corrupted serialization; experiment verification fails when a rollout
  resource call has no exec-stream completion; the Playwright MCP binary embedded in `--mcp-config` is re-stat
  checked immediately before the spawn, against the identity the command build resolved; and a malformed agy
  template lock is taken over once it ages past the stale window instead of blocking every later launch for 60
  seconds, while a lock path that is not a regular file fails the launch at once.
- Review round 108, whole tree: a session output sink that settles after the final flush was abandoned no longer
  changes the queue's accounting (pending bytes went negative) or reports a late sink failure as a new fatal end; the
  doctor's credential store readers open the file once without blocking and check type and size on the descriptor, so
  a FIFO or an oversized file swapped in after a path check is `unknown` instead of a blocked or unbounded read.
- `codemux doctor` no longer reports a working kimi login as `LOGIN-EXPIRED`. Kimi's access token lives 15 minutes and
  kimi renews it from the stored refresh token on its next run, so a store with a refresh token is `logged-in`, with a
  note when the access token has aged out. Only an expired access token with no refresh token is `LOGIN-EXPIRED`
  (remedy: `kimi login`), and a store with no token is `NO-LOGIN`. The expiry is read as epoch seconds or
  milliseconds, as a number or a decimal string.
- Review round 104, whole tree: the kimi no-tools and aider history finalizers remove their files under a parent
  revalidated by its recorded device and inode and arm off only after the removal succeeds, so a swapped parent cannot
  redirect the removal and a transiently failed cleanup stays retryable — the same record now guards the
  project-settings session directory, codex's `--output-last-message` scratch, and the provider-override session
  homes; a `can_use_tool` whose request id is empty, over the protocol bound, or carries NUL is answered by the driver
  itself instead of joining the pending set, where no decision could resolve it; `doctor --timeout` must land on whole
  milliseconds from 1 to 60000 (seconds 0.001 to 60, three decimals), so a sub-millisecond flag is a usage refusal
  instead of every probe timing out; a credential mirror that is not valid UTF-8 is refused instead of copied with
  replacement characters standing in for the token; a ledger line naming an unknown agent or autonomy level is
  malformed, never a totals row; a usage snapshot whose cached count exceeds its input publishes null input and total
  instead of a clamped zero the components cannot sum to — on the agy, codex run, codex session, and experiment
  parsers alike; and an MCP catalog schema with an empty `type` or composition array matches no instance and is
  invalid, never catalog evidence.
- Review round 100, whole tree: a sandboxed launch whose options drop a constraint the request carries — a network
  restriction, a trust level, or a timeout only one side names — or whose options name a trust level weaker than the
  default the request validated, is refused before anything spawns, and the sandboxed spawn runs on the request's own
  deadline; the call receipt and ledger record the network restriction and trust level the sandbox actually ran;
  hermetic kimi homes read `region` and `device_id` as bounded regular files and refuse a symlink, FIFO, or oversized
  file before copying anything; a relay delivery whose close throws fails the run with that error instead of an
  unhandled rejection; a kimi server exit keeps the first substantive failure found while waiting (wire-log, protocol,
  result-changed, call-id-unresolved) ahead of the generic exit message; a codex rollout timeout refuses a pending
  response that carries usage but no assistant message, reasoning item, or function call; a kimi result envelope past
  the 16 MiB capture bound is truncated for experiment runs and fails with exit 125 and the reply dropped for plain
  runs; a session whose outbound queue overflowed refuses ordinary events for the rest of the session and still
  delivers the terminal notices.
- Review round 96, whole tree: a failed aider turn whose history holds its prompt with no reply ends the session
  instead of leaving state the next turn would replay; the first signal to a kimi session stops a landed child at once
  instead of opening the grace drain; every private per-run directory's cleanup revalidates its parent first, so a
  parent swapped for a symlink cannot redirect the removal into another directory, a parent missing at its path counts
  as a refusal because a rename moves the run directory with it, and a refused or failed removal is reported by the
  run's cleanup and retried at exit; the credential file's refresh-token check reads bounded and answers fail-closed
  on a FIFO or an oversized file; an empty opencode message is rejected as invalid input instead of ending a fresh
  session as untrackable; and a malformed `expiresAt` (null, a string, NaN) no longer counts as a live token.
- Review round 93, whole tree: a session registry record's `created_at` and `last_activity` must be the UTC stamps
  the writers make, so a malformed value can no longer outrank real stamps in pruning and evict a valid session; an
  `owner_pid` outside the range a kernel assigns is invalid, and the liveness probe treats such a pid as dead instead
  of answering `session_busy` forever.
- Review round 90, whole tree: a credential scrub that ends on another writer's replacement is judged
  against the file on disk, not the pre-scrub snapshot, so a sandboxed launch can no longer proceed as
  current on a stale access token; a cost total that would leave the finite range prints `unknown` — on the
  totals line and the harness-estimate line — and the session fold yields null instead of `Infinity`; a
  session record whose `ended` is not null or a valid timestamp reads as corrupt, so resume fails closed
  instead of skipping the live-owner check; `calls` opens the ledger before judging it, so a FIFO swapped
  in between the check and the open is refused on the descriptor instead of blocking the command; and a
  ledger that shrinks mid-read decodes only the bytes actually read, never the NUL-filled tail. Round 91 on that diff: an overflowed session cost stays unknown
  until the harness reports a new session figure; a scrub that ends on a file with no Claude credential is `failed`,
  never judged by the copy read before it; a registry `ended` stamp is checked whole, so trailing text or an offset
  is refused.
- Review round 87, whole tree: a session history delta that is not valid UTF-8 ends the session as
  unreliable state instead of passing as a reply with its byte offset committed, an incomplete
  trailing character included (the history is read after the turn's process tree settled); equivalent spellings of the working
  directory (`/tmp/repo` and `/tmp/repo/.`) no longer silently disable project instructions on claude
  and zai runs; the live gate fails when a Keychain snapshot goes missing around the probe pool
  instead of certifying the pool unobserved, and stops before the probes when the baseline is missing
  or its snapshot failed; an oversized harness line reports the bytes seen at the crossing, matching the
  documented figure (docs/session-protocol.md); and an opencode run whose hermetic home cannot be
  removed still removes its provider configuration, combining cleanup failures into one error.

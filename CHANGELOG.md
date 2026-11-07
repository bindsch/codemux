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

Nothing yet.

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

### Added

- `codemux run --max-budget-usd <amount>` passes a spend threshold to a
  headless `claude` or `zai` run as Claude Code's own flag (a positive amount
  with at most ten integer digits and two fraction digits, so it reaches the
  harness as written; every other agent refuses the flag before launch, and so
  do tui and session, where upstream applies it to `--print` runs only). The
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

- The audited ceilings move to the versions the 2026-11-02 live gate passed
  on: agy 1.4.12, claude and zai 2.1.300, codex 0.165.0, kimi 2.4.0 (docs/
  harnesses.md records the evidence per harness). droid 0.221.0 stays at
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
- `codemux tui -a pi` passes `--no-approve` at medium and high autonomy
  only; at read-only and low the TUI keeps pi's native approvals, matching
  the headless flag map.
- Codex autonomy flags changed shape on `run`, `tui`, and `session`: the
  approval policy now rides the `-c approval_policy="never"|"untrusted"`
  config override instead of `-a never|untrusted`, because codex's root
  parser drops `-a` before `exec` and `untrusted` was never a valid `-a`
  value. The sandbox mode flags (`-s read-only` and friends) are unchanged.

### Fixed

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
  2026.11.05, kimi 2.5.0, opencode 1.19.5.
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
- Review round 80, whole tree: `calls --since` no longer treats an empty session id as a session key, so a recent
  empty-id turn cannot pull old empty-id closing records past the cutoff; session usage (codex, opencode, and the
  cumulative fold) applies the envelope's safe-integer rule, so a count past the safe range or a sum that would
  leave it reports null in usage events and the ledger summary instead of a rounded number; `calls --sum` prints
  `unknown` for a token total that would leave the safe range and keeps it unknown; the ledger reader refuses a
  count JSON parsing has rounded past the safe range instead of accepting its rounded neighbor; and a short ledger
  append write is reported (no lock is held, so nothing repairs the file afterwards: the reader marks the partial line
  malformed, together with any record that lands on it). Round 81 on that diff: a field the cumulative fold
  lost to overflow stays unknown through every later turn instead of reviving with the next count, a normalizer's
  own cache-sum overflow included.
- Review round 73, whole tree: an opencode or aider turn whose process spawn rejects after a graceful end began
  (shutdown or stdin close) is reported failed with the spawn error and exits nonzero instead of interrupted with
  exit 0; a Codex experiment inventory is checked only when the tool map carries the experiment namespace and every
  experiment tool, so a map of only `functions` no longer passes evidence validation; every read of the Claude
  credential mirror is bounded at 1 MiB and refuses oversized or non-regular files; the experiment message bound
  counts the JSON body alone on both the HTTP relay and the stdio forwarder, and a request whose relay-injected
  call id pushes it past the bound is refused 413 instead of killing the run, so a boundary-size request succeeds
  end to end; Codex approvals under JSON-RPC ids that differ only by type (1 and "1") stay distinct and separately
  answerable, with the caller-facing request id carrying the id's JSON spelling; a session registry holding one
  session id twice is corrupt, naming the id, instead of silently resuming the first record. Round 74 on that diff: a
  caller's `request_id` may be the JSON spelling of a 128-character harness id (up to 770 code units) and Codex string
  ids are bounded at 128 like every harness id; a tools/call is measured in its final forwarded form (the injected
  call id at its 512-character cap) before it is registered, so a refusal consumes no relay index, leaves no
  correlation state, and is recorded as `request_refused`. Round 75: the native call id cap counts the bytes of its
  JSON spelling, so an id of quotes or multibyte characters cannot outgrow the probe; a server response body of
  exactly the bound is accepted (the framing newline never counted on the request side and now counts on neither),
  and a reader failure answers every pending request with the failure instead of leaving it unresolved until close.
  Round 76: a credential mirror codemux refused on its content (oversized, invalid UTF-8) is `unsafe` when a Keychain
  entry exists, since the child could still read a refresh token from it; a mirror that would exceed the bound is
  never written; a retry of an earlier dispatch is matched before the size probe; the protocol doc says which
  harnesses present a raw request id and which present the JSON spelling. Round 77: a scrub whose conflict re-read is
  refused on content is `unsafe` too, and an oversized mirror write is refused before any refresh-token backup exists.
  Round 78: the writer's conflict re-read is the same bounded, no-follow read, so a file or FIFO swapped in mid-write
  is refused unread.
- Review round 64, whole tree: a session that shuts down before its harness attaches waits for the late child before
  releasing the resume record and emitting the end; an initial stdin write failure stops and awaits the spawned child
  instead of escaping past it; a sandboxed launch whose options disagree with the request (autonomy, working
  directory) is refused before anything spawns; experiment cleanup finalizes the private hermetic home even when
  evidence preservation fails, reporting both failures; the Codex stream parser's rejoin bound covers the first
  fragment and counts UTF-8 bytes, not UTF-16 code units; a scoped Codex notification for an unknown turn while no
  turn is open is a grammar error; experiment evidence refuses calendar timestamps JavaScript would silently
  normalize (2026-02-30); an out-of-order Claude usage delta is recorded as evidence, never as a turn's usage; a
  delivery sink that rejects with `null` still poisons the session's outbound queue. Round 65 on that diff: a stdin
  write whose promise rejects under backpressure fails the run and stops the child, even when the rejection settles after
  the child exited or a protocol sink issued the write after the captures started (a synchronous throw from that writer included), and never replaces an earlier
  capture failure's diagnosis; the Codex parser holds the turn/start window to the first turn id it saw and the
  response must confirm it, and a scoped notification without a turn id in that window is a grammar error; a child that attaches after the end path began gets the orderly shutdown (EOF, grace, stop)
  instead of an immediate SIGTERM that reported a clean harness as failed; several experiment cleanup failures are
  relayed as one failure naming each; a Claude usage delta after its stream's message_stop is evidence, never the
  turn's usage; and a codex or agy spawn that
  throws after a signal ends through the driver's already-begun end path, as claude's did.
- Review rounds 41 to 47 on the machine check and the live gate: a tokenless codex `auth.json` still logs in through
  an environment key; a fresh session's unreferenced private directory is removed on every end path; the OpenCode
  result envelope is bounded once JSON-escaped; the live gate's signal handlers cover the probe pool only; the
  installed layout matches the version exactly; the gate's subprocesses inherit the process
  environment (they lost PATH); a complete override on a harness without the capability, or one its adapter refuses
  (a token cap it cannot carry), is OVERRIDE-INVALID; an active override silences the native login and usage columns;
  the usage verdict follows the launching agent's `quota.timeoutSeconds` budget; a doctor `--format` typo is
  refused before anything runs or spends; the spend probe invokes this codemux, never PATH's; credential stores must
  be regular non-empty files and a tokenless codex `auth.json` is no login; `security` is resolved through the
  executable trust rule; the loopback fake provider treats any credential beside the override key as a leak, caps
  request bodies, and closes its connections on shutdown; probe H2 scrubs the operator's environment; the J listener
  closes on every exit path; ledger lines with negative or fractional counts are malformed; OpenCode's XDG paths are
  read exactly as OpenCode reads them; a Kimi tool call without a string arguments field is a protocol failure.
- A print-only launch (`--print-sandbox`) prepares only the paths its argv names: agy creates no private
  Keychain, reads no login, copies no token, and repairs no search list; its cleanup invokes `security` never. An
  agy run whose private HOME cannot be given a default keychain is refused instead of warned, because agy's token
  refresh would otherwise raise the macOS prompt "a keychain cannot be found to store antigravity" on the operator's
  screen (it did, on 2026-11-03, from a print-only path). The live gate wraps every probe in a Keychain hygiene
  check (user search list and default keychain unchanged) and gains probe P (`--print-sandbox` on every harness,
  zero quota); `codemux doctor` reports a user default keychain that names a missing file as broken.
- `codemux list` labels carry the condition an adapter enforces (`tools(read-only)` for codex and agy,
  `tools(hermetic)` for OpenCode, `hermetic(read-only)` for agy), and `list --json` adds `toolsNoneRequiresReadOnly`,
  `isolationRequiresReadOnly`, `model`, `effort`, and `effortLevels`, so a workflow that reads the listing does not
  send a combination the launch refuses.
- The live gate's per-probe timeout defaults to 600 seconds, so the canonical
  `make live-gate` can run the codex experiment probe it requires (six to
  eight minutes on the release machine) instead of failing it as a timeout.
- A Kimi call Kimi rejected compares its stdout arguments by raw string or
  parsed form, so a literal `{}` the model sent no longer fails the run; the
  live gate's codex experiment probe takes `--codex-model` (default `worker`)
  for a machine without that alias; the hermetic OpenCode model preference
  is read to exactly its judged size; the scode sandbox check names an
  untrusted scode instead of crashing.
- Programmatic `--sandbox-block` paths must be absolute like the CLI's; a
  symlink cycle in a block path refuses after 40 hops instead of recursing
  without bound; the installed-layout pin accepts its own quoted spelling as
  already pinned; the live gate's session probe fails any stdout line that is
  not a JSON event; the coverage gate refuses detailed lcov hits that disagree
  with the record's stated totals; a Kimi call Kimi rejected keeps its raw
  argument string for the stdout comparison whether or not it parsed.
- The credential mirror is opened with O_NONBLOCK beside O_NOFOLLOW and
  judged by fstat, so a FIFO planted between the check and the open cannot
  block the launch; the three places that judge a kimi wire line (the
  fold's regime decision, the session parser, the result parser) share one
  rule, a recognized role or the error type or any string `type`, so a
  stream opening with a typed roleless event is folded as wire instead of
  returned raw, and an untyped JSON value stays the model's plain answer.
- The launcher re-takes its ownership baseline from the validated `id`
  binary; programmatic `--sandbox-block` paths use the registry's own
  canonical rule; the installed-layout check quotes a pinned Bun path that
  needs quoting; the live gate's session probe fails any line after
  `session_ended`, JSON or not; the coverage gate refuses detailed lcov
  entries that outnumber the record's stated counts.
- A resumed project-settings session whose operator login is gone (no
  credential mirror) removes the credential copy a previous run left in its
  private directory instead of handing the old token to the resumed child.
- The registry write probe for agy, opencode, and kimi sessions runs for
  fresh sessions only, as before the module split, and releases the claim
  if it fails; the live gate arms a probe's timeout before writing its
  stdin, so a child that never reads stdin still dies at the deadline; a
  capture-limit failure's partial output is itself bounded at the limit.
- A `--sandbox-block` path whose leaf does not exist yet resolves its
  deepest existing ancestor, so a symlinked parent cannot be retargeted
  before scode reads the block; the coverage gate uses a file's stated
  function counts once any of its lcov records carried two functions of one
  name, and rejects a `DA:` line 0; the fresh project-settings session
  directory's failure cleanup revalidates its parent like every other
  removal.
- The live gate fails on an `UNREADABLE` or `UNTRUSTED` version contract
  like a stale or known-broken one (a harness whose contract could not be
  established is not released on its probes alone; `--allow-stale-contracts`
  lifts all four); `--sandbox-block` paths are canonicalized at the policy
  boundary every caller crosses, not only on the CLI; a hermetic OpenCode run
  refuses a model preference file writable by other accounts; the ledger
  stream joins an incomplete line once at its newline instead of on every
  chunk; the oversized-metadata emergency envelope keeps every documented
  result-block key.
- The launcher redecides the stat dialect before judging `id` and
  `readlink` with it, recognizes Toybox `stat` as GNU-format, and refuses a
  trust-checking tool whose directory is world-writable without the sticky
  bit; `calls --since` reads both of its passes up to the ledger size seen
  at the start, so records appended meanwhile cannot split a session.
- The coverage gate falls back to a record's stated function counts when
  two of its `FN:` entries share a name (lcov keys hits by name), counts
  `export *` as a runtime export in the type-only waiver guard, and the
  hermetic OpenCode model-preference copy reads the file through one
  descriptor opened with O_NOFOLLOW instead of re-opening by path.
- `codemux usage` validates `--timeout` before it looks for usagemux, so a
  bad value exits 64 whatever the integration's state; the CI summary step
  no longer blames the contract printers when the gate step never started.
- The launcher's fixed tool directories put the system-managed ones first
  (`/run/current-system/sw/bin` before `/usr/local/bin`), so the bootstrap
  `stat` and `id` it runs before the full trust rule never come from a
  directory a system without `/usr/bin` leaves to local installs.
- Codex is no longer listed as carrying served-model evidence: its envelope
  reports `served_model` only from a reroute notice, so the live gate's
  provider-override probe prints UNSUPPORTED for codex instead of failing a
  successful override run.
- The live gate's session probe fails a stream that carries any event after
  `session_ended`; `calls --since` adds in-window turns to its session set
  during the second pass as well; the scode sandbox probe runs
  `/bin/sh -c "exit 0"` instead of `/usr/bin/true`, which NixOS lacks.
- The launcher treats BusyBox `stat` (Alpine) as GNU-format instead of
  BSD, so Linux hosts without coreutils resolve their Bun; a relative
  `codemux_pinned_bun` value is refused instead of spinning the ancestor
  walk.
- The coverage gate judges an lcov record's stated `LH`/`LF` and `FNH`/`FNF`
  before its detailed entries replace them, so a summary with more hits than
  lines is refused whether or not `DA` lines follow.
- A Kimi call the experiment classes as rejected by Kimi for unparseable
  arguments must also carry the same raw argument string on stdout, and a
  server that answered an empty-argument call with the same "Invalid args"
  words keeps its relay match instead of being classed as rejected.
- The type-only coverage waiver guard counts exported functions, `export
  default`, `export =`, and `export { value }` re-exports as runtime values,
  so a file carrying any of them cannot be waived as declarations only.
- A Codex experiment serves the real model cache even when another Codex
  client wrote it: the ChatGPT desktop app's app-server daemon rewrites the
  shared `models_cache.json` with its own `client_version` about hourly, and
  the equality rule refused every experiment it had touched. The mismatch is
  a stderr warning and a `catalog_client_version_mismatch` record; an
  undetected Codex version still refuses.
- The live gate keeps a failed probe's working directory, with its
  experiment recording, under the report directory and names it in the row,
  instead of deleting the evidence with the probe.
- A hermetic OpenCode home whose model-preference copy throws (a full disk,
  a permission change) is removed instead of left behind: its cleanup is
  registered before the copy runs.
- The quota gate no longer refuses a launch on usage it cannot read: a
  usagemux `error` or `unavailable` status, or a snapshot with no bounding
  window, warns with the provider's message and proceeds. A refusal needs
  the `primary` window or a `secondary`/`tertiary` window whose span is one
  week — a window's name never decides, so a weekly-named third-party pool
  (agy's antigravity pools, cursor's grok pool) warns while a week-long
  tier window refuses whatever the provider calls it; `scoped` pools warn
  below the ceiling too, and only `mcp` windows never gate (audit round 2,
  B1, B7). The live gate of 2026-11-02 had every claude launch refused
  on a usage backend that answered in 30 seconds, every opencode launch
  refused for missing browser cookies, and every cursor launch refused on an
  empty third-party pool while the plan had 42 percent left.
- The agy session driver sends the stream-json input frame agy documents,
  keyed by `event` with `message.content` text blocks; agy 1.4.12 answered
  the claude-shaped `type` frame with an ERROR result, so no agy session
  turn ever ran.
- A hermetic OpenCode run carries the operator's model preference
  (`model.json` in the state directory) into its private state, so it runs
  the model a plain run uses instead of the provider's first model, which
  the subscription may not include.
- Three tests that depended on where or how the gate ran: the live-fixture
  privacy scan no longer treats every directory name on the checkout's path
  as a forbidden word (a clone under a `scratch` or `codemux` directory
  failed), the agy keychain test reads only complete ledger lines while a
  builder is appending, and the session-timeout test waits for the started
  session and its open turn before the timer ends it.
- A Kimi experiment run no longer fails its final integrity check on a tool
  call Kimi itself rejected for unparseable arguments (`args: {}` on the
  wire, an `Invalid args for tool` error to the model, nothing dispatched):
  the call is recorded as `harness_invalid_args` and the assistant's
  unparseable `arguments` string as `native_arguments_malformed`. The hold
  probe of 2026-11-02 returned both markers correctly and was failed on the
  first of 13 such rejections.
- The live gate's experiment-MCP probe writes the spec's accepted
  harness prefixes from the build under test — the candidate's own
  `list --json` when one is probed, this checkout's table otherwise — so a
  candidate declaring a different prefix is probed against its own
  contract, not refused on this checkout's.
- A kimi plain run whose capture fails on one kept line past the 16 MiB
  bound names that line in the failure — its length and its first 512
  bytes with controls escaped — instead of answering a bare 125 that says
  only that some line was too long.
- A kimi line that opens with `{` but does not parse as one kimi event —
  one line of a pretty-printed JSON object spread over several lines — is
  plain text, not a cut wire: the object returns verbatim as the reply.
- The live gate's `usage --json` check validates stdout with the same
  snapshot parser `codemux usage` runs and fails on any other JSON, which
  parses but is not a usagemux snapshot.
- Coverage accounting merges repeated lcov records for one path by the
  maximum hit per line and per function, so two partial records of one
  file read as the union of their hits instead of the larger of their
  totals.
- The experiment relay closes the connection whenever it answers a request
  whose declared body it never read (the 401, 404, 405, and catalog
  routes). The unread bytes could otherwise be parsed as the next request
  on the reused socket, and the next request was answered 400 instead of
  its own status.
- `codemux calls` streams the whole ledger in one bounded pass: the
  `--since` window and the `--sum` totals see every record whatever the
  ledger's size, and only the listing is bounded, by `-n`. The totals no
  longer stop at the newest 16 MiB behind an under-count note.
- The live gate's session probe (F) drives the session protocol instead of
  closing stdin before the turn ran: the user frame opens a scripted
  exchange whose shutdown frame is written only after the turn's
  `turn_completed` event, and the probe now requires a `session_ended`
  event with `reason: "shutdown"` and exit code 0. The live gate of
  2026-11-02 closed stdin at once — EOF — so codex rejected the frame
  (`shutting_down`), kimi's drain grace expired mid-turn, and every row
  failed on a cause that was the probe's, not the harness's.
- The live gate's experiment probe (G) verifies delivery from the run's
  recording, not from the model's echo: the reply carries the marker
  (bare, or under the harness's own wall-time header), and the probe
  directory's recording must hold exactly one `model_tool_result` opening
  with the harness's own header followed by the marker — the bare marker
  for claude and zai — plus one `result_comparison` with `equal: true`. A
  missing or unreadable recording fails naming its path. Both live-gate
  replies of 2026-11-02 arrived as the bare marker because models drop the
  header, so the old reply-only check failed every codex and kimi row on
  a compliant run.

- A model alias the chosen agent has no mapping for (`run -a codex -m sonnet` with
  the default aliases) is refused with exit 64 like every other caller mistake,
  instead of a configuration error exit 1 (review round 21, contracts-2).
- A caller `--sandbox-block` that sits inside a launcher-allowed harness
  state directory is refused before the spawn (exit 64, naming both
  paths). scode drops a block beneath its own recursive allow, so the
  block could not be honored in either overlap direction; before, only a
  state directory inside the block was refused.
- An oversized kimi tool event (over the 16 MiB capture bound) is shed
  from its line prefix while the plain-run stream folds, instead of
  latching exit 125: the reply around it survives, and the canary scan
  still covers the shed bytes. Only a line that would be kept remains
  subject to the bound, so an oversized assistant text line still fails
  with 125.
- A valid JSON value the kimi wire never spells — `"done"`, `42`, `true`,
  `null`, `[1,2]`, `{}` — is a plain answer, not a wire failure. The
  wire-shape rule is one shared classifier (a JSON object with a
  recognized role or a documented event shape), so the fold's regime
  decision and the result envelope's plain hatch cannot disagree.
- The live gate report escapes control characters in the candidate NOTE
  line, like every other printed argument; a raw ESC or newline in the
  candidate's own listing command could not reframe the report.
- Candidate mode's experiment-MCP and provider-override probe sets come
  from the candidate's own `list --json` (the new `experimentMcp`,
  `experimentPrefix`, and `servedModelEvidence` capability fields), and
  the gate's static tables are the source tables themselves, pinned by
  identity; a listing from an older build is refused instead of probed
  with this checkout's facts.
- A session spawn passes its own executable resolutions (the scode
  identity and the resolved command's trust-checked positions) to the
  pre-spawn re-stat, pinning them the way the run path does, so another
  launch's record for the same path can no longer satisfy the session's
  re-check.
- The run path's scode identity check is captured in the resolution's
  own synchronous block and carried across the async probes to the
  spawn; a capture at the spawn site could read another launch's record
  for the same path.
- A session spawn that throws after a signal already began the end path
  ends through that path — `session_ended` is emitted and the record is
  released or discarded exactly once, inside the end path's own ordering
  — instead of releasing the record and exiting hard before the event
  and any pending `--final` removal could run.
- The in-process test seam that disables the quota gate requires the
  nonce the test preload generated (mirrored on `globalThis`), not just
  a `CODEMUX_TEST_NO_QUOTA_GATE` value: the variable alone, exported by
  an operator or leaked into a child, disables nothing.
- A missing claude credential mirror still means "no operator login",
  but any other stat failure (permissions, an unreadable parent) now
  refuses with its own message instead of silently running without the
  credential.
- `--sandbox-block` paths are canonicalized once, where the flags are
  parsed (symlinks dereferenced where they resolve, the missing tail kept
  literal, then deduplicated and sorted), and that canonical spelling is
  what every sandboxed child passes scode and what a session records.
  Before, only the session record was canonicalized while the children
  enforced the caller's raw spelling, so a symlink retargeted between
  turns made later children block the new target and regain the
  originally named tree.
- `--print-sandbox` on `run` never touches the credential mirror. The
  print-only path still ran the claude family's per-run credential copy:
  a mirror holding a refresh token failed the print outright, and a valid
  mirror was written into the temporary private directory. The copy is
  deferred, as the session's pre-claim probe already did; the print reads
  no credential state and writes nothing into the private directory.
- The live gate's version-contract column covers every harness the
  candidate lists as available. In candidate mode the column now resolves
  each binary through the candidate's own `list --json` (whose agent
  entries carry a new `binary` field); a harness this checkout cannot
  resolve gets an `UNREADABLE` row naming the binary instead of no row,
  and a candidate-available harness left without a row fails the gate.
- Each sandboxed spawn re-checks the scode binary against its own launch's
  recorded identity, not the process-wide list, the same pin the wrapped
  command already had. Without it, a scode replaced between one launch's
  probe and another's could be executed by a launch that never probed it.
- The coverage gate's lcov parser accepts a named `TN:<name>` test header
  (not only the bare `TN:`) and merges repeated `SF:` records for one
  path — the maximum hit count under the shared found count, refusing
  records whose found counts disagree — instead of keeping only the last
  record's counts.
- The live gate reads its probe matrix from the candidate it tests. With
  `--codemux <path>`, discovery and capabilities now come from the
  candidate's own `list --json` (a new machine-readable listing; before,
  they came from the checkout running the gate), the candidate's
  `--version` must match the checkout unless `--allow-version-mismatch` is
  passed, and the report carries a NOTE naming the candidate as the source
  of the matrix.
- The live gate's experiment probe (G) accepts exactly the boundary each
  experiment builds. A codex reply with the marker glued straight after
  `Output:` — no newline — passed the gate though the experiment's own
  compare requires the newline; a kimi reply with a doubled newline passed
  the same way.
- The live gate's result-JSON probes (C and H) now require the requested
  `OK` answer. The verifier only checked that the envelope's reply field
  was a string, so a well-formed envelope answering a different question
  passed the gate.
- The live gate's hermetic-check probe (D) now has an outer deadline of
  `2 × --timeout + 30` seconds. The check runs two sequential launches —
  the hermetic probe, then its control — each with the full `--timeout`,
  and the old one-launch allowance could kill a healthy check at the
  second launch. Single-launch probes keep `--timeout + 30`.
- A `--final` session end that begins while the harness child is still
  starting (a signal during the launch preflight) now waits for that child
  to terminate and settle before removing the private config directory and
  stamping the record final. The removal used to run with no child
  attached, while the child the launch was about to produce could still
  read or recreate the directory.
- `--print-sandbox` no longer runs the credential sandbox preparation on
  `run` or `session`. The command is print only; it prints the scode argv
  it would exec and no longer refreshes the claude credential mirror on
  the way. The printed argv is unchanged — the preparation step
  contributes no arguments to it.
- A session aborted between the launch preparation and the spawn no longer
  removes a resumed `--final` session's private config directory. Nothing
  ran, so `--final` has nothing to remove: the directory stays for the
  next resume and the released record reads ended and resumable, never
  final. A fresh directory nothing points at is still removed.
- `session --resume --print-sandbox` records nothing. The print-only
  invocation used to claim the real session — clearing its end stamp and
  changing the owner — and then release it with a fresh end stamp; it now
  reads the record for the resume lookup's refusals and leaves the
  registry file byte-identical.
- The launcher no longer hardcodes `/usr/bin/readlink`, `/usr/bin/id`,
  and `/usr/bin/stat`. Each is resolved once from the first acceptable
  match in `/usr/bin`, `/bin`, `/run/current-system/sw/bin`,
  `/usr/local/bin`, `/opt/homebrew/bin` (system-managed directories first) — never from PATH —
  held to the same owner and write-bit rule as the Bun binary, so
  distributions whose coreutils are not under `/usr/bin` (NixOS) work.
- A hermetic Kimi run's canary scan covers the output the streaming fold
  drops. A planted code word that appeared only in a tool result was
  never scanned, so a harness that printed it was certified clean; the
  fold now records every marker match in what it sheds and the scan
  surface carries that evidence.
- A working directory carrying `.scode.yaml` refuses a sandboxed run with
  exit 64 like every other project-execution configuration refusal; it
  was a plain error, exit 1.
- A `--resume --final` claim no longer stamps the record final at claim
  time. A launch preparation that refuses after the claim (the quota gate,
  the version floor) releases the record ended and resumable, because the
  private directory was never removed; `final` is written only by the end
  path that removed it.
- The launcher requires one working directory on both sides of a
  project-settings launch — the validated request's directory and the
  executed directory — refusing the mismatch as experiment MCP and agy
  isolation launches already did.
- Live-gate probe C verifies each harness's own answer field (`reply` for
  kimi and opencode, `result` for claude, zai, and codex, `response` for
  agy), so an envelope spelling another harness's field fails, and it
  validates the documented block types: an object `model`, a string
  `labels`, or a string token count fails naming the field.
- Live-gate probe F fails when the live-session registry exists but cannot
  be read or parsed; only an absent registry file is nothing to check.
- The live-gate report escapes the stale-contract summary's version and
  detail like every other line, so no raw control byte survives anywhere
  in the report text.
- The credential mirror read is bounded at 64 KiB, and a mirror that
  cannot be opened or read is refused naming its error class (EACCES, EIO)
  instead of misreporting "not a regular file".
- Pinning the launcher's bun replaces the whole pinned line: re-pinning
  the same path is a no-op and a different path is refused, instead of
  appending a second path to the first.
- The launcher refuses a resolved bun target that is not executable with
  its own message, instead of dying at exec with exit 126.
- Live-gate probe G applies the probed harness's own header rule: kimi's
  compliant three-decimal `Wall time:` reply passes, codex's four-decimal
  `Output:` header passes for codex, and claude and zai answer with the
  bare marker; a codex or kimi reply without its own header fails naming
  the missing header, and the other harness's header shape fails.
- A `--final` session runs its whole private-directory removal inside the
  driver's end path — one attempt, a pause, one retry — before the record
  is stamped and `session_ended` is emitted, so a first failure that the
  retry clears ends final and non-resumable with the directory gone,
  instead of deleting the directory while the record still promises a
  resume.
- The credential mirror is read with `lstat` and through an `O_NOFOLLOW`
  descriptor: a symlinked or non-regular mirror refuses the
  `--experiment-project-settings` run instead of being read through.
- The run-path and session private config directories revalidate their
  parent directory before every removal; a parent swapped for a symlink
  refuses the removal instead of resolving the link.
- A usagemux snapshot dated more than a minute in the future is treated as
  unreadable, like a stale one, instead of passing the freshness check
  with a negative age.
- `CODEMUX_TEST_NO_QUOTA_GATE` is the test suite's hermeticity switch for
  the quota gate (set only by the test preload); no operator environment
  variable silently disables the gate — `--no-quota-gate` and
  `quota: false` are the only switches.
- `kimiControlBrandHome` is refused on every request that is not the
  experiment control probe, with or without `--experiment-mcp`.
- A print-only session (`--print-sandbox`) never removes the private config
  directory a resume runs in and never stamps the record final; `--final`
  there prints `--final ignored: nothing ran` and a fresh directory is
  still removed.
- A `--final` session whose private directory could not be removed (both
  the end-path attempt and the CLI's retry failed) exits 1, keeps the
  record ended and resumable with no final stamp, and prints the kept
  directory's path; the stale-directory sweep reclaims it later.
- A run's private config directory removal that fails once is retried at
  process exit by an exit hook that stays registered until a removal
  succeeds.
- `check` validates the plain control request before the quota gate (as
  run does) and validates the hermetic twin on the canary's planted
  directory, so a hermetic check of kimi, codex, or agy from a repository
  holding project configuration files (AGENTS.md and kin) is no longer
  refused before any probe runs.
- Live-gate probe G accepts a compliant codex or kimi reply: the fixture
  marker after a valid `Wall time:` header, parsed with the experiment's
  own header parser, not just the bare marker.
- Result envelopes carry `codemux.served_model`, the model the provider
  reported serving the run (null where the harness's wire exposes none);
  live-gate probe H asserts the override on it and reports UNSUPPORTED for
  harnesses whose envelopes cannot carry that evidence.
- Live-gate probe C verifies the documented `codemux` block schema — every
  documented key present, the usage object with its five fields — instead
  of accepting any envelope that names the agent.
- `session` refuses `--enable-playwright-mcp` combined with `--hermetic
  --experiment-project-settings`, as `run` refuses it under `--hermetic`.
- OpenCode's builder-level refusals (`--experiment-project-settings`
  without `--hermetic`, the remote-config carrier, plain `--tools none`)
  are usage refusals (exit 64), not exit 1.
- The quota gate's weekly detection matches a weekly window by span: its
  span is one week within an hour of provider rounding, instead of a
  below-only floor at exactly 10 080 minutes.
- Claude and Z.AI remove the private project-settings directory they
  created when the experiment bridge fails to build, instead of stranding
  it for the stale-directory sweep.
- A refused executable-trust resolution (a binary inside the execution
  working directory) records no identity, so a later spawn in the same
  process cannot re-check and accept it.
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

## [0.15.1] - 2026-10-28

### Changed

- Gemini medium now uses `--approval-mode yolo` with scode required, so headless runs can edit files and execute shell commands. Qwen medium keeps `--approval-mode auto`, which already supports shell commands after classifier review. The live gate probes medium shell execution for every harness without exceptions.

### Fixed

- The medium probe no longer reads a dotfile, which Cursor's Smart Auto classifier refuses.

## [0.15.0] - 2026-10-28

### Added

- Add `make live-gate` for release-owner checks of every installed harness
  with read-only reply and medium shell-command probes under the default
  sandbox. Require both probes before tagging; record credential skips and
  refuse failures or undocumented differences across harnesses.
- Add repeatable `run --label KEY=VALUE` metadata and `CODEMUX_LABELS`
  defaults for wrappers. Record labels in the call ledger and structured run
  results. Add `calls --label KEY=VALUE` filters and `calls --sum --by KEY`
  totals grouped by label value.

### Changed

- `--auto medium` headless runs of Claude and Z.AI now execute shell commands inside the sandbox, as every other harness that can run a command headless already did. Gemini's medium (`auto_edit`) cannot and is documented as unsupported. Persistent sessions retain their per-tool ceiling callback and receive no medium `Bash` grant.

### Fixed

- Normalize Kimi 2.3.2 headless bullet blocks to reply text. Preserve plain
  replies and stderr.
- Sandboxed Copilot runs on macOS, both headless and TUI, extract bundled
  packages under `~/.cache/copilot` instead of the blocked `~/Library`
  directory. Unsandboxed runs, other platforms, adapters without HOME, and
  non-empty `COPILOT_PKG_CACHE_HOME` or `COPILOT_CACHE_HOME` settings passed
  through with `--pass-env` receive no cache override.
- Give every sandboxed macOS Antigravity run a private Keychain, including API-key and file-token runs. Make it the default for its private HOME so token refresh has a default and does not show the "A keychain cannot be found to store Antigravity" dialog when selection succeeds. Preserve the real user's default and verify both defaults after selection. If the real default remains unreadable after a retry, skip private-default selection and warn; agy may still prompt to store its token.
- Sandboxed headless Cursor runs on macOS automatically use the file credential store
  when `~/.cursor/auth.json` exists. A non-empty, passed-through store setting
  overrides this choice. An API key does not disable file-store selection.
  Log in once with `AGENT_CLI_CREDENTIAL_STORE=file cursor-agent login`.
  A sandboxed run that fails with `Authentication required` in stderr gets
  a Keychain explanation and login options without changing its exit code.
  A passed-through API key or auth token also works. `--no-sandbox` keeps
  the default Keychain login.
- Ordinary sandboxed Antigravity `--auto medium` runs grant `command(*)` in
  a private settings copy. This permits headless shell commands while
  preserving the operator's settings and existing allow rules.

## [0.14.2] - 2026-10-25

### Added

- `--experiment-mcp` accepts the `zai` agent: it runs the same Claude Code
  binary and SDK control bridge as `claude` against the Z.AI endpoint, so
  the experiment server, safe mode, recordings, and result envelope are the
  claude path unchanged. Every other adapter still refuses.

### Fixed

- Headless `claude` and `zai` runs can search and fetch the web again at
  every autonomy level: Claude Code's subprocess environment hardening
  forces its permission mode to default, which denies `WebSearch` and
  `WebFetch` headless, so the two web tools are now granted with
  `--allowedTools` alongside the existing write grants. Neither writes
  locally; the trade-off, that a run reads pages nobody approved and the
  model picks the URLs it fetches, is documented in autonomy and
  sandboxing, and `codemux run --no-web` denies the two tools for a review
  of an untrusted tree (a deny rule, so it holds at `--auto high` and over
  saved approvals; other agents refuse the flag). Persistent sessions keep their ceiling and
  take no web grant.

## [0.14.1] - 2026-10-19

### Fixed

- `--experiment-mcp` compares an MCP image block as Claude Code delivers it
  (the API's base64 image source with the same bytes), so a screenshot
  returned by a Playwright tool no longer ends the run; a text block is
  compared as Claude rebuilds it (`{type, text}` plus a truthy `_meta`).
- `--experiment-mcp` accepts Claude Code 2.1.300's oversize-result spills of
  text results: the token form for one text block (`Error: result (N
  characters ...) exceeds maximum allowed tokens. Output has been saved to
  <path>.` plus one of Claude's guidance templates) and the persisted form
  for any text blocks (`<persisted-output>` from the 50,000 character result
  cap, with a size label and a 2 KB preview). The token form's JSON variant
  for several blocks still fails the run. Counts are checked against the
  runtime's locale data, with the grouping marks that differ between CLDR
  releases standing for each other. The delivered
  string must equal Claude's message exactly, the file must lie in the
  child's project directory, and its content must equal the server text or
  the JSON of the server's text blocks (a capped prefix only when the message
  names the cap and the prefix matches it). Comparisons record accepted spills
  with `spill_kind` and the failed check for rejected ones.
- `--experiment-mcp` tolerates `notifications/tools/list_changed` when a full
  paginated inventory recheck confirms unchanged tool definitions. Notifications
  and rechecks are recorded without forwarding them to Claude or disturbing
  pending tool responses. Changed definitions and all other server-initiated
  messages still fail the run.
- `--experiment-mcp` no longer fails a run when Claude Code delivers a
  single-text-block server result as a plain string without its trailing
  whitespace, which it does for `isError` results; a tool call that errors
  (a click on a missing element, a failed navigation) is ordinary agent
  behavior. Any other difference still fails the run.

## [0.14.0] - 2026-10-18

### Changed

- `--experiment-mcp` accepts any tool names the experiment server advertises,
  not only `bash`, `bash_bg`, `poll`, `kill`, `read` and `write`. A name must
  match `[A-Za-z0-9_-]{1,64}` and its namespaced form `mcp__<name>__<tool>`
  must fit in 64 characters, the bound Claude Code's SDK bridge applies. This lets a hermetic run expose a
  benchmark's own tools, such as Playwright MCP's `browser_navigate`.

## [0.13.6] - 2026-10-15

### Fixed

- The claude override's base URL normalization examines only the pathname:
  a host named `v1` and a query string are left alone, one trailing `/v1`
  is stripped from any path (`/gw/v1` becomes `/gw`), and an unparseable
  URL passes through to the override's own validation (0.13.5 review).

## [0.13.5] - 2026-10-15

### Fixed

- The claude provider override accepts a base URL ending in `/v1`: Claude
  Code appends `/v1/messages` itself, so that form produced
  `/v1/v1/messages`, a 404 the binary reported as `model_not_found` before
  any operator-visible request. One trailing `/v1` is now stripped; host
  roots and gateway paths are kept as given (`docs/provider-overrides.md`).
- Documented the output-token cap a small-context endpoint needs under the
  claude override (`CODEMUX_CLAUDE_PROVIDER_MAX_OUTPUT_TOKENS`), with the
  vLLM error that signals it.
- Documented that Claude Code 2.1.280's full-tools prompt is at least
  31,745 input tokens, so a 32k endpoint needs `--hermetic --tools none`
  or a larger window; the symptom is a timeout, because Claude Code retries
  the endpoint's 500 until the run's deadline.

## [0.13.4] - 2026-10-13

### Documentation and verification

- Replace the versioned README banner and long duplicated reference sections
  with installation, first-run/session examples, essential limits, and command
  navigation. Use repository links that work from Homebrew's README location.
- Add one current documentation index and references for CLI options,
  configuration, harness capabilities/version evidence, autonomy, isolation,
  authentication, provider routing, results/usage, sessions/protocol, experiment
  MCP, troubleshooting, and architecture.
- Correct hermetic, tools-none, persistence, Agy prompt/configuration/recovery,
  session transport/resume, timeout, usage-scope, output-limit, and ledger
  selection claims. Describe incomplete historical evidence explicitly.
- Freeze designs, panels, and task reports as dated historical summaries with
  immutable source links and current-reference dispositions. Consolidate release
  histories, mark false-statement corrections, and define the date convention.
- Correct run/check/session/calls help to describe actual timeout phases,
  normalization, paid probes, capabilities, parser behavior, and mixed output.
- Make `bun run check` invoke `make check`, including shell syntax validation.
  Fix the shell target to check both scripts separately; the old second path
  was only an argument to the first script. Make `bun run smoke` delegate to
  `make smoke` and cover every command help path.
- Unify testing/releasing instructions around `make release-gate`; require
  curated release notes and source/Homebrew version, checksum, license, and
  documentation-layout checks.
- Replace historical prose pins with public-contract documentation checks and
  retain behavioral output-boundary coverage. Check current examples, command
  coverage, source/distribution links, metadata, and spelling.

## [0.13.3] - 2026-10-13

### Fixed

- Report canonicalization errors for owned Antigravity Keychain mirrors and templates during recovery and cleanup. Preserve inaccessible unrelated search-list entries.
- Support symlinked Gemini configuration directories in ordinary and sandboxed Antigravity runs, including before any probe root exists. Continue rejecting symlinked or foreign-owned probe roots.

## [0.13.2] - 2026-10-13

### Fixed

- Accept and record documented Claude control-protocol notifications, including compaction boundaries and tool-progress heartbeats, while rejecting unknown frame types.
- Suppress the Codex Plan fallback after a protocol failure, including a top-level error after turn completion.
- Share Antigravity configuration entries individually so API-key runs never link the unused OAuth token into their private homes.
- Recover stale private homes and Keychain mirrors from both validated, user-owned login and injected HOME probe roots.
- Reject symlinked probe roots before Keychain recovery and restrict mirror ownership to the exact private run-directory layout.
- Preserve inaccessible unrelated Keychain search-list entries without blocking recovery.
- Bound asynchronous adapter cleanup on signals by the existing grace period and report incomplete cleanup before exiting.
- Reject relative and empty injected HOME values in the shared adapter constructor, before credential preparation.

## [0.13.1] - 2026-10-13

### Fixed

- Skip all file-token inspection and copying when an Antigravity API key survives sandbox environment filtering.
- Preserve completed child results, including exit codes and captured output, when protocol or adapter cleanup fails. Append the cleanup diagnostic to stderr.
- Validate absolute, user-owned HOME directories before stale-home sweeping. Sweep only marked, user-owned entries under the real user's probe root.
- Restrict Keychain recovery to the canonical template path and real user's probe root. Preserve and report unrelated lookalikes.
- Stop parsing a Claude control chunk synchronously after a rejected request, before a later tool call can reach the experiment server.
- Require boolean experiment error flags when present on both server and model results.
- Reject unknown, missing, and non-string experiment frame types.
- Use synchronous exit cleanup for private homes, Keychain restoration, and experiment recording finalization. Await asynchronous cleanup before known exits.
- Cancel Aider and OpenCode shutdown waits on fatal errors while retaining the raw child exit contract.
- Treat a Kimi spawn rejection with a null value as a fatal spawn failure.
- Prepare Claude's credential mirror under the same HOME supplied to the child.
- Retain a completed Codex Plan reply when the child subsequently exits nonzero.
- Bound cumulative human-mode Codex output before appending each line.
- Reject Codex warning items after a failed turn as trailing stream drift.

## [0.13.0] - 2026-10-13

- Add Claude experiment MCP through its SDK control bridge. It requires
  hermetic mode, no built-in tools, and read-only scode. The experiment server
  runs outside scode with named environment variables. Record server bytes,
  model-bound tool results, inventory comparisons, and the recording path.
- Refuse experiment MCP for Codex because it adds a result header; other
  adapters also lack a verified mechanism. Fail JSON-RPC errors, changed
  inventories/results, protocol aborts, and incomplete server cleanup.
- Enable Antigravity hermetic and tools-none paths with the recorded
  Antigravity 1.3.3/scode 0.6.0 evidence. Use private homes, policy restrictions,
  a template Keychain mirror, and bounded cleanup.
- **Correction:** the retained live checks identify an internal tested tree,
  not an immutable commit. Subsequent hardening has synthetic regression
  evidence; no later live verification is implied.

## [0.12.0] - 2026-10-12

### Upgrade notes

- Plain Codex launches now use `--json`, reduce the stream, and record full
  usage. Preserve human-mode reply bytes, including the appended newline.
  A completed reply survives a later nonzero child exit; protocol failures
  suppress it. Plan-only replies use a bounded last-message fallback where
  writable. Missing or unreadable named fallback files fail.
- **Correction:** output limits apply while a line accumulates and when it
  completes. Discarded aggregate tool output does not consume retained capture,
  but one oversized line, retained reply, or stderr can still fail at exit 125.
  Earlier claims that only completed lines counted or that no tool-output
  volume could fail a run were false.
- Scrubbed provider credentials require scode's `--keep-env` support, including
  untrusted presets that imply scrubbing. Run, TUI, and session paths share the
  rule. Hidden scode configuration that enables scrubbing remains the operator's
  responsibility.
- Claude overrides add inline model-picker settings on run/TUI/session launches.
  Refuse nonempty `CODEMUX_CODEX_PROVIDER_STORE`: supported Codex releases have
  no matching setting and already request `store: false`.

### Added and fixed

- Add Kimi sessions over a per-turn stream-json process and native session
  store. Preserve deferred identity, registry ownership, provider identity,
  prompt bounds, and shutdown/spawn ordering.
- **Correction:** Kimi's leading `!` is model text on the audited headless
  path. Codemux refuses that shape and the word-bounded `/goal` name as policy;
  only `/goal creates` invokes the audited goal flow.
- Report raw child exits, summary exits, and caller shutdown intent separately.
  Nonzero or signaled child exits fail sessions even during requested shutdown.
  Retain terminal-event capacity and fail incomplete final output.
- Add Z.AI effort support; update Droid's gemini-flash alias to 3.6; prefer
  `cursor-agent` over `agent`, keeping desktop Cursor opt-in.
- Preserve recovered Codex error diagnostics, order fresh Kimi identity events,
  fail rejected interrupt delivery, validate exact KIMI_CODE_HOME values, and
  maintain process-tree cleanup and output-limit behavior under varied chunking.

## [0.11.0] - 2026-10-08

- Add the local call ledger and `calls` command with agent/time/limit filters,
  JSONL output, and per-field totals. Record run/check, turn, and closing
  session usage without prompts, credentials, or environment values.
- Store HOME-derived state with restrictive permissions. Allow
  `CODEMUX_CALL_LOG` relocation or disabling. Append failures warn without
  failing a completed run; reject unsafe files and bound reads to the newest
  16 MiB.
- Plain Claude/Z.AI/Agy/OpenCode runs now use structured harness output and
  unwrap replies. OpenCode discards tool events while retaining reply/usage.
  Codex's plain structured path follows in 0.12.0.
- **Correction:** closing token counters cover the driver invocation, not
  every resumed lifetime. Claude/Z.AI closing cost adopts lifetime cost.
  The newest-summary fold can omit older invocation usage if turns are absent.
- **Correction:** `--since` accepts JavaScript Date parsing as well as
  durations. `--json --sum` appends human-readable totals. A selected turn
  can include a lifetime cost summary; totals are not interval attribution.

## [0.10.0] - 2026-10-08

### Upgrade notes

The registry gains `provider_base_url`. Version 0.10.0 reads older records;
0.9.0 treats the expanded registry as corrupt and refuses resume. Upgrade every
binary sharing a home before mixing versions. Downgrading requires removing
the registry and losing recorded resume history.

### Added and fixed

- Add OpenCode and Aider sessions with native-store and owned-history resume,
  respectively. Both honestly report unsupported steer/interrupt/permission/
  delta/file-change capabilities.
- Carry provider overrides and caps into supported session spawns. Reject
  provider mismatches on resume. Codex override homes are keyed per session,
  never shared across sessions.
- Harden session-home and Aider-history ownership, symlink, bounds, race,
  and cleanup checks. Consult registry liveness before sweeping; unknown
  liveness preserves state. Sweep only sufficiently old eligible homes.
- Fix shutdown/drain behavior, pending spawns, usage folding, history parsing,
  late child cleanup, registry release ordering, and unsupported prompt commands.

## [0.9.0] - 2026-10-07

- Add `session` for Claude, Z.AI, Codex, and Agy with JSONL input,
  acknowledged inputs, versioned event envelopes, author labels, capabilities,
  timeouts, permissions, shutdown, and guarded resume.
- Enforce autonomy ceilings on caller approvals, including rewritten input,
  canonical paths, symlinks, executable configuration, and Unicode/case aliases.
- Serialize registry updates and claim resumes before spawning. Preserve
  trustworthy state, release claims on every end path, and fail unsafe registry
  contents. Handle deferred identity and incomplete persistence explicitly.
- Bound queues, frames, output flushing, and process-tree shutdown. Pair opened
  turns with completion, retain diagnostics/unknown events, fail protocol drift,
  and report failed startup/resume launches.
- Adopt Claude-family lifetime cost without adding it per turn. Normalize
  mid-turn Claude input as injection, not a new queued turn.
- Refuse provider overrides in this release; support arrives in 0.10.0.
  Correct platform-specific registry tests.

## [0.8.0] - 2026-10-07

- Add provider overrides for Claude, Codex, and OpenHands, plus supported output
  and context caps. Claude requires Messages API compatibility; Codex requires
  Responses API compatibility and uses private per-run configuration.
- Add Codex multi-agent override control and keep provider keys out of spawned
  shell tools. Refuse unsupported caps and unsupported TUI override paths.
- Separate override credentials from operator login and credential-mirror
  synchronization. Restore OpenHands overrides behind `--override-with-envs`.

## [0.7.1] - 2026-10-05

- Remove refresh tokens from sandboxed Claude credential mirrors while retaining
  access tokens and descriptive fields. Keychain tokens are authoritative when
  they differ. Existing mirrors are backed up before atomic scrubbing.
- Expired/revoked access tokens fail authentication; a sandboxed mirror cannot
  refresh. Refuse a known mirror that cannot be safely scrubbed.
- Preserve file-only logins, unreadable Keychain state, explicit profiles, and
  `CODEMUX_NO_KEYCHAIN_SYNC` escape-hatch behavior with diagnostics. Keep
  backups private and prune older completed backups.

## [0.7.0] - 2026-10-04

- Add provider overrides for the retained supported adapters, including Droid
  custom-model settings, Kimi environment routing, Goose environment routing,
  Pi private provider configuration, OpenCode configuration, and Aider routing.
  Reject partial, unsupported, or template-expanding values.
- Add verified tools-none mappings for Droid, Kimi, Goose, and Pi. Withdraw
  Aider hermetic support after config injection; keep unsupported hermetic
  capabilities refused.
- Refuse OpenCode tools-none without hermetic mode and refuse hermetic mode
  when login state can load remote configuration.
- Remove unverified override/isolation machinery for Copilot, Gemini, Cline,
  OpenHands, and Qwen. OpenHands override support returns in 0.8.0.
- Harden private-artifact sweeps, bounded/no-follow reads, FIFO handling,
  environment-prefix validation, per-adapter environment propagation,
  model naming, reasoning settings, and Aider reply extraction.
- Use Bun SQLite for OpenCode state inspection. Keep canary tool selection
  constant between the isolation probe and its positive control.

## [0.6.1] - 2026-10-04

- Add Antigravity CLI (Agy), audited at 1.2.14, with equals-form flags and
  argv prompt transport.
- Keep standalone Cursor entries as the default; require explicit
  `CODEMUX_CURSOR_ENTRY=cursor` pass-through for the desktop wrapper.
  The then-current entry order was `agent`, then `cursor-agent`; 0.12.0
  reverses it.

## [0.6.0] - 2026-10-03

- Add stdin prompt input (`-f -`) with UTF-8, size, and collection-time bounds.
  Validate independent launch restrictions before reading a potentially stalled
  pipe. Input collection and child execution receive separate timeout budgets.
- Add structured results for Claude, Z.AI, and Codex with normalized usage;
  Codex uses a constructed envelope and a bounded Plan-only fallback.
  **Correction:** the envelope is not always the harness's own JSON object.
- Add scode accounting file and correlation-ID options on run/TUI.
- Isolate overlapping Codex launch state; apply exec approval config correctly;
  attribute model reroutes; protect fallback reads and cleanup.
- Fix Copilot reasoning flags and unknown-version refusal, probe redirected
  OpenCode binaries, sanitize version-probe environments, and use one validated
  environment pass-through list.
- Require absolute, unpadded Claude profile redirects.

## [0.5.2] - 2026-09-17

- Add hermetic runs and tool selection for Claude/Z.AI/Codex, plus paired
  customization canaries. Forward Codex API-key credentials where supported.
- **Correction:** hermetic mode suppresses specified automatic customization
  channels; it does not provide prompt-only reproducibility. Codex tools-none
  retains native planning/patch capabilities constrained by read-only scode.
  Canaries test planted channels against controls, not universal absence.
- Share the run/check launch path, forward termination to the process tree,
  validate env-prefixed executables, and allow the intentional empty tools flag
  in wiring checks. Update harness and sandbox-default documentation.

## [0.5.1] - 2026-09-15

- Restore sandboxed Claude/Z.AI write behavior through scoped grants at medium
  autonomy and correct Claude credential-stub synchronization.
- Terminate detached descendants of timed-out runs and harden bounded cleanup.
- Run static wiring checks in neutral directories isolated from ancestor
  customization files.
- Upgrade js-yaml to 4.3.2 for GHSA-2883-xcg3-v3hh.

## [0.5.0] - 2026-08-21

- Add sandboxed Claude Keychain-to-file credential synchronization, including
  ownership/symlink checks, atomic writes, profile opt-outs, and
  `CODEMUX_NO_KEYCHAIN_SYNC`. Later security behavior is documented in 0.7.1.
- Add OpenHands 1.16.0 with environment-based model selection and project
  execution-configuration refusals. Headless autonomy depends on scode.
- Run static wiring checks in a neutral directory.

## [0.4.0] - 2026-08-15

- Enable sandboxing by default and require scode below high autonomy. Keep
  native harness controls as additional enforcement.
- **Correction:** scode protects its filesystem/network boundary, not every
  version-sensitive native tool, customization, or protocol guarantee.
- Add Kimi with TUI autonomy mappings and headless scode enforcement.
- Add version floors, audited ceilings, known-break rules, explicit untested
  override, and executable-identity checks around version probes.

## [0.3.1] - 2026-08-13

- Escape provider usage strings for terminal display and report oversized usage
  responses accurately. Isolate absent-tool tests from local Bun directories.

## [0.3.0] - 2026-08-04

- Add optional usagemux subscription reporting with validated JSON, quota,
  credits, subscription timestamps, and doctor discovery.
- Upgrade js-yaml to 4.3.1 for GHSA-5p4m-2wfm-xmqj.

## [0.2.1] - 2026-08-02

- Treat the pinned Bun package-manager version as a minimum.
- Add Homebrew installation with scode dependency.

## [0.2.0] - 2026-08-02

- Add testing/release/contribution/security documentation, MIT licensing,
  repository metadata, shell aliases, and macOS/Linux release CI.
- Add Aider, Cline, Copilot, and Cursor adapters; sandbox previews and policy
  overrides; model aliases and expanded effort mappings.
- Harden autonomy, project execution-configuration checks, interpreter and
  executable trust, environment filtering, Z.AI credentials, prompt validation,
  pipe handling, process-tree timeouts, and local opt-in Playwright MCP.
- Require scode 0.2.0, add installed-contract checks, and enforce 80% line and
  function coverage. Correct harness flags, pure/safe-mode configuration,
  and native state isolation.

## [0.1.0] - 2026-02-24

Untagged initial version; no corresponding published repository release.

- Add the adapter architecture for Claude, Codex, Droid, Goose, Gemini,
  OpenCode, Pi, Qwen, and Z.AI; normalized autonomy/effort; scode integration;
  diagnostics; and Bun/TypeScript tests.

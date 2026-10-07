# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.0] - 2026-10-07

### Added

- Live sessions: `codemux session` starts or resumes a persistent agent
  session over one JSONL protocol — input lines on stdin (`user`,
  `steer`, `interrupt`, `permission_decision`, `shutdown`, each
  acknowledged as accepted or rejected with a reason), event envelopes
  on stdout with the harness's raw line carried verbatim (unrecognized
  frames pass through as `unknown`; a wire-grammar violation ends the
  session rather than being guessed past). Supported: Claude Code,
  Z.AI, Codex, and Antigravity; any other agent refuses with exit 64.
  Each harness runs behind a session-only version floor (claude/zai
  2.1.280, codex 0.159.3, agy 1.2.14) and an honest capability matrix —
  a false flag means the input is rejected by name, never silently
  ignored (Antigravity's matrix is documented rather than
  live-verified; its login had expired, so its contract rests on the
  recorded fixture and is marked as such). Same safety seams as `run`:
  scode sandbox default, the same autonomy mapping except a narrower
  claude/zai `high` (`--permission-mode default` with `run`'s grant
  list, never `--dangerously-skip-permissions`), `--pass-env`
  validation, and the same repository executable-configuration refusals
  (a `.codex/config.toml` or `.codex/rules/` in the working directory
  refuses a codex session, as `run` refuses the run). Permission
  requests surface as events the caller answers; an unanswered request
  is denied after `--permission-timeout` (or superseded on interrupt
  and turn timeout) and no decision is relayed past the autonomy
  ceiling. Sessions are recorded
  in a local registry (`~/Library/Application Support/codemux/
  live-sessions.json` on macOS, `~/.local/state/codemux/` elsewhere)
  and `--resume` accepts only registry-vouched ids — same agent, same
  harness home, autonomy no higher than recorded, containment no lower
  than recorded; a corrupt or
  untrusted registry fails closed, a registry that cannot be written
  fails the session the same closed way before it runs, and a registry
  that would sit inside the working directory or harness home is
  refused at start. Clean
  lifecycle on stdin close and
  on harness crash, with the whole process tree killed after the
  shutdown grace; an internal codemux failure while processing a harness
  line is reported as codemux's own error, never recast as unusable
  harness output. `--hermetic` and `--tools` are refused for sessions,
  and so is `--sandbox-trust untrusted` on a sandboxed one (with
  `--no-sandbox` the trust flag is ignored with a warning, as in `run`);
  claude/zai sessions accept `--enable-playwright-mcp` at `--auto low` on
  the same sandbox-scoped carrier as `run`. Provider overrides do not
  reach sessions in this release: `codemux session` exits 64 while any
  `CODEMUX_<AGENT>_PROVIDER_*` variable is set for the session agent,
  naming the variables; overrides reach sessions in the next release
  (docs/HERMETIC.md; the
  2026-10-05 addendum in docs/HARNESS-COMPATIBILITY.md carries the
  per-harness wire contracts).

### Fixed

- Live-session review fixes (four auditors, live2 round). The claude
  family's medium-scoped path grant could be escaped with a `..` after a
  missing directory (the scope check compared a resolved launch
  directory against an unresolved tool path); canonicalization now
  resolves the joined path before comparison. The claude-family parser
  deduplicated assistant frames by `message.id`, but the recorded wire
  sends one content block per frame under a shared id — the dedupe
  dropped real thinking and text blocks; it is removed, sibling frames
  all parse, and `usage_stream` is now honestly `false` for claude/zai
  (usage arrives only in the turn's `result`). Outbound-queue overflow
  fired its failure on every further enqueue; both failure classes now
  latch. A `user`/`steer` text whose harness frame cannot fit inside the
  stdin line cap is rejected `text_too_long` before the ack instead of
  being accepted and then undeliverable; a failed write to harness stdin
  is a fatal codemux error instead of a silent diagnostic; a final event
  that cannot be delivered reports exit 1 instead of success. An
  oversize caller-stdin line is rejected exactly once with its remainder
  discarded through the terminating newline (a second bogus rejection
  could land on the next line). An untrusted registry is a policy
  refusal — exit 78, not 66 — matching the documented exit-code split.
  Docs corrected to match: the session capability matrices, the
  `--permission-prompt-tool stdio` carrier, and the blanket session
  `--tools` refusal.

- Live-session review fixes (four auditors, live3 round). A stalled final
  flush — a caller whose sink accepts the last event but never returns —
  resolved `run()` with the session's own exit code instead of reporting
  the undelivered result; the final flush now has a bounded wait (1 s)
  after which the outbound queue is abandoned and the exit code is forced
  to at least 1 (all three drivers). Two concurrent `--resume` starts of
  the same id could overwrite each other's live ownership; the claim is
  now made atomically under the registry writer lock and the loser fails
  closed with `session_busy`. A dangling or looping symlink sitting
  inside the medium scope denied nothing — its realpath resolve threw and
  the deepest existing ancestor (the scope root) was compared instead;
  a symlink whose target cannot be resolved now denies outright, in both
  the claude-family ceiling and the codex approval ceiling. A codex
  `fileChange` whose patch moves a file was judged only by the source
  path; the move destination is now judged with it, and a non-string or
  empty `move_path` denies. The claude/zai `steer` capability flag is now
  honestly `false`: the wire has no carrier that shapes the running turn
  on demand, so a `steer` line is rejected `unsupported` (codex keeps
  `steer: true` via `turn/steer`). The codex session thread config
  was described as the app-server equivalent of run's `--ignore-rules`;
  it is not — it skips AGENTS.md discovery only, execpolicy rules
  (`~/.codex/rules`) have no verified carrier, and the parity gap is
  recorded in the compatibility ledger and docs/HERMETIC.md (unreachable
  through any launchable session today: every one runs
  `approvalPolicy: "never"` inside scode). Docs corrected to match: the
  event list (`assistant_delta`, not a nonexistent `deltas` event),
  `--timeout` expiry's exit-1-with-`reason: "timeout"` mapping, the
  unconditional `--include-partial-messages` in the documented spawn,
  the panel doc's removed usage dedupe and its `owner_start` field name.

- Live-session review fixes (four auditors, live4 round). A signal in
  the window between driver construction and the CLI's async spawn
  finished the driver with no child to stop, stranding the harness
  process that then attached; a finished driver now stops the child at
  attach (all three drivers). A `shutdown` that arrived while the codex
  handshake was still initializing was buffered like any turn input, so
  a stalled initialize held the session open behind an unlimited default
  timeout; a shutdown during startup is acked and ends the session at
  once. A rejected codex interrupt request left the pending flag set, so
  the turn's real completion was recast as `interrupted`; a rejected
  interrupt never happened and the flag is cleared. Sessions created
  with `--sandbox-no-net` or `--sandbox-scrub-env` recorded neither
  flag, so a resume without the boundary was allowed — the resumed
  transcript then ran with reach creation never granted; both flags are
  recorded and a resume may not clear either, judged as the resume
  effectively runs (resolved options, not raw argv). Antigravity
  reported `usage_stream: false` while the driver emitted standalone
  per-turn `usage` events; the events are removed and usage rides only
  the per-turn result envelope, the same contract claude/zai ship. The
  `--tools` help text implied `default` was accepted ("'none' is refused
  for sessions") while every value refuses; it now states the refusal
  outright. Usage sums are keep-semantics: a null side yields the other
  side, so a partially-reporting turn can no longer null the session
  cumulative's known fields, and no counter is ever guessed as zero.
  The design doc's codex usage-accounting passage claimed a resumed
  thread's first update "yields nulls for that turn" — no such rule
  exists in code; the passage now states the real contract (per-delta
  `usage` events, first-replaces-then-adds turn folding, keep-semantics
  session sums, resume counting from the first update the resumed
  process sees).

- Live-session review fixes (four auditors, live5 round). The shutdown
  path disposed its signal handlers before cleanup completed, so a
  second SIGINT/SIGTERM during the grace window killed codemux mid-kill
  and left the harness tree it was stopping alive; the gate now stays
  installed until the child has settled and `session_ended` is out, its
  fire-once latch absorbing repeat signals (all three drivers). The same
  path silently discarded the harness's final output: lines arriving
  after the end path began — the end-interrupt's answer, the interrupted
  turn's completion, its usage — were dropped, so a clean shutdown could
  report no `turn_completed` and a null-usage `session_ended`; harness
  lines are now parsed and emitted through the whole grace drain, the
  FSM's shutdown transitions wait for settlement, a first result still
  adopts the session identity mid-drain, and the codex end-interrupt is
  a real correlated JSON-RPC call whose response the normal handlers
  consume. The medium-scoped path check judged one spelling of the
  target only; a `..` over a missing directory could route an edit
  through a symlink out of the launch directory (`gone/../link/x`), and
  the mirror shape (`link/../x`) hid behind macOS realpath's lexical
  collapse of `link/..`; both spellings — symlinks expanded in namei
  order, and the lexically normalized path — must land inside the scope,
  or the request denies fail-closed (claude-family ceiling and codex
  approval ceiling alike). A malformed `--permission-timeout` or
  `--shutdown-grace` exited 1 as an internal error instead of 64 usage.
  Docs and comments corrected to match the code: the ceiling module's
  low-autonomy header, the codex driver's empty-session-id and tier-2
  claims, the usage event's per-harness contract, the documented
  claude/zai spawn's missing `--replay-user-messages`, HERMETIC.md's
  resume-guard summary (all guards, not three), the fixture README's
  sanitizer claim, registry comment residuals, and the fake claude
  harness's deny answer keyed by the request it actually denied.

- Live-session review fixes (live6 round). Security: the medium-autonomy
  ceiling could be escaped with path spellings Claude Code rewrites
  before it writes — its Edit/Write/NotebookEdit tools expand a leading
  `~` to the home directory and trim surrounding whitespace, while the
  scope check resolved both as ordinary relative names inside the launch
  directory, so an allow on `Write {file_path: "~/.bashrc"}` or
  `" /etc/hosts"` was judged inside while the write landed outside; a
  target codemux cannot interpret the way the harness will (whitespace-
  padded, `~`-relative) now denies fail-closed, in both the claude-family
  ceiling and the codex approval ceiling. A corrupt or unreadable
  registry's resume refusal now names the registry's path, as the
  documented failure policy says, so an operator can find the file. The
  claude-session builder's dead `addDirs` parameter — never fed, the
  session surface has no `--add-dir` — is removed. Docs and comments
  corrected to match the code: the tier-2 mirror split (parser-caught
  violations mirror the raw line then fatal; driver-caught lifecycle
  violations — a result with no open turn, a duplicate permission id —
  fatal without the mirror), the permission-answer refusal semantics
  (`malformed`/`unsupported` leave the request pending;
  `autonomy_escalation` resolves deny), the codex resume pattern's
  actual refusal point for a pasted claude UUID (the registry, not the
  pattern), the agy driver's `unsupported`-not-`unknown_request`
  comment, the low-level schema rule in the report and panel doc, the
  session writable set (cwd and harness home; no `--add-dir`), the
  claude-family scoping of the never-bypass-flag sentence (agy's run
  mapping keeps it), the README's rejection-reason union, and the panel
  doc's lock-budget and agy `=`-form flag spellings.

- Live-session review fixes (live7 round). Security: a relative `..`
  could route a medium edit through a symlink out of the launch
  directory — the scope check collapsed `..` before symlink expansion,
  so both spellings saw the lexical form and the link never mattered
  (`bun/../1.4.2/INSTALL_RECEIPT.json` from a cwd whose `bun` is a
  symlinked Homebrew opt directory read the Cellar file while being
  judged inside); relative components now survive until symlink
  expansion, in both the claude-family ceiling and the codex approval
  ceiling. A fatal error arriving during the shutdown drain — after
  `finish` began, before the child settled — was ignored by the end
  path's re-entry guard, so the driver emitted the fatal and still
  exited 0 with the initiating reason; cleanup stays idempotent while
  the verdict stays updatable, and a failure inside the grace window
  raises the exit code to 1 (all three drivers). A root working
  directory bypassed the registry containment checks — the prefix
  built for scope `/` was `//`, which no real path starts with, so
  `--cwd /` escaped both the start-time writable-set refusal and the
  resume-time untrusted guard; a root scope now contains every path,
  the same rule the ceiling's scope check carries. Design and README
  amended with the relative-join rule, the drain's failure contract,
  and the root-cwd refusal.

- Live-session review fixes (live8 round). The session cost was
  double-counted: the claude-family result's `total_cost_usd` is a
  session-lifetime figure on the wire (every report already includes
  the earlier turns), and the cumulative summed it per turn — replaying
  the recorded zai fixture reported $0.4447632 against the harness's
  own $0.118512; the fold now sums the per-turn token counts while the
  cost adopts the harness's latest figure (a turn reporting no cost
  keeps the known one; codex and agy carry no cost and are unchanged).
  A permission request arriving during the shutdown drain — after the
  end path denied everything it found pending — was left registered
  with an expiry timer the end path had already cleared while the
  caller's decision channel was closed, so the harness waited on an
  answer that could never come, stalling the persistence the grace
  window exists for; such a request is now denied at once
  (`permission_resolved: "superseded"`), on both the claude family and
  codex. Design, README, and the panel doc amended with both rules.

- Live-session review fixes (live9 round). The registry writer lock's
  stale recovery could break mutual exclusion: the steal unlinked a
  fixed pathname without verifying it still identified the dead holder,
  so two writers racing on one corpse could both acquire — the lock
  file's name is now never reused (`.<lock>.<pid>.<salt>.held`,
  created `O_EXCL` and confirmed by rescan), and a steal can only unlink
  the exact file whose payload was verified dead. A harness exiting
  nonzero during the shutdown drain with its turn still open resolved
  the session as success; the end verdict now reads the child — no
  completion delivered plus a nonzero exit is a failure (exit 1, fatal
  error ahead of `session_ended`), with two exemptions: a completion
  that WAS delivered (the claude family exits 1 after an interrupted
  turn by convention) and a signal death (all three drivers). The
  resume-autonomy ranking was one ladder for every agent, but
  "low out-reaches high" holds only where a permission round-trip
  exists — an agy session created at low could resume at high's
  `--dangerously-skip-permissions`; the ranking is now per agent, with
  agy strict (`read-only < low < medium < high`) and unknown agents
  ranked strict too. A harness whose `--version` the probe cannot read
  skipped the session floor entirely (warn and continue); it is now
  refused like a below-floor build, `CODEMUX_ALLOW_UNTESTED_HARNESS=1`
  overrides. Caller input arriving during the shutdown drain was
  dropped unacknowledged and the documented `shutting_down` rejection
  was unreachable dead code; every line is now answered inside the
  drain window (`input_rejected` `shutting_down`), on all three
  drivers. Design, README, and the compatibility ledger amended with
  all five rules.

- Live-session review fixes (live10 round). Security: the ceiling's
  symlink expansion collapsed a relative link target's `..` by string
  before the kernel would apply it, so a Write spelling like
  `L/../.zshrc` over a link chain (`L -> S/../.ssh`, `S -> outside the
  scope`) could pass both the kernel and lexical spellings while the
  file landed outside the edit scope — the expansion now substitutes
  the target without collapsing it and lets the namei-order walk
  expand the inner links; the codex file-change scope check shares the
  same `pathInsideScope` and the fix. Codex dropped caller lines that
  arrived before the session handshake finished — no ack, no event, and
  the process exited 0 — they are now answered `input_rejected`
  `shutting_down` like every drain-window line, and mid-turn lines
  already acked and queued harness-side but foreclosed by the end are
  reported with a non-fatal `error` naming the drop (acks cannot be
  retracted; the steer buffer gets the same notice). Per-turn
  `turn_completed.usage.cost_usd` mirrored the wire's session-to-date
  `total_cost_usd` next to per-turn token counts, inviting callers to
  sum overlapping figures; it is now null on the claude family and the
  real figure rides `session_ended.usage`. The cumulative
  `total_tokens` was summed independently of its parts, so a turn
  reporting input and output but no cache figure left the total not
  matching the components; totals are now computed from the summed
  parts. Derived `file_change` events fired at the `tool_use` frame,
  before the permission answer — a denied or failed edit had already
  been reported as a change; they are now emitted only when the call's
  own `tool_result` reports success, keyed to the tool_use id, and a
  Write's action reads the target's pre-write state (overwriting an
  existing file is an edit, not an add). Session floors sat above the
  run contracts' audited maximums, so every valid claude/zai/codex
  session printed a false "unaudited version" warning; a floor is
  itself an audited build and now raises the audited ceiling with it
  (the warning starts above the floor), and a floor override can never
  lower the refusal point or the ceiling. An agy session ended
  mid-turn left the turn open with no `turn_completed`; the driver now
  synthesizes one (`finish: interrupted`, reason naming the session
  end, all-null usage) on end paths whose child exit is not itself the
  reported failure, so every `turn_started` is answered on every path.
  Invalid flag values (`--auto bogus`, `--sandbox-trust bogus`) exited
  1 instead of the documented usage code; they are 64 (EX_USAGE) on
  session and run alike, and the dead unreachable branch is removed.
  Docs corrected to match: the README's codex `session_started.raw`
  exception, the panel's F6/F11/B1 narrowed to what shipped, and the
  report's live9 audit now names `updateRegistry` (the real sole
  caller of the registry lock) instead of the nonexistent
  `withRegistryLock`.
- Live-session review fixes (live11 round). Codex: a shutdown while
  `turn/start` was still in flight skipped the graceful interrupt (the
  end path waited for a turn id it would never get) — the interrupt is
  now sent whenever the state machine still holds an open turn;
  approvals pending at turn completion were never cleared (a later
  decision was acked for a dead request, and the expiry timer could
  write a stray decline into a later turn) — a turn that completes or
  fails now supersedes what it leaves pending, claude family included;
  a turn failing while its interrupt was pending was reported
  `interrupted` with its error dropped — an explicit failure now keeps
  `finish: failed` and its own reason; a stale interrupt rejection
  could clear the NEXT turn's interrupt state (rejections are matched
  by call id now), so a turn-timeout completion keeps its
  `turn-timeout` reason; a resumed thread is announced from the
  `thread/resume` response (the pinned 0.159.3 server sends no
  `thread/started` on resume — live-proven), where it used to wait for
  a notification that never comes, and a late `thread/started` that is
  the session's first and names the adopted thread is tier-1
  passthrough (a second one, or one naming another thread, stays a
  tier-2 fatal). All three drivers: the crash
  path no longer adds a second false "during the shutdown drain"
  fatal for the same exit, and a turn left open by a crash, a signal
  death, or a 143-exiting wrapper (the signal's coded spelling — a
  nonzero exit that is not 143 and delivers nothing still costs
  success) is answered with a synthesized `turn_completed` (failed on
  a crash, interrupted otherwise, usage all-null). Registry: the
  autonomy and trust validations used `in`, so prototype-chain
  spellings ("constructor", "toString") validated and the trust guard
  compared NaN — such records are corrupt now, failing the resume
  closed. Ceiling: medium no longer grants writes inside the launch
  directory's `.git` (hooks and config are executable git
  configuration), and containment additionally requires the target's
  raw spelling inside the launch directory's own raw disk spelling, so
  a normalization-folded sibling directory cannot ride the NFC
  comparison into "inside".
- Live-session review fixes (live12 round). All three drivers: the
  shutdown path could leave an open turn unanswered exactly when the
  live9 drain-failure verdict fired — the verdict and the live10/11
  synthesis were mutually exclusive, so a harness exiting nonzero during
  the drain (a failure while persisting) emitted the fatal but no
  `turn_completed` for the turn it belonged to; the synthesis now runs
  for every still-open unanswered turn, failed with the drain failure as
  the reason when the verdict fired. Claude/zai: a stale interrupt
  mislabeled both turns it touched — a clean result raced by the
  interrupt was reported `interrupted`, and the already-written
  interrupt then struck the next turn, whose error result was reported
  `failed`; the interrupted verdict is the driver's now (the parser
  reports the raw error bit), an error result with an interrupt
  outstanding is the interrupt striking, and an interrupt that missed
  rolls to the next turn — once. Codex: a resume never checked that the
  server returned the requested thread (the id was preset, so a server
  resuming into a different thread ran unannounced under the wrong id) —
  the response's `thread.id` must now echo the request or the session
  fails closed with both ids named.

- Live-session review fixes (live13 round). The medium-level `.git`
  refusal compared path components case-sensitively, so a `.GIT`-spelled
  write — which a case-insensitive filesystem (macOS's default, Windows)
  opens as the real `.git` — passed the scope check and could approve an
  executable hook; the component compare now folds case outright (a
  deliberate over-denial of a literal `.GIT` directory on
  case-sensitive disks). Registry stamp failures were silently
  swallowed: `updateRegistry`'s outcome contract is total (it never
  throws), so the try/catch around every touch and end stamp was dead
  code — a lost end stamp left the record looking owned by a live
  process with no stderr line, and the next resume could answer
  `session_busy` with nothing explaining why; both stamp paths now
  report on stderr (the touch once per session, not per turn). The
  turn-path activity stamp waited out the writer lock's full budget
  (about 10 s of synchronous `Atomics.wait`) inside harness-line
  handling on every turn completion, freezing stdout reads, caller
  events and signal handlers whenever another codemux process held the
  lock; the touch now takes a single-attempt lock — one sweep, fail
  fast — while the load-bearing start and end writes keep the full
  budget at the session boundaries. Pruning could write a registry its
  own validator rejects: with more than 1000 entries whose owners were
  all live there was nothing evictable, and the oversized file read as
  corrupt (every resume fails closed, the next start resets the
  registry, dropping every live record); an all-live overflow now evicts
  the oldest entry anyway — a lookup hint evicted answers `not_found`,
  the smaller loss — and pruning judges liveness against one
  process-table snapshot instead of enumerating the host's processes
  once per live owner inside the held lock.
- Live-session review fixes (live14 round). A lock file a failed
  acquisition left behind (created but never written, or half-written)
  blocked every later registry write forever: its unjudgeable payload
  read as `unknown`, and nothing fell back to the pid encoded in the
  never-reused file name — with that pid dead the file can only be that
  acquisition's leftover, so it is now stolen like any corpse, and the
  failed acquirer unlinks its own file instead of abandoning it. The
  lock-owner liveness check ran `ps` under the caller's ambient time
  zone and locale, so two codemux processes with different `TZ` values
  minted different start tokens for the same live pid and judged a live
  writer dead — a stolen lock, a `session_busy` resume waved through;
  the spawn now pins `TZ=UTC LC_ALL=C`, making the token a property of
  the process. Steers buffered behind a delayed `turn/start` were joined
  into one `turn/steer` frame with no size check: two 9 MiB steers both
  passed the pre-ack check alone and were acked, then the ~18 MiB joined
  frame was refused as oversize and the session crashed as a codemux
  failure; the batch now grows only while the built frame fits, so the
  flush falls back to one request per steer. A codex turn that completed
  cleanly while an interrupt was still in flight was recast
  `interrupted` (with `turn-timeout` on the timeout path): the wire's
  `turn/completed` names `interrupted` itself, so the wire's status is
  the verdict and only a wire `interrupted` the timeout's own interrupt
  produced carries the `turn-timeout` reason. An early `shutdown` took
  the next `input_seq` while an earlier user line sat unsequenced in the
  startup buffer, so order-matching brokers read the rejection as the
  shutdown's answer; the parked lines are now rejected first, arrival
  order preserved. Also fixed in the same write-path audit: a harness
  dying while a large accepted line still drained through its stdin
  pipe surfaced as an unhandled `EPIPE` promise rejection from the
  FileSink instead of the child's exit reporting the death — the drain
  rejection is absorbed on both the write and the half-close paths.

- Live-session review fixes (live15 round). A codex turn could complete
  without ever starting: `turn_started` rode the harness's `turn/started`
  notification, but the FSM opens the turn at submit — a `turn/start`
  error completed a turn the caller never saw open, and a shutdown before
  the notification synthesized an interruption for an unannounced turn.
  The caller-facing `turn_started` is now emitted at submit, claude-family
  style (`raw: null`), and the harness's notification mirrors as tier-1
  `unknown` like every other harness echo of something codemux already
  announced. An allow on a codex approval whose `availableDecisions`
  offers no plain `accept` (for example `["acceptForSession","decline"]`)
  built a wire answer that substituted `decline` while the caller was
  told allow and the ack said accepted — codemux never answers
  `acceptForSession`, so allow is undeliverable: the request advertises
  `deny` as its only option, the allow is rejected `unsupported`,
  `permission_resolved` says deny, the wire carries the decline, and a
  non-fatal error names what happened. The codex handshake kept going
  after an end path began — an initialize response landing inside the
  shutdown drain sent the thread request, adopted the thread, recorded
  the registry start, and announced `session_started` after the
  shutdown was already acked — the chain now stops the moment an end
  path began, on both the success and the error branch (the claude
  family's init frame and agy's first result still announce mid-drain:
  harness-initiated identity frames, not codemux continuation chains).
  A `turn/completed` with an unrecognized status passed through as
  `unknown` and left the turn open forever, its queued input never
  running; it now completes the turn `failed` with the status named.
  JSON-RPC response ids were matched on `Number(id)`, so a string "1"
  answered the numeric request 1 — ids now match strictly, and a
  frame failing the match fails closed. A `thread/start` response
  naming a different thread than an already-adopted `thread/started`
  left two ids for one session; the response is now cross-checked
  against the adopted id and fails closed naming both. The cumulative
  `total_tokens` fold counted a turn that left a component unreported
  as zero — the total is now null unless every folded turn reported
  every part. The claude family accepted frames carrying no session id
  (they now fail closed), dropped empty `text_delta` blocks silently
  (they now mirror as `unknown`), and resolved a Write/Edit
  `file_path` against codemux's own cwd when deciding add-vs-edit (the
  session `--cwd` now decides). Both line framers — the harness-side
  reader and the caller-stdin framer — rescanned from byte 0 and
  recopied the whole buffer on every chunk, so a line near the cap
  arriving in pipe-sized chunks was quadratic; both now grow on demand
  and resume the scan where it stopped. The held-lock filename pattern
  was documented as `.<registry>.<pid>.<random>.held`; the real shape
  is `.<lock>.<pid>.<salt>.held` (CHANGELOG and design doc corrected).

- Live-session review fixes (live16 round). Two user lines sent before a
  codex session finished its handshake crashed it: the replay opened a
  turn for the first, queued the second, and then submitted the queued
  one while the first was still open; the queue now drains only from
  idle. A claude-family `shutdown` with a mid-turn line queued reported
  the line dropped, but the harness had already received it and could
  run it inside the grace window, and its result then hit an idle state
  machine and turned the clean end into exit 1; the notice now says the
  harness may still run it, and such a result mirrors as `unknown`. A
  codex thread id or agy conversation id the harness reported was
  adopted unchecked, and one over the registry's 128-character cap made
  the whole registry unreadable — every resume refused and the next
  start reset it, dropping live owners' records; reported ids must match
  the `--resume` patterns, and every registry write is validated with
  the reader's rules first. A resume could widen reach the sandbox-flag
  guard did not cover: a different `--cwd`, an added `--pass-env` name,
  or `--enable-playwright-mcp`; the registry now records the pass-env
  names and the Playwright flag and refuses all three (exit 78). Records
  written by earlier builds of this branch lack the two new fields and
  read as corrupt, so the next fresh session backs that file up and
  starts a new one. A JSON-RPC response whose `error` was not an object,
  or that carried neither `result` nor `error`, was read as success; both
  are failures now. Antigravity emitted `turn_started` after the fatal
  error when the write that opened the turn failed; the start now
  precedes the write. The registry's signal-0 fallback read `EPERM` as a
  dead process, so inside a sandbox that denies signals a live lock
  holder or owner looked dead; only `ESRCH` means dead now.

- Live-session review fixes (live17 round). At `--auto medium` the
  ceiling blocked only `.git`, so a caller `allow` could let a turn
  write `.claude/settings.json` hooks that the next interactive claude
  in that directory runs outside the sandbox; medium now also refuses a
  caller `allow` for the harnesses' project settings (`.claude`, `.codex`, `.gemini`,
  `.cursor`), `.vscode`, `.idea`, `.husky`, `.envrc`, `.mcp.json`,
  `.claude.json`, `.gitconfig`, `.gitmodules`, `.ripgreprc`, and shell
  startup files below the launch directory (codex patch approvals share
  the rule). The refusal applies only to requests the harness asks
  about; see the live18 entry. The harness's stderr was captured and never read, so a
  startup failure such as an expired login reached the caller only as
  "exited unexpectedly"; it now passes through on codemux's stderr, as
  in `run`. A read error on the caller's stdin ended the session as a
  clean close with exit 0; it is now a fatal error and exit 1. The end
  path wrote the end-interrupt and sent SIGTERM in one step, so a
  harness that dies on SIGTERM never answered it, and agy never saw its
  stdin close; the interrupt (for agy, the stdin close) now gets
  `--shutdown-grace` before SIGTERM, which then gets a second grace
  before the kill. A harness that exited nonzero during an idle shutdown
  was ignored; it now costs success like a mid-turn one. `--turn-timeout`
  fired once and never re-armed, so a refused or ignored interrupt left
  the turn uncapped; a turn still open one period after its timeout
  interrupt now ends the session (`reason: timeout`, exit 1). A crash
  end's synthesized turn said the process exited unexpectedly even when
  the end was an outbound overflow or a registry failure; it now carries
  the fatal that ended the session. Antigravity emitted `user_message`
  before the `turn_started` it named; the order now matches the other
  drivers. A codex approval whose decision list named neither `decline`
  nor `cancel` was answered `decline` anyway after the caller was told
  deny; it is now never forwarded, answered with a JSON-RPC error, and
  its turn interrupted.

- Live-session review fixes (live18 round). A plain `allow` on a
  claude or zai permission request reached the harness without
  `updatedInput`, the field the harness runs the tool with; it now
  carries the request's own input, and an allow too large for the
  harness write cap is rejected `text_too_long` with the request left
  pending. A claude-family `control_request` other than `can_use_tool`
  was passed through with no reply, so the harness blocked until the
  turn timeout; it is now answered with the control protocol's error
  response, mirrored raw, and reported non-fatal. An `interrupt` sent
  after the first `user` line but before the harness's init frame was
  acknowledged and dropped; it is now delivered when that turn opens.
  The shutdown verdict excused any nonzero child exit after any drained
  completion; only exit 1 after an interrupted claude-family turn is
  excused now, and codex or agy exiting nonzero during the drain always
  costs success. A codex usage update that landed after its turn
  completed was charged to the next turn; it now counts toward the
  session total only. The registry writer accepted a symlinked registry
  directory the reader refuses, so every session recorded and none
  could resume; the writer now refuses it too. An oversize registry
  read as untrusted and blocked every new session; it is now corrupt,
  so the next start backs it up, and the writer prunes to the 4 MiB cap
  as well as the 1000-entry one. A failed registry write left its temp
  file behind; it is removed, and the write is flushed before the
  rename. `requestStop` after the harness exited held the event loop for
  the grace period and then signaled a reaped process group. The
  caller-stdin cap missed a line whose newline arrived with the bytes
  that took it over. A stdin read error during the final flush emitted
  an event after `session_ended`. Docs: the medium ceiling's
  executable-configuration list only covers requests the harness asks
  about, which at medium is Claude Code's own sensitive set (`.git`,
  `.claude`, `.vscode`, `.idea`); a write to `.envrc` or `.husky/`
  inside the launch directory is as open as in a medium `run`.
- Live-session review fixes (live19 round). Two concurrent resumes of
  one claude or zai session both started a harness and forwarded the
  caller's first input. The loser was refused only at the init frame,
  after its harness had acted on that input. A resume now claims the
  registry record under the lock before it starts the harness, so the
  second resume exits 78 `session_busy` with nothing spawned; this
  covers codex and agy resumes too. Bun buffers every write a harness
  has not read, so a harness that stopped reading its stdin let the
  caller grow codemux's memory without limit. More than 64 MiB of
  unread input now ends the session with a fatal error. The codex
  driver's in-memory holds are bounded at 256 lines or 32 MiB. Past the
  bound, a `user` line queued behind a turn or a `steer` held for the
  turn id is rejected `busy`, and a line sent before the handshake
  completes ends the session. The recorded zai fixtures carried claude's
  dash-encoded project slug, which named the operator's account and
  repository path; every fixture is sanitized, and a test scans for the
  running machine's home, username, and checkout path. Docs: a claude or
  zai session at `high` is narrower than a `high` run (no
  `--dangerously-skip-permissions`), where the README and this changelog
  claimed identical autonomy mapping; only an error result with an
  interrupt outstanding is an interrupted turn; a late codex
  `thread/started` is passed through only when it is the first and
  names the adopted thread; every claude-family allow carries
  `updatedInput`; the README's medium list now names `.claude.json` and
  `.ripgreprc`.
- Live-session review fixes (live21 round). Claude/zai sessions
  reported `user_during_turn: "queue"` and opened a new turn for every
  mid-turn `user` line, on a misreading of the step-0 fixture. Print
  mode folds a mid-turn message into the running turn when that turn
  makes another model request (one result answers both) and runs it as
  its own turn when it does not, so the extra turn never completed and
  every later result was attributed to the turn before it. The flag is
  now `false` and a mid-turn `user` line is rejected `busy`. With no
  forwarded mid-turn line, an interrupt that misses its turn is dropped
  by the idle harness, so the driver no longer keeps it pending for the
  next turn. `session_ended.resumable` was true for any claimed resume,
  including one the harness refused (a claude transcript already
  cleaned up, a codex resume answered with another thread, an agy
  conversation that never produced a result); a resume the harness
  never confirmed is now resumable only when its end did not fail. The
  CLI's claim release after a failed spawn now reports a lost registry
  stamp on stderr, as the drivers do. A harness line the session state
  rejected (a duplicate permission request id; the `result` claude
  sends, with no init frame, for a resume whose transcript is gone) was
  reported as a fatal but never mirrored raw; it now goes out as
  `unknown` before the fatal (claude/zai and codex), and the claude
  fatal names the refused resume. Docs: the fixture notes, the
  auto-deny evidence, the codex item types, and the session-floor
  wording now match the recorded frames.
- Live-session review fixes (live20 round). A resumed session that
  ended before its first turn (stdin closed with no input, or the
  harness crashed at startup) left its registry claim open and reported
  `resumable: false`; every driver now releases the claim on every end
  path and reports the session resumable, and the CLI releases it when
  the spawn throws. Real codex sends a turn's usage after
  `turn/completed`; when queued input had already opened the next turn,
  that late update ended the session as a grammar error. Late usage,
  items, and deltas naming the turn that just closed are now accepted
  with a null `turn_id`. A `permission_decision` whose answer could not
  be written to the harness was acked accepted although the session was
  ending; it is now rejected `shutting_down` (codex and claude/zai). On
  claude/zai, an interrupt that missed its turn relabeled the next
  turn's API error as interrupted; only an `error_during_execution`
  result counts as the interrupt there. A resume could refuse its own
  claim as `session_busy` when one of two `ps` readings timed out; the
  start write now recognizes its own claim by pid. Two writers stealing
  the same dead registry lock counted the loser's ENOENT as contention,
  which failed the per-turn activity stamp. Caller stdin was decoded
  lossily, so a line with an invalid UTF-8 byte was forwarded with a
  substitute character; it is now rejected `malformed`. Tests now pin
  the full `thread/resume` params and the resumed read-only ceiling
  that the design said were pinned.
- Live-session review fixes (live22 round). The medium ceiling's
  executable-configuration check lowercased names with `toLowerCase`, so
  `.vſcode/tasks.json` (long s) passed it while macOS's case-insensitive
  lookup opens the real `.vscode`; the check now folds case the Unicode
  way. A codex session that ended mid-turn dropped the usage the open
  turn had already reported from `session_ended.usage`, and a refused
  `turn/start` never added its usage to the total; both now count it. A
  codex `turn/start` success that names no turn now ends the session
  instead of sending the next turn to a busy thread. An agy session whose
  start could not be recorded reported `resumable: true`; it is now
  `false`. A registry that was busy or unreadable for a transient reason
  made `--resume` exit 78, the permanent policy refusal; it now exits 1.
  A claude or zai session, fresh or resumed, is now recorded before its
  harness starts, and a fresh agy session first checks that the registry
  can be written, so a registry failure no longer lets the first turn
  run untracked. A fresh claude or zai record the harness never
  confirmed is removed at the end. The turn timer no longer re-arms after
  the session began to end, which raised a second, false
  `--turn-timeout` fatal. A claude-family interrupt the harness refused
  stayed pending and labeled the turn's own error `interrupted`; it is
  now cleared. A pre-init input's result drained at the end now counts
  toward `session_ended.usage`. A turn answered by codemux after a fatal
  error is now `failed`, not `interrupted`. A caller-stdin error after
  the session began to end no longer turns a clean end into exit 1.
- Live-session review fixes (live23 round). A claude or zai harness that
  refused the shutdown interrupt left it pending, so the turn's own
  error was labeled `interrupted`, the harness's exit 1 was excused, and
  the session ended 0; the refusal is now matched to the exact id sent.
  A registry with invalid UTF-8 was treated as untrusted and blocked
  every session until deleted by hand; it is now corrupt, so the next
  fresh session backs it up and starts a new one. A lock file with
  invalid UTF-8 left by a dead process is now stolen like other junk. A
  dangling symlink at the registry directory or file is now refused as
  untrusted instead of failing every start as a retryable error. A
  resume whose registry sits inside the recorded working directory now
  exits 78, as documented, instead of 64. On codex, an `interrupt` or
  `steer` and, on claude/zai, an `interrupt` whose write the harness
  refused is now rejected `shutting_down` instead of acked accepted. A
  codex steer the app-server rejects is reported with its `input_seq`
  and turn. A codex usage update from two turns back no longer ends the
  session as a grammar error. Codex response-side violations (an unknown
  response id, a thread response with a bad id, a `turn/start` success
  with no turn id, a second thread announcement) now mirror the raw line
  before the fatal. The tier-3 excerpt is now 4 KiB of bytes in every
  parser, not 4096 characters. Doc corrections: the README's tier-2 and
  synthesized-usage paragraphs, HERMETIC's absent-registry case, and the
  design's ack carve-outs, `updated_input` routing, low-level schemas,
  and `total_tokens` rule.
- Live-session review fixes (live25 round). A session ignored the
  provider override `run` applies: a codex override ran against the
  operator's own `~/.codex` login with the provider key left in the
  child's environment, and agents whose `run` refuses an override
  started anyway. `codemux session` now refuses (exit 64) while any
  `CODEMUX_<AGENT>_PROVIDER_*` name is set for the session agent. A
  registry lock the directory would not let codemux create (a denied
  `~/Library`, a read-only or full disk) waited about 10 seconds and then
  blamed a live writer; the real error is now reported at once, and so
  is a dead holder's lock file that cannot be removed.
  `--enable-playwright-mcp` at `--auto medium` or `high` added a server
  whose every call the ceiling denied; it now requires `--auto low`. A
  codex frame the stream ended inside is now reported as a fatal instead
  of dropped. A refused codex `turn/start` write no longer holds the end
  path for the full grace. An orderly end whose interrupt the harness
  would not take (it stopped reading stdin) now exits 1 and answers the
  turn `failed` instead of ending 0. A stdout read error is now a fatal
  that ends the session and kills the tree, not an unhandled rejection.
  Usage errors from `--pass-env`, `--effort`, `--auto`, `--model`, and
  `--cwd` now exit 64, not 1. `--effort none` is refused for codex
  sessions instead of accepted and never sent. A resume no longer
  refuses a record that names its own pid as the live owner. Doc
  corrections: the design's closed-turn rule and `--timeout` flag name,
  the `--sandbox-trust untrusted` refusal's sandboxed-only scope, and the
  registry reader's and fake agy's comments.

## [0.8.0] - 2026-10-07

### Added

- **Provider overrides for Claude Code, Codex, and OpenHands, plus token
  caps for every override-capable harness.** `CODEMUX_CLAUDE_PROVIDER_{
  BASE_URL,API_KEY,MODEL}` routes Claude Code through the gateway
  variables the Z.AI endpoint uses — `ANTHROPIC_BASE_URL` +
  `ANTHROPIC_AUTH_TOKEN`, model on `--model` (the mechanism is shared in
  `src/claude-family.ts`; Z.AI is unchanged) — and requires an endpoint
  that serves the Anthropic Messages API and accepts the `system`-role
  turns Claude Code >= 2.1.2xx puts inside the `messages` list (a proxy in
  front of a vLLM 0.12 Messages shim must fold them into the top-level
  `system` field before forwarding; README quotes the exact rejection).
  With the override set the
  operator's Claude login plays no part: the sandboxed Keychain
  credential-mirror sync is skipped (nothing of the operator's login is
  copied for a run that does not use it), `ANTHROPIC_API_KEY` and
  `CLAUDE_CODE_OAUTH_TOKEN` are kept out of the child environment, and a
  mirror that still holds a refresh token still refuses the launch.
  `CODEMUX_CODEX_PROVIDER_*` writes a per-run private `CODEX_HOME`
  (0600 config.toml, no `auth.json` link — the provider key is the
  credential, delivered through `env_key`-named environment) holding a
  `model_providers.codemux` entry with `wire_api = "responses"` (the only
  value every supported release accepts, so the endpoint must speak the
  OpenAI Responses API; `--ignore-user-config` is skipped because it skips
  the override's own config). The generated config also sets
  `shell_environment_policy.exclude` for the key variable, so the shell tool
  never hands the provider key to commands the model runs, whatever codex's
  default name filter does. `CODEMUX_CODEX_PROVIDER_MULTI_AGENT=off`
  writes `features.multi_agent = false` into that config, removing the
  grouped `namespace` tool codex's subagent feature adds to every
  Responses request — the opt-out that lets an endpoint without
  namespace tool grouping (vLLM 0.12's `/v1/responses` validator) serve
  codex, at the cost of spawning no codex subagents; `on` (the default)
  writes nothing, any other value fails the run before launch, and so
  does the knob set without an override. `CODEMUX_OPENHANDS_PROVIDER_*` restores the
  0.7.0-cut override behind `--override-with-envs` (`LLM_BASE_URL`/
  `LLM_API_KEY`/`LLM_MODEL`, litellm's `openai/` prefix).
  `CODEMUX_<AGENT>_PROVIDER_MAX_OUTPUT_TOKENS` and
  `..._MAX_CONTEXT_TOKENS` (positive integers, only meaningful with an
  override) cap the override where the harness can carry it — Claude Code
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, Codex `model_context_window`, OpenCode
  `limit.output`/`limit.context` (both required together), Kimi
  `KIMI_MODEL_MAX_COMPLETION_TOKENS`/`KIMI_MODEL_MAX_CONTEXT_SIZE`, Droid
  `maxOutputTokens`, Pi `maxTokens`/`contextWindow` — and a cap a harness
  cannot honor fails the run loudly before launch with the evidence
  (README's table lists every refusal). Codex, Droid, Pi, and OpenCode
  overrides support headless runs only (`codemux tui` refuses them; their
  per-run config files ride the launch lifecycle); the Claude Code,
  OpenHands, Aider, Kimi, and Goose overrides carry into the TUI. An
  override exported for a harness without support (Z.AI, Antigravity,
  Cursor, the 0.7.0 cut) fails the run before launch instead of being
  ignored. `codemux list` and `codemux doctor` mark the capability
  ("provider"). (src/provider-override.ts, src/codex-provider.ts,
  src/claude-family.ts, src/adapters/*; docs/HARNESS-COMPATIBILITY.md's
  2026-10-07 addendum records the wire_api floor and the cap refusals.)

## [0.7.1] - 2026-10-05

### Security

- **The sandboxed Claude credential mirror never carries the refresh token.**
  Before a sandboxed `claude` launch codemux refreshes
  `~/.claude/.credentials.json` from the macOS Keychain; it now copies the
  access token (and the descriptive fields beside it) only, writes
  `refreshToken` emptied, drops `refreshTokenExpiresAt`, and scrubs a mirror
  that still holds a refresh token even when its access token is current.
  A sandboxed child therefore authenticates for the access token's lifetime
  and fails with a plain 401 when it expires or is revoked; it can no longer
  refresh. Root cause of the 2026-10-05 lockout: a sandboxed child holding a
  copy of the operator's refresh token rotated it (or presented a stale one
  after the interactive Claude Code had rotated it), and the provider revoked
  the whole grant family, logging the operator out of every Claude session.
  The "a file fresher than the Keychain is left alone" rule is gone with the
  rotation it existed for: the Keychain is authoritative whenever the access
  tokens differ, expiry ordering plays no part. The scrub does not depend on
  the Keychain being usable: an entry with no usable access token still
  leaves no refresh token in the file, and a mirror that cannot be scrubbed
  (or sits behind a symlink) refuses the sandboxed launch outright
  (`claude: ... refusing the sandboxed launch`). Nothing is destroyed blind:
  before a refresh token is removed, the file is copied to
  `~/Library/Application Support/codemux/credential-backups/` (0700, files
  0600) — under `~/Library`, which the scode sandbox blocks, so no sandboxed
  child can read it — and a Keychain that exists but cannot be read (locked
  over SSH, denied, timed out, empty) mirrors nothing and scrubs nothing: a
  file carrying a refresh token is then refused, one without launches as
  before. `CODEMUX_NO_KEYCHAIN_SYNC=1` means "do not consult the Keychain", and
  without the Keychain a mirror cannot be told from Claude Code's only
  store, so that path neither scrubs nor refuses; the adapter reports a
  refresh token left in the file. A passed-through `CLAUDE_CONFIG_DIR`
  profile is treated the same way (reported, never refused or scrubbed),
  while the default mirror is still synced and scrubbed even then, because
  the sandbox lets the child read `~/.claude` regardless of the profile. A
  backup whose rewrite did not happen is removed again, and once a rewrite
  has succeeded the backups older than its own are pruned (never a newer
  one a parallel launch may have written), so copies never pile up; a scrub
  of the file's own credential keeps every other key it carries. A machine with no
  Keychain entry at all — Linux, or a file-only macOS login — is left alone:
  there the file is Claude Code's only credential store, not a mirror. An
  empty or already expired Keychain access token is never mirrored as
  "synced"; when the file's own token has expired too the adapter warns,
  instead of launching into an undiagnosed 401 (`src/credentials.ts`, `src/adapters/claude.ts`; regression tests
  in `tests/credentials.test.ts`).


## [0.7.0] - 2026-10-04

### Added

- Provider overrides: point one harness at a different model provider
  through `CODEMUX_<AGENT>_PROVIDER_{BASE_URL,API_KEY,MODEL}` (blank values
  count as unset; a half-configured override refuses the launch; a base
  URL or model name containing `{` or `}` is refused — OpenCode substitutes
  `{env:…}`/`{file:…}` and Droid and Pi expand `${VAR}` templates in the
  config files an override writes). The key is
  delivered through the environment codemux itself provides or through a
  private per-run file, never through an operator configuration file, so an
  override survives `--hermetic`. Consumers: Aider (litellm's `openai/`
  model prefix with `OPENAI_API_BASE`/`OPENAI_API_KEY`), OpenCode (a
  private `OPENCODE_CONFIG` provider file plus a key environment it
  references), Kimi Code (the `KIMI_MODEL_*` group that synthesizes a
  provider in memory), Droid (a per-run BYOK `customModels` entry inside a
  private `--settings` file), Pi (a private agent directory behind
  `PI_CODING_AGENT_DIR`), and Goose (the pure-environment
  `GOOSE_PROVIDER`/`OPENAI_HOST`/`OPENAI_BASE_PATH`/`OPENAI_API_KEY`/`GOOSE_MODEL`
  group). Documented in the README ("Provider overrides").
- Aider's `--hermetic` claim is withdrawn and the flag refused again. The
  2026-09-17 two-probe check passed, but its canary plants `AGENTS.md` and
  `CLAUDE.md` — a channel the control probe already exercises through
  `--read` — and never rode aider's own config layers, which no flag
  closes: `.aider.conf.yml`, `.env` and `.aider.model.settings.yml` load
  from the working directory, the git root and the home alongside every
  pinned file, inside the aider process where the `AIDER_*` sanitizer block
  cannot see them (`main.py` at 0.86.2). Confirmed live on 2026-10-04: a
  plain run whose working directory held only a `.aider.conf.yml` naming a
  canary note answered with the note's code word, every pinned flag in
  place (docs/HERMETIC.md). The answer machinery stays for the day aider
  grows a switch: a per-run chat-history file under `~/.aider/.codemux/`
  (aider's stdout is a transcript; the history holds the bare reply and
  the model's reasoning), with the code-word scan covering stdout plus the
  full history. Only a hermetic run creates the file; plain runs keep
  `--chat-history-file /dev/null`, so no run today writes its conversation
  to disk (h6 review).
- OpenCode claims `--hermetic` and `--tools none`, verified live on
  2026-09-17 through the provider override (GLM-5.3 via Z.AI): the override
  rides a private `OPENCODE_CONFIG` file codemux writes per run and removes
  at exit, with the key delivered as `{env:…}` interpolation and headless
  runs only. Hermetic runs now REMOVE `OPENCODE_CONFIG`,
  `OPENCODE_CONFIG_DIR` and `OPENCODE_CONFIG_CONTENT` through `env -u`
  instead of blanking them: OpenCode's global config path reads
  `OPENCODE_CONFIG_DIR ?? …`, an empty string survives the `??`, and the
  resulting empty global path turned the global `AGENTS.md` lookup into a
  project-relative one — a live leak of the check's planted code word at
  1.18.18, traced by pointing the override at a tee proxy and reading the
  request body. The hermetic check's probe prompt now forbids tool use: a
  tool-armed model (GLM-5.3 under `--auto`) answered the question by
  reading the planted `CLAUDE.md` itself while its request was clean, which
  is the model's own discovery, not a configuration leak.
- The `env` prefix validator accepts `-u NAME` pairs (plain identifier
  names only); every other option (`-i`, `-S`) is still refused.
- Droid claims `--tools none`, verified live on 2026-09-17 through a
  provider override (GLM-5.3 via Z.AI): the override writes one BYOK
  `customModels` entry into a private per-run settings file passed as the
  root-level `--settings <path>` (merged for that process only), with the
  key referenced as `${CODEMUX_DROID_PROVIDER_API_KEY}` and delivered
  through the environment codemux provides — never argv, never an operator
  file, and no Factory login needed, which is what unblocked the probe
  (droid's self-update had left no stored login). Droid selects a custom
  model by the entry's `id` (here `custom:codemux:<model>-0`, the shape of
  the operator's own working entries), not its `model` name; a `-m` naming
  only the API model id falls through to Factory inference and fails
  authentication. Under `--tools none` (`--only-tools ToolSearch`) the
  session transcripts contain no tool call at all and neither capability
  probe could produce its secret (the shell probe returned fabricated
  output, distinguishable because the probe asks for a transform of
  planted content), while a plain run's model read the file and produced
  it; the non-hermetic control probe leaked the planted code word, which
  grounds the hermetic refusal (instruction files load from the working
  directory up to the git root with no switch).
- Kimi Code claims `--tools none`, verified live on 2026-09-17 through a
  provider override (GLM-5.3 via Z.AI): the override rides the
  `KIMI_MODEL_*` environment group (a temporary provider synthesized in
  memory, so nothing touches config.toml), suppressing the `-m` flag
  because a config alias would outrank the synthesized model. Under
  `--tools none` the read and shell capability probes produced neither
  secret while a plain run produced both; the non-hermetic control probe
  quoted the planted code word and `~/.agents/AGENTS.md`'s owner, which
  grounds the hermetic refusal (the AGENTS.md merger has no switch).

- Goose claims `--tools none`, verified live on 2026-09-17 at 1.50.1
  (installed via the official `download_cli.sh`) through a provider
  override (GLM-5.3 via Z.AI): the override rides pure environment —
  `CODEMUX_GOOSE_PROVIDER_{BASE_URL,API_KEY,MODEL}` become the
  `GOOSE_PROVIDER`/`OPENAI_HOST`/`OPENAI_BASE_PATH`/`OPENAI_API_KEY`/`GOOSE_MODEL`
  group, every one of which goose reads before any config file or keyring,
  so the key never touches argv or an operator file. The base URL splits
  into the host/path pair with goose's own `derive_base_path` semantics, so
  `https://api.z.ai/api/coding/paas/v4` becomes
  `OPENAI_HOST=https://api.z.ai` with
  `OPENAI_BASE_PATH=api/coding/paas/v4/chat/completions`, and a
  chat-completions path forces the chat-completions protocol; a base URL
  with a query string is rejected because the pair cannot carry one. Under
  `--tools none` (`--no-profile`, under which the session instantiates no
  extension at all — every tool, the developer, skills and memory platform
  extensions included, reaches the model only through an extension) the
  read probe produced no output at all and the shell probe produced a
  fabricated quip rather than the real transform of the planted token,
  while plain runs produced both the secret and its transform; the
  non-hermetic control probe leaked the planted code word, which grounds
  the hermetic refusal (`GOOSE_SYSTEM_PROMPT_FILE_PATH` replaces the whole
  system prompt from the operator's config file on every session with no
  switch, and `GOOSE_PATH_ROOT` — the wholesale relocation — strands the
  provider and model selection living in the same file while the global
  skill directories under the real home escape it).
- Qwen keeps refusing both capabilities, now verified live on 2026-09-17
  at 0.24.0 (installed via npm) through a provider override that no longer
  ships (GLM-5.3 via
  Z.AI): the probe rode the `OPENAI_API_KEY`/`OPENAI_BASE_URL`/
  `OPENAI_MODEL` group qwen documents for headless setups, so the key
  never touched argv or an operator file. The non-hermetic control probe
  stayed clean — every codemux qwen run already carries `--safe-mode`,
  which closes every operator channel, so the check's control can never
  leak and `--hermetic` can never pass by design — while the plain read
  and shell probes produced the planted secret and its transform, so the
  harness demonstrably ran against Z.AI with its tools intact;
  `--tools none` stays refused because no tool-removal flag survives
  safe mode.
- Cline keeps refusing both capabilities, now verified live on
  2026-09-17 at 3.0.62 (installed via npm) through a provider override
  that no longer ships
  (GLM-5.3 via Z.AI): the probe's `CODEMUX_CLINE_PROVIDER_{BASE_URL,API_KEY,MODEL}`
  wrote a private per-run data directory passed as `--data-dir`, whose
  `settings/providers.json` carries one `openai-compatible` entry — the
  key rides that 0600 file (cline's runtime reads provider keys from
  providers.json only; `apiKeyEnv` is a configure-UI hint and `-k/--key`
  would put it in argv), never argv or an operator file. `--data-dir`
  is also what makes the override work at all: a plain one-shot run
  delegates its session to cline's long-lived hub daemon
  (`forceLocalBackend: isYoloMode || config.sandbox === true` in
  apps/cli/src/runtime/run-agent.ts), and the session config sent to the
  daemon carries the key but not the settings file's base URL — observed
  live when every run after the first sent the override's key to
  api.openai.com — while `--data-dir` sets `CLINE_SANDBOX=1` and forces
  the in-process backend that reads the file. The non-hermetic control
  probe leaked the planted code word through the workspace AGENTS.md
  channel and the model's reasoning also named the operator from the
  global `~/.agents/AGENTS.md` channel, so both refusals stand on live
  leaks; the plain read and shell probes produced the planted secret
  and its transform, so the harness demonstrably ran against Z.AI.
- Pi claims `--tools none`, verified live on 2026-09-17 through a
  provider override (GLM-5.3 via Z.AI): the override writes a private
  agent directory behind `PI_CODING_AGENT_DIR` — the only knob that
  relocates the `models.json` pi reads custom providers from — holding a
  one-provider entry whose `apiKey` is the
  `${CODEMUX_PI_PROVIDER_API_KEY}` reference; pi expands `$VAR`/`${VAR}`
  config templates from the environment at auth time, so the value never
  touches disk, argv, or an operator file, and the run needs no stored
  login. Under `--tools none` (`--no-tools`, with the autonomy mapping's
  `--tools` allowlist suppressed because pi resolves it over `--no-tools`)
  the read probe answered that it had no tools to read the file and the
  shell probe produced no output at all, while plain runs produced the
  planted secret and its transform; the non-hermetic control probe
  leaked the planted code word, which grounds the hermetic refusal (the
  working-directory context-file channel is not trust-gated, and the
  global `~/.pi/SYSTEM.md`/`APPEND_SYSTEM.md` system-prompt override has
  no switch).
- Gemini's `--tools none` mapping cannot be claimed on
  a user-owned prefix, so both capabilities stay refused and the mapping is
  removed in 0.7.0 as dead surface: gemini 0.60.0 was installed and
  exercised live on
  2026-09-17, and its system-settings layer requires the settings file and
  every ancestor directory up to `/` to be owned by root (uid 0) — a rule
  present identically at the audited 0.53.1 — or the file is skipped with a
  warning and the run starts with its tools restored. The private per-run
  file under `~/.gemini/.codemux/` that the mapping wrote was therefore
  always skipped on such a machine (observed live through the identical
  warning on the packaged file). The same warning shows the packaged
  system-settings file every plain gemini run points at
  (`resources/gemini-system-settings.json`, whose one pin disables generic
  project `.env` loading) has never loaded on a user-owned prefix either —
  a documented contract gap, not a regression; the other two protections
  (`.gemini` project controls rejected, nested sandbox disabled) are
  launch-boundary mechanisms and apply everywhere. Gemini keeps refusing `--hermetic`: no switch
  closes the workspace channels, gemini loads only `GEMINI.md` — never the
  `AGENTS.md` or `CLAUDE.md` the check plants, so a leaking control probe is
  impossible — and the live pass found no custom-provider path to verify
  against either: `GOOGLE_GEMINI_BASE_URL` resolves to the "gateway" auth
  type the CLI's own validator rejects, pinning API-key auth still landed
  the request on Google, and Z.AI serves no Gemini-protocol endpoint (only
  Anthropic and OpenAI protocols, docs.z.ai/devpack/tool/others).
- Copilot keeps refusing both capabilities,
  now verified live on 2026-09-17 at 1.0.85 (installed via npm) through
  an override that no longer ships (GLM-5.3 via Z.AI): the probe's
  `CODEMUX_COPILOT_PROVIDER_{BASE_URL,
  API_KEY,MODEL}` rode the documented BYOK environment group —
  `COPILOT_PROVIDER_BASE_URL` / `COPILOT_PROVIDER_TYPE=openai` /
  `COPILOT_PROVIDER_API_KEY` plus `COPILOT_MODEL` (docs.github.com, "Use
  bring-your-own-key models with Copilot CLI") — which activates before any
  GitHub authentication at 1.0.85, so the runs needed no Copilot login; the
  key rides the environment codemux provides, never argv. The plain probes
  ran against the model: the read probe produced the planted secret and the
  shell probes demonstrably executed (`cat notes.txt | wc -c` answered the
  file's true byte count). `--tools none` lost its mapping: the previous
  bare `--available-tools` mapping is removed because no argv spelling of
  an empty allowlist disarms the tools — a bare flag, `--available-tools=`,
  and `--available-tools ""` all left the read and shell tools armed in
  live probes at `--auto high` (the optional-variadic flag parses every
  empty spelling into an absent filter), so the capability stays refused on
  live evidence rather than an unverified mapping. `--hermetic`'s mechanism
  (the private `COPILOT_HOME`) is removed in 0.7.0 as dead surface,
  unclaimable for the same reason: the check's control probe cannot leak the
  planted code word because `--no-custom-instructions` rides every codemux
  run — verified live when the control answered `Peter`, the name inside
  the user-installed skill `~/.agents/skills/domain-dns-ops/SKILL.md` (a
  real leak of the user-skill channel the private home closes) while the
  planted code word never appeared; dropping the flag from plain runs to
  make the control leak would un-harden every run. In-session (sandboxed)
  exercise needs `COPILOT_PKG_CACHE_HOME` passed with `--pass-env`: the
  loader's first-run self-extraction cannot mkdir under
  `~/Library/Caches` from inside a sandboxed session
  (docs/HARNESS-COMPATIBILITY.md).

### Fixed

- OpenCode provider overrides whose model carries the provider prefix
  (`--model codemux/glm-5.3`, or the same value in
  `CODEMUX_OPENCODE_PROVIDER_MODEL`) generated a config the run's own
  selector could not resolve: the models entry was keyed by the prefixed
  name while OpenCode splits a selector on its first `/`. The prefix is
  now normalized away before the entry is written.
- Droid's effort mapping resolves the session's model — the request's,
  else the override's — before choosing the no-reasoning value, so an
  override model in the gpt-5.6 family gets that family's `none` instead
  of the generic `off` droid rejects for it.
- The `env` prefix trust check no longer honors `-u NAME`/`--unset NAME`
  after a `NAME=value` assignment. Past an assignment, options must not
  be honored: env would treat the option as the program to run (BSD env,
  and POSIX env generally), so the check now refuses the prefix instead
  of validating the wrong binary.
- Aider's answer extraction anchors on the run's user header instead of
  the last `#### ` header, so a reply containing its own header (for
  example `Laurent` followed by `#### Note` and `OK`) no longer extracts
  as exactly `OK`.
- The adapter factories forward the environment view `getAdapter` is
  handed. They used to construct every adapter against `process.env`
  regardless, so an exported `CODEMUX_*_PROVIDER_*` override leaked into
  `verify`'s deliberately empty view: a configured cline then threw from
  `buildRunCommand` and `verify` reported broken static wiring for a
  working setup (found by the h2 review).
- The OpenCode provider override refuses a model containing `{` or `}`:
  OpenCode substitutes `{env:…}` and `{file:…}` in config text before
  parsing, so such a model id would splice an environment variable's
  value or an arbitrary file's content into the config codemux writes
  (found by the h3 review).
- Aider's post-run history read follows no symlink and stops at a bound
  (32 MiB — the largest legal prompt plus the reply and reasoning around
  it). The sandboxed harness can write `~/.aider/.codemux/`, so the old
  bare `readFileSync` would have followed a harness-planted link to a
  file outside the sandbox — read by codemux, which runs outside it —
  and read a harness-grown file without bound. Both refusals fail closed
  on stdout (h3 review).
- The OpenCode login-state inspection reads its SQLite store through
  `bun:sqlite` instead of `node:sqlite` (h4 review): the pinned runtime
  floor (Bun 1.3.14) has no `node:sqlite`, and the module loads with the
  adapter registry, so the import broke every CLI command on the floor —
  `./bin/codemux --help` printed "error: No such built-in module:
  node:sqlite" and still exited 0. Same fail-closed semantics, same
  refusal design, no new dependency; the docs agree there is no switch to
  close the channel (opencode.ai/docs/config at 1.18: remote config is
  "fetched automatically when you authenticate with a provider that
  supports it", first in the precedence order, and the documented
  config and env surface gates neither fetch).
- A provider-override base URL containing `{` or `}` is refused (h4
  review): OpenCode substitutes `{env:…}`/`{file:…}` and Droid and Pi
  expand `${VAR}` templates in the config files an override writes, so a
  brace could splice an environment variable's value or a file's content
  into a config codemux writes. One rule covers both template shapes.
- Pi's provider override declares `reasoning: true` on the generated
  model entry (h4 review): pi 0.85.1 defaults a custom model's reasoning
  to false, which clamps the `--thinking` flag `--effort` maps to "off",
  so the bare entry silently disabled reasoning (observed at the
  composer as `{"reasoning":false,"requested":"high","effective":"off"}`).
- One bad stale artifact no longer blocks every later run (h4 review):
  the sweeps for aider's chat-history files, kimi's no-tools agent
  files, opencode's provider-config directories, droid's
  provider-settings directories and pi's agent directories let a single
  unremovable entry — a directory named like the file pattern, `EISDIR`
  on a non-recursive rm — throw out of the sweep and fail every
  subsequent launch. Each removal now warns on stderr and moves on.
- Aider's post-run history read opens the file without blocking (h5
  review): a harness that replaced its writable history file with a FIFO
  and exited parked `openSync(O_RDONLY)` before the type check could
  reject it, and the read runs after the subprocess timeout is cleared,
  so `--timeout` could not stop the hang — an isolated reproduction
  blocked until SIGKILL. The open now carries `O_NONBLOCK` (the pattern
  the bounded file reads in `src/file-io.ts` already use), the
  descriptor check rejects the FIFO, and the read fails closed on stdout
  as every other refusal does.
- The OpenCode login-state inspection reads `auth.json` through the
  bounded, nonblocking, no-final-symlink reader instead of a bare
  `readFileSync` (h6 review): the read runs during validation, before
  the subprocess timeout starts, so a harness that replaced the store
  with a FIFO hung codemux until SIGKILL — the same class as the h5
  finding, in the one raw read the h3/h5 conversions had left. Any
  store that exists but cannot be read — symlinked (OpenCode follows
  symlinks codemux refuses, so skipping the inspection would miss a
  real carrier), oversized, unparsable, or a FIFO — now fails closed
  naming the file, and `opencode.db` is lstat'd to a regular file
  before SQLite opens it, its own open having the same two shapes.
- A provider-override model containing `{` or `}` is refused on Droid
  and Pi (h6 review): the h4 brace refusal covered the base URL, but
  the model lands in the same template-expanded files — droid's
  settings entry and pi's models.json — so a crafted model name could
  splice an environment variable's value into the config codemux
  writes. Refused at validation and again before anything is created.
- Aider writes the per-run chat-history file only on hermetic runs (h6
  review): the file rode every headless run, so plain runs — whose
  history nothing reads, the hermetic check being refused — persisted
  the whole conversation under `~/.aider/.codemux/` where the run used
  to write `/dev/null`. Plain runs go back to `/dev/null` and create
  nothing.
- The OpenCode hermetic-home sweep warns and moves on when one stale
  home cannot be removed (h6 review): the h4 sweep hardening covered
  five sweeps and missed this sixth, so an unremovable stale home threw
  out of it and failed every later hermetic launch.
- Aider's installed-contract pins carry only flags a reachable run
  sends (h6 review): `--map-tokens` rides only the `--hermetic`
  branch, which aider refuses, and `--read` rides instruction
  directories, which only the hermetic check sets on its refused
  probe — both were pinned though no reachable request emits them,
  which would fail the gate on an upstream removal codemux is
  indifferent to (the rule the copilot `--available-tools` comment
  states). An always-on test now builds every reachable aider command
  shape and fails on any pin none of them sends.
- The `check --hermetic` control probe repeats the hermetic probe's
  `--tools` selection unchanged, so `--hermetic` is the only difference
  between the two requests (h7 review). It used to fall back to the
  default tools for a harness that scopes `--tools none` to hermetic
  runs, which varied two things at once: the control's leak could have
  come through a tool, and the hermetic probe's clean `OK` could have
  meant tool removal rather than isolation. OpenCode — the one harness
  so scoped — now refuses the combination before any request is spent,
  because its control would be a plain `--tools none` run the adapter
  itself refuses; its isolation claim is checked with `--hermetic`
  alone and its `--tools none` claim keeps the read and shell probes of
  the live pass. The h6 review's documented residual (the armed
  default-tools control) is gone with the substitution.

### Changed

- OpenCode's `--tools none` requires `--hermetic`. The
  `OPENCODE_PERMISSION={"*":"deny"}` deny merges into the top-level
  permission only; the operator's opencode config can append per-agent
  permission rules after it, and the last matching rule wins — proven
  live at 1.18.18 through codemux's own plain-run path, where
  `"agent": {"build": {"permission": {"bash": "allow"}}}` in the
  operator's config put the bash tool into the model's request under the
  deny (h2 review; docs/HERMETIC.md). No environment variable spells
  per-agent or mode permissions, so a plain run cannot guarantee the
  deny and refuses the capability instead. The check's control probe
  runs with the default tools for such a harness — it varies `--hermetic`
  alone, and a plain `--tools none` run is now refused.
- OpenCode's `--hermetic` (and with it `--tools none`) refuses a login
  that carries remote configuration. OpenCode's config load fetches a
  well-known login's `.well-known/opencode` document and an active
  organization's `/api/config` from `opencode.db`, merging both as
  global config — custom prompts, plugins and agent permissions
  included, which append after the `--tools none` deny exactly like the
  operator's per-agent rules — unconditionally and behind no flag
  (`config.ts` at 1.18.18; the private hermetic home changes nothing,
  the login's data directory stays real; found by the h3 review, then
  proven live through the exact hermetic launch path against a local
  mock: with a well-known entry as the auth store's only content the
  run fetched the login's `.well-known/opencode` and the model's
  request carried the bash tool under the deny, while the identical
  launch with an empty auth store fetched nothing and sent no tools). A
  hermetic run now inspects the login state before launch and refuses
  while either carrier exists — a well-known entry in the auth store or
  an account with an active organization — naming the remedy; an account
  store that exists but cannot be read fails closed the same way. The
  hermetic env prefix also removes `OPENCODE_AUTH_CONTENT`, which
  `Auth.all` reads before the auth.json file and which could carry the
  same well-known login through an explicit `--pass-env`
  (docs/HERMETIC.md).

### Removed

- Dead surface behind the both-refused harnesses (the h4 review's cut):
  the provider overrides and hermetic/no-tools machinery for Copilot,
  Gemini CLI, Cline, OpenHands and Qwen — every harness whose
  `--hermetic` and `--tools none` are both refused. The refusals and
  their live grounding stay in docs/HERMETIC.md; the modules
  (`src/copilot-hermetic.ts`, `src/cline-provider.ts`,
  `src/gemini-no-tools.ts`), their flags, tests and README enumeration
  are gone. The machinery existed to ground the refusals' live checks
  and could never be claimed as a capability, so it shipped per-run
  files, config writing and env prefixes with no capability behind
  them. Plain-run commands for the five are unchanged (OpenHands keeps
  `--override-with-envs` model selection; copilot keeps
  `--disable-builtin-mcps` below high autonomy), and the
  installed-contract entries are unchanged from 0.6.1. Provider
  overrides remain for aider, opencode, kimi, droid, pi and goose.

## [0.6.1] - 2026-10-04

### Added

- `agy` (Google Antigravity CLI) as a harness, pinned against 1.2.14. The
  prompt rides in argv as `--print=<prompt>`, and every value flag
  (`--model`, `--effort`, `--mode`, `--output-format`) is emitted in the
  single-token `--flag=value` form — the space form of the pre-parsed
  flags exits 2 at the pinned release, and `--model`'s space form was
  never exercised there. Effort
  maps all five levels the binary accepts (low/medium/high/xhigh/max; the
  docs' table names only three). Autonomy maps `read-only` to
  `--mode=plan`, `medium` to `--mode=accept-edits`, `high` to
  `--dangerously-skip-permissions`, and `low` to default prompting — an
  unrecognized `--mode` value only warns and continues upstream, so scode
  stays the enforcement below `high`, as everywhere. `--result-json` maps
  to `--output-format=json` and passes the envelope through with the
  codemux block appended, the usage normalized to the same meaning every
  harness reports (agy's `input_tokens` includes the cache-read count and
  `thinking_tokens` sits outside the total; `total_tokens` is computed
  from the normalized components, null when one is missing, never echoed
  from the envelope). Runs reject project-controlled
  Antigravity config — the `.agents/{skills,rules,plugins,agents}.json`
  manifests, `.agents/hooks.json`, the `.agents/{skills,rules,plugins,
  agents,workflows}/` directories, and `.gemini/{.env,config/}` — between
  the working directory and its Git root, matching the config roots the
  binary's own strings name. Launches forward only the credentials the
  binary reads (`GEMINI_API_KEY`, `GOOGLE_API_KEY`); in particular
  `GOOGLE_APPLICATION_CREDENTIALS` is stripped, because setting it to a
  missing or valid-shaped service-account file leaves the headless auth
  path at the identical OAuth wall — it has no reader. Audited from the
  binary's flag surface and the official
  headless docs, not live: this machine has no Antigravity login. The
  adapter's exact argv was exercised live to the authentication wall, and
  the envelope's JSON tags were observed live in an ERROR envelope; a
  success envelope with nonzero usage remains docs-pinned. No
  hermetic or `--tools none` claim (see docs/HERMETIC.md). Version floor
  1.2.14, the only audited release.

### Changed

- Cursor launches run the standalone `agent` entry, then the legacy
  `cursor-agent` alias — exactly 0.6.0's default — and report cursor as
  not installed when neither resolves. The desktop CLI's `cursor agent`
  subcommand is now strictly opt-in: set `CODEMUX_CURSOR_ENTRY=cursor`
  and pass the name through (`--pass-env CODEMUX_CURSOR_ENTRY`). The
  desktop wrapper is not a pure forward: the Cursor.app launcher
  downloads and runs `https://cursor.com/install` when
  `~/.local/bin/cursor-agent` is absent and runs `cursor-agent update`
  when the installed build is old, before exec-ing that same binary —
  the entry may install or update the agent on first use, so codemux
  never executes it on its own initiative (not discovery, not the
  version gate by default, not the installed-contract suite). The
  passthrough is the authorization — argv the operator typed, which
  neither a repository nor a shell profile can inject — and a launch
  that selects the desktop entry without it is refused before the
  version gate could execute anything. Under the opt-in, the
  trusted-executable check applies to the `cursor` binary resolved
  against the requested working directory and the version probe sends
  `cursor agent --version` only after that check, only inside the launch
  path (`cursor --version` reports the desktop app's semver rather than
  the agent build; the probe arguments key on the resolved entry's name,
  not the canonical path's basename — the standard Homebrew `cursor`
  symlink resolves into the Cursor.app bundle as `code`, and a basename
  test probed the desktop semver, missed the calendar pattern, and
  warned past the floor). `codemux verify` builds its commands against an
  explicitly empty environment view, so an exported
  `CODEMUX_CURSOR_ENTRY` never selects the desktop entry there and cannot
  fail its wiring check — the static result is the same whatever the
  operator's shell exports.

## [0.6.0] - 2026-10-03

### Fixed

- Overlapping codex runs no longer share per-run state. The private
  hermetic home lived in plain fields on the singleton adapter, so run
  B's launch replaced run A's home before A's command was built, and one
  run's teardown finalized every home the adapter had ever made,
  including another run's in-flight one. Every piece of per-run state —
  the hermetic home, the `--output-last-message` fallback path this
  release adds — now lives on a per-launch `RunContext` the launcher
  owns and threads from `prepareRun` through `processRunResult`, so every
  launch, even two through one request object, touches only its own.

- Codex autonomy's approval policy is passed as the config override
  `-c approval_policy="…"`, so it reaches the run. It had been `-a <policy>`
  at the top level, before `exec`, where codex's root-to-exec handoff drops
  it (the handoff copies only the shared options like `-s` and `-m`, and
  `exec` has no `-a` of its own) — so an exec run's approval policy was
  silently whatever codex configured. At codex-cli 0.159.x, `-a` accepts
  only `on-request` and `never`, so `low`'s `untrusted` was an invalid value
  there. The config override is the one channel that reaches `exec`, `exec
  resume`, and the TUI alike, which is how effort already passed. Verified
  against the codex-rs clap grammar at rust-v0.159.3 (see
  docs/HARNESS-COMPATIBILITY.md).

- `copilot`'s reasoning effort is passed as `--reasoning-effort`, the flag the
  CLI actually takes. It had been `--effort`, which upstream added in v1.0.10 as
  a shorthand alias and has since dropped, so every
  `codemux run -a copilot --effort <level>` failed on an unknown option.
  `--reasoning-effort` has been the canonical flag since v1.0.4, so no release at
  or above the version floor is affected by the switch. The
  accepted values are unchanged, so no translation is needed, unlike Droid's
  `none` to `off`. The installed-contract suite pins the real name and
  `make release-gate` runs it on every PR; it caught nothing because it skips a
  binary absent from the machine, and no machine in the loop had copilot
  installed. Copilot also gains a `HARNESS_CONTRACTS` entry: without one
  `assertSupportedHarnessVersion` returns immediately -- a silent pass, not a
  warning -- and copilot is the harness that renamed a flag between patch
  releases, so an unpinned version there was the least safe default in the
  table, with a floor of 1.0.77, the version the ledger recorded before this
  audit. A lower floor would report roughly seventy never-audited releases as
  supported, since everything between the floor and the audited version runs
  silently. A refusal is visible and overridable with
  `CODEMUX_ALLOW_UNTESTED_HARNESS`; a false "supported" is not. The
  version is read with `--binary-version`, not `--version`: the latter starts the
  packaged application and needs a writable extraction cache, so under a
  restricted filesystem it fails and the gate silently stops enforcing. A test
  now fails if any harness the ledger records as installed has no version
  contract, and an unrecognized ledger row fails rather than being skipped.

- A copilot that reports no version is refused rather than warned through.
  `--binary-version` arrived in 1.0.3, below the 1.0.77 floor, so a silent
  probe is a below-floor release (1.0.0 through 1.0.2) rather than an unknown
  build, and the tier the floor exists to refuse was running with only a
  warning. The refusal is per contract (`unknownVersion`), keeps the warn
  default for harnesses whose probes a supported release can fail to answer,
  and is downgraded by `CODEMUX_ALLOW_UNTESTED_HARNESS` like every refusal.

- With `OPENCODE_BIN_PATH` passed through, the compatibility verdict now comes
  from the redirected executable rather than the unrelated PATH-resolved one.
  The gate resolves the redirect to a trusted executable — the same validation
  the PATH binary gets, which is what makes probing it outside the sandbox
  acceptable — and reads the version from it, so a below-floor redirect no
  longer hides behind a supported launcher and a supported redirect is no
  longer blocked by an old one. A redirect codemux cannot so resolve keeps the
  "cannot confirm" warning and still gates the PATH binary below the floor.

- Codex's per-run `--output-last-message` directory is removed only after its
  `.codemux-scratch` parent passes the trust check the result reader already
  applied. A run with write access to `~/.codex` could replace that parent
  with a symlink, and the recursive cleanup — unlike the read — followed it,
  deleting a matching run directory outside codemux's scratch tree even on a
  launch whose result read had already refused the swap. The parent is
  lstat-checked first; a parent that fails keeps its directory and reports the
  refusal.

- A rerouted codex run is attributed to the model that served it. Codex 0.159.3
  reports a reroute in the `--json` event stream as a completed error item
  (`model rerouted: <from> -> <to> (<reason>)`); the parser now records it and
  the `--result-json` envelope's `model` field carries the served model — with
  a stderr note naming it — instead of the requested one, which the harness
  may have substituted away mid-run.

- The harness version probe runs with an allowlisted environment rather than
  the caller's. It executes before any sandbox exists, so a variable that
  redirects code loading reaches it that a launch would have stripped:
  copilot's `COPILOT_CLI_DIST_DIR` makes even `--version` run a chosen
  directory's JavaScript, and against copilot 1.0.85 an unscrubbed probe read
  a fabricated 0.0.1 from a fixture directory. The probe now keeps only what
  lets the binary be found and produce readable output, so no credential for
  any agent reaches it either; the kept locale names follow the launch
  environment's own prefix rule, so the `--version` exec and the run resolve
  their locales the same way. A passed-through name that redirects the
  executable still cannot be honored — resolving it would run an unvalidated
  binary outside the sandbox — so the probe reports the version as
  unconfirmed while still probing the PATH-resolved default binary and still
  refusing it below the version floor; `CODEMUX_ALLOW_UNTESTED_HARNESS`
  covers a deliberate redirect there as anywhere else.

- The launch path validates and builds from one `passthroughEnv` list. The
  launcher validated `request.passthroughEnv` but built the sandbox
  environment from a second list on the launch options, so a programmatic
  caller could put a name on the options that validation never saw and the
  child still received. The options field is gone; the request's list is the
  single source.

### Added

- `-f -` reads the prompt from stdin, the same way a prompt file is read,
  so a caller can pipe a prompt without staging a file (`printf '…' |
  codemux run -a codex -f -`). Stdin is not argv: the read is bounded at
  16 MiB (the prompt-file limit) rather than the 32 KiB argv cap, though
  the argv rule still applies to the prompt's content for harnesses that
  pass it as an argument. An empty or whitespace-only stdin prompt is
  refused, and so is a terminal stdin — a non-interactive command reading
  a TTY would hang until the run's timeout; pipe the prompt instead. The
  read itself is bounded by `--timeout` like the run, so a prompt producer
  that stalls with the pipe open fails the run rather than hanging it;
  stdin is decoded with the same fatal UTF-8 decoder as a prompt file, so
  malformed bytes are an error (`-f - prompt must contain valid UTF-8`)
  rather than replacement characters that silently change the prompt text
  between the two advertised-equivalent input paths; and every
  prompt-independent check (agent capabilities, availability, hermetic,
  tools) runs before anything reads stdin, so an unsupported combination
  (`-a droid --hermetic -f -`) rejects at once instead of blocking on the
  read — a malformed command (`-p` with `-f`, a missing prompt, an
  unreadable prompt file) still fails before the availability checks.

- `--result-json` now works for Codex and Z.AI, and every envelope carries one
  codemux-owned block. Codex is asked for its JSONL event stream
  (`codex exec --json`, pinned against `codex-rs/exec/src/exec_events.rs` at
  rust-v0.159.3, the installed codex-cli 0.159.3): the stream names the
  thread, the final assistant message, and the thread's cumulative token
  usage as of the last completed turn, none of
  which the human-mode stderr summary carries (it prints one blended total
  that discounts cached input). That usage figure is a snapshot of the
  running thread counter, and every codemux run launches with `--ephemeral`,
  so the thread this run started makes the last snapshot exactly this run's
  usage. codemux reduces the stream to an envelope
  whose `result` is the final assistant message as plain text. A turn that
  ends with only a `Plan` item succeeds too: codex 0.159.3 treats the last
  `Plan` of a turn as its final message, but the JSONL event-stream mapper
  drops the item, so the launch also passes `--output-last-message <file>`
  (in a per-run directory under `.codemux-scratch/` inside the real
  CODEX_HOME — harness state, which every scode platform keeps writable
  and none shadows; inside the private home for `--hermetic` runs; no
  file at all under `--sandbox-trust untrusted` on a non-hermetic run,
  which denies harness state, so the event stream is the result's only
  source and a Plan-only turn there reports `result: null`; a hermetic
  run names its file whatever the trust, and `untrusted` denies the
  private home itself, so the child cannot write it — same outcome,
  different mechanism) and the message codex itself
  recorded — the Plan included — is the result when the stream's last
  turn completed without an `agent_message`, with a stderr note saying
  where it came from. The fallback supplements rather than bypasses: a turn with no
  message anywhere still fails, a failed turn cannot be rescued by a file,
  and a stream that carries its own `agent_message` stands. The file never
  outlives the run — removed once read, and disposed on every exit path
  (rejection, signal, and timeout alike) through the per-run context the
  launcher owns (see Fixed on overlapping runs) — and a cleanup failure
  says so on stderr without failing a finished run. The reader also
  refuses a fallback whose per-run directory — or its
  `.codemux-scratch`/`.codemux-hermetic` parent — is not a real
  user-owned directory, because O_NOFOLLOW guards only the file's own
  name and an intermediate symlink would point the read, and the delete
  that follows it, at a `last-message` outside the run: a run that loses
  the fallback this way fails closed (`result: null`) with a warning
  instead. Z.AI shares
  Claude Code's `--output-format json` envelope. Claude-family envelopes keep
  every harness field unchanged with the block appended:
  `"codemux": {"agent", "model", "usage": {"input_tokens", "output_tokens",
  "cached_input_tokens", "total_tokens", "cost_usd"}, "session_id"}`. Fields
  the harness does not report are null, never guessed; usage means the same
  thing per harness (uncached input, cache traffic, output, their sum), so
  Codex's `input_tokens`, which includes both cached reads and cache writes
  upstream (each a breakdown of the total, not an addition to it), is
  normalized — both subtracted from the input, both joined into
  `cached_input_tokens` — before it lands in the block. `session_id` is
  always null in this release —
  no run persists a session (Claude and Z.AI launch with
  `--no-session-persistence`, Codex with `--ephemeral`) — and the field is
  reserved for the planned live-sessions release. A failed run is
  failed on every channel: the exit is non-zero even when the harness's own
  was not, and the diagnostic from the `error` or
  `turn.failed` event rides on stderr — the JSONL processor prints those on
  stdout, where a reduction that ignored them lost the only record of why a
  run died; codemux's own stderr lines separate themselves from the
  harness's last (possibly unterminated) line, so diagnostics a caller
  parses line by line never fuse. In codex-built envelopes `result` is
  null on failure (a partial message from an earlier completed item never
  poses as the final one, matching codex, which discards its own final
  message on a failed turn), and the usage fields are null too: a figure
  from a run whose end the harness itself called failed is at best
  incomplete, and an exact-looking total that understates it is worse
  than none. A
  Claude-family envelope keeps the harness's own fields verbatim, failure
  included. A run the envelope
  says was served by several models (`modelUsage` with several entries)
  reports `model: null`, not the requested model; a Z.AI envelope without
  `modelUsage` reports the model codemux selected (`opus`, which every
  such run passes) rather than null. Stdout that breaks the JSON promise
  fails loudly (non-zero exit, the raw stdout kept, a stderr line saying
  what is missing), never a silent success: Claude-family plain text on
  exit 0; JSON that is not the result envelope — the envelope is
  `type: "result"` naming an outcome, so a bare `{}` (which parses), a
  bare discriminator, or a subtype-only "success" is refused like plain
  text, while an envelope reporting its own failure (`is_error: true`, an
  `error_*` subtype such as `error_during_execution`) fails the run even
  when the harness exited 0, so a wrapper that masks the exit code cannot
  mask the structured failure too; an empty codex stream; or a codex
  stream codemux cannot parse. An empty or whitespace-only reply is no
  reply on either path: a Claude envelope whose `result` is `""` or
  `" \n"` and a codex turn whose only `agent_message` carries empty or
  whitespace text fail the run, with the harness's own fields kept as it
  reported them. A computed `total_tokens` needs every component
  reported, so `{output_tokens: 5}` stays `total_tokens: null` instead of
  guessing the rest as zero; a codex turn whose `turn.completed` reports
  no usage leaves null fields rather than inheriting an earlier turn's
  stale totals; and the all-zero snapshot codex 0.159.3 emits when the
  thread never received a token-usage update (`Usage::default()`) counts
  as unreported the same way, not as a measured zero. Codex runs share
  one success verdict: a `turn.failed` or
  `error` event, a stream that ends
  without a final assistant message, a stream whose last turn never ended
  with `turn.completed`, or codex's own non-zero exit fails the run on every
  channel — and a stream that
  breaks the event grammar — no single `thread.started` announcement
  opening the stream, a terminal event no `turn.started` opened, a second
  turn after a completed one, or an item event (`item.started`,
  `item.updated`, or `item.completed`, whatever the item's type) after
  the last `turn.completed` — fails as unparseable before the verdict,
  the raw stdout kept; so does a recognized `agent_message` whose `text`
  is not a string: drift is refused, not skipped over.

- `--result-json` on `run` asks the harness for its own structured result
  envelope on stdout rather than plain text, so a caller can account for what
  a run consumed. A headless run previously reported nothing about its token
  use, and nothing could be recovered afterward either, because these runs pass
  `--no-session-persistence` and leave no session file. Claude Code supplies
  the envelope through `--output-format json`: the reply plus `usage`,
  `modelUsage` and `total_cost_usd`. codemux asks for it and re-emits it with
  every harness field unchanged plus the codemux block (above); the rest of
  the shape belongs to the harness. Harnesses without the capability
  refuse the flag instead of returning plain text, so a caller that asked for
  usage and got none cannot record the run as having cost nothing.

- `--sandbox-account <file>` / `--sandbox-account-id <id>` on `run` and
  `tui` forward scode's per-run scratch accounting: when set, scode appends
  one JSON line per sandboxed run describing the private scratch directory
  it created and tore down (`scratch_kib`, duration, exit code), tagged with
  the correlation id. The variables are applied through the sandbox
  environment, which is the one place codemux sets `SCODE_*` names itself;
  scode still unsets both before the harness runs, so the agent never sees
  them. codemux requires an absolute `--sandbox-account` path and refuses
  the flags with a clear error when the installed scode predates scratch
  accounting (probed from `--help`, since scode versions do not track the
  feature; a probe that does not exit cleanly refuses rather than guessing).
  The id is validated against the set scode records (`[A-Za-z0-9._:-]`, 1-128
  chars — anything else would be silently nulled and break correlation), and
  an id without a sink is refused as the misconfiguration it is. When the
  sink resolves inside the sandbox working directory — with symlinks
  resolved on both sides, so alias paths (/var/folders vs /private/var/folders)
  do not dodge the check — codemux warns that the records are
  confidentiality, not integrity, and proceeds: some callers, crew among
  them, place the sink there on purpose. This is the forwarding
  half of fleet workspace-storage measurement (scode records; the
  orchestrator correlates).

### Changed

- A passed-through `CLAUDE_CONFIG_DIR` must be an absolute path (claude
  and zai, `run` and `tui` alike). Claude Code resolves a relative one
  against the run's working directory, so the config store the harness
  home owns would land wherever `--cwd` happens to point; the launch is
  refused with a clear message instead. The check reads the exact value
  the child receives, because the harness reads the variable without
  trimming: a whitespace-padded value — `" /var/claude-profile"`, where
  the padding hides a relative path, or `"/var/claude "`, where a
  directory name would keep the padding — is refused too, and only the
  literal empty string counts as no redirect. Z.AI keeps reading and writing
  the same Claude Code home it
  always did — codemux pins no directory of its own — so
  `--setting-sources user` loads the
  operator's own `~/.claude/settings.json`, exactly as before 0.6.0.

## [0.5.2] - 2026-09-17

### Added

- `codemux run --hermetic` runs a harness with none of the operator's
  customizations: no user or project instruction files, skills, plugins,
  hooks, MCP servers, memories, or account-level integrations. The model
  sees the prompt and the harness's own base instructions, and the login
  still works. Claude Code and Z.AI use `--safe-mode`. Codex gets a private
  `HOME` and `CODEX_HOME` per run under `~/.codex/.codemux-hermetic/`,
  holding only a hard link to the real `auth.json` (Codex rewrites that
  file in place, so token rotations reach the real login; nothing is ever
  written back over it), handed to Codex through `env` so scode keeps the
  real home for its deny rules, plus
  `--ignore-user-config`, a zero AGENTS.md budget, and disabled apps,
  plugins, hooks, memories, goals and shell snapshot; repositories shipping
  `.agents/skills` or `.codex/skills` are refused. Every other harness
  refuses the flag until it has a verified mechanism. See
  `docs/HERMETIC.md` for the per-harness status and what each one lacks.
- `codemux run --tools <default|none>` selects the built-in tools a
  headless run exposes, independently of `--hermetic`. `none` maps to
  `--tools ""` for Claude Code and Z.AI and to disabled shell, exec,
  image, browser, computer-use, multi-agent and web-search features for
  Codex; Codex cannot drop `apply_patch`, so it takes `none` only with
  `--auto read-only`. Harnesses that cannot remove their tools refuse
  `none`, and `none` cannot be combined with `--enable-playwright-mcp`.
- `codemux check --hermetic` proves the mechanism with two real requests:
  a hermetic probe in a scratch directory carrying planted `AGENTS.md` and
  `CLAUDE.md` files with a random code word must answer `OK` without the
  code word, and a control probe without `--hermetic` must show the
  planted code word reaching the model; a control that answers anything
  else, stays clean, or fails also fails the check.
  `codemux verify` builds the hermetic command statically, and
  `codemux list` and `doctor` show which harnesses support `hermetic` and
  `tools`.

### Fixed

- `CODEX_API_KEY`, the variable Codex 0.154 actually reads for API-key
  authentication, is now forwarded to Codex runs alongside the older
  `OPENAI_API_KEY`. A hermetic Codex run authenticates with an API key
  only when that variable is set, so it never switches an operator with a
  stray `OPENAI_API_KEY` away from the account login a plain run uses.
- README and the compatibility ledger now list Kimi and OpenHands, name
  them among the argv-prompt harnesses, and describe the sandbox as on by
  default with `--no-sandbox` as the opt-out; SECURITY.md gives the same
  advice.

### Changed

- `check` moved into its own module and shares one launch path with `run`.
- A SIGINT, SIGTERM or SIGHUP to a headless `codemux run` is forwarded to
  the agent's whole process tree, which then gets the usual grace period
  before SIGKILL, and codemux stops with exit 143 instead of leaving the
  agent running after it is gone (or, when the signal lands during the
  harness version probe, launching the run anyway).
- Executable validation now covers a command's `env NAME=value` prefix and
  the program it launches, not only the first token.
- `verify` accepts an empty argument only as the value of `--tools`
  (`--tools ""` removes Claude's tools); any other empty argument still
  fails the wiring check.

## [0.5.1] - 2026-09-15

### Fixed

- `codemux verify` (and its tests) no longer reports Copilot's wiring as
  broken when the user's own temp root holds harness configuration, such as
  the `.claude/settings.local.json` a Claude Code session started in `$TMPDIR`
  leaves behind. The adapters' project-configuration walker climbs from the
  working directory to the nearest `.git`, so the neutral scratch directory
  `verify` builds commands in now carries an empty `.git` marker that ends the
  walk there; its ancestors are no longer inspected.

- Headless `claude` and `zai` runs could not write files. Both adapters set
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` for subprocess env hygiene, and
  Claude Code 2.1.25x couples that variable to a permission hardening that
  force-resets the requested permission mode to `default`, where writes need
  the interactive approval a headless run cannot provide. Medium autonomy
  now also emits an `--allowedTools Edit(//<launch dir>/**)` grant (the
  hardening's documented escape hatch, anchored to the launch directory —
  the same paths acceptEdits would auto-approve, and immovable by an
  approved `cd`) beside the unchanged native flags, and high adds bare
  Edit, Write, NotebookEdit, and Bash grants, a subset of the bypass it
  always requested. Hardened versions write again, audited versions keep
  their previous headless behavior, and `high` under the hardening stays
  weaker than a true bypass. The hardening discards plan mode too, so a
  hardened read-only TUI prompts instead of planning — scode's read-only
  boundary still enforces the level. At medium, a launch directory
  containing a parenthesis, a backslash, a glob metacharacter, a tab or
  line break, or trailing whitespace refuses the launch — the rule
  grammar cannot represent any of them. Grants ride only on headless
  runs; the TUI keeps the native flags so a human approves;
  docs/HARNESS-COMPATIBILITY.md has the details.

- Timed-out runs now terminate their whole process tree. The runner killed
  the agent's process group, but Codex starts each tool command in a fresh
  process group, so a shell loop left behind by a timed-out agent kept
  running (one such loop opened `gtk3-demo-application` on the desktop
  minutes after its run had ended). The runner now also walks the process
  table by parent pid, remembers descendants together with their start
  times across the SIGTERM grace period so orphans reparented to init or
  to a subreaper are still reached by the SIGKILL escalation, and signals
  a remembered pid only while its start time is unchanged, so a pid reused
  by an unrelated process is not signaled (the one exception is a process
  table that cannot be read mid-escalation, where remembered pids are
  signaled unverified). Interactive runs keep SIGTERM
  child-only, so the
  agent can shut down its own children, but the SIGKILL escalation now
  covers the tree as well, including when the agent exits on SIGTERM before
  the grace period ends: its descendants get the rest of that period, then
  the SIGKILL, in both modes. Known limitation (accepted): the first snapshot
  is taken when the first termination signal fires, so a descendant whose
  chain of parents back to the agent had already broken by then, or that
  forks a new process and exits between two snapshots, escapes any
  pid-tree walk; closing that needs kernel help, which is what the scode
  boundary is for. Such a process holding the captured output open no
  longer makes the run hang: the runner stops reading one second after
  its SIGKILL escalation, returns the timeout, and notes it on stderr. The table comes from `/proc` on Linux and from `/bin/ps`
  by absolute path on macOS, never via PATH, so an agent that can write to
  a PATH entry from inside the sandbox cannot plant the binary the runner
  executes outside it. A host that denies process enumeration (codemux
  nested inside another sandbox) gets a warning on stderr and the 0.5.0
  immediate group-only kill, instead of a silent degrade.
- Sandboxed `claude` runs authenticate again with Claude Code 2.1.25x. That
  version keeps the on-disk credential mirror as a stub with emptied tokens
  and a zero expiry once the Keychain owns the credential. The 0.5.0 sync
  classified that stub as a foreign file and silently left it alone, so
  every sandboxed run failed with "OAuth session expired". The file side of
  the sync now also recognizes that stub (string `accessToken` and
  `refreshToken`, a numeric `expiresAt`, a `scopes` array, and no key this
  codemux does not know) as a stale mirror to refresh; the same stub with an
  unknown key is left untouched and reported on stderr, so a newer Claude
  Code format fails loudly rather than silently. It is refreshed
  alongside any file with a usable token as before; a value of any other
  shape stays foreign, and the Keychain side still demands a usable token
  before anything is written. Deliberate trade-off: the live token rests
  on disk again (mode 0600) where 2.1.25x had moved it Keychain-only;
  CODEMUX_NO_KEYCHAIN_SYNC=1 opts out entirely.

### Security

- `js-yaml` upgraded to 4.3.2 (GHSA-2883-xcg3-v3hh: unbounded CPU use on
  empty merge-key sources). Codemux only parses its own config files with it,
  so the exposure was to a hostile local config, not to agent output.

## [0.5.0] - 2026-08-21

### Fixed

- Static wiring verification (`codemux verify` and its tests) builds commands
  against a neutral scratch working directory instead of the checker's own
  cwd. An adapter that correctly refuses repository-local executable
  configuration (Copilot) no longer reports its wiring as broken when the
  checker itself runs inside such a repository — including this one, whose
  hook shim lives in `.claude/settings.json`.

### Added

- Sandboxed `claude` runs stay authenticated. Claude Code keeps an on-disk
  mirror of its Keychain credential at `~/.claude/.credentials.json`; the
  scode sandbox cannot reach the Keychain, so a sandboxed Claude reads only
  that file, and a rotated Keychain token leaves it stale — every sandboxed
  run then 401s. A new `prepareSandbox` adapter hook, on sandboxed
  (non-untrusted) launches, refreshes it. Scoped deliberately narrow: it only
  refreshes a file that already exists (never fabricates one; a file that is
  not a Claude credential mirror is reported foreign and left untouched);
  only the `claudeAiOauth` field is read or written, so co-stored `mcpOAuth`
  state is preserved; the Keychain replaces the file only when strictly newer
  (or, when an expiry is unorderable, when the tokens differ); and a final
  re-check re-reads the whole file before the atomic rename, backing off if it
  changed or was deleted at all. A symlinked target or parent is refused, and
  the sync is skipped when `CLAUDE_CONFIG_DIR` / `CLAUDE_SECURESTORAGE_CONFIG_DIR`
  is passed through (the child then reads a mirror it owns).
  `CODEMUX_NO_KEYCHAIN_SYNC=1` disables it. Known limitation (accepted):
  the refresh is lock-free, matching Claude Code's own handling of this
  file, so a token rotated by a concurrent sandboxed Claude in a microsecond
  window can be overwritten and lost for one launch (self-heals thereafter).
- OpenHands CLI adapter (`openhands`), audited against CLI 1.16.0. `--headless`
  auto-approves by design, so headless runs carry no native approval gate and
  depend on the scode boundary. `--llm-approve` is never emitted: it confirms
  only what an LLM predicts is high-risk, which is a different mechanism from
  graded human approval rather than a weaker form of it. Model selection goes
  through `--override-with-envs`, since 1.16.0 has no model flag. Project-local
  `.openhands` skills, hooks, agents, microagents, plugins, and profiles are
  rejected before launch.

## [0.4.0] - 2026-08-15

### Changed

- **The sandbox is the boundary, not the harness.** Every autonomy level below
  `high` now requires scode, and `--sandbox` is on by default for `run`, `tui`,
  and `check` (opt out with `--no-sandbox`). Harness-native permission controls
  are treated as defense in depth. Upstream can restructure them without
  removing the flags Codemux passes -- OpenCode 1.18.18 turned its deny map into
  a rules list resolving to allow-all, and `--agent build` kept working while
  silently losing its gate. Anchoring enforcement in scode means such a change
  costs a warning instead of a silent downgrade, and removes the need to track
  every harness's permission semantics. Gemini's interactive TUI carried an
  undocumented exemption from this rule and no longer does.

### Added

- Kimi Code CLI adapter (`kimi`), audited against 0.31.1. Interactive sessions
  map autonomy onto `--plan`, `--yolo`, and `--auto`; headless runs carry none
  of them, because 0.31.1 rejects all three alongside `--prompt`. Project-local
  `.kimi-code` agent, skill, and mcp directories are rejected before launch.
- A declared compatibility matrix (`src/harness-compatibility.ts`) checked
  before launch. Three tiers, because newer is not the same as broken: below
  `min` refuses, through `maxAudited` runs silently, and anything newer runs
  with a warning. Refusal above `maxAudited` requires an explicit `breaks`
  entry describing a determined change, scoped to the autonomy levels it
  actually removes enforcement from. `CODEMUX_ALLOW_UNTESTED_HARNESS=1`
  downgrades a refusal to a warning.
- The harness binary's identity (inode, size, mtime) is compared across the
  version probe, and a mismatch warns. The reported version was observed
  changing between invocations on the same machine, so the value read is not
  guaranteed to be the value that runs.

## [0.3.1] - 2026-08-13

### Fixed

- Provider-supplied strings relayed by usagemux (`plan`, `account`, `provider`,
  `message`, window `kind`, and credit `unit`) are escaped before reaching a
  terminal, so a hostile or compromised upstream response cannot emit ANSI/OSC
  sequences. `--json` was never affected: `JSON.stringify` escapes them.
- An oversized usagemux response now reports that its output was truncated
  instead of surfacing as "invalid JSON".
- `minimalPath()` in the test helpers no longer exposes the real directory
  holding `bun`. Once `bun` and `usagemux` shared a Homebrew prefix, the
  "usagemux is absent" tests passed or failed depending on the machine.

## [0.3.0] - 2026-08-04

### Added

- Optional `codemux usage` integration with the standalone `usagemux` CLI,
  including strict versioned JSON validation, quota and subscription-renewal
  metadata, human and JSON output, and non-failing discovery in `doctor`.

### Fixed

- Updated `js-yaml` to 4.3.1, clearing GHSA-5p4m-2wfm-xmqj (quadratic CPU
  consumption resolving `!!omap`).

## [0.2.1] - 2026-08-02

### Changed

- The Bun version check treats `packageManager` as a minimum rather than an
  exact match. CI still provisions the pinned version, but a newer local Bun no
  longer fails `make runtime`.

### Added

- Homebrew installation via `brew install bindsch/tap/codemux`, which pulls in
  `scode` as a dependency.

## [0.2.0] - 2026-08-02

### Added

- Structured release and testing documentation (`docs/RELEASE-GATE.md`, `docs/RELEASING.md`, `docs/TESTING.md`).
- Public contribution and private vulnerability-reporting guidance.
- `verify --show-scode` preview flow for effective sandbox command rendering.
- Per-harness sandbox policy defaults with explicit override flags.
- Adapters for Aider, Cline CLI, GitHub Copilot CLI, and Cursor Agent CLI.
- A dated compatibility ledger covering all 13 harnesses and their audited upstream versions.

### Changed

- Hardened autonomy mappings, sandbox defaults, configuration validation, Z.AI credentials, and process lifecycle handling.
- Coverage is enforced at 80% for lines and functions; release checks now include dependency audit and frozen-install validation.
- README rewritten into production-oriented structure with command/option references.
- Project gate workflow standardized via `Makefile` and `make check`.
- CI now runs the release gate on macOS and Linux with pinned actions and Bun.
- Standardized the project under the MIT license.
- Historical design notes moved under `docs/`; package metadata now points to
  the canonical GitHub repository.
- Shell aliases moved under `scripts/` with the other repository utilities.
- Refreshed built-in model aliases and split process execution from adapter
  validation to keep the runtime modules focused.
- Added Cursor's primary `agent` binary, stdin prompts, native Plan/Auto Review
  modes, workspace trust, and deterministic outer-sandbox integration.
- Expanded normalized reasoning effort through `minimal`, `xhigh`, `max`, and `ultra`
  where each harness supports those values.
- Require scode 0.2.0 or newer for sandbox launches and surface incompatible
  installations in `doctor` and the release gate.

### Fixed

- Prevented read-only modes from silently enabling writes in Claude, Z.AI, Cursor, Qwen fallback, and OpenCode.
- Fixed sandbox relative working directories, output truncation, pipe deadlocks, environment-test races, and invalid Droid/OpenCode flags.
- Removed implicit mutable `@latest` MCP execution; Playwright MCP is now local and opt-in.
- Validated TUI Playwright MCP binaries against the effective `--cwd`, closing
  a repository-local executable bypass.
- Prevented hostile working trees from injecting Bun preloads, dotenv settings,
  shell loaders, runtime search paths, or repository-authorized secret passthrough.
- Enforced durable read-only boundaries, process-tree timeouts,
  valid Gemini argv ordering, restricted Pi/Qwen startup behavior, and explicit
  errors for unsupported effort levels.
- Added installed third-party CLI contract checks to the release gate while
  keeping the hermetic default test suite independent of absent tools.
- Enabled Qwen's current `--safe-mode` and retained the outer read-only sandbox
  requirement for headless Gemini Plan Mode.
- Rejected repository-controlled executables, sandbox policy files, and
  Copilot hook/MCP/agent configuration across headless and TUI launch boundaries.
- Prevented OpenCode project plugins, dependency installation, custom tools,
  and configuration from executing before autonomy enforcement; all OpenCode
  launches now use pure mode.
- Updated Claude/Z.AI, Codex, OpenCode, Qwen, Copilot, Pi, Aider, and model-alias
  contracts for their current upstream CLIs; hardened project execution config
  checks across every applicable harness.
- Isolated Aider model metadata, Codex exec rules, Factory hooks/custom droids,
  Gemini local environment/native sandbox inputs, and OpenCode singular policy
  directories; Claude/Z.AI TUI sessions now disable repository customizations.

## [0.1.0] - 2026-02-24

### Added

- Initial unified CLI for multi-agent coding harnesses.
- Adapter architecture for `claude`, `codex`, `droid`, `goose`, `gemini`, `opencode`, `pi`, `qwen`, and `zai`.
- Normalized autonomy and reasoning-effort controls with per-adapter translation.
- Sandbox integration through `scode` for a single external sandbox boundary.
- Diagnostics commands: `list`, `doctor`, `check`, `autonomy`, and `verify`.
- Automated Bun test suite and TypeScript typecheck gate.

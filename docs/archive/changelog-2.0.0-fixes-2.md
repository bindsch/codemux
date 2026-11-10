---
read_when: "Reviewing earlier fixes included in codemux 2.0.0."
---
# 2.0.0 fixes, part 2

Preserved from the [2.0.0 changelog](https://github.com/bindsch/codemux/blob/main/CHANGELOG.md#200---2026-11-10).

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

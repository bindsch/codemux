# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

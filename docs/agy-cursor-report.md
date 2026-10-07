# agy + cursor agent: task report

Date: 2026-10-04. Branch `harness-agy-cursor`, worktree `~/Programming/Ops/codemux-agy`, based on released 0.6.0. Not committed (per task instruction); the tree is staged with `git add -A`.

## Bottom line

- `agy` (Google Antigravity) is a full codemux adapter at contract floor 1.2.14, audited from the binary's flag surface and the official docs — **not live-exercised: this machine has no Antigravity login**, contrary to the task's assumption. Every live `agy` invocation stops at the OAuth wall (verbatim captures below).
- Cursor launches run the standalone `agent` entry, then the legacy
  `cursor-agent` — exactly 0.6.0's default; the desktop `cursor agent`
  subcommand is strictly opt-in (`CODEMUX_CURSOR_ENTRY=cursor` passed
  through `--pass-env`, round 3), because the wrapper may install or
  update the agent on first use. Entry resolution is spawn-free. Verified
  live against Cursor 3.23.12 / agent build 2026.08.11-e8db854.
- Full suite after the four review rounds: **672 pass / 0 fail / 678 tests** (baseline 635/0/641; round 3 ended at 671/677; round 4 added the exported-env regression test). Release gate: everything green except the pre-existing copilot EPERM in the installed-contract suite, identical to the baseline.
- The `agy` binary **self-updated from 1.2.14 to 1.2.16 mid-task**; the version gate warned on the next launch exactly as designed, and the contract re-ran green against 1.2.16 (details below).

## Machine state that shaped the audit

**agy is not logged in here.** The task said it would be; it is not. Two consequences, both stated where they matter:

1. No live run, no live envelope. The `--result-json` envelope is a
   **documented-schema pin** (the official headless docs' examples plus the
   binary's embedded JSON tags), not a live capture. The tests say so.
2. The hermetic live check could not run, so `--hermetic` and `--tools none`
   are refused for agy on two grounds: no mechanism, and no login to verify
   one with (docs/HERMETIC.md).

## Live captures, verbatim

Working directory for all: the worktree root. Raw captures live in
`scratch/` (ignored). OAuth URLs are reproduced in full; they carry no
secrets (public client id, one-time state).

### agy version, first probe (scratch/agy-live-01-basic.txt)

```
$ agy --version
1.2.14
--- exit 0

$ agy -p "Reply with exactly: OK" (text output)
--- exit 1
```

### agy help surface (scratch/agy-help.txt, complete)

```
$ agy --help
Usage of agy:
  --add-dir                       Add a directory to the workspace (repeatable) (default [])
  --agent                         Agent for the current CLI session
  -c                              Short alias for --continue
  --continue                      Continue the most recent conversation
  --conversation                  Resume a previous conversation by ID
  --dangerously-skip-permissions  Auto-approve all tool permission requests without prompting
  --disable-slash-commands        Disable slash command and skill expansion in print mode
  --effort                        Reasoning effort for the current CLI session (low|medium|high|xhigh|max)
  -i                              Short alias for --prompt-interactive
  --input-format                  Input format for print mode (text, stream-json). stream-json reads one NDJSON message per line from stdin and runs a turn for each; it requires --output-format stream-json (default text)
  --json-schema                   Optional JSON schema string or path to a schema file to enforce structured output (for stream-json, only applicable to the final result)
  --log-file                      Override CLI log file path
  --mode                          Set the agent execution mode for this session (accept-edits, plan)
  --model                         Model for the current CLI session
  --new-project                   Create a new project for this session
  --output-format                 Output format for print mode (text, json, stream-json) (default text)
  -p                              Short alias for --print
  --print                         Run a single prompt non-interactively and print the response
  --print-timeout                 Optional time limit for print mode; 0 waits until the turn completes (default 0s)
  --project                       Project ID or project name for the current CLI session
  --prompt                        Alias for --print
  --prompt-interactive            Run an initial prompt interactively and continue the session
  --remote-control                Create a remote connection for the CLI session on start up
  --sandbox                       Run in a sandbox with terminal restrictions enabled

Available subcommands:
  agent           List available agents
  agents          List available agents
  changelog       Show changelog and release notes
  help            Show help for subcommands
  install         Configure environment paths and shell settings
  mcp             Manage MCP servers (add, remove, list, enable, disable)
  mic-serve       Serve this machine's microphone to a CLI on another host
  models          List available models
  plugin          Manage plugins (install, uninstall, list, enable, disable)
  plugins         Alias for plugin
  remote-control  Manage the remote-control background daemon (start, status, stop)
  update          Update CLI
--- exit 0
```

### Flag-form probes at 1.2.14 (scratch/agy-flag-form-probes.txt, complete)

The `=` form parses (then dies for lack of a TTY, expected without a
prompt); the space form exits 2. `--mode=bogus` warns and continues —
fail-open, which is why the adapter treats `--mode` as advisory and scode
as the boundary.

```
$ agy --effort=high </dev/null (10s cap)
CLI error: bubbletea: error opening TTY: bubbletea: could not open TTY: open /dev/tty: device not configured
--- exit 0

$ agy --effort high </dev/null (10s cap)
flags provided but not defined: -effort high
Usage of agy:
--- exit 2

$ agy --effort=bogus </dev/null (10s cap)
CLI error: bubbletea: error opening TTY: bubbletea: could not open TTY: open /dev/tty: device not configured
--- exit 0

$ agy --mode=plan </dev/null (10s cap)
CLI error: bubbletea: error opening TTY: bubbletea: could not open TTY: open /dev/tty: device not configured
--- exit 0

$ agy --mode plan </dev/null (10s cap)
flags provided but not defined: -mode plan
Usage of agy:
--- exit 2

$ agy --mode=bogus </dev/null (10s cap)
warning: unrecognized --mode value "bogus" (valid: accept-edits, plan)
CLI error: bubbletea: error opening TTY: bubbletea: could not open TTY: open /dev/tty: device not configured
--- exit 0

$ agy --output-format=json </dev/null (10s cap)
CLI error: bubbletea: error opening TTY: bubbletea: could not open TTY: open /dev/tty: device not configured
--- exit 0

$ agy --output-format json </dev/null (10s cap)
flags provided but not defined: -output-format json
Usage of agy:
--- exit 2

$ agy --input-format=stream-json </dev/null (10s cap)
Error: --input-format stream-json requires --output-format stream-json
--- exit 2

$ agy --disable-slash-commands </dev/null (10s cap)
CLI error: bubbletea: error opening TTY: bubbletea: could not open TTY: open /dev/tty: device not configured
--- exit 0
```

### The adapter's full argv, live (scratch/agy-adapter-argv-live-2.txt, verbatim)

Round-2 correction: the round-1 capture
(scratch/agy-adapter-argv-live.txt, kept in scratch) was still not the
adapter's argv. It carried `--model=gemini-3-pro` as a single token while
the adapter then emitted `--model gemini-3-pro` as two argv tokens (what
the round-1 test pinned), so the one property the evidence existed to
establish — that the emitted `--model` form parses on the pinned 1.2.14,
whose sibling value flags reject the space form with exit 2 — was never
exercised live. Both sides are now aligned, and the alignment went the
safe way: the adapter emits `--model=<value>` (the `=`-form every other
value flag uses, and the form both prior captures actually ran), the
pinned test asserts that array, and the capture below was produced by
calling `AgyAdapter.buildRunCommand` on this working tree and executing
the returned array verbatim (the driver is scratch/run-adapter-argv.ts).
Binary at capture time: 1.2.16 (the round-0 self-update; 1.2.14 remains
the audited floor, and the `=`-form is valid on both).

```
# agy 1.2.16 (binary self-updated from the audited 1.2.14 during round 0; no login on this machine)
# argv built by calling AgyAdapter.buildRunCommand on the working tree (bun scratch/run-adapter-argv.ts), then run verbatim: stdin /dev/null, 10s cap
$ argv (JSON tokens): ["agy","--disable-slash-commands","--model=gemini-3-pro","--effort=high","--mode=accept-edits","--print=Reply with exactly: OK"]
$ rendered: agy --disable-slash-commands --model=gemini-3-pro --effort=high --mode=accept-edits '--print=Reply with exactly: OK'
--- exit 1
--- stdout ---

--- stderr ---
Authentication required. Please visit the URL to log in:
  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com&code_challenge=Yvh3k6MeWCHIRTO-Si7kzP3Nf9pDYlD0xCRgnmCSDqg&code_challenge_method=S256&prompt=consent&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2F%2Fauth%2Fcloud-platform+https%3A%2F%2Fwww.googleapis.com%2F%2Fauth%2Fuserinfo.email+https%3A%2F%2Fwww.googleapis.com%2F%2Fauth%2Fuserinfo.profile+https%3A%2F%2Fwww.googleapis.com%2F%2Fauth%2Fcclog+https%3A%2F%2Fwww.googleapis.com%2F%2Fauth%2Fexperimentsandconfigs+https%3A%2F%2Fwww.googleapis.com%2F%2Fauth%2Faicode+openid&state=ffzjvs-8qA9tMEDjmoBucg

Waiting for authentication (timeout 60s)...
Or, paste the authorization code here and press Enter:
```

Every flag the adapter emits parses; the invocation stops only at
authentication. One flag-form note from the round-1 flag-set probe below
(`--output-format=json` on an authentication failure): the envelope's
JSON tags are live-observed in an ERROR envelope (`conversation_id`,
`status`, `response`, `error`, `duration_seconds`, `num_turns`, and
`usage` with `input_tokens`, `output_tokens`, `thinking_tokens`,
`cache_read_tokens`, `total_tokens`). A success envelope with nonzero
usage is still docs-pinned (no login here); the usage-normalization
arithmetic rests on the documented examples either way.

The round-1 flag-set probe (prompt in the `--print=` the adapter uses,
`--output-format=json`, and the `=`-form of every value flag — a
hand-composed set of the adapter's flags, run before the round-2 fix made
`--model`'s form match it):

```
$ agy --disable-slash-commands --model=gemini-3-pro --effort=high --mode=plan --output-format=json --print="Reply with exactly: OK" </dev/null (10s cap)
Authentication required. Please visit the URL to log in:
  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com&code_challenge=JdKb6eAZU4EGzGBiIFyQZG7QGhSWhx67hKljtHZH5gY&code_challenge_method=S256&prompt=consent&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2F%2Fauth%2Fcloud-platform+https%3A%2F%2Fwww.googleapis.com%2F%2Fauth%2Fuserinfo.email+https%3A%2F%2Fwww.googleapis.com%2F%2Fauth%2Fuserinfo.profile+https%3A%2F%2Fwww.googleapis.com%2F%2Fauth%2Fcclog+https%3A%2F%2Fwww.googleapis.com%2F%2Fauth%2Fexperimentsandconfigs+https%3A%2F%2Fwww.googleapis.com%2F%2Fauth%2Faicode+openid&state=WD6iWUihDDPykmOeK8GnEQ

Waiting for authentication (timeout 60s)...
Or, paste the authorization code here and press Enter:

Error: authentication interrupted.
error: authentication failed or timed out
{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}
--- exit 124
```

The round-0 combined probe, relabeled for what it is — a hand-composed
probe of the same flags in a different order and form:

```
$ agy --print "Reply with exactly: OK" --mode=plan --effort=high --model=gemini-3-pro --output-format=json --disable-slash-commands </dev/null (10s cap)
Authentication required. Please visit the URL to log in:
  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com&code_challenge=Vkfg4aeD-yJ73sbq-yjv6m5WRFU9n5I4n3dYc4ZBwoo&code_challenge_method=S256&prompt=consent&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2F%2Fauth%2Fcloud-platform+https%3A%2F%2Fwww.googleapis.com%2F%2Fauth%2Fuserinfo.email+https%3A%2F%2Fwww.googleapis.com%2F%2Fauth%2Fuserinfo.profile+https%3A%2F%2Fwww.googleapis.com%2F%2Fauth%2Fcclog+https%3A%2F%2Fwww.googleapis.com%2F%2Fauth%2Fexperimentsandconfigs+https%3A%2F%2Fwww.googleapis.com%2F%2Fauth%2Faicode+openid&state=94UUZe8e4MwKOCKzjmmCuw

--- exit 124

$ agy -p "x" --dangerously-skip-permissions </dev/null (10s cap)
Authentication required. Please visit the URL to log in:
  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com&code_challenge=-2Fb2yKbefxahuY9hcqQgvDze8tlWBd3AKnIA94Eo5o&code_challenge_method=S256&prompt=consent&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.profile+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcclog+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fexperimentsandconfigs+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Faicode+openid&state=erDHxDioYSsiqlk4oM7eBQ
--- exit 124
```

The plain interactive probe (scratch/agy-probe-stderr.txt) shows the full
wait-and-timeout path:

```
Authentication required. Please visit the URL to log in:
  https://accounts.google.com/o/oauth2/auth?...&state=SeD1Qq_n8qSJJeblt9tsVg

Waiting for authentication (timeout 60s)...
Or, paste the authorization code here and press Enter:
Error: authentication timed out.
error: authentication failed or timed out
```

(URL elided here only to keep this copy readable; the full one is in the
scratch capture.)

### Credential variables in the binary (scratch/agy-strings.txt)

```
  11 GEMINI_API_KEY
   2 GOOGLE_API_KEY
   1 GOOGLE_APPLICATION_CREDENTIALS
```

`ANTHROPIC_API_KEY` does not appear. The environment allowlist for agy is
the two API-key names only (src/environment.ts): round 2 removed
`GOOGLE_APPLICATION_CREDENTIALS` after a live probe (scratch/agy-adc-probe.txt)
showed agy never reads it — setting it to a missing and then a
valid-shaped service-account file both leave the headless auth path at the
identical OAuth browser wall, so forwarding a service-account key was a
claim without a reader (the ADC function is linked in the binary but is
not on the auth path).

### Hermetic check refusal (scratch/agy-live-hermetic-refusal.txt)

Refused before any model call; costs nothing:

```
$ ./bin/codemux check --hermetic --no-sandbox --auto high -a agy
Error: agy has no verified hermetic mode; see docs/HERMETIC.md
```

### codemux run against agy, no login

Sandboxed first (exit 71 — this agent shell is itself sandboxed, so the
nested `sandbox-exec` was denied; also the first live sighting of the
1.2.16 self-update and the version-gate warning):

```
$ ./bin/codemux run -a agy -p "Reply with exactly OK"
Running with agy (sandboxed)...
Warning: agy 1.2.16 is newer than the 1.2.14 this Codemux audited. No breaking change is known for it, so this run continues. If autonomy stops behaving as documented, that is the first thing to suspect.
scode: '/Users/example/.local/bin/agy' is not a known harness — sandbox behavior has not been tested for this command
sandbox-exec: sandbox_apply: Operation not permitted
--- exit 71
```

Unsandboxed (scratch/agy-live-run-nologin.txt) — the documented
authentication failure, exactly as the headless docs promise (no hang):

```
$ ./bin/codemux run -a agy --no-sandbox --auto high -p "Reply with exactly OK"
Running with agy...
Warning: agy 1.2.16 is newer than the 1.2.14 this Codemux audited. No breaking change is known for it, so this run continues. If autonomy stops behaving as documented, that is the first thing to suspect.
Error: authentication required. Run 'agy' to log in, then retry.
error: authentication failed or timed out
--- exit 1
```

Note for scode owners: scode on this machine does not know `agy` ("not a
known harness — sandbox behavior has not been tested"), so sandboxed agy
runs carry that warning until scode adds it.

### The self-update: 1.2.14 → 1.2.16

Discovered when the run above warned. Re-probes:

```
$ agy --version
1.2.16
```

Space-form probe at 1.2.16 (scratch/agy-space-form-1216.txt) — the
1.2.14 exit-2 parse rejection no longer reproduces; the invocation now
parses and proceeds to authentication:

```
$ agy --effort high --print="Reply OK"
Authentication required. Please visit the URL to log in:
  https://accounts.google.com/o/oauth2/auth?...&state=AfdkVCixF2PF4m-tyBalVg
--- exit 1
```

The `=`-form the adapter emits is valid on both releases, and the
installed-contract agy entry passed against 1.2.16 in the release-gate
run below, so nothing breaks. The ledger row and the contract floor stay
pinned at 1.2.14, the audited release, and the 2026-10-04 addendum
records the drift.

### Cursor entry-point probes (scratch/cursor-entry-probes.txt)

```
$ cursor agent --version
2026.08.11-e8db854
--- exit 0

$ agent --version
2026.08.11-e8db854
--- exit 0

$ cursor --version
3.23.12
2d29876d567da1607532b23bbf2cd5ddbca496f0
arm64
--- exit 0
```

`cursor agent --help` answers (and is byte-identical to `agent --help`
apart from the usage line — compared during the adapter work), and the
subcommand reaches the same agent build the standalone entries run.
`cursor --version` reports the desktop app's semver, not the agent
build — hence the contract's per-entry version-probe arguments
(`cursor agent --version` through the desktop, used only under the
round-3 opt-in).

(The copilot EPERM line in the same scratch file is the pre-existing
environmental failure discussed under the gate below.)

### Diagnostics include agy (scratch/cli-list.txt, cli-doctor.txt, cli-verify.txt)

```
$ ./bin/codemux list
Available agents:
  ✅ agy [model, autonomy, effort]
  ✅ aider [model, autonomy, effort]
  ✅ claude [model, autonomy, effort, hermetic, tools]
  ❌ cline [model, autonomy, effort]
  ✅ codex [model, autonomy, effort, hermetic, tools]
  ✅ copilot [model, autonomy, effort]
  ✅ cursor [model, autonomy]
  ✅ droid [model, autonomy, effort]
  ✅ goose [model, autonomy]
  ✅ gemini [model, autonomy]
  ✅ kimi [model, autonomy]
  ✅ openhands [model, autonomy]
  ✅ opencode [model, autonomy, effort]
  ✅ pi [model, autonomy, effort]
  ✅ qwen [model, autonomy]
  ✅ zai [model, autonomy, hermetic, tools]
```

```
$ ./bin/codemux doctor   (agy and cursor sections)
agy (agy): ✅ installed
  Non-interactive: yes
  Interactive: yes
  Model selection: yes
  Autonomy levels: read-only, low, medium, high
  Effort levels: low, medium, high, xhigh, max
  Hermetic runs: no
  Tool selection: no

cursor (agent): ✅ installed
```

(`cursor (agent)` is the spawn-free display name: doctor must not launch
anything, and the standalone `agent` entry resolves on this machine. The
desktop entry never resolves here — it needs the round-3 opt-in.)

```
$ ./bin/codemux verify
| agy | yes | yes | yes | yes | 0 | PASS |
| cursor | yes | yes | yes | yes | 0 | PASS |
...
Summary: PASS 14, WARN 2, FAIL 0
```

The two WARNs are pre-existing: cline (not installed) and pi (two
documented notes about its approval modes).

## Gate

| Check | Baseline | Now |
|---|---|---|
| Full suite (`bun test`) | 635 pass / 0 fail / 641 tests | **666 pass / 0 fail / 672 tests** (+31, all new agy/cursor coverage) |
| `make contracts` | 1 pass / 1 fail (copilot EPERM) | 1 pass / 1 fail (same copilot EPERM; agy + cursor entries passed before it; version probes now exercise 11 binaries: agy, aider, claude, codex, copilot, cursor, droid, kimi, openhands, opencode, zai — 10 at baseline) |
| `make release-gate` overall | fails at `contracts` (copilot) | fails at `contracts` (copilot, identical error) |

The copilot failure is environmental and pre-existing: `copilot --help`
tries to extract its bundled package into `~/Library/Caches/copilot`,
which this machine's sandbox denies (`EPERM ... mkdir
/Users/example/Library/Caches/copilot/pkg/darwin-arm64`). Identical text at
baseline (scratch/baseline-gate.txt line 102) and now. Every other gate
target passes (`make release-gate` aborts at `contracts`, so the rest ran
individually — scratch/release-gate-remaining.txt): `runtime`, `check`,
`sandbox-contract` ("scode sandbox contract passed"), `smoke`, `bun
audit` ("No vulnerabilities found (checked 9 packages)"),
`bun install --frozen-lockfile --dry-run`, `./bin/codemux run --help`.

Prose check: `check_american.py` over every changed file (15 src/docs + 8
tests) — "0 British spelling(s) found", exit 0.

## What was built

New: `src/adapters/agy.ts`. Changed: `src/types.ts` (AgentId union),
`src/adapters/{base,cursor,index}.ts` (displayName seam; cursor entry
resolution), `src/autonomy.ts`, `src/environment.ts` (agy credential
allowlist), `src/harness-compatibility.ts` (agy contract, floor 1.2.14;
cursor per-binary version args), `src/info-commands.ts`, 
`src/project-safety.ts` (agy project-config refusals),
`src/result-envelope.ts` (`parseAgyResultEnvelope`, `agyResult`),
README (agents/autonomy tables, result-envelope note, cursor paragraph),
CHANGELOG `[Unreleased]`, docs/HARNESS-COMPATIBILITY.md (row + 2026-10-04
addendum), docs/HERMETIC.md (agy refusal row), and the eight test files.

Design points worth naming:

- **Prompt in argv as `--print=<prompt>`**: keeps a leading-dash prompt
  inside the option and applies BaseAdapter's argv guards. No stdin
  transport exists.
- **`=`-form enum flags**: required at 1.2.14 (space form exits 2);
  still valid at 1.2.16, so the adapter keeps emitting it.
- **`--mode` is advisory**: unrecognized values warn and continue
  (fail-open, verified live), so autonomy below high rests on scode, as
  everywhere in codemux. `low` maps to default prompting because
  headless soft-denies approvals it cannot show — and still exits 0
  (documented upstream), which scode is the durable answer to.
- **Envelope**: `--output-format=json` (the `=`-form 1.2.14 requires for
  its pre-parsed value flags) passes through with the codemux
  block appended. Usage normalization: agy's `input_tokens` includes the
  cache-read count and `thinking_tokens` sits outside the total, so
  uncached input is `input - cache_read`, the read count becomes
  `cached_input_tokens`, and the total is taken as reported (all three
  documented examples sum exactly). Pinned against the docs' schema and
  the binary's JSON tags — not a live capture; the tests mark it.
- **Cursor entry selection**: spawn-free resolution of the standalone
  `agent`, then the legacy `cursor-agent`; the desktop `cursor agent`
  entry needs the explicit `CODEMUX_CURSOR_ENTRY=cursor` opt-in passed
  through `--pass-env` (README and the ledger carry the warning that the
  wrapper may install or update the agent on first use). No probe ever
  runs — `list`, `doctor`, and `verify` answer every question
  spawn-free, and `verify` builds real commands in ~0.14s on this
  machine.
- **Project safety**: agy runs and TUIs refuse repository-controlled
  `.agents/{skills,rules,plugins,agents}.json` manifests,
  `.agents/hooks.json`, the `.agents/{skills,rules,plugins,agents,workflows}/`
  directories, and `.gemini/.env` plus the whole `.gemini/config/` tree,
  between the working directory and its Git root — the config roots the
  binary's own strings name. Workspace `.agents/teamwork/` and
  `.gemini/antigravity/` artifacts are not refused (output, not
  executable config).
- **No model aliases for agy**: `agy models` is login-gated (same wall as
  everything else), so there is no verified model-name surface to alias.

## Task checklist

| Item | Status |
|---|---|
| agy adapter: id, headless `--print`, argv-bound prompt | done |
| agy `--model` / `--effort` (five levels, others refused pre-launch) | done |
| agy autonomy mapping + docs (autonomy.ts, README table) | done |
| agy `--result-json` via `--output-format=json`, envelope pinned, usage mapped | done (documented-schema pin, not live — no login) |
| agy hermetic/tools claim | **refused** — no mechanism, no login (docs/HERMETIC.md) |
| agy project-config refusals | done |
| agy credential allowlist (2 vars, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, verified in binary strings; `GOOGLE_APPLICATION_CREDENTIALS` removed in round 2 — no reader) | done |
| agy version contract + ledger row + installed-contract entry + list/doctor/verify | done (live-verified this session) |
| cursor `agent` entry preference + `cursor-agent` fallback; desktop `cursor agent` strictly opt-in (`CODEMUX_CURSOR_ENTRY=cursor` via `--pass-env`), trust-checked against the run's cwd | done (opt-in added in round 3) |
| cursor flag surface verified (`cursor agent --help` identical) + contract updated | done |
| `make release-gate` | passes except pre-existing copilot EPERM (counts above) |
| check_american.py on changed prose | clean, exit 0 |
| CHANGELOG / README / ledger addendum with versions | done |
| usagemux check before live calls | agy calls cost nothing (no login); no zai quota touched |
| Report + `git add -A`, no commit | this file; staged |

## Review fixes, round 1

Findings from the round-1 review, blocker through minor, each fixed with
the smallest correct change and a regression test. The delivered findings
file listed four distinct findings: its correctness section repeated the
same two verbatim, and its trailing `contracts-2` section was empty.

| # | Severity | Finding | Fix | Regression test |
|---|---|---|---|---|
| 1 | blocker | The cursor subcommand probe spawned the PATH-resolved `cursor` with the inherited environment and the caller's working directory, before any trust check — a repository-local `cursor` on PATH executed outside the sandbox during discovery | `cursorAgentSubcommandAnswers` resolves the executable through `resolveTrustedExecutable(binary, "cursor", process.cwd())` first — a refusal reads as "does not answer" and the preference falls back without executing it — then spawns the validated path with the scrubbed `probeEnvironment` from the OS temp root (src/adapters/cursor.ts) | tests/new-adapters.test.ts: "a cursor that fails the executable trust check never executes during discovery" and "the subcommand probe runs a trusted cursor with a scrubbed environment from a neutral directory" |
| 2 | major | The cursor version-probe arguments were selected by the canonical path's basename; the standard Homebrew `cursor` symlink resolves into the Cursor.app bundle as `code`, so the gate ran bare `--version`, read the desktop semver (3.23.12), missed the calendar pattern, and warned past the floor — even for a below-floor agent build | The entry identity is preserved end to end: `assertHarnessSupported` passes the adapter's `binaryName` through `VersionGateRequest` into `probeHarnessVersion`, and the contract's `versionArgsFor` keys on that name, never on the resolved path's basename (src/harness-compatibility.ts, src/cli-runtime.ts) | tests/harness-compatibility.test.ts: "cursor's version probe keys on the entry name, not the executable's basename" |
| 3 | minor | This report's "The adapter's full argv, live" section presented a hand-composed probe (prompt first, space-form `--print`, reordered flags) as the adapter's argv | Section rewritten above: the adapter's literal argv — built by calling `buildRunCommand`, the same array tests/new-adapters.test.ts pins — was run live to the authentication wall and is quoted verbatim (scratch/agy-adapter-argv-live.txt); the round-0 capture is relabeled as a hand-composed probe of the same flags | The pinned argv test is the regression guard; the capture itself is the corrected evidence |
| 4 | minor | README and CHANGELOG documented agy autonomy as `--mode plan` / `--mode accept-edits` in space form, which the pinned 1.2.14 rejects with exit 2 | Both now show `--mode=plan` / `--mode=accept-edits`, the form the adapter emits | tests/new-adapters.test.ts "maps autonomy levels onto agy's mode flags" already pins the emitted form; the fix aligns the prose with it |

Verification that the tests catch the bugs rather than merely passing
after them:

- Finding 1: with the probe body temporarily reverted to the pre-fix
  spawn, both regression tests fail (`2 fail` in
  tests/new-adapters.test.ts); restored, all pass.
- Finding 2: replaying the old basename-keyed selection against the same
  fake binary sends `["--version"]` and reads `null` — the floor bypass,
  reproduced; the fixed selector reads `2026.08.11`.

Ripples worth naming:

- `probeHarnessVersion` and `VersionGateRequest` gained an explicit
  entry-name parameter (`binaryName`), so every direct caller states the
  entry identity instead of inferring it from a path; the seven direct
  `assertSupportedHarnessVersion` constructions in
  tests/harness-compatibility.test.ts and the installed-contract call
  now pass it.
- The round-1 live capture also confirmed the envelope's JSON tags in an
  ERROR envelope (see the corrected section above); a success envelope
  with nonzero usage remains docs-pinned, as before.
- README (cursor paragraph, agy autonomy row), CHANGELOG (both
  unreleased bullets), and docs/HARNESS-COMPATIBILITY.md (cursor row and
  addendum) were updated for the changed behavior.

### Gate after round 1

| Check | Round 0 | Round 1 |
|---|---|---|
| Full suite (`make check`: typecheck, shell, tests) | 666 pass / 0 fail / 672 tests | **669 pass / 0 fail / 675 tests** (+3, the new regression tests; 6 skip = installed-contract entries) |
| `make contracts` | 1 pass / 1 fail (copilot EPERM) | 1 pass / 1 fail (same copilot EPERM, identical text; version probes exercised and non-null on all 11 binaries including cursor through the new signature) |
| `make release-gate` overall | fails at `contracts` (copilot) | fails at `contracts` (copilot, identical error) |

The copilot failure is the pre-existing environmental EPERM documented in
the round-0 gate section. Every other gate target passes, run individually
after the abort (scratch/release-gate-round1-remaining.txt): `runtime`,
`sandbox-contract` ("scode sandbox contract passed"), `smoke`, `bun audit`
("No vulnerabilities found (checked 9 packages)"), `bun install
--frozen-lockfile --dry-run`, and every `--help`/`verify` smoke command.

Prose check: `check_american.py` over every round-1 changed file —
"0 British spelling(s) found", exit 0.

## Review fixes, round 2

Findings from the round-2 review, blocker through minor. The delivered
findings file carried six distinct findings: its correctness section
restated the two cursor majors its security section detailed, and its
`contracts-2` section was empty. The two majors share one root cause —
the desktop-subcommand probe — so they share one fix.

| # | Severity | Finding | Fix | Regression test |
|---|---|---|---|---|
| 1 | major | The cursor entry probe ran `cursor agent --help` before any gate, forbidden-rooted at `process.cwd()` instead of the run's `--cwd`, so a repository-controlled `cursor` on PATH (with `--cwd` inside that repository, e.g. a direnv `PATH_add bin`) executed outside the sandbox during discovery, before the launch's trust check could refuse it | The probe is deleted. Entry resolution is three null checks (`agent`, then `cursor-agent`, then the desktop `cursor`) and executes nothing, so discovery has nothing to get wrong; the version gate — which resolves the trusted executable against the run's own working directory before its version spawn — is the first and only executor (src/adapters/cursor.ts) | tests/new-adapters.test.ts: "discovery never executes a repository-local cursor, whatever the trust check would say" — a repo-local `cursor` that marks its execution is consulted for availability, entry, and command building; the marker must not exist |
| 2 | major | The same probe ran from `list`, `doctor`, and `verify` whenever the desktop entry was the sole candidate, and the desktop wrapper (the Cursor.app 3.23.12 launcher) downloads and runs `https://cursor.com/install` when `~/.local/bin/cursor-agent` is absent and runs `cursor-agent update` when the build is old — before forwarding even `--help` — so diagnostics could download and execute an installer or modify the installation | Same deletion, plus the preference reversal it enables: the standalone `agent`/`cursor-agent` entries are what the wrapper's `agent` subcommand execs anyway (verified in the launcher script, lines 96–138), so they now win and the desktop entry is the last resort, executed only by a launch or the gate's own post-trust-check version probe. `isAvailable` and everything `verify` builds are spawn-free, including desktop-only installs | tests/new-adapters.test.ts: "diagnostics never execute the desktop wrapper's installer path" — a fake wrapper that marks `agent`-subcommand invocations is asked every diagnostic question; the marker must not exist |
| 3 | major | The round-1 "adapter's literal argv, live" evidence was still mislabeled: the capture carried `--model=gemini-3-pro` as one token while the adapter then emitted two (`--model gemini-3-pro`, what the round-1 test pinned), so the emitted `--model` form — the one flag form never exercised at the pinned 1.2.14, whose sibling value flags reject the space form with exit 2 — never ran live | The adapter now emits `--model=<value>` (the `=`-form every other value flag uses and the form both prior captures actually ran) in run and TUI builds, the pinned test asserts that array, and the evidence is new: `AgyAdapter.buildRunCommand` was called on the working tree and the returned array executed verbatim (driver scratch/run-adapter-argv.ts, capture scratch/agy-adapter-argv-live-2.txt, binary 1.2.16, quoted in the corrected section above) | tests/new-adapters.test.ts: "builds a headless command with the value flags in = form and the prompt last" (and "builds interactive commands") — both fail against the pre-fix adapter |
| 4 | minor | `GOOGLE_APPLICATION_CREDENTIALS` sat in agy's credential allowlist on analogy ("the Google auth stack's service-account file"), without evidence agy reads it — the ADC function is linked in the binary, but linked is not read | A live probe settled it (scratch/agy-adc-probe.txt): setting the variable to a missing file and then to a valid-shaped service-account file both leave the headless auth path at the identical OAuth browser wall, so the variable has no reader. Removed from the allowlist; the comment and the test fixture cite the probe (src/environment.ts) | tests/environment.test.ts: "agy's allowlist does not forward GOOGLE_APPLICATION_CREDENTIALS" |
| 5 | minor | The agy project-config refusal list was narrower than its own justification: the comment claimed discovery of "skills, rules, plugins, and subagents from `.agents/` manifests" while the list refused only the four manifests and `.agents/skills/` | The list now follows the binary's own strings, which name `.agents/hooks.json`, the `.agents/{rules,plugins,agents,workflows}/` directories, and a whole `.gemini/config/` tree (plugins, skills, hooks.json, mcp_config.json, workflows) beside the manifests; agy's own output directories (`.agents/teamwork/`, `.gemini/antigravity/`) stay unrefused, named as deliberate (src/project-safety.ts) | tests/new-adapters.test.ts: "rejects the Antigravity config roots the binary names beyond the manifests" |
| 6 | minor | The ledger header still read "Most recent single-harness audit: 2026-09-21 (Copilot)", understating the file's own 2026-10-04 Antigravity addendum | Header now reads 2026-10-04 (Antigravity, flag surface only) (docs/HARNESS-COMPATIBILITY.md) | Prose only; no test |

Verification that the tests catch the bugs rather than merely pass after
them: all four pre-fix sources (`cursor.ts`, `agy.ts`, `environment.ts`,
`project-safety.ts`) were swapped back in from the git index and the two
suites re-run — seven tests failed, exactly the ones the findings predict:

```
(fail) AgyAdapter > builds a headless command with the value flags in = form and the prompt last
(fail) AgyAdapter > builds interactive commands
(fail) AgyAdapter > rejects the Antigravity config roots the binary names beyond the manifests
(fail) CursorAdapter > prefers the standalone entries and keeps the desktop subcommand as the last resort
(fail) CursorAdapter > discovery never executes a repository-local cursor, whatever the trust check would say
(fail) CursorAdapter > diagnostics never execute the desktop wrapper's installer path
(fail) environment sanitization > agy's allowlist does not forward GOOGLE_APPLICATION_CREDENTIALS
  35 pass / 7 fail
```

The fixed sources were restored and the same files pass (42/0).

Ripples worth naming:

- The desktop-subcommand preference is gone, so the entry order is
  `agent` > `cursor-agent` > `cursor agent` everywhere (adapter, README
  table, ledger row and addendum, CHANGELOG). The addendum's title and
  Cursor section were rewritten; the round-0 design point about probe
  economics is superseded — `verify` now runs in ~0.14s on this machine
  (it paid 3.2–4.5s for the probe through the shim chain), and the 20s
  test timeouts that pacing bought are dropped (tests/cli.test.ts,
  tests/verify.test.ts).
- `CursorAdapter.displayName` lost its override (the base default —
  `binaryName` — is spawn-free now, and `BaseAdapter`'s doc no longer
  names a probing adapter); doctor prints the same `cursor (agent)` here.
- The installed-contract suite still resolves the cursor entry through
  the adapter (`agent` on this machine) and its version probes were
  exercised on all 11 binaries in the gate run below.
- The report's "Credential variables in the binary" section now records
  the round-2 allowlist change with the probe citation instead of the
  round-0 claim that the allowlist is "exactly those three names".

### Gate after round 2

| Check | Round 1 | Round 2 |
|---|---|---|
| Full suite (`make check`: typecheck, shell, tests) | 669 pass / 0 fail / 675 tests | **667 pass / 0 fail / 673 tests** (6 skip = installed-contract entries; the count moved because the seven probe-era cursor tests became three, plus one new agy and one new environment test) |
| `make contracts` | 1 pass / 1 fail (copilot EPERM) | 1 pass / 1 fail (same copilot EPERM, identical text; version probes exercised and non-null on all 11 binaries, cursor through the spawn-free standalone entry) |
| `make release-gate` overall | fails at `contracts` (copilot) | fails at `contracts` (copilot, identical error) |

The copilot failure is the pre-existing environmental EPERM documented in
the round-0 gate section (`copilot --help` cannot extract into
`~/Library/Caches/copilot` on this machine). Every other gate target
passes, run individually after the abort
(scratch/release-gate-round2-remaining.txt): `runtime`, `check`,
`sandbox-contract` ("scode sandbox contract passed"), `smoke`, `bun audit`
("No vulnerabilities found (checked 9 packages)"), `bun install
--frozen-lockfile --dry-run`, and all six `--help`/`verify` smoke
commands. Diagnostics were also run live (scratch/cli-diagnostics-round2.txt):
`list` shows cursor ✅, `doctor` prints `cursor (agent): ✅ installed`,
`verify` reports PASS 14 / WARN 2 / FAIL 0 with cursor at 0 warnings.

Prose check: `check_american.py` over every round-2 changed file —
"0 British spelling(s) found", exit 0.

## Review fixes, round 3

Round 3 ordered a redesign before any finding-fixes: three review rounds
agreed that the Cursor desktop wrapper (`cursor agent ...`) may download
or update the agent when invoked, so codemux must never run it on its own
initiative — not for discovery, not for the version probe, not for the
installed-contract test. The redesign landed first, then every remaining
finding was fixed against it. The delivered findings file carried five
distinct findings: its correctness section repeated one major verbatim,
its security section detailed the same root cause, and its contracts
section added one major and three minors.

**The redesign.** Default resolution is exactly 0.6.0's again: `agent`,
then `cursor-agent`; neither found means "not installed", and the
desktop `cursor` is not consulted at all. The desktop entry runs only
under an explicit opt-in: `CODEMUX_CURSOR_ENTRY=cursor` set in codemux's
environment AND the name passed through (`--pass-env
CODEMUX_CURSOR_ENTRY`), documented in README and the ledger with the
warning that the wrapper may install or update the agent on first use.
The passthrough is the authorization — argv the operator typed, which
neither a repository nor a shell profile can inject — and a launch that
selects the desktop entry without it is refused at validation, before
the version gate could execute anything (verified live: exit 1 with both
fixes named, scratch/cli-diagnostics-round3.txt). With the opt-in, the
trust check applies to the `cursor` binary resolved against the
requested working directory, and the version probe sends
`cursor agent --version` only after that check and only inside the
launch path — never in `isAvailable`, `list`, `doctor`, `verify`, or the
installed-contract suite. The round-2 "last resort" chain is gone; the
opt-in selects the desktop entry outright (standalone builds included),
and an opt-in naming a `cursor` that does not resolve falls back to the
default chain.

| # | Severity | Finding | Disposition | Regression test |
|---|---|---|---|---|
| 1 | major (correctness, listed twice verbatim) | The version gate's `versionArgsFor` sent `cursor agent --version` whenever the desktop entry resolved, and the gate executes before scode starts; the wrapper downloads and executes an installer when `~/.local/bin/cursor-agent` is absent, so a desktop-only machine's `codemux run -a cursor --sandbox --sandbox-no-net` could download and execute code outside the requested boundary | Closed by the redesign: the gate can no longer reach the desktop entry unless the operator opted in, and under the opt-in the probe is authorized (README/ledger warning) and ordered — trust check first, launch path only | tests/new-adapters.test.ts: "the desktop entry is ignored without the opt-in" (desktop-only without the opt-in is "not installed", so nothing can select or probe the wrapper) |
| 2 | major (security) | Same root cause: the trust check only confirms ownership and write modes; it says nothing about the wrapper fetching and executing a network script, so "post-trust-check" was not safety | Closed by the redesign for the unauthorized case (the gate never reaches the wrapper by default). Under the opt-in the wrapper's install/update behavior is exactly the documented risk the operator accepted; the trust check still bounds WHICH `cursor` runs, resolved against the run's `--cwd` | tests/harness-compatibility.test.ts: "the desktop entry's gate refuses an untrusted cursor before probing it" (repository-local `cursor` + opt-in + passthrough → refused, execution marker absent) and "the desktop entry's gate probes cursor agent --version only after the trust check" (trusted `cursor` → the probe runs and sends exactly `agent --version`) |
| 3 | major (contracts) | The installed-contract suite resolved the cursor entry through the adapter, so on a desktop-only machine `make contracts`/`make release-gate` ran `cursor agent --help`, `models`, and `--version` — the wrapper's installer path — contradicting the ledger's and adapter's own "nothing executes the desktop entry before a launch's own gate" | Fixed: default resolution never selects the desktop entry (desktop-only reports "not installed", and the suite skips absent binaries), and the suite now resolves the standalone entries directly (`standaloneCursorBinary()`: `agent`, else `cursor-agent`) so even an exported `CODEMUX_CURSOR_ENTRY` in the gate's environment cannot make it execute the wrapper | tests/new-adapters.test.ts: "the desktop entry is ignored without the opt-in"; the suite's own standalone-only resolution is the structural guard (tests/installed-contract.test.ts) |
| 4 | minor (contracts) | This report's diagnostics section still said "A launch probes and prefers `cursor agent`" — round-1 text left stale by the round-2 rewrite | Fixed in place; the section now states the desktop entry never resolves without the opt-in | Prose only; no test |
| 5 | minor (contracts) | This report's "What was built" understated the agy project-config refusals (four manifests, `.agents/skills/`, `.gemini/.env`) against the delivered list in `src/project-safety.ts` | Fixed in place: the full round-2 list (manifests, `.agents/hooks.json`, the five directories, `.gemini/config/`) | Prose only; the delivered list is already pinned by tests/new-adapters.test.ts "rejects the Antigravity config roots the binary names beyond the manifests" |
| 6 | minor (contracts) | This report's checklist said "agy credential allowlist (3 vars...)" after round 2 removed `GOOGLE_APPLICATION_CREDENTIALS` | Fixed in place: 2 vars with the removal cited | Prose only; pinned by tests/environment.test.ts |

The contracts auditor also asked that the report's evidence overstatement
("an adapter's literal argv" claim) be corrected. That was round-2
finding #3, and its fix is real: `scratch/run-adapter-argv.ts` exists,
calls `AgyAdapter.buildRunCommand` on the working tree, and executes the
returned array verbatim; `scratch/agy-adapter-argv-live-2.txt` matches
the report's quoted block token for token (re-checked this round). No
overstatement remained there; the surviving ones were findings #4–#6,
fixed above.

Verification that the tests catch the bugs rather than merely passing
after them (round-1's temporary-revert method; the adapter was restored
and re-run green after each):

- Reverting the entry resolution to round 2's `agent` > `cursor-agent` >
  `cursor` chain fails exactly the two redesign tests ("the desktop
  entry is ignored without the opt-in", "the desktop entry is used when
  the opt-in is set") — 37 pass / 2 fail.
- Deleting the two `assertDesktopEntryAuthorized` calls from the
  validators fails exactly "the desktop opt-in requires the --pass-env
  gesture" — 38 pass / 1 fail.
- The two gate tests are ordering pins for the redesign's security
  property (the only route to the wrapper runs the trust check first);
  the gate's mechanics were already correct in round 2, so they are
  guards against regression, not against a live round-2 bug — stated so
  rather than claimed otherwise.

Ripples worth naming:

- `codemux tui` now validates the request before the version gate, as
  `codemux run` always did (src/index.ts): an adapter that refuses the
  request — cursor's desktop entry without the passthrough among them —
  must do so before the gate can execute the binary it resolves. The
  unsandboxed TUI path validates twice (again inside `runInteractive`),
  which is idempotent.
- The installed-contract suite lost its `cursorPrefix` machinery: the
  cursor help and models probes send bare `--help`/`models` through the
  standalone entry, and the version-probe loop resolves cursor through
  `standaloneCursorBinary()` rather than the adapter's `binaryName`.
- `src/autonomy.ts`'s cursor note, README (prerequisites line, agents
  table, sandbox-integration paragraph), CHANGELOG's Changed bullet, and
  the ledger (header, Cursor row, 2026-10-04 addendum — retitled "and
  the desktop opt-in") all describe the opt-in with the install/update
  warning.
- Diagnostics were re-run live (scratch/cli-diagnostics-round3.txt):
  `list` shows cursor ✅ through the standalone entry, `doctor` prints
  `cursor (agent): ✅ installed`, `verify` reports PASS 14 / WARN 2 /
  FAIL 0, and the set-but-not-passed opt-in refuses with exit 1.

### Gate after round 3

| Check | Round 2 | Round 3 |
|---|---|---|
| Full suite (`make check`: typecheck, shell, tests) | 667 pass / 0 fail / 673 tests | **671 pass / 0 fail / 677 tests** (6 skip = installed-contract entries; the count moved because the round-2 cursor preference test became three opt-in tests, plus the two gate tests) |
| `make contracts` | 1 pass / 1 fail (copilot EPERM) | 1 pass / 1 fail (same copilot EPERM, identical text; version probes exercised and non-null on all 11 binaries, cursor through the standalone entry) |
| `make release-gate` overall | fails at `contracts` (copilot) | fails at `contracts` (copilot, identical error) |

The copilot failure is the pre-existing environmental EPERM documented in
the round-0 gate section. Every other gate target passes, run individually
after the abort (scratch/release-gate-round3-remaining.txt): `runtime`
("Bun 1.4.2 satisfies the package.json floor of 1.3.14"), `check`,
`sandbox-contract` ("scode sandbox contract passed"), `smoke`, `bun
audit` ("No vulnerabilities found (checked 9 packages)"), `bun install
--frozen-lockfile --dry-run`, and every `--help`/`verify` smoke command.

Prose check: `check_american.py` over every round-3 changed file —
"0 British spelling(s) found", exit 0.

## Review fixes, round 4

Findings from the round-4 review (ed18735d, FAIL minor — no major or
blocker defects): three minors, each fixed with the smallest correct
change, plus the 0.6.1 release prep.

| # | Severity | Finding | Fix | Regression test |
|---|---|---|---|---|
| 1 | minor | CHANGELOG, README, and the agy.ts capability comment showed `--output-format json` in the space form for Antigravity — the identical defect class round 1 fixed for `--mode`, survived by the `--output-format` mentions — while the adapter emits `--output-format=json` precisely because the space form exits 2 at the pinned 1.2.14, a fact the same CHANGELOG bullet states | Every Antigravity mention now shows the `=`-form: the three named spots plus the same class found beyond them (the two agy doc comments in src/result-envelope.ts, the installed-contract agy comment, and two spots in this report's own prose — the "Envelope" design point and the checklist row). The verbatim space-form probe capture above stays as quoted evidence, and the claude/zai mentions stay: claude.ts and zai.ts really do emit `--output-format json` as two argv tokens | Prose only; tests/new-adapters.test.ts "--result-json asks for the JSON envelope" already pins the emitted `--output-format=json` token |
| 2 | minor | The ledger row said the binary "self-updated to 1.2.16 after" the audit while the addendum it cites says "mid-audit" — the update landed during round 0, before the adapter-argv capture, which ran at 1.2.16 — so the row told a reader every audit probe ran against 1.2.14 | The row now reads "self-updated to 1.2.16 mid-audit", matching the addendum and this report | Prose only; no test |
| 3 | minor | tests/new-adapters.test.ts built the "desktop entry is ignored without the opt-in" adapter without the `env` argument, so it read the real process.env: with `CODEMUX_CURSOR_ENTRY=cursor` exported — the exact environment tests/installed-contract.test.ts hardens against — `desktopOptIn` turned true, the desktop entry resolved, `isAvailable()` returned true, and the test failed while asserting "without the opt-in" | Every CursorAdapter construction in the file that defaulted to process.env now passes an explicit empty environment (five sites: the describe-level `adapter`, `fallback`, `desktopOnly`, `none`, and `standalone`); a comment at the describe level names the rule | tests/new-adapters.test.ts: "an exported CODEMUX_CURSOR_ENTRY cannot flip the opt-out tests" — sets the variable in process.env (saving and restoring it), then asserts the explicit-`{}` construction still reports the desktop entry ignored |

The finding-3 pattern was audited across every other adapter test, as
ordered: all sixteen zai constructions pass explicit env
(tests/zai.test.ts), every codex construction but one does
(tests/adapters.test.ts), and the one bare `new CodexAdapter()` serves
only env-free methods (`id`, `capabilities`, `buildRunCommand`,
`processRunResult` — `CODEX_HOME`, `HOME`, and `CODEX_API_KEY` are read
only in the prepareRun/hermetic paths), so no exported variable can
change its tests' outcomes. ClaudeAdapter takes no environment at
construction. The registry-based cli/verify tests assert only the
entry-agnostic `cursor` name, and the installed-contract suite resolves
the standalone entries directly (round 3), so an exported opt-in cannot
reach the wrapper through any of them.

Verification that the test catches the bug rather than merely passing
after it (round 1's temporary-revert method): dropping the explicit
`{}` from the regression test's construction — the exact pre-fix
pattern — fails it, `0 pass / 1 fail`; restored, the file passes
40/0.

Release prep (docs/RELEASING.md steps 4–6) landed in the same round:
`package.json` 0.6.1, the `[Unreleased]` entries moved into
`## [0.6.1] - 2026-10-04` (the Antigravity adapter under Added, the
opt-in `cursor agent` entry under Changed — nothing else sat under
Unreleased), an empty `[Unreleased]` kept at the top per the 0.6.0
release convention, README banner v0.6.1, and the gate plus smoke
re-run below (`./bin/codemux --version` prints 0.6.1).

### Gate after round 4

| Check | Round 3 | Round 4 |
|---|---|---|
| Full suite (`make check`: typecheck, shell, tests) | 671 pass / 0 fail / 677 tests | **672 pass / 0 fail / 678 tests** (+1, the regression test; 6 skip = installed-contract entries) |
| `make contracts` | 1 pass / 1 fail (copilot EPERM) | 1 pass / 1 fail (same copilot EPERM, identical text; version probes exercised and non-null on all 11 binaries, cursor through the standalone entry) |
| `make release-gate` overall | fails at `contracts` (copilot) | fails at `contracts` (copilot, identical error) |

The copilot failure is the pre-existing environmental EPERM documented in
the round-0 gate section. Every other gate target passes, run individually
after the abort (scratch/release-gate-round4-remaining.txt): `runtime`
("Bun 1.4.2 satisfies the package.json floor of 1.3.14"), `check`,
`sandbox-contract` ("scode sandbox contract passed"), `smoke`
(`./bin/codemux --version` prints 0.6.1), `bun audit` ("No
vulnerabilities found (checked 9 packages)"), and `bun install
--frozen-lockfile --dry-run`.

Prose check: `check_american.py` over every round-4 changed file (9) —
"0 British spelling(s) found", exit 0.

## Review fixes, round 5

Findings from the round-5 review (c9dbde20, FAIL — one security finding
the auditor reported as minor and the verifier escalated to major, plus
two contracts minors): all three fixed, each with a regression test
where code changed.

| # | Severity | Finding | Fix | Regression test |
|---|---|---|---|---|
| 1 | minor, escalated to major (security) | `codemux verify` built its commands through the launch-path adapter, so with `CODEMUX_CURSOR_ENTRY=cursor` exported and `cursor` on PATH the variable selected the desktop entry, the empty passthrough could not authorize it, and the wiring check recorded the refusal as "run command generation failed: CODEMUX_CURSOR_ENTRY=cursor selects Cursor's desktop entry…" — `verify` reported cursor FAIL (reproduced live before the fix: run/build `no`/`no`) while a real launch with `--pass-env CODEMUX_CURSOR_ENTRY` works. Authorization is a property of a launch's argv, not of static wiring | `verify` constructs every adapter it consults against an explicitly empty environment view (`STATIC_WIRING_ENV` in src/verify.ts, passed at all four `getAdapter` sites: run builds, tui builds, wiring status, scode previews), so the desktop entry is not even selected there — an exported variable cannot change a static wiring result, the installed column included. The registry (`src/adapters/index.ts`) became a factory map and `getAdapter(id, env = process.env)` now constructs per call instead of handing out module-load singletons: the view is the only thing verify overrides, and the launch path is unchanged (process.env, read at the call instead of at import — same process, same values). The refusal itself is untouched: a launch that selects the desktop entry without the passthrough still fails with both fixes named | tests/verify.test.ts: "an exported CODEMUX_CURSOR_ENTRY never fails the static wiring check" — sets the variable in process.env (saving and restoring it), pins the premise by asserting a process.env-viewed adapter refuses launch validation wherever `cursor` resolves (so the test bites rather than passing vacuously on machines without the desktop binary), then asserts `verifyAgentWiring("cursor")` reports both builds ok, no FAIL, no issues |
| 2 | minor (contracts) | The README options table's `--result-json` row still read "Claude, Z.AI and Codex; other harnesses refuse the flag" while this diff ships agy with `supportsResultJson: true` and the README's own "Result envelopes" section lists Antigravity — the row contradicted both the code and the document it sits in | The row now lists Antigravity and says the Claude-family and Antigravity envelopes are the harness's own with one added `codemux` block | Prose only; tests/new-adapters.test.ts "--result-json asks for the JSON envelope" already pins the accepted flag and the emitted `--output-format=json` |
| 3 | minor (contracts) | The agy envelope parser set `total_tokens` from the reported field even when the normalized components were unreported, against the documented cross-harness rule (`types.ts`: the total "is their sum plus output"; README: "computed only when every component was reported") that the claude and codex parsers implement — a usage block naming `total_tokens` without the component counts would publish a total whose own addends are null. No documented agy example triggers it (every example carries the full block), so a divergence, not a live bug | `total_tokens` is now computed as the sum of the three normalized components, only when all are known (src/result-envelope.ts, mirroring the claude and codex parsers). The sum reproduces agy's own total whenever every component was reported — the cache reads the uncached input subtracted are added back — so every documented example parses to the same numbers; a reported total over missing components is null, never echoed. The parser's usage-arithmetic doc comment states the rule | tests/result-envelope.test.ts: "a reported total without its components is null, never echoed" — a SUCCESS envelope whose usage is `{output_tokens: 5, total_tokens: 5}` parses to `total_tokens: null` with the components it did report kept |

Docs updated alongside: the CHANGELOG's 0.6.1 cursor entry states that
`codemux verify` builds against an empty environment view and the agy
entry that `total_tokens` is computed, never echoed; the
HARNESS-COMPATIBILITY ledger's desktop-entry passage and the README's
both name the empty view. The cursor adapter's
`assertDesktopEntryAuthorized` doc comment says static diagnostics never
see the refusal.

Why the registry stopped caching, and why that matters for the test:
bun runs every test file in one process (verified — same pid across
files), so a module-load singleton snapshot would have made the exported
variable invisible to a test that sets it mid-suite; the regression test
would have passed against the unfixed code without the snapshot ever
seeing the variable. Per-call construction makes the environment view
the only difference between verify's adapter and a launch's, which is
exactly what the test exports.

Verification that each test catches its bug rather than merely passing
after it (round 1's temporary-revert method): pointing verify's four
constructions back at the default environment — the exact pre-fix
behavior — fails the wiring test (`8 pass / 1 fail`); restored, the file
passes 9/0. Re-echoing the reported total fails the envelope test
(`83 pass / 1 fail`); restored, 84/0. Live after the fix:
`CODEMUX_CURSOR_ENTRY=cursor ./bin/codemux verify` reports cursor
`PASS` and `Summary: PASS 14, WARN 2, FAIL 0`, exit 0.

### Gate after round 5

| Check | Round 4 | Round 5 |
|---|---|---|
| Full suite (`make check`: typecheck, shell, tests) | 672 pass / 0 fail / 678 tests | **674 pass / 0 fail / 680 tests** (+2, the regression tests; 6 skip = installed-contract entries) |
| `make contracts` | 1 pass / 1 fail (copilot EPERM) | 1 pass / 1 fail (same copilot EPERM, identical text; version probes exercised and non-null on all 11 binaries) |
| `make release-gate` overall | fails at `contracts` (copilot) | fails at `contracts` (copilot, identical error) |

Count provenance: one intermediate suite run printed 682 tests across 31
files — two throwaway probe files used to establish the single-process
fact above had landed under `scratch/`, and `bun test` scans the whole
project; removed, the suite is the 680 across 29 files the table reports.

The copilot failure is the pre-existing environmental EPERM documented in
the round-0 gate section (`mkdir ~/Library/Caches/copilot/pkg/darwin-arm64`).
Every other gate target passes, run individually after the abort:
`runtime` ("Bun 1.4.2 satisfies the package.json floor of 1.3.14"),
`typecheck`, `shell`, `sandbox-contract` ("scode sandbox contract
passed"), `smoke`, `bun audit` ("No vulnerabilities found (checked 9
packages)"), `bun install --frozen-lockfile --dry-run` (exit 0), and the
release-gate CLI probes including
`verify --show-scode --sandbox-trust trusted --sandbox-no-net` (exit 0;
`./bin/codemux --version` prints 0.6.1).

Prose check: `check_american.py` over every round-5 changed file (10) —
"0 British spelling(s) found", exit 0.

No live model calls: the contracts probes are `--help`/`--version` only
and every verify check is static, as before.

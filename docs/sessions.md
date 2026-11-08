---
read_when: Starting, controlling, or resuming a live agent session.
---

# Sessions

`codemux session` is the persistent, bidirectional interface.
Send JSONL on stdin and read JSONL events on stdout. Diagnostics use stderr.
Use [the protocol reference](session-protocol.md) when writing a client.
For one prompt and one captured result, use `codemux run` instead.

## Supported agents

These are session-specific minimum versions. A version floor admits a
binary; it does not promise every optional capability or a working login.

| Agent ID | Minimum version | Mid-turn user input | Steer | Interrupt / turn timeout | Permissions | Deltas | File changes | Usage stream |
|---|---|---|---|---|---|---|---|---|
| `claude` | 2.1.280 | rejected | no | yes | yes | yes | derived | no |
| `zai` | 2.1.280 | rejected | no | yes | yes | yes | derived | no |
| `codex` | 0.159.3 | queued | yes | yes | yes | yes | native | yes |
| `agy` | 1.2.14 | rejected | no | no | no | no | no | no |
| `opencode` | 1.18.18 | rejected | no | no | no | no | no | no |
| `aider` | 0.86.2 | rejected | no | no | no | no | no | no |
| `kimi` | 0.31.1 | rejected | no | no | no | no | no | no |

All seven report `live_input: true` and `resume: true`. Read the capabilities
on `session_started`; unsupported operations receive `input_rejected`.
ZAI uses the Claude binary. The other installed agents have no session driver:

- `cline`: the CLI wraps a VS Code extension; it prints one-shot output and has no bidirectional control wire upstream.
- `copilot`: one-shot CLI; no bidirectional control wire upstream.
- `cursor`: the standalone `cursor-agent` entry is one-shot, and the desktop agent has no external control wire; not built.
- `droid`: one-shot headless entry plus a human TUI; no bidirectional control wire upstream.
- `gemini`: one-shot `-p` entry plus a human TUI; no bidirectional control wire upstream.
- `goose`: upstream keeps a session ledger a driver could resume, but the run path exposes no bidirectional control wire; not built.
- `openhands`: the local service owns the event loop and the adapter drives only `--headless` one-shot runs; not built.
- `pi`: one-shot headless entry plus a human REPL; no bidirectional control wire upstream.
- `qwen`: one-shot headless entry plus a human TUI (a gemini-cli fork); no bidirectional control wire upstream.

See [harness compatibility](harnesses.md) for harness-specific limits.

## Start, finish a turn, and shut down

Prerequisites: Bun, codemux, scode, and a logged-in supported harness on PATH.
Run from a project directory, not your home directory or `/`: the registry
must be outside both the working directory and the harness state directory.
The example below makes a real model request when you run it.

This shell function sends one prompt, keeps stdin open until the turn
finishes, then requests shutdown. It also denies any permission request.
Waiting for `turn_completed` avoids using the shutdown grace period as a
deadline for the model's answer.

```sh
session_once() {
  bun -e '
    import { createInterface } from "node:readline";
    const args = ["codemux", "session", "-a", "claude", "--auto", "read-only", "--timeout", "120"];
    if (process.env.SESSION_ID) args.push("--resume", process.env.SESSION_ID);
    const child = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    const send = (message) => { child.stdin.write(JSON.stringify(message) + "\n"); child.stdin.flush(); };
    const { Readable } = await import("node:stream");
    const lines = createInterface({ input: Readable.fromWeb(child.stdout) });
    let ended = false;
    send({ type: "user", text: "Reply with one short greeting. Do not use tools.", author: "example" });
    for await (const line of lines) {
      console.log(line);
      const event = JSON.parse(line);
      if (event.type === "permission_request") send({ type: "permission_decision", request_id: event.request_id, decision: "deny" });
      if (event.type === "turn_completed") send({ type: "shutdown" });
      if (event.type === "session_ended") { ended = true; child.stdin.end(); }
    }
    const code = await child.exited;
    process.exit(code || (ended ? 0 : 1));
  '
}

unset SESSION_ID
set -o pipefail
session_once | tee session-events.jsonl
```

A clean end has `session_ended.exit_code: 0`. Its `harness_exit` preserves
the observed child exit. Keep reading through `session_ended`, then collect
the OS exit code; a failed final stdout flush can make the OS exit nonzero.
Do not treat `shutdown_requested: true` as evidence of success.

## Resume

Extract a usable ID only after the first command has ended successfully:

```sh
export SESSION_ID="$(bun -e '
  const rows = (await Bun.file("session-events.jsonl").text()).trim().split("\n").map(JSON.parse);
  const end = rows.findLast((row) => row.type === "session_ended");
  if (!end || end.exit_code !== 0 || !end.resumable || !end.session_id) process.exit(1);
  console.log(end.session_id);
')"
test -n "$SESSION_ID" && session_once
```

The function passes `--resume "$SESSION_ID"` on the second invocation.
Keep the same agent, working directory, harness home, provider, and
containment flags. `resumable` is a hint: the trusted registry entry and
usable harness state must still exist. A copied ID alone is insufficient.

Registry locations:

- macOS: `~/Library/Application Support/codemux/live-sessions.json`.
- Other platforms: `~/.local/state/codemux/live-sessions.json`.

The registry is user-owned, mode 0600, outside the session's writable roots.
Its parent must be user-owned and not group- or other-writable. Neither leaf
may be a symlink. System symlink ancestors are resolved. It contains at most
1000 entries and 4 MiB. Resume claims ownership before spawning; an entry
with a live owner cannot be resumed concurrently.

Resume checks the agent, canonical working directory, resolved harness home,
provider identity, hermetic provenance, project-settings mode, autonomy,
sandbox trust, network and environment containment, blocked paths, passed
environment names, and Playwright access. It cannot add a passed name, enable
Playwright, remove existing containment, drop a recorded `--sandbox-block`
path, or increase reach. Provider
identity excludes URL query and fragment. Changing the model is not itself
a resume refusal.

For Claude, ZAI, and Codex, the reach order is
`read-only < medium < high < low`: a low session's caller can approve more
than a high session's fixed grants. Other agents use
`read-only < low < medium < high`. Thus a Claude session created at high
cannot resume at low. Trust can tighten from trusted to standard, but cannot
loosen from standard to trusted.

The registry prevents accidental replay under different settings. It is not
an authorization boundary against other processes running as the same user.
Launch flags always come from the current command, never from registry data.

## Options

Common selection flags are `-a/--agent`, `-m/--model`, `--effort`, `--auto`,
`--cwd`, `--pass-env`, and the sandbox options. Autonomy defaults to
`read-only`; sandboxing defaults on and requires scode. Disabling it with
`--no-sandbox` requires `--auto high`. Sandboxed sessions accept
`--sandbox-trust trusted` or `standard`; `untrusted` is refused because it
denies persistent harness state. Sandbox policy flags without sandboxing
are warned about and ignored.

| Flag | Default | Behavior |
|---|---|---|
| `--resume <id>` | fresh session | Resume a registry-backed harness session |
| `--timeout <seconds>` | none | Whole-session deadline; expiry ends with a nonzero exit |
| `--turn-timeout <seconds>` | none | Claude/ZAI/Codex only; first expiry interrupts, second expiry on that same turn ends the session |
| `--permission-timeout <seconds>` | 300 | Deny an unanswered permission request |
| `--shutdown-grace <seconds>` | 10 | Grace before SIGTERM, then another grace before SIGKILL |
| `--no-author-prefix` | prefix enabled | Preserve attribution events without prepending `[author] ` to harness text |
| `--permission-policy <policy>` | `default` | `deny` answers every permission request with an immediate deny (Claude/ZAI); see [permissions](#permissions-and-attribution). Per invocation: the registry record does not carry it, so a `--resume` that wants the deny policy passes the flag again |
| `--experiment-project-settings` | Off; requires `--hermetic` | The one hermetic session mode (Claude/ZAI); see [below](#hermetic-project-settings-sessions) |
| `--final` | Off; requires the project-settings mode | Remove the session's private config directory when this session ends |
| `--sandbox-block <path>` | none | Repeatable; pass an extra scode `--block` for this session's children (absolute paths only), an operator-side extra on top of the project-settings blocks. Canonicalized once at flag parse (symlinks dereferenced, then deduplicated and sorted), and that same spelling is recorded and enforced by every child; a resume must carry every recorded block path and may add more |
| `--print-sandbox` | Off; requires `--sandbox` | Print the scode argv the long-lived child would exec, one argument per line with control characters escaped (a newline inside an argument prints as `\n`), and exit 0 without starting a session (refused for the turn-per-process agents); the credential sandbox preparation is skipped and the credential copy deferred — the command is print only; a fresh session's private directory is removed on the way out |
| `--quota-ceiling <percent>` | config `quota.minRemainingPercent`, initially 10 | Refuse the session when a bounding usage window is below this percent remaining; overrides the config ceiling for this one session |
| `--no-quota-gate` | gate on | Skip the pre-launch usagemux quota check for this session |

Every timeout accepts finite positive seconds up to **86400**, including
fractions, and rounds upward to whole milliseconds. Zero disables nothing:
omit an optional timeout to have no cap. A turn timeout that successfully
interrupts leaves the session available for another turn.

The first command of a session and every resume pass the
[quota gate](results-and-usage.md#quota-gate) — after every request check and
resume guard, before anything spawns, records a fresh session, or creates a
home — so a refused session (exit 64) spends nothing. A refused fresh session
records nothing; a refused resume has already written its ownership claim to
the registry (the claim precedes the gate), and the refusal releases it, so
the record stays resumable for the next attempt.

A plain `--hermetic`, every `--tools` value, and `--max-budget-usd` (the
spend limit applies to headless runs; use run) are refused for sessions;
the one hermetic mode is `--hermetic --experiment-project-settings`
(below). `--effort none` sends no effort field on every session harness, codex included.
`--enable-playwright-mcp` is supported only for Claude/ZAI and requires
`--sandbox` and `--auto low`.

## Hermetic project-settings sessions

`--hermetic --experiment-project-settings` on Claude or ZAI gives a
persistent session the same isolation `run` gives the flag (see
[isolation](isolation.md)): a private Claude config directory,
`--setting-sources project,local`, `--disable-slash-commands`, and no
`--safe-mode`, so the repository's own permission rules, hooks, and
project memory apply while the operator's user memory, settings, skills,
plugins, and hooks stay out. It requires scode and `--auto low` or
`--auto high`. The session high is codemux's own — `--permission-mode
default` plus the Edit/Write/NotebookEdit/Bash grants, never
`--dangerously-skip-permissions` — so the repository's deny rules still
bind; a run keeps the low-only rule because its high is the bypass flag.
The run path's refusals apply unchanged: no `--pass-env CLAUDE_CONFIG_DIR`
or `CLAUDE_CODE_PROJECT_DIR_NAME`, and no ancestor of the working
directory may carry `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`,
or `.claude/rules` (a home normally carries `~/.claude/CLAUDE.md`, so
place the working tree outside the home).

The private directory is created at the first command under
`~/.claude/.codemux-hermetic/session-<session id>/` and holds the
session's own transcript and trust record, so every `--resume` of that
session reuses it. The operator's harness state is unreachable from the
session's children: every spawn (the long-lived child and each turn's)
runs under scode with the real config root and the `~/.claude.json`
beside it blocked and only this session's own directory re-allowed, so
the operator's transcripts, history, and every other run's and session's
`.codemux-hermetic` directory are out of reach, read and write (see
[isolation](isolation.md)). A resume whose directory is missing — removed
by `--final` or the stale sweep — is refused as policy (exit 78), never
silently remade: the transcript it exists to continue would be gone.
Three lifetimes:

- Without `--final`, the directory persists after the session ends, for
  the next `--resume`.
- `--final` on a session command removes the directory when that session
  ends, any copied access token with it, and that command's `session_ended`
  reports `resumable: false` — but only once the removal succeeded. The
  end path tries the removal twice (one attempt, a pause, one retry); if
  both fail, the directory is kept, two stderr lines name the kept path
  and the reason (one per attempt), the command exits 1, and the record
  stays ended and
  resumable with no final stamp — so a later `--resume --final` or the
  stale sweep can retry.
- The stale sweep removes a directory that has been quiet for two days
  and whose registry entry is gone, the same dead-owner rule as hermetic
  run directories.

The mode is containment provenance: a resume must carry the same flags,
and a session cannot gain or lose the mode on resume. A project's
PreToolUse and PostToolUse hooks fire for every tool call on every turn
under this mode — Claude Code runs hooks per call, not per turn — which
is the observable the mode exists to provide. A Claude session without a
provider override carries an access-token-only copy of the credential
mirror inside the directory; ZAI and override sessions carry no operator
login ([authentication](authentication.md)).

Provider overrides via `CODEMUX_<AGENT>_PROVIDER_*` are supported on session
spawns for Claude, Codex, OpenCode, Aider, and Kimi. ZAI and Agy refuse
overrides. The adapter validates them as on `run`; the selected provider
must match on resume. See [CLI reference](cli.md).

Claude/ZAI account redirects use `CLAUDE_CONFIG_DIR`, Codex uses `CODEX_HOME`,
and Kimi uses `KIMI_CODE_HOME`, only when included in `--pass-env`. Values
must be absolute; Claude/Codex reject whitespace padding, and Kimi rejects
an empty value. OpenCode uses its resolved XDG data directory. Aider keeps
history in `~/.aider`; Agy uses `~/.gemini/antigravity-cli`.

## Permissions and attribution

An accepted `user` or `steer` produces `user_message` with the original text
and optional author. This event is the attribution record. The default
`[author] ` prefix is only a display aid and is not an identity check.

For a `permission_request`, answer using its `request_id` and one of its
`options`. Decisions apply to that request only. Codemux denies requests
on timeout, interrupt, completion, or shutdown. A late answer receives
`unknown_request`. A caller's `allow` cannot exceed the launch autonomy:
the harness receives a deny and the input receives `autonomy_escalation`.

On Claude/ZAI a deny may carry a `message` (1–2000 UTF-16 code units, no
NUL, no control characters other than newline), which the harness shows
the model as the rejection text; Codex rejects the field as `unsupported`.
Without one, every deny codemux sends — yours, the permission policy, the
autonomy ceiling, the timeouts, supersession, shutdown — uses the text
Claude Code itself gives the model on a user rejection (it begins "The
user doesn't want to proceed with this tool use."), so the agent reads the
denial as its own harness's answer rather than an outside wrapper's. The
`permission_denied` and `permission_resolved` events and the
`autonomy_escalation` rejection record the text that was sent.

`--permission-policy deny` (Claude/ZAI) answers every request with an
immediate deny instead of forwarding it to you: the request is still
emitted, then a `permission_denied` event records it, and no
`permission_resolved` follows — a decision for it receives
`unknown_request`. This is the shortest safe setting for a session with
no human on the input; without it, the permission timeout (default 300
seconds) and the turn timeout remain the fallbacks.

On Claude/ZAI, read-only approves no tool; medium permits scoped editing
outside executable configuration; high grants editing and Bash; low lets
the caller decide. Edit, Write, NotebookEdit, and Bash arguments must fit
their known schemas even at low. Other tools have no such schema check at
low. Operator allow rules may bypass this permission channel; scode supplies
the enforced containment boundary. Codex's ceiling allows requests at low,
scoped file changes at medium, and commands/file changes at high; it denies
read-only requests. Its sandboxed launch uses `approvalPolicy: "never"`,
so the capability does not promise approval requests will occur. Codex
rejects substituted `updated_input`, which its wire cannot carry.

## End conditions and failures

`shutdown` or stdin EOF begins orderly draining. A signal, absolute timeout,
or fatal failure also ends the session. Pending turns receive a completion
when possible, and `session_ended` is the final event. Turn-per-process
agents drain a child still being spawned on orderly shutdown; a hard end
stops it when it arrives. That wait is bounded by the stop grace for every
end (review round 110): a spawn that outlasts it fails the session, and
that spawn refuses to create its process when it resumes, so no child
starts after the CLI's run cleanup. Grace expiry can kill the child and therefore
make an otherwise requested shutdown fail.

A second SIGINT/SIGTERM/SIGHUP while the first signal's end still runs
SIGKILLs the whole child tree at once, for every agent: the first signal
starts the graceful end, a later one skips the grace. A child that did not
exist yet — a turn's spawn still in flight — is killed the moment it lands.
A second signal with no child alive only latches and changes nothing.

The descendant capture samples the process tree every five seconds while a
session runs, so the end path's SIGKILL reaches processes whose parent exited
long before. The sampling continues through a stop's grace period, and one
extra asynchronous sample follows the stop signal itself, so a cleanup helper
the harness starts while handling SIGTERM is remembered before the harness
exits. A descendant that forks and exits between two samples, or before
the first one, or a harness that starts its helper and exits at once after
the stop signal, leaves a process the reaper owns and no walk can attribute;
that is a known limit, and closing it needs kernel help the sandbox boundary
does not provide.

On Windows codemux has no process table reader and no process groups, so a
tree-scoped termination reaches the immediate child only; descendants the
harness created survive it. This is a known limit of the Windows build, and
the paths that spawn process trees of their own (the experiments) are
refused there.

| Exit | Meaning |
|---|---|
| 0 | Clean session end |
| 1 | Runtime/protocol/I/O failure or timeout; registry unavailable; unsupported installed harness version; Commander syntax error such as an unknown flag or missing value |
| 64 | Explicit session usage/validation refusal, including unsupported agents, flags, timeout values, or containment settings |
| 66 | No recorded entry for the requested resume ID |
| 78 | Resume policy/trust refusal, including a corrupt or untrusted registry or a live owner |
| 143 | Codemux's signal-stop convention |

The exit status is the `exit_code` that `session_ended` reported. A signal
that stops a session is reported in that event and exits 143. A signal that
arrives after the event was written, while it is still being flushed, stops
nothing: the session had already ended, so the status stays what the event
said, 0 after a clean end. Only a failed delivery of the event changes the
status, to at least 1. Every agent follows this rule.

Kimi, OpenCode, and agy learn a fresh session's id from the first turn's
output and record it beside the stream: the session never waits on the
registry lock mid-turn. A session that ends with that record still unwritten
— the lock stayed busy until the end — ends as a crash: the fatal error
`cannot record the session in the registry` is the verdict, the exit is
nonzero (1, or the signal's 143 when a signal ended it), the registry holds
no entry, and the session is not resumable. A resumed session is tracked by
the record the CLI claimed before the spawn, so the verdict applies to fresh
sessions only. The same holds when the lock stays busy past the whole retry
budget while a resumed session is live: the exhausted record is a lost
refresh of a record that exists, so the session prints one stderr line
naming the spent budget and the claim that stays the record, announces
`session_started`, and keeps running.

Child failures can preserve another nonzero code. Any observed nonzero child
exit or signal changes the final reason to `harness_failed`, including after
a requested shutdown. A caller must inspect both exit status and events.
Malformed caller JSON receives a rejection and does not itself end a session.

Aider's stdout is a human transcript: non-JSON lines become `unknown`.
Its assistant message is extracted from persistent history. History is
checked before each turn, reads are bounded per turn, and the accumulated
file has no codemux size cap. A killed partial turn is not resumable because
restoring history could replay its unanswered prompt; a turn that failed the
same way — its prompt recorded, no reply, whatever the exit code was — ends
the session, since the next turn would replay it. The test is what aider
itself restores: a reply that is only a reasoning block counts as a reply,
and a reply made only of `> `, `# `, or `#### ` lines does not, because
aider writes its tool output and the user's text in those shapes and
restores none of them as assistant text. Aider refuses harness text
beginning with `/` or `!`;
Kimi refuses `/goal` followed by whitespace or end, and `!`; OpenCode
refuses a message that is empty after trimming, which its wire exits 1 on.
These checks apply after the author prefix. An OpenCode `error` event, and
a Kimi roleless `{type:"error",message}` frame, fail their turn even when
the turn's process exits 0 — the failed turn's reason is the error message
— while the session itself continues with the next turn.

Usage is described in [results and usage](results-and-usage.md). Token
totals belong to this driver instance, including after resume. Claude/ZAI
cost instead adopts the harness's latest lifetime figure; do not sum it
across resumes.

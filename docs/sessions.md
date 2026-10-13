---
read_when: Starting, controlling, or resuming a live agent session.
---

# Sessions

`codemux session` is the persistent, bidirectional interface in v0.13.3.
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
ZAI uses the Claude binary. The other installed agents have no session driver.
See [harness compatibility](HARNESS-COMPATIBILITY.md) for harness-specific limits.

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
provider identity, hermetic provenance, autonomy, sandbox trust, network and
environment containment, passed environment names, and Playwright access.
It cannot add a passed name, enable Playwright, remove existing containment,
or increase reach. Provider identity excludes URL query and fragment.
Changing the model is not itself a resume refusal.

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

Every timeout accepts finite positive seconds up to **86400**, including
fractions, and rounds upward to whole milliseconds. Zero disables nothing:
omit an optional timeout to have no cap. A turn timeout that successfully
interrupts leaves the session available for another turn.

`--hermetic` and every `--tools` value are refused for sessions. Codex
sessions also refuse `--effort none`. `--enable-playwright-mcp` is supported
only for Claude/ZAI and requires `--sandbox` and `--auto low`.

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
stops it when it arrives. Grace expiry can kill the child and therefore
make an otherwise requested shutdown fail.

| Exit | Meaning |
|---|---|
| 0 | Clean session end |
| 1 | Runtime/protocol/I/O failure or timeout; registry unavailable; unsupported installed harness version; Commander syntax error such as an unknown flag or missing value |
| 64 | Explicit session usage/validation refusal, including unsupported agents, flags, timeout values, or containment settings |
| 66 | No recorded entry for the requested resume ID |
| 78 | Resume policy/trust refusal, including a corrupt or untrusted registry or a live owner |
| 143 | Codemux's signal-stop convention |

Child failures can preserve another nonzero code. Any observed nonzero child
exit or signal changes the final reason to `harness_failed`, including after
a requested shutdown. A caller must inspect both exit status and events.
Malformed caller JSON receives a rejection and does not itself end a session.

Aider's stdout is a human transcript: non-JSON lines become `unknown`.
Its assistant message is extracted from persistent history. History is
checked before each turn, reads are bounded per turn, and the accumulated
file has no codemux size cap. A killed partial turn is not resumable because
restoring history could replay its unanswered prompt. Aider refuses harness
text beginning with `/` or `!`; Kimi refuses `/goal` followed by whitespace
or end, and `!`. These checks apply after the author prefix.

Usage is described in [results and usage](results-and-usage.md). Token
totals belong to this driver instance, including after resume. Claude/ZAI
cost instead adopts the harness's latest lifetime figure; do not sum it
across resumes.

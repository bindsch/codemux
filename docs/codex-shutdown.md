---
read_when: Diagnosing Codex app-server shutdown or changing its session lifecycle.
---

# Codex 0.167.1 shutdown evidence

On 2026-11-14, Codex 0.167.1 completed session turns but exited 1 about
45 seconds after codemux closed its stdin. The model answer was successful;
the process shutdown was not. Codemux correctly retained that raw failure.

## Protocol and cause

The app-server client notification is `initialized`, not MCP's
`notifications/initialized`. Codemux's old fixture recorded the latter.
Both the [0.166.0 protocol](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/common.rs)
and [0.167.1 protocol](https://github.com/openai/codex/blob/rust-v0.167.1/codex-rs/app-server-protocol/src/protocol/common.rs)
define `ClientNotification::Initialized` with camel-case serialization.
Neither defines an app-server `shutdown` request or `exit` notification.
The socket notification handler currently only logs client notifications,
so correcting the spelling alone did not fix shutdown.

`thread/unsubscribe` is a request with `{threadId}` parameters. Its response
has status `unsubscribed`, `notSubscribed`, or `notLoaded`. It removes the
connection's subscription; it does not archive or delete the thread.
`thread/closed` is a server notification, not a client close request.
See the [thread processor](https://github.com/openai/codex/blob/rust-v0.167.1/codex-rs/app-server/src/request_processors/thread_processor.rs).

The installed binary was
`/opt/homebrew/Caskroom/codex/0.167.1/bin/codex`, SHA-256
`ebabe5f0d79145a9e61274ce9ecf7c02c9021b7b04bfa59b7e61ad4461c32b0b`.
Its strings include `thread/unsubscribe`, `thread/closed`,
`stdin reader finished (EOF)`, `app-server-shutdown`, and a SIGTERM message
that names a 45-second shutdown deadline. The
[stdio implementation](https://github.com/openai/codex/blob/rust-v0.167.1/codex-rs/app-server-transport/src/transport/stdio.rs)
arms a watchdog on EOF or SIGTERM. That thread sleeps 45 seconds, then calls
`std::process::exit(1)` without logging. The
[0.166.0 source](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-transport/src/transport/stdio.rs)
already contains this watchdog; it is not evidence that 0.167 introduced it.

The reproduced EOF-only failure occurred 45.10 seconds after the shutdown
acknowledgment. Its native SQLite logs show EOF, the stdout writer exiting,
the agent loop exiting, and the processor exiting with
`stdio_connection_closed` in the first second. The remaining stall is after
those steps. We have not identified the exact blocked Rust future or runtime
task. The watchdog and timing explain the silent exit 1; they do not prove
that every EOF shutdown fails.

## Codemux behavior

For a probed Codex version at least 0.167.0, codemux sends
`thread/unsubscribe` once the thread is idle and the session has no failure.
It waits for the correlated response, bounded by `--shutdown-grace`, before
closing stdin. An active turn gets its existing interrupt phase first; a
turn that remains open is never unsubscribed. Missing or undeliverable
unsubscribe replies produce a warning and proceed to EOF and normal process
cleanup. Rejected replies retain the request error. Invalid success payloads
are fatal protocol errors.

Codex 0.166.0, older releases, and unknown versions retain EOF shutdown.
The initialized-notification spelling is corrected for every version.
No exit-1 exception is applied: nonzero child exits still fail the session.
The existing rules for codemux-owned shutdown signals remain unchanged.

## Live checks and limits

Five sessions ran through this checkout's `bin/codemux session -a codex`
with `-m clerk --no-quota-gate`. The model resolved to `gpt-6-luna`.
No direct app-server session or extra model call was used.

| Check | Result |
| --- | --- |
| Hermetic, corrected `initialized`, EOF only | Turn ended normally; child and session exited 1 after 45.10 seconds of shutdown. |
| Hermetic, acknowledged unsubscribe then EOF | Child and session exited 0, about 7.9 seconds after shutdown. |
| Hermetic, final version-gated implementation, default 30-second grace | Child and session exited 0, about 2.7 seconds after shutdown. |
| Resume the preceding hermetic session | Refused: `no rollout found for thread id`. The transcript exists, but the native SQLite `threads.rollout_path` still names the old `run-*` directory after private-home settlement renamed it to `session-*`. |
| Ordinary session, final implementation, caller EOF | Child and session exited 0, about 3.1 seconds after turn completion. |

The resume finding concerns the existing private-home relocation path. This
change does not rewrite Codex's database or alter home settlement. The raw
transcript remains present. Fixture tests cover resume request ordering and
registry semantics; they do not establish live hermetic resume compatibility.

The audited ceiling stays **0.166.0**. The supplied 2026-11-14 live gate also
has an unresolved experiment-MCP probe failure, independent of shutdown.
Successful shutdown probes alone do not justify raising the full contract.
See [harness compatibility](harnesses.md#version-contracts).

`tests/session-codex-shutdown.test.ts` covers reply-before-EOF ordering,
version boundaries, resume-shaped sessions, accepted reply statuses,
timeouts, rejected writes and replies, malformed replies, interrupted and
unanswered turns, and nonzero exits. `tests/session-codex-wire.test.ts` pins
the notification and request shapes. Local probe logs and the final check
receipt are indexed in `scratch/report-codex-167.md`.

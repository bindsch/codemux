---
read_when: Finding implementation boundaries or changing launch and session behavior.
---

# Architecture

Codemux v0.13.3 is a Bun CLI that translates a common request into a harness
invocation. Harness adapters own command and environment differences.
Launchers own process lifetime and cleanup. scode supplies the optional
OS-level containment boundary. Codemux does not host a model or replace
the harness's login and session store.

## Entry points and adapters

[bin/codemux](../bin/codemux) starts Bun with the runtime configuration.
[index.ts](../src/index.ts) registers commands and validates configuration.
[config.ts](../src/config.ts) resolves defaults and model aliases;
[cli-runtime.ts](../src/cli-runtime.ts) provides shared validation, version
checks, and scode discovery. See [CLI reference](cli.md) and
[configuration](configuration.md) for the public settings.

The [adapter registry](../src/adapters/index.ts) maps agent IDs to adapters.
[BaseAdapter](../src/adapters/base.ts) defines capabilities, request
validation, per-run preparation, command/environment construction, result
processing, and cleanup. Adapter instances do not own mutable session
state. [harness-compatibility.ts](../src/harness-compatibility.ts) supplies
minimum versions; session floors are separately defined in session modules.

## One-shot runs and TUI

[launch.ts](../src/launch.ts) owns a run context from preparation through
cleanup. It obtains the adapter's command and environment, checks the
sandbox contract, executes the process, normalizes the result, records the
call, and releases per-run state. [run-exit-cleanup.ts](../src/run-exit-cleanup.ts)
provides an exit cleanup backstop for prepared contexts.

[process-runner.ts](../src/process-runner.ts) captures bounded stdout and
stderr, enforces deadlines, and settles the process tree. The result path
uses [result-envelope.ts](../src/result-envelope.ts), adapter-specific
reducers, and [plain-unwrap.ts](../src/plain-unwrap.ts). `--result-json`
normalizes the harness result with codemux metadata; plain output extracts
the usable answer. See [results and usage](results-and-usage.md).

`tui` inherits the terminal and launches the harness's interactive mode.
It does not use the session JSONL protocol. `run` likewise does not become
resumable by returning a harness ID; explicit `session` owns that contract.

## Containment, credentials, and providers

[sandbox-policy.ts](../src/sandbox-policy.ts) resolves effective policy;
[sandbox.ts](../src/sandbox.ts) builds scode arguments and filtered
environments. Adapter autonomy flags constrain harness behavior, while
scode supplies filesystem and process containment. Neither prompt text
nor permission acknowledgments replace that boundary.

[credentials.ts](../src/credentials.ts), adapter environment methods, and
the provider modules translate operator login or explicit overrides into
the selected harness's carriers. Provider overrides reuse these seams for
sessions. [hermetic-home.ts](../src/hermetic-home.ts) manages isolated
per-run homes and bounded cleanup. Hermetic runs and persistent sessions
have different state lifetimes; sessions currently refuse `--hermetic`.
See [authentication](authentication.md) and [isolation](isolation.md).

## Sessions

[session/cli.ts](../src/session/cli.ts) validates session flags, checks the
registry, constructs the driver, frames caller stdin, and wires child
processes. The implementation shares adapter validation and provider
handling with `run`, but does not capture a whole session into memory.

| Module | Responsibility |
|---|---|
| [protocol.ts](../src/session/protocol.ts) | Strict input validation, capabilities, common JSONL envelope and event builders |
| [fsm.ts](../src/session/fsm.ts) | Starting/idle/active/shutting-down/ended state, input sequencing, pending permission IDs |
| [process.ts](../src/session/process.ts) | UTF-8 line framing, stream bounds, output queue, signals, grace periods and child outcome |
| [spawn.ts](../src/session/spawn.ts) | Session child launch through the shared sandbox/environment checks |
| [ceiling.ts](../src/session/ceiling.ts) | Claude-family permission decisions bounded by launch autonomy |
| [registry.ts](../src/session/registry.ts) | Record validation, ownership claim, resume guards and bounded pruning |
| [registry-io.ts](../src/session/registry-io.ts) | Placement checks, locks and atomic registry writes |
| [usage.ts](../src/session/usage.ts) | Per-turn and driver-instance usage accumulation |

Claude/ZAI use one long-lived stream-json child with a control channel.
[driver.ts](../src/session/driver.ts) owns turn, permission, and shutdown
state. Codex uses one dedicated app-server and JSON-RPC through
[codex-driver.ts](../src/session/codex-driver.ts); the driver handles its
handshake, queued user messages, steer, approvals, and late usage.
Agy uses a persistent result stream through
[agy-driver.ts](../src/session/agy-driver.ts).

OpenCode, Aider, and Kimi spawn one process per turn while retaining native
session state between turns. Their driver files own that lifecycle; Kimi
also separates pure transitions into
[kimi-machine.ts](../src/session/kimi-machine.ts). The corresponding
`*-session.ts` modules build commands, declare capabilities, and parse
harness-specific records. Aider stdout is human transcript passthrough;
[aider-history.ts](../src/aider-history.ts) extracts the answer from history.

Resume requires both a trusted registry entry and usable harness state.
The registry is a same-user lookup and policy guard, not an authorization
boundary. Every launch setting is re-derived from the invocation. A Codex
provider override home is keyed by session ID; this is a naming rule, not
an access boundary between same-user processes. Its final location must
settle before ownership is released.

The [session guide](sessions.md) covers operational behavior. The
[protocol reference](session-protocol.md) defines fields, ordering, limits,
and failure delivery. The [original design summary](LIVE-SESSIONS-DESIGN.md)
is historical and does not override either reference.

## Accounting and verification

[call-log.ts](../src/call-log.ts) appends local run, completed-turn, and
session-close records. `calls` queries that ledger. `usage` delegates to
usagemux for provider quota; these are different datasets. Token usage is
per run or driver instance, while Claude-family session cost can include
the stored conversation's lifetime. The ledger does not turn an unknown
usage field into zero.

Unit tests cover protocol parsing, ceilings, usage, and state transitions.
Fake-harness process tests cover CLI validation, streaming, shutdown,
concurrency, and resume without a provider request. Sanitized wire fixtures
under [tests/fixtures/live](../tests/fixtures/live/README.md) retain prior
observations. Installed-contract and live-provider checks are separate
evidence; passing fake tests does not establish a fresh live result.
See [testing](TESTING.md) and [release gate](RELEASE-GATE.md).

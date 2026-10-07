# Live session fixtures

Recorded in step 0 of the live-sessions implementation (2026-10-04/05) on
macOS 27.0. Each file is NDJSON with one record per exchange frame:
`dir` is `in` (a line the probe wrote to the harness's stdin), `out` (a line
the harness wrote to stdout), `unparsable` (a non-JSON stdout line), or
`meta` (probe-side outcome: child exit code, timeouts, resolved ids).

Claude-family frames were recorded with `claude` 2.1.280 through the zai
endpoint (the codemux `zai` adapter's endpoint, same binary and same
stream-json wire format; the endpoint only changes where tokens are billed).
Codex frames were recorded with `codex` 0.159.3 `app-server` under a
relocated `CODEX_HOME`. agy frames were recorded with the installed agy
build; its login had expired, so the only live frame is the auth-failure
result.

## Files

- `zai-session-a.ndjson` — four-turn exchange: two plain turns, a turn with
  a Bash call, a mid-turn user message (line 34) that the harness folded
  into the ACTIVE turn — echoed with `isReplay: true` after the tool
  result (line 59) and answered in that turn's own result (line 74,
  `"two-b\n\nprobe-permission-ok"`, `num_turns: 2`, `result_index: 2`;
  the next result, line 82, is the interrupted counting turn) — and an
  interrupt control round-trip (lines 78-84) ending in a result with
  `subtype:"error_during_execution"`, `is_error:true`, exit code 1. Also
  shows `system/init` arriving once PER TURN (lines 6, 18, 30, 76) with the
  same `session_id`, and `system/hook_started`/`hook_response` frames from
  user-settings hooks.
- `zai-permission.ndjson` — `touch /tmp/...` under
  `--permission-mode default`: NO `can_use_tool` request is emitted; the
  write outside the allowed working directories is auto-DENIED and surfaces
  as `system/permission_denied`. Documents the auto-deny path.
- `zai-permission2.ndjson` — `sw_vers -productVersion`: same auto-deny
  outcome, confirming it is policy, not path-specific.
- `zai-permission3.ndjson` — the working permission round-trip with
  `--permission-prompt-tool stdio`: a `control_request` with
  `request.subtype:"can_use_tool"` carrying `tool_name`, `input`,
  `permission_suggestions`, `decision_reason`; answered on stdin with a
  `control_response` (`behavior:"allow"`, `updatedInput`); the harness then
  echoes the accepted `control_response` back on stdout and proceeds.
- `zai-resume.ndjson` — `--resume <uuid>` reports the SAME `session_id` in
  its init frame (no `resume` field distinguishes it).
- `codex-app-server.ndjson` — full `initialize` →
  `notifications/initialized` → `thread/start` (explicit
  `sandbox:"danger-full-access"`, `approvalPolicy:"never"` accepted) → two
  `turn/start`/`turn/completed` cycles. Confirms: responses omit `jsonrpc`;
  `thread/started` params carry the thread object (`params.thread.id`); the
  `thread/start` RESULT also carries it; item types are
  userMessage/agentMessage, and text deltas ride a separate
  `item/agentMessage/delta` notification that carries no item;
  `turn/completed` params carry no usage;
  usage arrives only via `thread/tokenUsage/updated` with `total`
  (cumulative) and `last` (per-turn delta); plus the ambient notification
  stream (`remoteControl/status/changed`, `account/*`, `mcpServer/*`).
- `agy-session.ndjson` — the auth-failure result frame. Envelope key is
  `event` (not `type`): `{"event":"result","result":{conversation_id,
  status, response, error, duration_seconds, num_turns, usage}}`. The
  full-exchange probe was NOT run: agy's login is expired and re-login is
  interactive.

## Sanitization

Applied by `scratch/probes/sanitize.ts` (kept alongside the probe drivers):
the checkout the probes ran in is replaced with `/Users/example/project`,
both as a path and as claude's dash-encoded project slug
(`-Users-example-project`, carried in each zai init frame's
`memory_paths`), the operator's home path with `/Users/example`, the
hostname with `example-host.local`, the harness installation id with a
zero uuid,
and the probe driver's own `ts` stamp on each record is dropped, and a
scan asserts the endpoint API key does not appear. Timestamps carried
inside the harness frames themselves survive — codex
`emittedAtMs`/`startedAtMs` fields and the `timestamp` on zai user and
assistant frames (zai result frames carry none) are left as recorded. Session ids, request ids, and usage numbers are left
as recorded — they are already opaque and the tests need realistic
shapes.

`tests/session-fixtures-privacy.test.ts` enforces the identity half of
this: it reads the home directory, username, and checkout paths of the
machine running the suite and fails on any spelling of them in this
directory (review live19 — the project slug had survived the home
replacement and disclosed the username and the repository path).

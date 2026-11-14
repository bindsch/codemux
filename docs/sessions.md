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
| `opencode` | 1.18.18 | rejected | no | yes | no | no | no | no |
| `aider` | 0.86.2 | rejected | no | yes | no | no | no | no |
| `kimi` | 2.5.2 | rejected | no | yes | no | no | no | no |
| `cursor` | 2026.11.05 | rejected | no | no | no | no | no | no |
| `droid` | 0.221.0 | rejected | no | no | no | no | no | no |
| `pi` | 0.85.1 | rejected | no | yes | no | no | no | no |
| `qwen` | 0.24.0 | rejected | no | no | no | no | no | no |
| `gemini` | 0.60.0 | rejected | no | yes | no | yes | no | no |
| `copilot` | 1.0.85 | rejected | no | yes | no | no | no | no |
| `goose` | 1.50.1 | rejected | no | no | no | no | no | no |
| `cline` | 3.0.74 | rejected | no | yes | no | yes | no | no |
| `openhands` | 1.16.0 | rejected | no | no | no | no | no | no |

All sixteen report `live_input: true` and `resume: true`. Read the capabilities on `session_started`; unsupported operations receive `input_rejected`. A first interrupted Kimi turn can continue only after its id is known or recovered from its private session index.
ZAI uses the Claude binary. Cline opens one ACP connection (cli-v3.0.74 `cline --acp`) per caller input and reloads the native session with `session/load` between turns. Its per-turn usage is the change in the cumulative usage that `cline history --json` reports.

Cursor, Droid, Pi, Qwen, Gemini, Copilot, Goose, and OpenHands run one process per caller input, as Aider, OpenCode, and Kimi do. The harness's own store or a codemux-owned history file carries state between turns. OpenHands supports caller-owned homes and hermetic sessions.
Of those eight agents, Droid, Pi, Qwen, Gemini, Copilot, Goose, and OpenHands accept `--hermetic`; Cursor refuses it. The [hermetic section](#hermetic-sessions) describes private-home behavior.

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

Goose and Cline session IDs reported by Codemux have the form
`<agent>-<uuid>--<native-id>`. The UUID distinguishes separate homes even
when the harness assigns the same native ID. Pass the full reported ID to
`--resume`; Codemux sends only the native part to the harness. Existing
registry entries with native IDs remain resumable. The registry refuses
to replace a record belonging to another agent or home. A private-home
settlement failure fails the session. When settlement runs between turns,
it also fails the current turn; a persistent child's home settles at shutdown.

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
| `--harness-home <dir>` | Off | Persistent caller-owned config and runtime home; every session agent (Cline, Copilot, Goose, and OpenHands require a provider override); absolute canonical path, no symlinks, incompatible with `--hermetic` |
| `--timeout <seconds>` | none | Whole-session deadline; expiry ends with a nonzero exit |
| `--turn-timeout <seconds>` | none | Claude/ZAI/Codex/Aider/OpenCode/Copilot/Gemini/Pi/Cline; first expiry interrupts, second expiry on that same turn ends the session. Kimi stops its turn child through the shutdown grace |
| `--permission-timeout <seconds>` | 300 | Deny an unanswered permission request |
| `--shutdown-grace <seconds>` | 30 | Grace before SIGTERM, then another grace before SIGKILL. Claude Code can take over 10 s to exit after a completed turn |
| `--no-author-prefix` | prefix enabled | Preserve attribution events without prepending `[author] ` to harness text |
| `--permission-policy <policy>` | `default` | `deny` immediately denies Claude/ZAI/Codex requests; Kimi/OpenCode/agy use native rules with `--hermetic`; OpenHands plants a PreToolUse hook that blocks every tool but `finish` and `think` in its hermetic home (refused with `--experiment-project-settings`). Aider sends negative stdin confirmations and suppresses yes-always grants. See [permissions](#permissions-and-attribution). Pass the flag again on resume; the registry does not store it |
| `--hermetic` | Off | Accepted by Claude, ZAI, Codex, Agy, OpenCode, Aider, Kimi, Droid, Pi, Qwen, Gemini, Copilot, Goose, Cline, and OpenHands. Cline, Goose, and OpenHands require a provider override. Cursor refuses it. Private-home behavior and isolation conditions are described [below](#hermetic-sessions) |
| `--experiment-project-settings` | Off; requires `--hermetic` | Hermetic plus the repository's own settings in place of the operator's (claude/zai; opencode keeps the project's config; openhands loads the working directory's `.openhands`); see [below](#hermetic-project-settings-sessions) |
| `--final` | Off; requires an isolation mode | Remove a hermetic session's private home and transcript. A caller-owned `--harness-home` is always preserved |
| `--sandbox-block <path>` | none | Repeatable; pass an extra scode `--block` for this session's children (absolute paths only), an operator-side extra on top of the project-settings blocks. Canonicalized once at flag parse (symlinks dereferenced, then deduplicated and sorted), and that same spelling is recorded and enforced by every child; a resume must carry every recorded block path and may add more |
| `--print-sandbox` | Off; requires `--sandbox` | Available for Agy, Aider, Claude, Cline, Codex, Copilot, Cursor, Droid, Goose, Gemini, Kimi, OpenCode, OpenHands, Pi, Qwen, and ZAI. Print scode argv, one argument per line with control characters escaped (a newline prints as `\n`), and exit 0 without starting a session. Aider, Kimi, and OpenCode show a representative per-turn command with a prompt placeholder; Cline, Copilot, Cursor, Droid, Gemini, Goose, OpenHands, Pi, and Qwen print the representative first turn's command, since their session children spawn per turn. Fresh private homes and generated files use representative paths that need not exist. Previews create no directories or files, copy no credentials, modify no existing state, and run no stale-directory sweep; their finalizers are no-ops. Resumed previews validate existing private homes and their parents without modifying them. Preview and credential-preflight grants never enter the policy used by real turns |
| `--quota-ceiling <percent>` | config `quota.minRemainingPercent`, initially 10 | Refuse the session when a bounding usage window is below this percent remaining; overrides the config ceiling for this one session |
| `--no-quota-gate` | gate on | Skip the pre-launch usagemux quota check for this session |

Every timeout accepts finite positive seconds up to **86400**, including
fractions, and rounds upward to whole milliseconds. Zero disables nothing:
omit an optional timeout to have no cap. A turn timeout that successfully
interrupts leaves the session available for another turn.

The first command of a session and every resume pass the
[quota gate](quota.md#quota-gate) — after every request check and
resume guard, before anything spawns, records a fresh session, or creates a
home — so a refused session (exit 64) spends nothing. A refused fresh session
records nothing; a refused resume has already written its ownership claim to
the registry (the claim precedes the gate), and the refusal releases it, so
the record stays resumable for the next attempt.

Aider and OpenCode accept `--tools default` and `--tools none` on every turn and resume. OpenCode requires hermetic mode without project settings for `none`. Copilot names an unavailable-tool sentinel that empties the registry, Gemini writes empty core tools into its per-turn settings, and Pi passes `--no-tools`; each is reapplied on every resumed turn and `default` restores discovery. Kimi binds an empty native allowlist on the first tools-none turn; resume restores it and refuses a different tool selection. Other session tool selections remain agent-specific. `--max-budget-usd` is refused for sessions; the spend limit applies to headless runs.
`--hermetic` is accepted by Claude, ZAI, Codex, Agy, OpenCode, Aider, Kimi, Droid, Pi, Qwen, Gemini, Copilot, Goose, Cline, and OpenHands. Cursor refuses it with exit 64 because its state cannot be relocated to a session-lifetime private home.
`--effort none` uses the native value where supported: Codex sends `effort: "none"`
and Pi sends `--thinking off`. On other agents without a native `none`, codemux
omits effort configuration. `--enable-playwright-mcp` is supported
for Claude/ZAI/Cline/Codex/Kimi/OpenCode/Copilot/Gemini/Goose/Pi/Qwen, never combined with either
isolation flag, and requires `--sandbox`; Claude, ZAI, Codex, Kimi, Gemini, Goose, Pi, and Qwen
require `--auto low`, Copilot and Cline require `--auto medium` or `high`
(low has no caller approval bridge), and OpenCode accepts any level.

## Caller-owned session homes
`--harness-home <dir>` selects one persistent directory across turns and session restarts. Pass the same path with `--resume <id>`; a changed path or missing transcript directory refuses resume. Codemux creates absent directories with mode 0700 and requires ownership by the invoking user. The directory must be separate from the working directory and all real harness stores. It must also neither contain nor lie inside one of scode's default-blocked paths, such as `~/Library`, `~/.ssh`, or `~/.config/gh`: a sandbox grant beneath one would reopen it. Symlinks and symlink ancestors are refused. Neither `--final` nor failed-launch cleanup removes it; the caller owns retention and cleanup.

Codemux seeds only dedicated logins and checks them before every child launch, after sandbox preflight. A login a harness rewrites in place is hard-linked; use a directory on the login's filesystem. A replaced or missing real login refuses stale private credentials; remove the private login entry after restoring the real login, then retry. Claude and Qwen replace their login files by rename, so the caller home never holds their refresh tokens: codemux rewrites an access-token-only copy from the real login on every launch and resume. A Claude mirror that still carries a refresh token refuses the launch, and a sandboxed Claude session runs the same Keychain sync and mirror guard as any sandboxed run. A Qwen access token at or near expiry refuses the launch; run Qwen once outside codemux to refresh it. Kimi also renames token files, so `.kimi-code/credentials` is a symlink to the real credential directory, the hermetic home's mechanism, and the sandbox grants that one directory. API-key authentication needs no login. Codemux does not export a Keychain login or copy operator settings.

All paths below are relative to `<dir>`. HOME, USERPROFILE, and XDG roots move inside it. A `--pass-env` name the caller home sets or clears is refused with exit 64, because the home would replace it without notice. That covers these roots and each agent's own redirects, cleared config variables, and flags, such as `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCODE_CONFIG`, and `GOOSE_DISABLE_KEYRING`. Place trusted settings and skills at the listed paths; caller content remains enabled. Cline, Copilot, and OpenHands require a configured `CODEMUX_<AGENT>_PROVIDER_*` override because their native login or provider files mix settings with credentials. Goose requires one as its hermetic runs do: the installed binary does not establish that `secrets.yaml` is rewritten in place. Agy requires `GEMINI_API_KEY` because the audited binary exposes no portable file-login path.

| Agent | Native root and caller content | Login files or condition |
| --- | --- | --- |
| Claude / ZAI | `CLAUDE_CONFIG_DIR=.`; `settings.json`, `skills/` | Access-token-only `.credentials.json`, rewritten per launch; ZAI uses its gateway token |
| Cline | HOME and `CLINE_DIR=.cline`; `.cline/data/settings/`, `.cline/skills/`; requested options go to overlay files under `.cline` | Provider override; never links the provider settings file |
| Codex | `CODEX_HOME=.codex`; `config.toml`, `skills/` inside it | `.codex/auth.json` |
| Agy | HOME; `.gemini/antigravity-cli/settings.json`, `.gemini/skills/` | Explicit API key; no Keychain access |
| Aider | HOME; `.aider.conf.yml`; use its `read` setting for instruction files | `.aider/oauth-keys.env` |
| Copilot | `COPILOT_HOME=.copilot`; `settings.json`, `skills/` inside it | Provider override; never links `config.json` |
| Cursor | `CURSOR_CONFIG_DIR=.cursor`; `cli-config.json`, `rules/`, `skills/` inside it | `.cursor/auth.json` on macOS; `.config/cursor/auth.json` on Linux |
| Droid | `FACTORY_HOME_OVERRIDE=.`; `.factory/settings.json`, `.factory/skills/` | `.factory/auth.json` |
| Gemini | `GEMINI_CLI_HOME=.`; `.gemini/settings.json`, `.gemini/skills/` | `.gemini/oauth_creds.json`, optional `google_accounts.json` |
| Goose | `GOOSE_PATH_ROOT=.`; `config/config.yaml`, `.agents/skills/` | Provider override; never links `secrets.yaml`; file storage enabled |
| Kimi | `KIMI_CODE_HOME=.kimi-code`; `config.toml`, `skills/` inside it | `.kimi-code/credentials` symlink to the real nonempty credential directory |
| OpenCode | XDG roots and `OPENCODE_CONFIG_DIR=.config/opencode`; `opencode.json`, `skills/` inside it | `.local/share/opencode/auth.json` |
| OpenHands | `OPENHANDS_PERSISTENCE_DIR=.openhands`; `agent_settings.json`, `microagents/` inside it | Provider override; never links `agent_settings.json` |
| Pi | `PI_CODING_AGENT_DIR=.pi/agent`; `settings.json`, `skills/` inside it | `.pi/agent/auth.json` |
| Qwen | `QWEN_HOME=.qwen`; `settings.json`, `skills/` inside it; runtime stays in the root | Access-token-only `.qwen/oauth_creds.json`, rewritten per launch |

With scode, real harness stores are blocked and the caller directory receives writable state access. Resolved command executables installed inside a blocked store receive exact-file grants; their parent directories stay blocked. When the caller's `HOME` differs from the account home, scode blocks the account home wholesale, so an executable installed there receives the same exact-file grant.

With scode 0.6.7 or newer, these grants use `--allow-ro`: read and execute access, never writes. Strict and untrusted executable checks accept them. Strict and untrusted also use exact-file read-only grants for resolved executables behind `env` wrappers outside system read roots, including nested wrappers. This removes the wrapped-executable limitation for agy and isolated OpenCode launches where their runtime dependencies are accessible. Writable harness state that covers executable code still causes a strict refusal; ordinary OpenCode's `.opencode` state grant is one example. Persistent sessions retain their separate refusal of untrusted mode because they need writable state.

With older scode, blocked-store executable grants remain writable `--allow` exceptions: the harness can rewrite its own executable. Strict and untrusted modes refuse these writable grants and wrapped executables outside system read roots. Caller-supplied blocks remain authoritative on both versions. `--print-sandbox`, where supported, shows the selected policy without creating the home. See [isolation](isolation.md#caller-owned-session-homes).
## Hermetic sessions

Session IDs must be single path components: separators, dot segments, whitespace, and NUL bytes are refused for every harness. Private-home operations check containment and the recorded parent's identity before accessing a child.

`--hermetic` applies the harness's run isolation to session turns; see [isolation](isolation.md) for each harness's conditions and unresolved limits. Flag acceptance alone does not promise a session-lifetime private home.
Fourteen agents keep a session-lifetime private home: Claude, ZAI, Codex, Kimi, Agy, Aider, OpenCode, Droid, Pi, Gemini, Copilot, Goose, Cline, and OpenHands. The home is reported on `session_started.private_home` and removed by `--final` or the two-day stale sweep. Qwen keeps none: its sessions live in the real data directory, and it reports `private_home: null`. A session cannot gain or lose hermetic mode on resume. A missing home on resume is refused as policy (exit 78), never silently remade, because its transcript would be gone.

Per agent:

- **claude/zai** run the `run` path's own hermetic argv (`--safe-mode`, `--setting-sources user`, `--strict-mcp-config`) inside a private `CLAUDE_CONFIG_DIR` under `~/.claude/.codemux-hermetic/session-<id>/` (a redirected config root is honored the same way), carrying the same credential copy a project-settings session carries. The operator's real config root is blocked for the session's children and only the private directory re-allowed.
- **codex** runs with `HOME` and `CODEX_HOME` pointed into the private home under `~/.codex/.codemux-hermetic/` (`CODEX_HOME` redirects are honored), holding the login link (or the override's provider config under `CODEMUX_CODEX_PROVIDER_*`, whose key is the credential). The home is keyed by the thread id once the harness mints it. A hermetic session's threads skip AGENTS.md discovery (a thread config carries `project_doc_max_bytes: 0` and an empty fallback list, start and resume alike); a plain session sends no thread config, so project documents load exactly as a plain codex run's do.
- **kimi** runs each turn with `HOME` and `KIMI_CODE_HOME` pointed into its managed private home, sharing the credential directory and a filtered `config.toml` with the operator's brand home and carrying copies of `region` and `device_id`; the session store lives inside the home.
- **agy** runs with HOME and XDG variables pointed into its managed private home, carrying a private Keychain login or the permitted API-key/file token. The first result supplies the conversation ID and triggers `session_started`. Its reported `private_home` is the final `session-<id>` path; the live child uses the temporary path until session settlement. The reported directory exists for caller configuration only after that settlement or on resume.
- **opencode** keeps login and the native session database in private data/state directories across turns and resume. The login is a hard link to the real `auth.json`, which OpenCode rewrites in place, so a token refresh during the session reaches the real login. HOME, configuration, and cache remain fresh per turn. The first completed turn settles the private directory under the native session ID; later sandbox allowances follow that path. `--final` waits for child settlement before removal; failed removal keeps the session resumable. Project-settings mode adds the project's config and drops `--pure`.
- **aider** keeps `history.md` in its session private home and redirects HOME on every turn. It requires a clean explicit working directory. `--final` removes the private home after child settlement. Interruption removes only the canceled turn's history delta; later turns retain completed history.
- **droid** keeps a managed private home whose `.factory/auth.json` hard-links the real login. Each turn unsets the Factory override, disables self-update, and redirects HOME. A provider override rewrites the BYOK entry each turn. The first native session ID settles the home onto `session-<id>`.
- **pi** keeps a home under `~/.pi/agent/.codemux-hermetic/` (a
  passed-through `PI_CODING_AGENT_DIR` redirects it) and points
  `PI_CODING_AGENT_DIR` there on every turn; under a provider override
  the home's `models.json` carries the routing entry and a selected model is
  required, from `--model` or `CODEMUX_PI_PROVIDER_MODEL`. Plain Pi override sessions keep the native session directory
  stable with `--session-dir`, independently of per-turn provider settings.
- **gemini** keeps a home under `~/.gemini/.codemux-hermetic/` whose
  `.gemini/` holds hard links to the OAuth login files (skipped under an
  API-key override); `GEMINI_CLI_HOME` never routes a session.
- **copilot** keeps a home under `~/.copilot/.codemux-hermetic/` holding
  the hard-linked `config.json` login; `COPILOT_HOME` never routes a
  session.
- **goose** keeps an empty home under `~/.config/goose/.codemux-hermetic/`
  on purpose: the operator's goose config carries the system prompt, so
  nothing may ride into the private home — a hermetic goose session
  therefore requires the provider override (exit 64 without it), and
  each turn sets `GOOSE_PATH_ROOT` and the XDG trio at the home.
- **openhands** keeps an empty home under `~/.openhands/.codemux-hermetic/` and requires the provider override (exit 64 without it), because the operator's `~/.openhands` holds the whole agent spec. Each turn sets `HOME`, `OPENHANDS_PERSISTENCE_DIR`, and `OPENHANDS_CONVERSATIONS_DIR` at the home, so the conversation store that `--resume` reads lives there; the first turn's Conversation ID settles the home onto `session-<id>`. The working directory must be explicit and hold no `.openhands`. `--permission-policy deny` writes a PreToolUse rule to the home's `.openhands/hooks.json`; a resume applies the policy its own command names.
- **qwen** keeps no session-keyed home: safe mode is
  the whole hermetic claim, the native sessions stay in the real data
  directory, and `private_home` reports null.

`--final` removes the home when the session ends. On the claude family, agy, cline, opencode, droid, pi, gemini, copilot, goose, and openhands, the driver's end path retries a failed removal before stamping the record. If both attempts fail, it keeps the home, exits 1, and leaves the record resumable. Deferred homes settle onto the session-keyed name so the reported resume path exists (the project-settings section below spells this out).
On codex, kimi, and aider the CLI removes the home after the session's children settled; a fresh session's record keeps its resumable stamp (the harness's own id never reaches the CLI), so a later resume of it answers the missing-home refusal, exit 78.
Without `--final`, the home persists for the next `--resume`, and the stale sweep removes it once it has been quiet for two days and its registry record is free: ended without a final stamp, gone, or an unended record whose owner process is dead. A session that ended normally or crashed and was never resumed therefore loses its home after two quiet days, and a later `--resume` answers the missing-home refusal, exit 78.
The sweep retains a resumable home if its freshness scan cannot finish, including when it exceeds 4,096 entries or cannot read a subtree. A free registry record alone does not establish inactivity.

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
`~/.claude/.codemux-hermetic/session-<session id>/` — the same directory a
plain `--hermetic` session of this family uses, so a resume keys either
mode onto one home — and holds the
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
  and whose registry record is free (ended without a final stamp, gone, or
  an unended record whose owner process is dead); a held or unreadable record spares it.

The mode is containment provenance: a resume must carry the same flags,
and a session cannot gain or lose the mode on resume. A project's
PreToolUse and PostToolUse hooks fire for every tool call on every turn
under this mode — Claude Code runs hooks per call, not per turn — which
is the observable the mode exists to provide. A Claude session without a
provider override carries an access-token-only copy of the credential
mirror inside the directory; ZAI and override sessions carry no operator
login ([authentication](authentication.md)).

On OpenHands the mode is the hermetic session without the clean-working-directory rule: every turn runs in the empty private home and loads the working directory's own `.openhands` (1.16.0 reads `{working_dir}/.openhands/hooks.json` before the home's). It requires scode and `--auto low`, and refuses `--permission-policy deny`, whose rule in the home that file would replace.

Provider overrides via `CODEMUX_<AGENT>_PROVIDER_*` are supported on session spawns for Aider, Claude, Cline, Codex, Copilot, Droid, Goose, Gemini, Kimi, OpenCode, OpenHands, Pi, Qwen, and ZAI. Agy and Cursor sessions refuse overrides.
The adapter validates overrides as on `run`; the selected provider must match on resume. Qwen requires a non-legacy binary. A Pi override session supports both plain and hermetic mode; plain mode preserves the native session directory while private provider settings are prepared per turn. A hermetic Goose session requires an override because its private home contains no operator configuration. See [CLI reference](cli.md).

Claude/ZAI account redirects use `CLAUDE_CONFIG_DIR`, Codex uses `CODEX_HOME`,
and Kimi uses `KIMI_CODE_HOME`, only when included in `--pass-env`. Values
must be absolute; Claude/Codex reject whitespace padding, and Kimi and
Codex reject an empty value. OpenCode uses its resolved XDG data directory.
Aider keeps history in `~/.aider`; Agy uses `~/.gemini/antigravity-cli`.
Cursor keeps state in `~/.cursor`, droid in `~/.factory`, Pi in
`~/.pi/agent` (a passed-through `PI_CODING_AGENT_DIR` redirects it), Qwen
in its brand home (`QWEN_HOME`-aware), Gemini in `~/.gemini`, Copilot in
`~/.copilot`, and Goose in `~/.config/goose`. `GEMINI_CLI_HOME` and
`COPILOT_HOME` never route a session: their adapters refuse the
pass-through, because isolation owns the variable.

## Permissions and attribution

An accepted `user` or `steer` produces `user_message` with the original text
and optional author. This event is the attribution record. The default
`[author] ` prefix is only a display aid and is not an identity check.

The Permissions column means an ask channel, independent of native deny rules.
`codemux autonomy` reports the same fact and the reason when no channel exists.
`--permission-policy deny` uses ask channels for Claude/ZAI/Codex and native
rules for hermetic Kimi/OpenCode/agy/OpenHands sessions. Aider answers native stdin confirmations negatively in plain and hermetic sessions.

| Agent | Ask channel | `--permission-policy deny` |
|---|---|---|
| Claude/ZAI | `can_use_tool` requests over stdio | Immediate wire denial |
| Codex | App-server command, file-change, and permission requests | Immediate wire denial |
| Kimi | None: 2.5.2 `--prompt` forces auto mode; configured denies run first | Hermetic private `config.toml`, wildcard deny rule |
| OpenCode | None: 1.19.5 `run` answers `permission.asked` itself, once with `--auto`, reject otherwise | Hermetic per-turn config; project-settings mode refused |
| agy | None: 1.5.3 print mode soft-denies confirmations it cannot show | Hermetic private settings plus native `--settings` deny overlay |
| OpenHands | None: 1.16.0 headless mode selects NeverConfirm | Hermetic home `.openhands/hooks.json` PreToolUse rule that exits 2 for every tool but `finish` and `think`; project-settings mode refused |
| Aider | None: 0.86.2 confirmations are stdin yes/no prompts | Repeating negative stdin answers and `AIDER_YES_ALWAYS=false`; no `--yes-always` flag |

For a `permission_request`, send `permission_decision` with its `request_id`
and one of its `options`. `permission_response` is an alias with the same
fields, validation, and autonomy ceiling.
A caller decision produces `permission_resolved`. Timeout, interrupt,
completion, and shutdown deny pending requests; a late answer receives
`unknown_request`. The permission timeout defaults to 300 seconds.
An allow beyond the launch autonomy is denied with `autonomy_escalation`.

Claude/ZAI denials accept a `message` of 1–2000 UTF-16 code units, without
NUL or control characters except newline. Omission uses Claude's native
rejection text. Denial events record the text sent. Codex has no wire
denial text and rejects `message` and `updated_input` as `unsupported`.

For Claude/ZAI/Codex, the deny policy emits `permission_request`, answers
immediately, then emits `permission_denied`. It creates no pending request
or timer. No `permission_resolved` follows; later answers get `unknown_request`.
Codex omits `permission_denied.message` because its decline carries no text.

Claude/ZAI read-only approves no tool; medium allows scoped editing outside
executable configuration; high grants editing and Bash; low lets the caller
decide. Edit, Write, NotebookEdit, and Bash arguments must fit their schemas.
Operator allow rules can bypass requests; scode enforces containment.
Codex allows requests at low, scoped file changes at medium, and commands
and file changes at high. Read-only denies every allow. Above read-only,
Codex uses `approvalPolicy: "on-request"`; low and medium use its native
read-only sandbox as well as scode so writes require approval. Ordinary
read-only commands need not ask. High keeps native full access; read-only
keeps `never`. Codex 0.166.0 rejects the old public `untrusted` config value.

Kimi adds `{decision="deny", scope="user", pattern="*"}` to the private
config before each deny-policy turn. Existing rules and values remain;
the insertion can normalize TOML formatting. The generated rule denies all
tools, including reads. It persists on disk across default resumes; remove
it explicitly before resuming without that restriction. OpenCode requires
plain `--hermetic`: project agent permissions can override global denies.
agy preserves consumer settings and applies the deny overlay before spawn.
These three agents emit no permission events for native denials. Read the
harness tool error or result instead. Aider answers no at read-only and low,
and uses `--yes-always` at medium and high; it has no machine approval wire.

## End conditions and failures

`shutdown` or stdin EOF begins orderly draining. A signal, absolute timeout,
or fatal failure also ends the session. Pending turns receive a completion
when possible, and `session_ended` is the final event. Turn-per-process
agents drain a child still being spawned on orderly shutdown; a hard end
stops it when it arrives. That wait is bounded by the stop grace for every
end (review round 110): a spawn that outlasts it fails the session, and
that spawn refuses to create its process when it resumes, so no child
starts after the CLI's run cleanup. Grace expiry with a turn still open fails
the session. After all turns complete, an idle child killed by codemux during
caller-requested shutdown ends with reason `shutdown` and exit 0. A `warning`
event names SIGTERM, SIGKILL, or a SIGTERM wrapper's exit 143. The raw
`harness_exit` and resume rules remain unchanged. This applies to shutdown
input and caller EOF, not a timeout or a signal that stops codemux itself.

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
does not provide. After the harness exits, the process-group address is
used only while the sampler still lists a member of that group other than
the leader slot: the exited harness's pid may have been recycled into
another process's group leader, and that group takes no signal, while a
descendant that still carries the group id keeps the address alive. Two
residuals: a pid recycled between the last sample and the kill delivery, and
a host that denies process enumeration, where the table cannot be read and
the group signal fires after the exit as it always did, keeping its reach.

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

When a registry file is corrupt, the recovering write keeps the live file in
place until its replacement lands, and leaves a hard-linked
`<registry>.corrupt-<timestamp>` backup beside it, keeping the newest five
only after a successful replacement write. A failed replacement keeps the
corrupt file, and a resume still exits 78.

The exit status is the `exit_code` that `session_ended` reported. A signal
that stops a session is reported in that event and exits 143. A signal that
arrives after the event was written, while it is still being flushed, stops
nothing: the session had already ended, so the status stays what the event
said, 0 after a clean end. Only a failed delivery of the event changes the
status, to at least 1. Every agent follows this rule.

Kimi, OpenCode, and agy learn a fresh session's id from the first turn's output and record it beside the stream: the session never waits on the registry lock mid-turn. A session that ends with that record still unwritten — the lock stayed busy until the end — ends as a crash: the fatal error `cannot record the session in the registry` is the verdict, the exit is nonzero (1, or the signal's 143 when a signal ended it), the registry holds no entry, and the session is not resumable. A resumed session is tracked by the record the CLI claimed before the spawn, so the verdict applies to fresh sessions only. The same holds when the lock stays busy past the whole retry budget while a resumed session is live: the exhausted record is a lost refresh of a record that exists, so the session prints one stderr line naming the spent budget and the claim that stays the record, announces `session_started`, and keeps running.

Child failures can preserve another nonzero code. A nonzero child exit or signal changes the final reason to `harness_failed`, except for the idle shutdown kill described above and the supported turn-interrupt cases below. A harness that exits nonzero on its own still fails. A caller must inspect both exit status and events. Malformed caller JSON receives a rejection and does not itself end a session.

Aider's stdout is a human transcript: non-JSON lines become `unknown`. Its assistant message is extracted from persistent history. History is checked before each turn, reads are bounded per turn, and the accumulated file has no codemux size cap. An explicit interrupt stops the turn child and removes only that turn's history delta after the child settles. The session can continue; its end event retains the raw signal. Other unanswered failed turns end the session because a resume would replay them. The test is what aider itself restores: a reply that is only a reasoning block counts as a reply, and a reply made only of `> `, `# `, or `#### ` lines does not, because aider writes its tool output and the user's text in those shapes and restores none of them as assistant text. Local analytics report native output tokens, which Aider may estimate, and known cost; input, cache, and total counts stay null. Aider refuses text beginning with `/` or `!`; Kimi refuses `/goal` followed by whitespace or end, and `!`; OpenCode refuses a message that is empty after trimming, which its wire exits 1 on. These checks apply after the author prefix. An OpenCode `error` event, and a Kimi roleless `{type:"error",message}` frame, fail their turn even when the turn's process exits 0 — the failed turn's reason is the error message — while the session itself continues with the next turn.

Usage is described in [results and usage](results-and-usage.md). Token
totals belong to this driver instance, including after resume. Claude/ZAI
cost instead adopts the harness's latest lifetime figure; do not sum it
across resumes.

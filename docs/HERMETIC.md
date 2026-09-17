# Hermetic runs

`codemux run --hermetic` runs a harness with none of the operator's
customizations. The model sees the prompt and the harness's own base
instructions, nothing else. The login still works. Experiments that must
not depend on whose machine ran them use it; so does any run whose result
should be reproducible from a prompt alone.

Two flags, deliberately independent:

| Flag | Meaning |
|------|---------|
| `--hermetic` | No user or project instruction files (CLAUDE.md, AGENTS.md), skills, plugins, hooks, MCP servers, memories, or account-level integrations. |
| `--tools <default\|none>` | Which built-in tools the harness exposes. `none` removes the harness's own tools; it cannot be combined with `--enable-playwright-mcp`. |

A hermetic run keeps the harness's built-in tools unless `--tools none` is
added. `--tools none` works without `--hermetic` too. Both are headless
(`run` and `check`) only.

Codemux refuses `--hermetic` for any harness whose mechanism has not been
verified with the live check below, and refuses `--tools none` for any
harness that cannot remove its tools. A refusal is deliberate: an unverified
harness would quietly run with the operator's context.

## Verification: `codemux check --hermetic`

A flag inspection cannot prove that a harness ignored its customizations;
only the model's answer can. `codemux check --hermetic -a <agent>` makes
two real requests:

1. It plants `AGENTS.md` and `CLAUDE.md` carrying a random code word in a
   scratch working directory, runs the harness there with `--hermetic`, and
   asks whether any instruction file, memory, or user-installed skill was
   given, apart from the vendor's own system prompt and bundled skills. The
   run passes only when the model answers `OK` and the code word never
   appears.
   An owner's name in the answer is a leak; a refusal or anything else is
   inconclusive, and also fails.
2. It repeats the probe without `--hermetic`. The planted code word must
   reach the model here; that is what makes the `OK` above meaningful. The
   planted directory is also handed to the harness as an instruction
   directory (`--add-dir` plus the `project` setting source for Claude
   Code, which otherwise loads no project instruction file in headless
   runs), in both probes, so the control exercises the very channel
   `--hermetic` must close. A control that stays clean,
   answers anything but the code word, or fails fails the check: the
   hermetic probe passed, but it proved nothing about that harness on that
   machine.

The hermetic answer must be exactly `OK` (a trailing period or code fence is
tolerated). An `OK` beside anything else, such as an owner's name, fails.

Add `--tools none` to run the probes without built-in tools. The check
spends quota like any `check`.

## Per-harness status

Verified on 2026-09-17 against the installed binaries on the release
machine (Claude Code 2.1.270, Codex 0.154.0), sandboxed through scode,
both probes.

| Harness | `--hermetic` | `--tools none` | Mechanism |
|---------|--------------|----------------|-----------|
| Claude Code | verified | verified | `--safe-mode`: every customization disabled (CLAUDE.md at user and project level, skills, plugins, hooks, MCP servers, custom commands and agents); auth, model and built-in tools work normally. `--setting-sources user` stays, so a repository's own settings file never applies. `--tools ""` removes the built-in tools. `--bare` was rejected: it never reads the OAuth login, so a subscription run would bill an API key. |
| Z.AI | verified | verified | Same as Claude Code (same binary, Z.AI endpoint). |
| Codex | verified | verified at read-only | A private HOME and CODEX_HOME per run, holding only a hard link to the real `auth.json` (see below). `-c project_doc_max_bytes=0` skips AGENTS.md in the working directory; `--ignore-user-config` and `--ignore-rules` skip the user config and execpolicy rules; `--disable` for apps, plugins, remote plugins, hooks, memories, goals, shell snapshot; `include_apps_instructions=false`. `--tools none` disables the shell, unified exec, view_image, multi-agent, browser, computer-use, image-generation and tool-suggest features and sets `web_search = "disabled"`. `apply_patch` is tied to the model and cannot be removed, so `--tools none` is accepted only with `--auto read-only`, where scode denies writes to the working directory; locations scode keeps writable (harness state such as `~/.codex`, temp) remain reachable to it. Repositories (and a HOME used as the working directory) shipping `.agents/skills` or `.codex/skills` are refused. |
| Aider | refused | refused | Probably hermetic by construction: codemux already passes a packaged empty config, a null env file and packaged model files, and aider has no skills, hooks or MCP. Unverified: the live check needs a provider API key, and `--map-tokens 0` would still be needed to keep the repository map out of the prompt. No tool set to remove. |
| Cursor Agent | refused | refused | No flag or setting disables rules, `AGENTS.md`, hooks, or MCP servers; `~/.cursor` cannot be relocated with the login intact. |
| Droid | refused | refused | `--settings` merges a file over the user settings and `--disable-builtin-skills` covers only Factory's skills; AGENTS.md, hooks, MCP servers and custom droids from `~/.factory` still load. `--restrict-tools`, `--disabled-tools` exist and could support `--tools` once a hermetic mechanism exists. |
| Kimi Code | refused | refused | `--skills-dir` replaces skill discovery, but `~/.kimi-code` (config, MCP servers, agents) still loads and cannot be relocated with the login intact. |
| OpenCode | refused | refused | `--pure` drops external plugins only; the global config, `AGENTS.md`, and `.opencode` directories still merge. `XDG_CONFIG_HOME` could redirect the global config while `~/.local/share/opencode/auth.json` keeps the login, but project `AGENTS.md` discovery has no switch. Unverified. |
| OpenHands | refused | refused | `~/.openhands` microagents, skills, hooks and profiles load with no switch. |
| Cline, Copilot, Gemini CLI, Goose, Pi, Qwen | refused | refused | Not installed on the release machine; not audited. Copilot already passes `--no-custom-instructions` and `--disable-builtin-mcps`, so it is the nearest candidate. |

A harness moves from "refused" to "verified" when an adapter mechanism
exists and `codemux check --hermetic` passes with a leaking control probe.

## Codex: the private home

Codex reads its customizations from `$CODEX_HOME` (config.toml, AGENTS.md,
hooks.json, memories, plugins, the deprecated `skills` directory, execpolicy
rules) and from `$HOME/.agents/skills`. No flag turns all of that off, so a
hermetic run gets a fresh directory as both `HOME` and `CODEX_HOME`, holding
nothing but the login.

The private home lives inside the real CODEX_HOME, at
`.codemux-hermetic/run-<pid>-<random>/`, not under the temp root: scode
treats `~/.codex` as harness state on every platform, its Linux sandbox
mounts a fresh `/tmp` that would hide a home created there, and any write
policy for `~/.codex` then covers the private login too. Homes left behind
by codemux processes that no longer exist are swept on the next run.

The login is `auth.json`, and Codex rotates the tokens inside it. A copy
would strand the refreshed token in the private home and could leave the
real file holding a token the server no longer accepts. So the private home
carries a hard link to the real file: Codex 0.154 writes `auth.json` in
place (truncate and rewrite, never rename), which updates the shared inode,
so the real login stays current. A symlink is the fallback on a filesystem
without hard links. Should a future Codex replace the file instead of
rewriting it, the link diverges from the real file; codemux warns at exit
that the run's token rotation was discarded and that `codex login` may be
needed. Nothing is ever written back over the real file: a lock-free
reconciliation cannot tell this run's rotation from a concurrent login,
logout, or another run's refresh. `cli_auth_credentials_store="file"` pins
the file store: the Keychain entry is keyed by the real CODEX_HOME path and
would not be found from the private one, so a Keychain-stored login is
refused with an explanation (`codex login` with
`cli_auth_credentials_store = "file"`). With `CODEX_API_KEY` in the
environment (the variable Codex 0.154 reads; a stray `OPENAI_API_KEY`
changes nothing, exactly as in a plain run) the run is API-key-only: the
private home holds no login, even when a file login exists, so the
account login is never used or touched. The real home is the one a plain
run of the same command sees: `~/.codex`, or `$CODEX_HOME` when the
operator passes it through with `--pass-env CODEX_HOME`. The private home is removed at
exit. A SIGINT, SIGTERM or SIGHUP to codemux is forwarded to the child
process tree, which gets the usual grace period before SIGKILL; codemux
then stops with exit 143, so the run ends before its home goes. Homes left
by a codemux that died without cleaning up are swept once they are older
than two days, longer than any run may last.

The private home reaches Codex through `env HOME=… CODEX_HOME=… codex …`,
not through the environment codemux hands to scode: scode derives its
deny rules (`~/Documents`, `~/.aws`, and so on) from `$HOME`, so moving HOME
for the whole launch would move the sandbox's protected paths off the real
home. scode keeps the real home; only Codex sees the private one. Both
`env` and the `codex` it launches go through codemux's trusted-executable
check, so a repository cannot plant a `codex` on PATH for a hermetic run.

Codex refuses to launch when `CODEX_HOME` does not exist, so the directory
is created before the launch, never lazily.

## What hermetic does not cover

- The harness's own state directory when built-in tools stay on. A
  hermetic run with tools can still read the real `~/.codex` or
  `~/.claude` (config, instruction files, memories, the login) through its
  shell or file tools, because scode keeps harness state reachable.
  `--tools none` closes that; a reproducer relying on `--hermetic` alone
  should know a model that inspects its home can find the operator's files.
- Operator guardrails. Claude Code's `--safe-mode` drops the user's hooks
  and `permissions.deny` rules along with everything else, and Codex's
  `--ignore-user-config` drops the user's `shell_environment_policy`, so a
  restrictive policy for tool subprocesses no longer applies; with
  `--no-sandbox --auto high --hermetic`, nothing outside the model
  constrains the run. scode is the boundary, as always.
- Admin-managed policy layers. Claude Code's managed settings (including
  managed `SessionStart` hooks) still apply under `--safe-mode`, and Codex
  still loads `/etc/codex/config.toml` with `--ignore-user-config`. Both
  are the machine administrator's, not the operator's, and neither harness
  offers a switch. A reproducer on a managed machine should say so.

- The harness's own base system prompt, and for Codex the skills that ship
  with it (imagegen, openai-docs, plugin-creator, skill-creator and
  skill-installer at 0.154), which it extracts into any home. Both are part
  of the harness, not of the operator, and identical for every reproducer
  on the same version. Codex's `skip_host_skill_discovery` feature does not
  remove them.
- Under `--tools none`, neither Claude Code nor Codex can run a command or
  read a file (verified with a file whose content the model could not
  guess). A Codex release that renames a disabled feature would fail
  open (an unknown feature key only logs a warning), which the version
  contract's "newer than audited" warning is the cue for. Codex keeps
  `update_plan` and `apply_patch`; the latter is why
  Codex accepts `--tools none` only at read-only autonomy, and even there
  `apply_patch` can still write where scode allows writes (harness state
  such as `~/.codex`, temp), which a plain shell tool could too. A model's
  self-report of its tools is unreliable in both directions (Claude listed
  five tools it did not have), so verify a new version with a capability
  probe, not a listing.
- Content of the working directory that the harness reads on its own
  initiative through a tool it still has. `--tools none` closes that;
  `--auto read-only` under scode bounds it otherwise.
- Environment variables. Codemux passes the sanitized environment it always
  passes (see `src/environment.ts`).

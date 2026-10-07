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
added. `--tools none` works without `--hermetic` too — except on OpenCode,
where it is refused without it (the operator's config can override the
deny per agent; see the table). Both are headless (`run` and `check`)
only.

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

Add `--tools none` and both probes run without built-in tools: the control
repeats the hermetic probe's tools selection unchanged, so `--hermetic` is
the only difference between the two requests. That is what makes the
comparison mean anything — a control that leaks with the same tools proves
the planted files reached the model through a channel that needed no tool,
so the hermetic probe's clean `OK` attributes to isolation, not to tool
removal.

A harness whose `--tools none` is hermetic-only (OpenCode) cannot meet
that bar — its plain control would be a `--tools none` run the adapter
itself refuses (the operator's config can override the deny per agent) —
so `check --hermetic --tools none` refuses the combination before any
request is spent. Check such a harness with `--hermetic` alone for the
isolation claim; the `--tools none` claim keeps its own capability probes
(the read and shell probes of the live pass). The h6 review had accepted
an armed default-tools control here as an unclosable residual; the h7
review removed it (2026-10-04).

The check spends quota like any `check`.

## Per-harness status

Verified on 2026-09-17 against the installed binaries on the release
machine. Claude Code 2.1.270 and Codex 0.154.0 ran both probes sandboxed
through scode; OpenCode 1.18.18 ran through a provider override (GLM-5.3
via Z.AI) with `--no-sandbox --auto high`, the method the all-harnesses
pass records, so scode did not gate those probe runs. Aider's 2026-09-17
pass was withdrawn on 2026-10-04; see its row below.

| Harness | `--hermetic` | `--tools none` | Mechanism |
|---------|--------------|----------------|-----------|
| Claude Code | verified | verified | `--safe-mode`: every customization disabled (CLAUDE.md at user and project level, skills, plugins, hooks, MCP servers, custom commands and agents); auth, model and built-in tools work normally. `--setting-sources user` stays, so a repository's own settings file never applies. `--tools ""` removes the built-in tools. `--bare` was rejected: it never reads the OAuth login, so a subscription run would bill an API key. Under a provider override (`CODEMUX_CLAUDE_PROVIDER_*` → `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, the gateway env the Z.AI endpoint uses; the endpoint must serve the Anthropic Messages API) the operator's login plays no part at all: the sandboxed Keychain credential-mirror sync is skipped — nothing of the operator's login is copied for a run that does not use it — and the operator's own `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` are kept out of the child environment, so no second, operator-funded credential path exists. A mirror that still holds a refresh token still refuses the launch, because the sandboxed child reads `~/.claude` whatever credential it runs on. |
| Z.AI | verified | verified | Same as Claude Code (same binary, Z.AI endpoint). |
| Codex | verified | verified at read-only | A private HOME and CODEX_HOME per run, holding only a hard link to the real `auth.json` (see below). `-c project_doc_max_bytes=0` skips AGENTS.md in the working directory; `--ignore-user-config` and `--ignore-rules` skip the user config and execpolicy rules; `--disable` for apps, plugins, remote plugins, hooks, memories, goals, shell snapshot; `include_apps_instructions=false`. `--tools none` disables the shell, unified exec, view_image, multi-agent, browser, computer-use, image-generation and tool-suggest features and sets `web_search = "disabled"`. `apply_patch` is tied to the model and cannot be removed, so `--tools none` is accepted only with `--auto read-only`, where scode denies writes to the working directory; locations scode keeps writable (harness state such as `~/.codex`, temp) remain reachable to it. Repositories (and a HOME used as the working directory) shipping `.agents/skills` or `.codex/skills` are refused. A provider-override run (`CODEMUX_CODEX_PROVIDER_*`) reuses the private-home mechanism with one difference: the home holds the override's own `config.toml` — a `model_providers.codemux` entry whose `env_key` points at the environment codemux provides, so the provider key is the credential — and links no `auth.json`; `--ignore-user-config` is not passed because it skips `$CODEX_HOME/config.toml` itself, exactly where the override lives (the other hermetic flags still ride). |
| Aider | refused | refused | No switch closes aider's own config layers, and they load inside the aider process, where codemux's `AIDER_*` sanitizer block and the project-config assertions never see them: configargparse reads `.aider.conf.yml` from the working directory, the git root and the home alongside whatever `--config` names (`default_config_files`, `main.py` at 0.86.2), and `generate_search_path_list` runs the same home/git-root/cwd search for `.env` (every found file loads with `override=True` before arguments are re-parsed, so an `AIDER_READ` in `~/.env` takes effect) and for `.aider.model.settings.yml` (which can set `system_prompt_prefix`) alongside the pinned `--model-settings-file`. Every codemux run already pins the config, env file, model metadata and input history to packaged or null paths, and the `--hermetic` mapping would add `--map-tokens 0` to keep the repository map out of the prompt — but a `.aider.conf.yml` with `read: <file>` still injects that file's content into every chat, and the working-directory and git-root variants cannot be closed at all while the run works on the operator's project. Confirmed live on 2026-10-04 through the provider override (GLM-5.3 via Z.AI, `CODEMUX_AIDER_PROVIDER_{BASE_URL,API_KEY,MODEL}` → litellm's `openai/` model prefix with `OPENAI_API_BASE`/`OPENAI_API_KEY`; the key rides the environment codemux provides, never an operator file): a plain run whose working directory held only a `.aider.conf.yml` naming a canary note answered with the note's code word — "Added canary-note.md to the chat (read-only)" in the transcript, `CODEMUX-PROBE-… OK` as the reply, the prompt itself carrying no code word — with every pinned flag in place. The 2026-09-17 two-probe check had passed because its canary plants `AGENTS.md`/`CLAUDE.md`, a channel the control already exercises through `--read`; it never rode the config layers, so it certified what the pinned flags do not close (withdrawn in the 2026-10-04 review). The answer-extraction machinery — a per-run chat-history file under `~/.aider/.codemux/`, 0600 under a 0700 parent, removed at exit, whose bare reply and reasoning the check would read — stays for the day aider grows a switch; only a hermetic run creates it, and plain runs keep `--chat-history-file /dev/null`, so no run today writes its conversation to disk (2026-10-04 h6 review). No tool set to remove; `--tools none` has nothing to map onto. |
| Antigravity | refused | refused | No mechanism: nothing disables the instruction files, config manifests, MCP servers, and plugins under `~/.gemini` and `.agents/`, and `--disable-slash-commands` (1.2.14) covers only slash-command and skill expansion in print mode. There is also no tool-removal flag for `--tools none`. Unverifiable besides: the audit machine has no Antigravity login, so the live canary could not run (2026-10-04). |
| Cursor Agent | refused | refused | No flag or setting disables rules, `AGENTS.md`, hooks, or MCP servers, and `--plugin-dir` adds plugins rather than removing them (2026.08.11 `--help`); `~/.cursor` cannot be relocated with the login intact. No tool-removal flag exists, so `--tools none` has nothing to map onto. This machine has no Cursor login either (`agent models` fails authentication), so no live check is possible here regardless. |
| Droid | refused | verified | No switch disables instruction files: AGENTS.md and CLAUDE.md load from the working directory up to the git root, skills load from both `~/.factory/skills` and `~/.agents/skills` (`droid doctor`, 0.221.0, names both), and hooks, MCP servers and custom droids from `~/.factory` still load; `--disable-builtin-skills` (0.221.0 `exec --help`) covers only Factory's builtins. Confirmed live on 2026-09-17 through the provider override (GLM-5.3 via Z.AI, `CODEMUX_DROID_PROVIDER_{BASE_URL,API_KEY,MODEL}` → a per-run BYOK settings file passed as the root-level `--settings <path>`, "merged for this process only", holding one `customModels` entry whose `apiKey` is the `${CODEMUX_DROID_PROVIDER_API_KEY}` reference — the value rides the environment codemux provides; docs.factory.ai/model-independence/byok): a plain control run in the planted canary directory answered with the code word, so the instruction-file channel demonstrably reaches the model and the refusal stands on a live leak. Selection note: droid resolves a custom model by the entry's `id`, not its `model` name — the entry and the `-m` value use `custom:codemux:<model>-0`, the shape of the operator's own working entries; a `-m` naming only the API model id falls through to Factory inference and fails authentication. `--tools none` maps onto `--only-tools ToolSearch`: IDs are validated, so a renamed tool aborts the launch, and the binary's free `--list-tools` inventory (0.221.0) shows every Read, Edit, Execute and MCP tool blocked under it. Verified live through the same override: under `--tools none` the session transcripts contain no tool call at all, the read probe produced no secret, and the shell probe produced fabricated output rather than the real transform of the planted token (the transform design is what makes the fabrication detectable), while a plain run's model read the file and produced the secret. The plain-run shell probe could not execute on this machine — every `Execute`, even `echo ok`, was SIGKILLed because droid's own command sandbox cannot nest inside the session's outer sandbox — an environment artifact of the probe host, not of the mapping; the read probe carried the plain-run burden. An empty `--only-tools ""` is silently ignored and `--remove-tools` cannot drop the pinned ToolSearch, so neither was used. |
| Kimi Code | refused | verified | Hermetic has no mechanism: the AGENTS.md merger (`loadAgentsMdForRoots`, embedded `packages/agent-core` source in the 0.31.1 binary) unconditionally merges `<brand home>/AGENTS.md` and `~/.agents/AGENTS.md` — the latter under the real OS home, so `KIMI_CODE_HOME`, which 0.31.1 does honor for config.toml, mcp.json, skills, agents and SYSTEM.md, cannot close it — plus `.kimi-code/AGENTS.md` and then `AGENTS.md`/`agents.md` in the working directory, and the system prompt carries the merged text (`{{ KIMI_AGENTS_MD }}`); no flag or environment variable turns any of it off (skills are the one channel with a switch, `--skills-dir`). Confirmed live on 2026-09-17 through the provider override (GLM-5.3 via Z.AI, `CODEMUX_KIMI_PROVIDER_{BASE_URL,API_KEY,MODEL}` → the `KIMI_MODEL_*` environment group, which synthesizes a temporary provider in memory — kimi-code docs, "Define a model from environment variables"; the override suppresses the `-m` flag because a config alias would outrank the synthesized model): the control probe quoted the planted code word and named `~/.agents/AGENTS.md`'s owner, exactly the channels the refusal documents. `--tools none` maps onto a generated agent file passed as `--agent-file` ("Load an agent definition from a Markdown file", 0.31.1 `--help`): the frontmatter `tools` key is the profile's own allowlist (`tools: []` is the file's set; the tool manager's gates are strict membership tests over it, so no built-in and no MCP tool is exposed, and a profile renderer prints the state as "Tools: none"), and the file's required prompt body is `${base_prompt}`, which an explicit agent file renders as the default profile's own prompt, so kimi's base instructions stay. Codemux writes the file under `<brand home>/.codemux/`, a directory no discovery scans (user agents come from `<brand home>/agents` and `~/.agents/agents`, embedded `roots.ts`), and removes it at exit. Verified live through the same override: under `--tools none` the read probe could not produce a planted secret and the shell probe could not produce a transformed one (the model announced the task but never executed), while a plain run produced the secret. |
| OpenCode | verified | verified on hermetic runs; refused on plain runs | A private `HOME` per run under `~/.local/share/opencode/.codemux-hermetic/` (scode treats the data directory as harness state), reached through `env` so scode keeps the real home: `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `XDG_STATE_HOME` redirect into it, making the global config, the global `AGENTS.md`, global agents/commands/modes/skills, the legacy `~/.opencode`, and the `~/.claude`/`~/.agents` trees unreachable (paths derived from xdg-basedir, `packages/core/src/global.ts` at 1.18.18), while `XDG_DATA_HOME` keeps the real data directory so the in-place-rewritten `auth.json` login keeps working with no link. `OPENCODE_DISABLE_PROJECT_CONFIG=1` closes project `AGENTS.md`/`CLAUDE.md`/`opencode.json`/`.opencode` discovery (`session/instruction.ts`, `config/paths.ts`), `OPENCODE_DISABLE_CLAUDE_CODE=1` and `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` close the `~/.claude` fallbacks (`packages/core/src/flag/flag.ts`, `effect/runtime-flags.ts`). The config variables `OPENCODE_CONFIG`/`OPENCODE_CONFIG_DIR`/`OPENCODE_CONFIG_CONTENT` are REMOVED through `env -u`, never blanked: `Global.Path.config` reads `Flag.OPENCODE_CONFIG_DIR ?? Path.config`, and an empty string survives `??`, turning `path.join(global.config, "AGENTS.md")` into a project-relative file the ungated global-files loop then loads — a live leak at 1.18.18, found by pointing the provider override at a tee proxy and reading the request. Verified live on 2026-09-17 through the provider override (GLM-5.3 via Z.AI, `CODEMUX_OPENCODE_PROVIDER_{BASE_URL,API_KEY,MODEL}` → a private `OPENCODE_CONFIG` file codemux writes under the data directory's `.codemux/`, referencing the key as `{env:CODEMUX_OPENCODE_PROVIDER_API_KEY}`): the two-probe check passed with and without `--tools none`, the planted code word reaching the control probe both times. Two check-level notes from that session: the hermetic probe's prompt now forbids tool use, because GLM-5.3 under `--auto` answered the question by reading the planted `CLAUDE.md` itself while its request was clean (a model's own discovery is not a config leak); and the shell capability probe must ask for an output the prompt does not contain (a transform such as `cat \| tr`), because the model otherwise parrots the echoed text. `--tools none` maps onto `OPENCODE_PERMISSION={"*":"deny"}`, merged after every config layer, which removes every tool from the model's request (`config.ts`, `permission/index.ts`, `session/llm/request.ts`; source tag v1.18.18, github.com/anomalyco/opencode, opencode.ai/docs/config): verified live on hermetic runs — under it the read probe could not produce a planted secret and the shell probe could not produce a transformed one, while both succeeded in plain runs without the deny. Plain runs refuse the capability since the h2 review (2026-10-04): the deny merges into the top-level `permission` only, while the operator's config can append per-agent permission rules AFTER it (`item.permission = Permission.merge(item.permission, …)` in `agent/agent.ts`, and `mode` entries fold into agents after even `OPENCODE_CONFIG_CONTENT` in `config.ts`), and the last matching rule wins (`findLast` in `permission/index.ts`) — proven live at 1.18.18 through codemux's own plain-run path, where an operator config of `"agent": {"build": {"permission": {"bash": "allow"}}}` put the bash tool into the model's request under the deny (the same run against an empty operator config sent no tools; the probe drove a local OpenAI-compatible mock through `CODEMUX_OPENCODE_PROVIDER_*`, sandboxed, `--auto medium`). No environment variable spells per-agent or mode permissions and a codemux-written config layer still merges before the mode fold, so plain runs fail closed with "opencode --tools none requires --hermetic" instead. The h7 review (2026-10-04) adds the check-level consequence: `check --hermetic --tools none` refuses for OpenCode before probing, because its control probe would be exactly that refused plain run (the control repeats the probe's tools selection; see the verification section). The h3 review (2026-10-04) found the same override channel inside a hermetic run, attached to the login: config load iterates the auth store and, for every entry of type `wellknown`, fetches `<login>/.well-known/opencode`, and fetches `<account>/api/config` for the active organization in the data directory's `opencode.db`, merging both as global config — custom prompts, plugins and agent permissions included — unconditionally, with no flag gating either fetch (`config.ts` at 1.18.18; the private home changes nothing here, because the login's data directory stays real). Proven live at 1.18.18 through the exact hermetic launch path — the adapter's own command and scode wrapper, driven against a local mock — with a well-known entry as the auth store's only content: the run fetched the login's `/.well-known/opencode` and the model's request carried the bash tool under the `--tools none` deny, while the identical launch with an empty auth store fetched nothing and sent no tools. A hermetic run therefore inspects the login state before launch (`src/opencode-remote-config.ts`) and refuses while it carries either carrier: a well-known login (`opencode auth logout <id>` clears it) or an account with an active organization (deactivate the organization or log out of the account). A store that exists but cannot be read — the auth store symlinked, oversized, unparsable, or a FIFO; the account store not a regular file — fails closed with the same refusal: OpenCode follows symlinks codemux refuses, so skipping the inspection would miss a real carrier, and the reads are bounded, nonblocking and no-final-symlink (2026-10-04 h6 review). The auth store has one more mouth: `Auth.all` reads a passed-through `OPENCODE_AUTH_CONTENT` before the file (`auth/index.ts`), so the hermetic env prefix removes that variable alongside the config ones. Residual, no switch: admin-managed settings (see "What hermetic does not cover") and instruction files OpenCode attaches next to files the model itself reads (`session/instruction.ts` `resolve`; not the working-directory root, where the check plants its canary). |
| OpenHands | refused | refused | The user-level channels are closeable — `OPENHANDS_PERSISTENCE_DIR` (CLI 1.16.0 `locations.py`) relocates `agent_settings.json`, `mcp.json` and `conversations/`, and a private `HOME` relocates `auth/`, `hooks.json`, `profiles/` and the plugin caches — but the project channel has no switch at all: `_build_agent_context()` (CLI `agent_store.py`) calls `load_project_skills()` on every run, which loads `.cursorrules`, `AGENTS.md`, `agent.md`, `CLAUDE.md` and `gemini.md` case-insensitively from the working directory and the git root, plus `.agents/skills` and `.openhands/skills` from both, and the CLI also hard-codes `load_user_skills=True` and `load_public_skills=True` (vendor skills from the public OpenHands repository). The planted `AGENTS.md`/`CLAUDE.md` of the check would always reach the model, so no mechanism can meet the bar. Verified live on 2026-09-17 through the provider override (`CODEMUX_OPENHANDS_PROVIDER_*` → `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` behind `--override-with-envs`, GLM-5.3 via Z.AI; the override was cut with the 0.7.0 dead-surface sweep and restored once `--override-with-envs` gained a non-refusal purpose as its model-selection channel): a plain control run in the canary directory answered with the planted code word, so the project channel demonstrably reaches the model and the refusal stands on a live leak, not only on source reading. No tool-removal flag exists either: the tool list comes from the persisted agent or the CLI default. |
| Copilot | refused (the control cannot leak by construction) | refused (no empty allowlist disarms the tools) | A hermetic mechanism existed and is removed in 0.7.0 as dead surface: nothing can verify it (below), and the refusal stands on its own evidence. The mechanism was `env COPILOT_HOME=<private>` in front of the command, pointing every user-level channel at a fresh, empty directory under the real config directory (`~/.copilot/.codemux-hermetic/run-<pid>-<random>/`, swept at exit): settings.json and config.json (user settings, hooks, URL rules, trusted folders), `copilot-instructions.md`, the modular instruction files, skills, custom agents, plugins, the MCP config, memories and session state ("override the directory where configuration and state files are stored", 1.0.85 `copilot help environment`; the user instruction locations follow it, docs.github.com "Add custom instructions"), and setting COPILOT_HOME also stopped skills loading from `~/.agents/skills` (changelog 1.0.66). The repo channels close with what every run already carries: `--no-custom-instructions` ("Disable loading of custom instructions from AGENTS.md and related files", 1.0.85 `--help`) covers AGENTS.md, CLAUDE.md (and `.claude/CLAUDE.md`), GEMINI.md, `.github/copilot-instructions.md` and `.github/instructions/`; repo hooks, workspace MCP and repo extensions load in prompt mode only from a trusted folder or `GITHUB_COPILOT_PROMPT_MODE_*` env vars (1.0.85 source, gated behind `folderTrustIsTrusted`), and under the removed mechanism the trust state lived in the private home's config.json, which started empty; repository-controlled executables are rejected before launch as in every run. The built-in GitHub MCP server, an account-level integration, is disabled at every autonomy level below high in every codemux run. The login was the mechanism's remaining channel, and it held: the OAuth token in the OS keychain (service `copilot-cli`, docs.github.com "Authenticate Copilot CLI") is keyed by service name and not by the config directory, so the empty home authenticated; a plaintext fallback token in the real config.json (keychain-less systems) did not follow, and such a run failed authentication with Copilot's own error rather than silently losing hermeticity. `--tools none` has no working mapping: `--available-tools` is the documented model-visible allowlist ("Only these tools will be available to the model", 1.0.85 `--help`; "These filters decide which tools the model can see", `copilot help permissions`), but no argv spelling of an empty allowlist disarms the tools — verified live at 1.0.85 through a provider override this tree no longer ships (GLM-5.3 via Z.AI, `CODEMUX_COPILOT_PROVIDER_{BASE_URL,API_KEY,MODEL}` → the documented BYOK environment group `COPILOT_PROVIDER_BASE_URL`/`COPILOT_PROVIDER_TYPE=openai`/`COPILOT_PROVIDER_API_KEY` plus `COPILOT_MODEL`, docs.github.com "Use bring-your-own-key (BYOK) models with Copilot CLI"; the group activates before any GitHub authentication, app.js at 1.0.85 returning from provider initialization before the GitHub directory and login flow run, so the probes needed no Copilot login): under a bare `--available-tools`, under `--available-tools=`, and under `--available-tools ""`, the read probe produced the planted secret and the shell probe produced the true byte count of the planted file (`cat notes.txt | wc -c`), exactly as in plain runs — the optional-variadic flag (`[<tools>...]`, 1.0.85 `--help`) parses every empty spelling into an absent filter rather than an empty allowlist, and the autonomy level is not the explanation ("These flags control approval prompts and do not expose tools that were filtered out by --available-tools/--excluded-tools", `copilot help permissions`). The same live pass grounds the hermetic refusal: the plain read probe produced the planted secret and the plain shell probes demonstrably executed (`cat notes.txt | tr a-z A-Z` ran — the model reported the exit and the credential-shaped content but declined to echo the token; `cat notes.txt | wc -c` answered the true 30), so the harness ran against the custom endpoint with its tools intact, while the non-hermetic control probe answered `Peter` — the person named inside the user-installed skill `~/.agents/skills/domain-dns-ops/SKILL.md`, a live leak of the user-skill channel a plain run loads and the private `COPILOT_HOME` closes — with the planted code word never appearing, because `--no-custom-instructions` rides every codemux run including the control; a control that answers anything but the code word fails the check, and dropping the flag from plain runs to let the control leak would un-harden every run. Both refusals therefore stand on live evidence at 1.0.85 (installed via npm; the mechanisms themselves predate the audited 1.0.77 — `--available-tools` added 0.0.370, the COPILOT_HOME skills change 1.0.66). |
| Cline | refused | refused | No switch disables the workspace instruction channels: every headless run constructs the user-instruction service with rules, skills and workflows (`createUserInstructionConfigService`, `apps/cli/src/main.ts` at 3.0.62), which loads `<workspace>/AGENTS.md` — a first-class rule the loader itself names "Workspace AGENTS.md" — plus `.clinerules` (file or directory), `.cline/rules`, `.cline/skills`, `.agents/skills` and `.cline/hooks` (`sdk/packages/core/src/extensions/config/user-instruction-config-loader.ts`; the search paths in `sdk/packages/shared/src/storage/paths.ts`). The internal disable mechanism, `configExtensions` (`sdk/packages/shared/src/session/runtime-config.ts`, `DEFAULT_RUNTIME_CONFIG_EXTENSIONS` all-on), is a runtime API the CLI never exposes: no flag, environment variable or settings key sets it. The global channels under the real home — `~/.agents/AGENTS.md` ("Global AGENTS.md"), `~/.agents/skills`, `~/.agents/plugins` (Agent Plugins, started through the Hub), `~/Cline/Rules` and `~/Documents/Cline/{Rules,Workflows,Plugins}` — resolve `$HOME` at module load, so the documented relocation levers `--config <path>` ("Configuration directory (default: ~/.cline)") and `--data-dir <path>` (3.0.62 `--help`, backed by `CLINE_DIR`/`CLINE_DATA_DIR`) cannot reach them, and moving HOME itself strands the provider login at `~/.cline/data/settings/providers.json`. MCP servers load from `~/.cline/settings/cline_mcp_settings.json` and workspace `.cline/`, plus every enabled plugin's servers, with no `--no-mcp`. `--tools none` has no mechanism either: `enableTools: true` is hard-coded in the one-shot path, the only tool knob on the command line is approval (`--auto-approve <boolean>`, "Set tool auto-approval for all tools"), and the CLI's `ToolPolicy` record carries a single `autoApprove` for `*`. Confirmed live on 2026-09-17 at 3.0.62 (installed via npm) through a provider override this tree no longer ships (GLM-5.3 via Z.AI, `CODEMUX_CLINE_PROVIDER_{BASE_URL,API_KEY,MODEL}` → a private `--data-dir` whose `settings/providers.json` carries one `openai-compatible` entry; the flag's isolated-state mode is what keeps the run on the custom endpoint at all, because a plain one-shot delegates to cline's hub daemon, which drops the file's base URL — see docs/HARNESS-COMPATIBILITY.md): a plain control run answered with the planted code word, and the model's reasoning named both channels — "Workspace AGENTS.md" quoting the code word and "Global AGENTS.md" naming the operator from `~/.agents/AGENTS.md` — so the refusal stands on a live leak through both the workspace and the global channel, while the plain read and shell probes produced the planted secret and its transform (the harness itself live against the custom endpoint). |
| Gemini CLI | refused | refused (the mapping cannot load on a user-owned prefix) | Hermetic has no mechanism: nothing closes the workspace channels. The hierarchical context-file discovery loads `GEMINI.md` (the default `contextFileName`; `getContextFileNames` at 0.60.0) from the working directory up the tree, the `.gemini` directory, the user directory and every `--include-directories` path; workspace `.gemini/settings.json` applies in trusted folders; workspace policy directories are accepted and loaded even non-interactively ("WARNING: Workspace policies changed or are new. Automatically accepting and loading them.", 0.60.0 source); and `GEMINI_CLI_HOME`, which alone could relocate the user layer (settings, `GEMINI.md`, extensions under `extensions/`, skills under `skills/`, policies), replaces gemini's whole home directory and would strand the login with it. The check's control probe could never leak either: gemini loads only `GEMINI.md` or a settings/extension-configured context file name — never `AGENTS.md` or `CLAUDE.md` — so the planted code word cannot reach the model even in a plain run. Installed 0.60.0 and exercised live on 2026-09-17; no provider override can route it to a second provider either, so the hermetic side cannot even be verified that way: `GOOGLE_GEMINI_BASE_URL`, the only custom-endpoint variable, resolves the auth type to "gateway", which the CLI's own `validateAuthMethod` rejects ("Invalid auth method selected.", observed live), and pinning `selectedType: "gemini-api-key"` alongside it still landed the request on Google — the live error carries `generativelanguage.googleapis.com` service metadata, while Z.AI's endpoint answers a Gemini-protocol path with its own `code 1001` auth error when the SDK's `x-goog-api-key` header is used and with a `500` error body even under `Authorization: Bearer`; Z.AI documents only Anthropic- and OpenAI-protocol endpoints (docs.z.ai/devpack/tool/others). `--tools none` has a mapping that cannot be claimed, so the capability is refused; the mapping (a private file under `~/.gemini/.codemux/` holding the packaged system-settings pins plus `tools.core: []`, with `GEMINI_CLI_SYSTEM_SETTINGS_PATH` — the variable every codemux gemini run uses for the packaged file — pointed at it) is removed in 0.7.0 as dead surface. It rode the `tools.core` setting ("Restrict the set of built-in tools with an allowlist", settings schema at 0.60.0), and an empty allowlist would have been enforced twice: `maybeRegister` keeps a built-in tool only when the non-null list names it, so none registers and the model is never offered the schemas, and the policy engine pushes a wildcard DENY beneath the (empty) allows, denying every remaining execution path, MCP tools included; the system layer merges last (highest precedence, `mergeSettings` at 0.60.0), so user and workspace settings cannot re-widen the list. But the layer never loads on a user-owned prefix: gemini skips a system settings file unless the file and every ancestor directory up to `/` is owned by root (uid 0), not group- or world-writable, and not a symlink (`checkPosixStatsSecurity`/`isFileAndDirectorySecureSync` at 0.60.0, present identically at the audited 0.53.1), and a skip is a silent fail-open — the run starts with its tools restored. Observed live at 0.60.0: every gemini run codemux launched printed "Skipping system settings file '…/resources/gemini-system-settings.json': … not owned by root (uid 0). Current uid: 501", so the private `--tools none` file the mapping wrote under the user's home was skipped the same way — which is the refusal's reason, not just its history. The same warning shows the packaged pin file every plain run points at has never loaded on a user-owned prefix either (any Homebrew or source checkout is user-owned) — a contract gap recorded in docs/HARNESS-COMPATIBILITY.md, not a 0.60.0 regression. |
| Goose | refused | verified | Hermetic is blocked by one channel with no switch: `GOOSE_SYSTEM_PROMPT_FILE_PATH`, a config-file key that replaces goose's whole system prompt with a template of the operator's choosing, is read unconditionally by every session (`configure_session_prompts`, `crates/goose-cli/src/session/builder.rs` at 1.50.1, present at the audited 1.45.0); no flag disables it, and `get_param`'s env-first lookup cannot neutralize a config value here — an env value pointing at an empty file would empty the base prompt (`override_system_prompt` replaces the template), and a bad path aborts the launch. The documented wholesale escape `GOOSE_PATH_ROOT` ("Override the root directory for all goose data, config, and state files", `environment-variables.md` at 1.50.1) relocates config, data, state and the `.agents` trees, and the keyring login would survive it (the service name is the constant `goose`, not a path), but the same config.yaml also holds the active provider and model (`get_active_provider`), which a fresh root has no source for — carrying them over means importing operator config — and the global skill directories under the real home (`~/.agents/skills`, `~/.claude/skills`, `~/.config/agents/skills`, found via `dirs::home_dir()` in `skills/mod.rs`) escape the root entirely. The other channels do close with documented switches: `--no-profile` ("Don't load your default extensions, only use CLI-specified extensions", `run --help` at 1.50.1 and 1.45.0) drops every profile extension and every project plugin MCP server, and the context-file channel — `.goosehints` and `AGENTS.md` from the working directory up to the git root, the config directory, and `~/.agents/AGENTS.md` — would close with `CONTEXT_FILE_NAMES=[]` (documented env var, "JSON array of strings"; the default fires only when the key is absent or unparsable, never on an empty list, `load_hints.rs` at both versions), so a leaking control probe is exercisable in principle. Confirmed live on 2026-09-17 at 1.50.1 (installed via the official `download_cli.sh` with `CONFIGURE=false`, `~/.local/bin/goose`) through the provider override (GLM-5.3 via Z.AI, `CODEMUX_GOOSE_PROVIDER_{BASE_URL,API_KEY,MODEL}` → the environment group `GOOSE_PROVIDER`/`OPENAI_HOST`/`OPENAI_BASE_PATH`/`OPENAI_API_KEY`/`GOOSE_MODEL`, every value riding goose's env-first lookup — `get_param`, `crates/goose/src/config/base.rs` at 1.50.1 — so no operator file is touched; the endpoint split mirrors goose's own `derive_base_path`, so `https://api.z.ai/api/coding/paas/v4` becomes `OPENAI_HOST=https://api.z.ai` with `OPENAI_BASE_PATH=api/coding/paas/v4/chat/completions`, and a base path containing `chat/completions` forces the chat-completions protocol): a plain control run in the planted canary directory answered with the code word, so the context-file channel — the one `CONTEXT_FILE_NAMES=[]` would close and no run closes today — demonstrably reaches the model and the refusal stands on a live leak. `--tools none` maps onto `--no-profile`: with no CLI-specified extensions the session instantiates none (`collect_extension_configs` returns the empty CLI set under the flag), and every tool — the developer, skills and memory platform extensions included — reaches the model only through an extension, so the model is offered none. Verified live through the same override: under `--tools none` the read probe produced no output at all and the shell probe produced a fabricated quip rather than the real transform of the planted token, while plain runs produced both the secret and its transform. |
| Pi | refused | verified | Every channel but one closes with documented switches: `--no-context-files` ("Disable AGENTS.md and CLAUDE.md discovery and loading", 0.85.1 `--help`; `core/resource-loader.js` skips `loadProjectContextFiles`, which reads the global context file from `~/.pi` and walks the working directory to the root, not trust-gated, so a plain run's control probe can leak), `--no-skills`, `--no-extensions`, `--no-prompt-templates` and `--no-themes` — and the `--no-approve` ("Ignore project-local files for this run") every codemux pi run already passes forces the project untrusted, dropping `<cwd>/.pi/` settings, extensions, skills, prompts, themes, SYSTEM.md and APPEND_SYSTEM.md plus the `.agents/skills` walk-up (`TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES`, `core/trust-manager.js`; with no in-session trust cache the CLI override wins, `main.js`). The channel with no switch is the global `~/.pi/SYSTEM.md` and `~/.pi/APPEND_SYSTEM.md`, which replace or append to the system prompt (`discoverSystemPromptFile` falls back to `~/.pi/SYSTEM.md` unconditionally, and the session passes both into the base prompt as `customPrompt`/`appendSystemPrompt`, `core/agent-session.js`). The only suppression is an empty value to `--system-prompt`/`--append-system-prompt`, which at 0.85.1 skips discovery only because an empty string is falsy where the loader checks nullish — undocumented, not exercised by the check's planted `AGENTS.md`/`CLAUDE.md`, and fail-open on any refactor; not accepted as a mechanism. `PI_CODING_AGENT_DIR` relocates all of `~/.pi` including the credentials, so it cannot close it either. Confirmed live on 2026-09-17 at 0.85.1 through the provider override (GLM-5.3 via Z.AI, `CODEMUX_PI_PROVIDER_{BASE_URL,API_KEY,MODEL}` → a private agent directory behind `PI_CODING_AGENT_DIR` — the only knob that relocates the `models.json` pi reads custom providers from, `getAgentDir`, config.js at 0.85.1 — holding a one-provider `models.json` whose `apiKey` is the `${CODEMUX_PI_PROVIDER_API_KEY}` reference; pi expands `$VAR`/`${VAR}` config templates from the environment at auth time, `resolve-config-value.js` at 0.85.1, so the value rides the environment codemux provides and the run needs no stored login): the plain control probe in the planted canary directory answered with the code word, so the working-directory context-file channel — the one `--no-context-files` would close and `--no-approve` does not gate — demonstrably reaches the model and the refusal stands on a live leak. `--tools none` maps onto `--no-tools` ("Disable all tools by default (built-in and extension)", 0.85.1 `--help`) with the autonomy mapping's `--tools` allowlist suppressed, because pi resolves an explicit allowlist over `--no-tools` (`options.tools ?? (options.noTools === "all" ? [] : undefined)`, `core/sdk.js`). Enforcement is a strict gate: an empty allowlist becomes an empty set — truthy — so `isAllowedTool` is false for every built-in, extension and custom tool, and the tool registry, the definitions map and the active tool set all end empty (`_refreshToolRegistry`, `core/agent-session.js`); pi has no MCP configuration channel of its own (MCP-shaped tools arrive through extensions and pass the same gate). Verified live through the same override: under `--tools none` the read probe answered that it had no tools to read the file and produced no secret, and the shell probe produced no output at all, while plain runs produced the planted secret and its transform. |
| Qwen | refused (already hermetic by construction) | refused | Every codemux qwen run already passes `--safe-mode` (since codemux 0.2.0), and at 0.24.0 that flag closes every operator channel at once (package source, `@qwen-code/qwen-code` on npm): the startup hierarchical-memory load returns early and clears user memory and context-file paths (`refreshHierarchicalMemory`, `packages/core/src/config/config.ts`), so neither the working directory's context files — `QWEN.md` and `AGENTS.md` are both context filenames (`packages/core/src/utils/memory-constants.ts`) — nor `--include-directories` ever loads (the later reload path logs "Safe mode active — skipping memory reload from include directories.", `packages/cli/src/ui/commands/directoryCommand.ts`); skills fall back to the bundled set, subagents to the built-in set, hooks are all disabled (`getDisableAllHooks`), extensions load none, auto-memory, auto-skill and team memory are off, and the effective MCP map shrinks to the session-injected and `--mcp-config` servers captured at boot (codemux passes none). A plain run is therefore already hermetic and `--hermetic` has nothing left to close, so the two-probe check can never pass: its control probe is a plain run under the same safe mode, the planted `AGENTS.md` code word can never reach the model, and a control that stays clean fails the check by design. Dropping `--safe-mode` from plain runs to make the control leak would un-harden every run, so the flag stays refused. `--tools none` has no mechanism that survives safe mode: `--core-tools`, the allowlist a non-empty value of which "rejects any tool not in this set", is forced to `undefined` under safe mode with the warning "Safe mode: --core-tools flag is ignored (settings-sourced core tools are also disabled)." (`packages/cli/src/config/config.ts`), settings are zeroed the same way, and `--exclude-tools` is an exclusion list matched only by exact tool identifier (`isToolEnabled`, `packages/core/src/tools/tool-utils.ts`), so it fails open on any tool an upgrade adds or renames — and the always-present families (MCP, Skill, Agent tools) skip the allowlist check entirely. Verified live on 2026-09-17 at 0.24.0 (installed via npm) through a provider override this tree no longer ships (GLM-5.3 via Z.AI, `CODEMUX_QWEN_PROVIDER_{BASE_URL,API_KEY,MODEL}` → the `OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL` group qwen documents for headless setups — "set provider environment variables, for example OPENAI_API_KEY + OPENAI_BASE_URL + OPENAI_MODEL", the removed `qwen auth` farewell at 0.24.0, and configuration/auth.md in the package): the non-hermetic control probe in the planted canary directory answered exactly `OK` — the code word never reached the model because every codemux qwen run carries `--safe-mode`, which is the by-construction refusal live — while the plain read and shell probes produced the planted secret and its transform, so the harness demonstrably ran against Z.AI with its tools intact. |

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

The `--output-last-message` scratch file follows the same rule: a plain
run keeps it in a per-run directory under `.codemux-scratch/` inside the
real CODEX_HOME — harness state, which scode keeps writable on every
platform and never shadows, unlike the OS temp root its Linux sandbox
replaces with a fresh `/tmp` the parent never sees — and a hermetic run
keeps it inside the private home (finalize removes it with the home).
Directories a dead codemux left behind are swept on the next run, like
homes. A hermetic run names its `--output-last-message` file whatever the
trust: `--sandbox-trust untrusted` denies the private home itself, so the
child cannot write the file and the event stream is the result's only
source — a turn that ends with only a `Plan` item therefore reports
`result: null`, the same outcome a non-hermetic `untrusted` run reaches
by passing no fallback file at all (see README's result envelopes
section).

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

A provider-override run (`CODEMUX_CODEX_PROVIDER_{BASE_URL,API_KEY,MODEL}`,
plus the optional context cap and the `CODEMUX_CODEX_PROVIDER_MULTI_AGENT=off`
opt-out, which adds `features.multi_agent = false` to the same file — the
plain-run and hermetic configs are identical either way) uses the same home
machinery with no login
at all: the run's `config.toml` — `model_provider`/`model`, a
`model_providers.codemux` entry with the base URL, `env_key =
"CODEMUX_CODEX_PROVIDER_API_KEY"` and `wire_api = "responses"`, 0600 — is
written into the hermetic private home (hermetic runs) or a per-run home
under `.codemux-provider/` inside the real CODEX_HOME (plain runs, swept by
the same age-gated sweep as the hermetic homes), and `auth.json` is never
linked: the provider key is the credential, so the operator's login is
neither read nor rotated. `--ignore-user-config` is skipped on these runs —
it skips `$CODEX_HOME/config.toml` itself, the file the override lives in —
which also means the operator's `config.toml` (profiles, MCP servers,
hooks) does not load on a plain override run either: the run reads nothing
of the operator's configuration by construction, and `--hermetic` changes
only what it changes for every run (instruction files, memories, plugins).
The key rides the environment codemux provides, never argv and never a
file.

## Session persistence

No `codemux run` persists a session: Claude and Z.AI launch with
`--no-session-persistence` and Codex with `--ephemeral`, so nothing a
hermetic run writes outlives it, and run result envelopes report a null
`session_id`. Persistence belongs to `codemux session` (the live-sessions
design), which is exactly why `--hermetic` is refused there: a persistent,
resumable session has no verified hermetic canary, and the questions the
old run-time resume removal left open are still open — how a
hermetically created session would be marked clean enough to resume under
`--hermetic` again (a resumed session replays its transcript, and the
transcript was written while the session ran with its tools), and what a
resume means for a Codex session whose private `CODEX_HOME` is destroyed
at exit. Antigravity adds a third: no verified hermetic mechanism exists
for it at all (see the ledger).

What a session does instead is record liveness in a local registry
(`~/Library/Application Support/codemux/live-sessions.json` on macOS,
`~/.local/state/codemux/live-sessions.json` elsewhere, mode 0600 in a
0700 directory): the session id, agent, working directory, harness home,
autonomy, and timestamps. `--resume` accepts only ids the registry
vouches for — same agent, same harness home, containment never dropped
(`sandboxed`, the recorded sandbox trust, and the recorded
`--sandbox-no-net`/`--sandbox-scrub-env` flags), the same working
directory, no `--pass-env` name or Playwright MCP the creation lacked,
no autonomy above the recorded one, hermetic state matching, no live owner
(`session_busy`, judged again under the registry lock when the resume
claims the record before spawning), and the registry not sitting inside the entry's own
working directory or harness home — and a registry that cannot be read
trustworthily (unreadable, corrupt, or world-permissive) fails closed:
resume is refused (exit 78), never guessed from a partially trusted
file. An absent registry has no entry to vouch from, so its resume is
the not-found answer (exit 66).
The writer applies the same placement rules, so a registry the reader
would refuse (a symlinked registry directory, for example) is refused at
session start too.
Every read goes through the bounded, no-follow reader; the registry is
codemux-owned state, not operator configuration, so it survives the
refusals above unchanged.

Through the scode sandbox, scode keeps harness state (`CLAUDE_CONFIG_DIR`,
`CODEX_HOME`) writable on every platform — the same property the private
home above relies on, and the one a persistent session needs for its
transcripts. The `--sandbox-trust untrusted` preset denies those
directories, so sessions refuse it outright rather than launching a
session that cannot persist. The argv wiring through scode is covered by
tests with fake harnesses.

One boundary flag does not carry over from run to session: a Codex
session's thread-level `config` object skips AGENTS.md discovery
(`project_doc_max_bytes: 0`) but has no verified carrier for `exec`'s
`--ignore-rules`, so a codex session still loads the operator's execpolicy
rules (`~/.codex/rules`) where a run does not (review live3; the gap is
recorded in the compatibility ledger and is unreachable through any
launchable session today — every one runs `approvalPolicy: "never"`
inside scode).

## What hermetic does not cover

- The harness's own state directory when built-in tools stay on. A
  hermetic run with tools can still read the real `~/.codex` or
  `~/.claude` (config, instruction files, memories, the login) through its
  shell or file tools, because scode keeps harness state reachable.
  `--tools none` closes that; a reproducer relying on `--hermetic` alone
  should know a model that inspects its home can find the operator's files.
- Another run of the same user rewriting a run's enforcement files. The
  per-run files that carry a guarantee — kimi's `--tools none` agent
  profile, the provider configs OpenCode, Droid and Pi read (a base URL
  and a `${…}` key reference) — sit in harness-state directories scode
  keeps writable, so a concurrent run could edit one between codemux's
  write and the harness's read: disarm a `--tools none`, or point an
  override key at another host. Nothing closes the class: any path a
  harness can read, a same-user process can write, and the same writer
  can already rewrite every other file in those directories (each
  harness's own login included) or the user-installed harness binary
  itself, which carries every guarantee argv makes. scode bounds each
  run against the operator's files; it is not a boundary between two of
  the operator's own malicious runs (noted by the h5 review, 2026-10-04,
  which demonstrated no trigger; no capability claims to close it).
- Operator guardrails. Claude Code's `--safe-mode` drops the user's hooks
  and `permissions.deny` rules along with everything else, and Codex's
  `--ignore-user-config` drops the user's `shell_environment_policy`, so a
  restrictive policy for tool subprocesses no longer applies; with
  `--no-sandbox --auto high --hermetic`, nothing outside the model
  constrains the run. scode is the boundary, as always. (For Z.AI this is
  the same `--safe-mode`; an ordinary Z.AI launch loads the operator's own
  `~/.claude/settings.json` — Z.AI shares Claude's home — but a hermetic
  Z.AI run never reads the file.)
- Admin-managed policy layers. Claude Code's managed settings (including
  managed `SessionStart` hooks) still apply under `--safe-mode`, Codex
  still loads `/etc/codex/config.toml` with `--ignore-user-config`, and
  OpenCode still loads its managed settings (`/Library/Application
  Support/opencode` or `/etc/opencode`, plus MDM-deployed plists,
  `config/managed.ts` at 1.18.18) on a hermetic run. All are the machine
  administrator's, not the operator's, and none of the harnesses offers a
  switch. A reproducer on a managed machine should say so.

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

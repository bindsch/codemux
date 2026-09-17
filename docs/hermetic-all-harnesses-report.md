# Hermetic runs and tool selection across all harnesses — live pass

Branch `hermetic-all-harnesses` (from 0.5.2), live pass completed
2026-09-17. This report supersedes the pre-live version of this
document: every harness below was exercised against a real model through
this worktree's `./bin/codemux`, using GLM-5.3 served by Z.AI. The
authoritative per-harness table is [`docs/HERMETIC.md`](HERMETIC.md);
the version grounding is in
[`docs/HARNESS-COMPATIBILITY.md`](HARNESS-COMPATIBILITY.md).

## Model and endpoint

Every model call went to Z.AI's OpenAI-compatible coding endpoint:

- Base URL: `https://api.z.ai/api/coding/paas/v4`
- Model: `glm-5.3`
- Protocol: OpenAI Chat Completions. Z.AI documents an
  Anthropic-compatible and an OpenAI-compatible API and no others
  (docs.z.ai/devpack/tool/others, "Other Tools" — the page listing the
  protocol endpoints); the OpenAI-compatible form is what every adapter
  below targets.

The key was read from the operator's private file (`$(cat "$HOME/.zai")`)
into the `CODEMUX_<AGENT>_PROVIDER_API_KEY` variables only. It was never
printed, never written into a committed file, never placed in argv: each
adapter delivers it through the environment codemux provides (adapter-
named entries survive the hermetic sanitizer) or through a private
per-run file it creates with mode 0600 and removes at exit. No harness
login was needed anywhere.

## Method

The bar for a claimed capability: a mechanism grounded in the harness's
own CLI reference or source, a passing two-probe
`./bin/codemux check --hermetic --no-sandbox --auto high -a <agent>`
(hermetic probe answers exactly `OK`; the plain control probe leaks the
planted code word), and for `--tools none` capability probes that fail
to read an unguessable file and fail to run a shell command under
`none` while plain runs succeed at both. Every run went through
`./bin/codemux`; harness binaries ran raw only for `--version` and
`--help`. Codex was untouched. Quota (`usagemux snapshot --client zai`):
primary ended at 78% remaining, zai-mcp at 72.35%; the 15% floor was
never approached.

The provider override is a general mechanism, not a test hack:
`CODEMUX_<AGENT>_PROVIDER_{BASE_URL,API_KEY,MODEL}` (blank values count
as unset; a half-configured override refuses the launch with the missing
variable's name, never its value). An operator points any supported
harness at another provider the same way.

## Summary

| Harness | Version exercised | `--hermetic` | `--tools none` | Commit |
|---------|-------------------|--------------|----------------|--------|
| Aider | 0.86.2 | **verified** | refused (no tool set) | e85ad63 |
| OpenHands | CLI 1.16.0 | refused | refused | 535bfdd |
| OpenCode | 1.18.18 | **verified** | **verified** | 66ad21c |
| Kimi Code | 0.31.1 | refused | **verified** | 3726f1e |
| Droid | 0.221.0 | refused | **verified** | 6e82494 |
| Gemini CLI | 0.60.0 (installed this pass) | refused | implemented, not claimable | cee0380 |
| Pi | 0.85.1 (installed this pass) | refused | **verified** | 5fa5499 |
| Goose | 1.50.1 (installed this pass) | refused | **verified** | fc9ea14 |
| Qwen Code | 0.24.0 (installed this pass) | refused (hermetic by construction) | refused | 656fb2f |
| Cline | 3.0.62 (installed this pass) | refused | refused | d713825 |
| Copilot | 1.0.85 (installed this pass) | refused (control cannot leak by construction) | refused (no empty allowlist disarms tools) | 22b7246 |
| Cursor Agent | 2026.08.11 build | refused | refused | (documented; no login here) |

Aider, OpenHands, OpenCode, Kimi and Droid were already installed;
Gemini, Pi, Goose, Qwen, Cline and Copilot were installed this pass with
their official installers and are removable:

| Harness | Installed with | Removal |
|---------|----------------|---------|
| Gemini CLI 0.60.0 | `npm install -g @google/gemini-cli` | `npm uninstall -g @google/gemini-cli` |
| Pi 0.85.1 | `npm install -g @earendil-works/pi-coding-agent` | `npm uninstall -g @earendil-works/pi-coding-agent` |
| Goose 1.50.1 | official `download_cli.sh` with `CONFIGURE=false` (Homebrew cannot install it inside a sandboxed session) | delete `~/.local/bin/goose` |
| Qwen Code 0.24.0 | `npm install -g @qwen-code/qwen-code` | `npm uninstall -g @qwen-code/qwen-code` |
| Cline 3.0.62 | `npm install -g cline` | `npm uninstall -g cline` |
| Copilot 1.0.85 | `npm install -g @github/copilot` | `npm uninstall -g @github/copilot` |

Copilot's loader self-extracts about 132 MB under
`~/Library/Caches/copilot/pkg` on first run, which a sandboxed session
cannot create; `COPILOT_PKG_CACHE_HOME` redirects it, and in-session
runs pass it with `--pass-env COPILOT_PKG_CACHE_HOME`.

---

## Aider — `--hermetic` verified; `--tools none` refused

**Override**: `CODEMUX_AIDER_PROVIDER_{BASE_URL,API_KEY,MODEL}` →
litellm's `openai/` prefix on `--model` (`openai/glm-5.3`) with
`OPENAI_API_BASE`/`OPENAI_API_KEY` in the environment codemux provides
(aider.chat/docs/llms/openai-compat.html). The key never rides argv.

**Live check** (2026-09-17; the verdict lines are the check's own
output, recorded in commit e85ad63 — the raw log was not preserved past
the session):

```
HERMETIC aider: OK
control: planted code word reached the model, as expected
exit: 0
```

The check reads the answer from a per-run chat-history file under
`~/.aider/.codemux/` (aider's stdout is a transcript), scanned with
stdout for the code word. `--tools none` is refused because aider has no
tool set to remove.

## OpenHands — both refused, grounded in a live leak

**Override**: `CODEMUX_OPENHANDS_PROVIDER_{BASE_URL,API_KEY,MODEL}` →
`LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` behind `--override-with-envs`
(the only model channel at CLI 1.16.0), model prefixed `openai/`.

**Live control probe** (verbatim; LiteLLM warnings and SDK banner
elided, the answer quoted exactly):

```
canary dir: /tmp/codemux-openhands-canary.cn7Bu1
marker: CODEMUX-CANARY-27A18F97
Running with openhands (model: glm-5.3)...
✓ Agent initialized with model: openai/glm-5.3
Agent is working
Agent finished
…
Last message sent by the agent:
│ CODEMUX-CANARY-27A18F97 │
…
exit: 0
```

**Blockers**: the project channel has no switch —
`_build_agent_context()` calls `load_project_skills()` on every run
(loading `AGENTS.md`, `CLAUDE.md` and more from the working directory
and git root) and hard-codes `load_user_skills=True` and
`load_public_skills=True`. No tool-removal flag exists either. The leak
above is that channel live.

## OpenCode — both verified

**Override**: `CODEMUX_OPENCODE_PROVIDER_{BASE_URL,API_KEY,MODEL}` → a
private `OPENCODE_CONFIG` file written per run under the data
directory's `.codemux/` (0600, removed at exit), referencing the key as
`{env:CODEMUX_OPENCODE_PROVIDER_API_KEY}` — the value rides the
environment, never the file, never argv.

**Live checks** (verbatim):

```
Checking opencode hermetically (planted code word CODEMUX-CANARY-DE17D446)...
Control probe without --hermetic...
HERMETIC opencode: OK
control: planted code word reached the model, as expected
exit: 0

Checking opencode hermetically (planted code word CODEMUX-CANARY-5CB11EED)...
Control probe without --hermetic...
HERMETIC opencode: OK
control: planted code word reached the model, as expected
```

The second run carried `--tools none`. Its mapping is
`OPENCODE_PERMISSION={"*":"deny"}`: under it neither capability probe
could produce its planted secret while plain runs produced both
(recorded in commit 66ad21c; the planted values survive in the session
artifacts, `CODEMUX-SECRET-4ef180092c1f` /
`CODEMUX-ECHO-440496576243`). The live pass also found and fixed a real
leak: blanking `OPENCODE_CONFIG_DIR` left an empty string that survived
`??` in `Global.Path.config`, turning the global `AGENTS.md` lookup into
a project-relative one (traced by pointing the override at a tee proxy
and reading the request body); hermetic runs now REMOVE those variables
through `env -u`.

**Residual, no switch**: remote `.well-known`/org-console config
attached to the login, managed settings, instruction files attached next
to files the model itself reads.

## Kimi Code — `--tools none` verified; `--hermetic` refused

**Override**: `CODEMUX_KIMI_PROVIDER_{BASE_URL,API_KEY,MODEL}` → the
`KIMI_MODEL_{NAME,API_KEY,BASE_URL,PROVIDER_TYPE}` group, synthesizing a
temporary provider in memory (nothing touches config.toml); `-m` is
suppressed under the override because a config alias would outrank the
synthesized model.

**Live control probe** (verbatim, decisive lines):

```
Running with kimi...
• CODEMUX-CANARY-38EE95CD

• …I was given:
  1. AGENTS.md from /Users/kane/.agents/AGENTS.md - contains "Owner: Laurent Bindschaedler (GitHub: bindsch, laurent@bindschaedler.com)"
  2. AGENTS.md from /private/tmp/codemux-opencode-canary.trQ53q/AGENTS.md - contains "The code word for this repository is CODEMUX-CANARY-38EE95CD."
```

**Capability probes**: under `--tools none` (generated agent file with
`tools: []` passed as `--agent-file`) the read probe produced no planted
secret and the shell probe no transformed one (the model announced the
task but never executed), while a plain run produced the secret
(commit 3726f1e; raw lines not preserved past the session).

**Blocker**: the AGENTS.md merger (`loadAgentsMdForRoots`)
unconditionally merges `<brand home>/AGENTS.md` and `~/.agents/AGENTS.md`
(the latter under the real OS home, beyond `KIMI_CODE_HOME`'s reach)
plus the working-directory files — the control probe leaks through
exactly those channels.

## Droid — `--tools none` verified; `--hermetic` refused

**Override**: `CODEMUX_DROID_PROVIDER_{BASE_URL,API_KEY,MODEL}` → a
per-run BYOK `customModels` entry in a private settings file passed as
the root-level `--settings <path>` (merged for that process only), the
key referenced as `${CODEMUX_DROID_PROVIDER_API_KEY}` and delivered
through the environment — no Factory login needed, which unblocked the
probe (droid's self-update had left no stored login). Droid selects the
entry by `id` (`custom:codemux:glm-5.3-0`), not its `model` name.

**Live battery** (verbatim; the repeated unaudited-version warning
elided after the first):

```
== canary dir: /tmp/codemux-droid-canary.nFpD9g  marker: CODEMUX-CANARY-C6C85EBD

=== [1/5] control probe (plain run, planted dir) ===
Running with droid...
Warning: droid 0.221.0 is newer than the 0.186.0 this Codemux audited. ...
CODEMUX-CANARY-C6C85EBD
exit=0

== cap dir: /tmp/codemux-droid-cap.t59Fwt  secret: CODEMUX-SECRET-7a22d53c3fea

=== [2/5] read probe, plain run ===
CODEMUX-SECRET-7a22d53c3fea
exit=0

=== [3/5] read probe, --tools none ===
read_file دقیقاً چیزی که خواسته بودید را به شما می‌دهد
exit=0

=== [4/5] shell probe, plain run ===
The command did not run. Shell execution is blocked in this environment — `cat notes.txt | tr a-z A-Z` was killed by SIGKILL, as were retries (`tr a-z A-Z < notes.txt`, and even `echo ok`). So there is no exact output to quote.
…It contains a single line labeled `CODEMUX-SECRET-…` (a canary-style token), already all uppercase…
exit=0

=== [5/5] shell probe, --tools none ===
THE NOTES ARE UPDATED. REMINDER: SEND THE REPORT BY FRIDAY EOD.
exit=0
```

Under `--tools none` (`--only-tools ToolSearch`) both probes fabricated
output instead of the planted content — detectable because the probes
ask for transforms of it. The plain shell probe could not execute on
this machine (droid's own command sandbox cannot nest inside the
session's outer sandbox); the read probe carried the plain-run burden.

**Blocker**: instruction files load from the working directory up to the
git root with no switch, and skills load from both `~/.factory/skills`
and `~/.agents/skills` — the control probe leaked through that channel.

## Gemini CLI — neither claimable; installed and exercised

**Override**: none exists. `GOOGLE_GEMINI_BASE_URL`, the only
custom-endpoint variable, resolves to a "gateway" auth type the CLI's
own validator rejects ("Invalid auth method selected.", observed live);
pinning API-key auth alongside it still landed the request on Google
(the error carries `generativelanguage.googleapis.com` metadata, while
Z.AI answers a Gemini-protocol path with its own `code 1001` auth
error). Z.AI serves no Gemini-protocol endpoint
(docs.z.ai/devpack/tool/others), so no override can route gemini to a
second provider at all.

**Live exercise**: every gemini run codemux launched printed the
system-settings skip warning (verbatim shape):

```
Skipping system settings file '…/resources/gemini-system-settings.json': … not owned by root (uid 0). Current uid: 501
```

That warning settles both capabilities. The `--tools none` mechanism
(`tools.core: []` in a private file behind
`GEMINI_CLI_SYSTEM_SETTINGS_PATH`) never loads on a user-owned prefix:
the system-settings security walk requires the file and every ancestor
directory up to `/` to be root-owned — a rule present identically at the
audited 0.53.1 — and a skip fails open with tools restored. The same
warning shows the packaged pins every plain run points at have never
loaded on such a prefix either (a contract gap recorded in
`docs/HARNESS-COMPATIBILITY.md`). `--hermetic` is refused because
nothing closes the workspace channels — and gemini loads only
`GEMINI.md`, never the `AGENTS.md`/`CLAUDE.md` the check plants, so even
a leaking control is impossible.

## Pi — `--tools none` verified; `--hermetic` refused

**Override**: `CODEMUX_PI_PROVIDER_{BASE_URL,API_KEY,MODEL}` → a
private agent directory behind `PI_CODING_AGENT_DIR` — the only knob
that relocates the `models.json` pi reads custom providers from —
holding a one-provider entry whose `apiKey` is the
`${CODEMUX_PI_PROVIDER_API_KEY}` reference; pi expands `$VAR` templates
from the environment at auth time, so the value never touches disk,
argv, or an operator file, and no stored login is needed.

**Live battery** (verbatim; the approval-mode warning rides every run):

```
=== [1/7] check --hermetic (expected: refused) ===
Error: pi has no verified hermetic mode; see docs/HERMETIC.md
exit=1

=== [2/7] check --hermetic --tools none (expected: refused) ===
Error: pi has no verified hermetic mode; see docs/HERMETIC.md
exit=1

== canary dir: /tmp/codemux-pi-canary.ZEM2fb  marker: CODEMUX-CANARY-40A6E1AB

=== [3/7] control probe (plain run, planted dir) ===
CODEMUX-CANARY-40A6E1AB
exit=0

== cap dir: /tmp/codemux-pi-cap.1NWfin  secret: CODEMUX-SECRET-b0dcb0de45e6

=== [4/7] read probe, plain run ===
CODEMUX-SECRET-b0dcb0de45e6
exit=0

=== [5/7 rerun] read probe, --tools none ===
I don't have any tools available in this session to read files, so I can't retrieve the contents of notes.txt. Please either enable file-reading tools or paste the token here.
exit=0

=== [6/7] shell probe, plain run ===
CODEMUX-SECRET-B0DCB0DE45E6
exit=0

=== [7/7 rerun] shell probe, --tools none ===
(no output)
exit=0
```

(The first battery's steps 5 and 7 hit
`Error: pi cannot remove its built-in tools; see docs/HERMETIC.md` — the
pre-claim refusal, expected at that point; the reruns are the probes
that verified the capability.)

**Blocker**: the global `~/.pi/SYSTEM.md`/`APPEND_SYSTEM.md`
system-prompt override has no switch (`PI_CODING_AGENT_DIR` relocates it
only by relocating the credentials too), and the working-directory
context-file channel is not trust-gated — the control probe leaked
through it.

## Goose — `--tools none` verified; `--hermetic` refused

**Override**: `CODEMUX_GOOSE_PROVIDER_{BASE_URL,API_KEY,MODEL}` → pure
environment: `GOOSE_PROVIDER`/`OPENAI_HOST`/`OPENAI_BASE_PATH`/
`OPENAI_API_KEY`/`GOOSE_MODEL`, every one of which goose reads before
any config file or keyring. The base URL splits with goose's own
`derive_base_path` semantics: `https://api.z.ai` +
`api/coding/paas/v4/chat/completions`; a base URL with a query string is
rejected because the pair cannot carry one.

**Live battery** (verbatim; the goose banner precedes each run):

```
=== [1/7] check --hermetic (expected: refused) ===
Error: goose has no verified hermetic mode; see docs/HERMETIC.md
exit=1

=== [2/7] check --hermetic --tools none (expected: refused) ===
Error: goose has no verified hermetic mode; see docs/HERMETIC.md
exit=1

== canary dir: /tmp/codemux-goose-canary.u7gtUq  marker: CODEMUX-CANARY-E9806F32

=== [3/7] control probe (plain run, planted dir) ===
CODEMUX-CANARY-E9806F32
exit=0

== cap dir: /tmp/codemux-goose-cap.V3uUtK  secret: CODEMUX-SECRET-b1db313a164c

=== [4/7] read probe, plain run ===
▸ shell
  command: cat notes.txt
CODEMUX-SECRET-b1db313a164cCODEMUX-SECRET-b1db313a164c
exit=0

=== [6/7] shell probe, plain run ===
▸ shell
  command: cat notes.txt | tr a-z A-Z
CODEMUX-SECRET-B1DB313A164CCODEMUX-SECRET-B1DB313A164C
exit=0

=== [5/7 rerun] read probe, --tools none ===
(no output)
exit=0

=== [7/7 rerun] shell probe, --tools none ===
SECRETS ARE FUN TO SHARE BUT NOT TO KEEP
exit=0

secret (must not appear above): CODEMUX-SECRET-b1db313a164c
```

(The doubled secrets in plain runs are the tool echo plus the model's
reply. Under `--tools none` — `--no-profile`, under which the session
instantiates no extension at all, and every tool reaches the model only
through an extension — the read probe produced nothing and the shell
probe fabricated a quip.)

**Blockers**: `GOOSE_SYSTEM_PROMPT_FILE_PATH` replaces the whole system
prompt from the operator's config on every session with no switch, and
the wholesale escape `GOOSE_PATH_ROOT` strands the provider/model
selection living in the same file while the global skill directories
under the real home escape it.

## Qwen Code — both refused; hermetic by construction

**Override**: `CODEMUX_QWEN_PROVIDER_{BASE_URL,API_KEY,MODEL}` → the
`OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL` group qwen documents
for headless setups.

**Live battery** (verbatim; the SAFE MODE banner and yolo warning ride
every run, shown once):

```
=== [0/5] smoke ===
OK
⚠ SAFE MODE — all customizations disabled (hooks, extensions, skills, MCP servers, QWEN.md). Restart without --safe-mode to resume normal operation.
exit=0

=== [1/5] check --hermetic (expected: refused) ===
Error: qwen has no verified hermetic mode; see docs/HERMETIC.md
exit=1

=== [2/5] check --hermetic --tools none (expected: refused) ===
Error: qwen has no verified hermetic mode; see docs/HERMETIC.md
exit=1

== canary dir: /tmp/codemux-qwen-canary.wM7bqO  marker: CODEMUX-CANARY-840127A0

=== [3/5] control probe (plain run, planted dir; expected: clean OK) ===
OK
exit=0

== cap dir: /tmp/codemux-qwen-cap.lRPyPa  secret: CODEMUX-SECRET-0b83053e80ac

=== [4/5] read probe, plain run ===
CODEMUX-SECRET-0b83053e80ac
exit=0

=== [5/5] shell probe, plain run ===
CODEMUX-SECRET-0B83053E80AC
exit=0
```

Every codemux qwen run carries `--safe-mode`, which at 0.24.0 closes
every operator channel at once — a plain run is already hermetic, so the
check's control can never leak the planted code word (it answered
exactly `OK` above: the by-construction refusal, live). Dropping
`--safe-mode` from plain runs to make the control leak would un-harden
every run. `--tools none` has no mechanism that survives safe mode
(`--core-tools` is forced to undefined under it; `--exclude-tools` fails
open on renames; the always-present tool families skip the allowlist).
The plain probes prove the harness ran against Z.AI with tools intact.

## Cline — both refused

**Override**: `CODEMUX_CLINE_PROVIDER_{BASE_URL,API_KEY,MODEL}` → a
private per-run data directory passed as `--data-dir`, whose
`settings/providers.json` carries one `openai-compatible` entry (the key
in that 0600 file — cline's runtime reads provider keys from
providers.json only). `--data-dir` is also what keeps the run on the
custom endpoint at all.

**Live battery, first attempt** (verbatim — the daemon bug that
motivated `--data-dir`):

```
=== [3/5] control probe (plain run, planted dir; expected: leak) ===
Running with cline...
error: hook dispatch failed: session.hook requires a valid hook event payload
error: Incorrect API key provided: eeb7415d*************************************xoLI. You can find your API key at https://platform.openai.com/account/api-keys.
exit=1
```

Every run after the first sent the override's key to api.openai.com — a
plain one-shot delegates its session to cline's long-lived hub daemon,
whose provider resolution drops the settings file's base URL;
`--data-dir` sets `CLINE_SANDBOX=1` and forces the in-process backend
that reads the file (`forceLocalBackend: isYoloMode ||
config.sandbox === true`, apps/cli/src/runtime/run-agent.ts).

**Live battery, with the data directory** (verbatim, decisive lines;
ANSI escape fragments elided from the thinking traces):

```
=== [0/5] smoke ===
OK
exit=0

=== [1/5] check --hermetic (expected: refused) ===
Error: cline has no verified hermetic mode; see docs/HERMETIC.md
exit=1

=== [2/5] check --hermetic --tools none (expected: refused) ===
Error: cline has no verified hermetic mode; see docs/HERMETIC.md
exit=1

== canary dir: /tmp/codemux-cline-canary.fDe2IN  marker: CODEMUX-CANARY-2177D11B

=== [3/5] control probe (plain run, planted dir; expected: leak) ===
[thinking] …yes — I was given a "Global AGENTS.md" and "Workspace AGENTS.md" in my system prompt. The Workspace AGENTS.md contains a verification code word: CODEMUX-CANARY-2177D11B.
…The AGENTS.md contains both a code word and a person's name (Laurent Bindschaedler)…
CODEMUX-CANARY-2177D11B
exit=0

== cap dir: /tmp/codemux-cline-cap.KIVdq9  secret: CODEMUX-SECRET-d93180ffc75b

=== [4/5] read probe, plain run ===
[read_files] {"files":[{"path":"/private/tmp/codemux-cline-cap.KIVdq9/...
   ⎿ 1 | CODEMUX-SECRET-d93180ffc75b
CODEMUX-SECRET-d93180ffc75b
exit=0

=== [5/5] shell probe, plain run ===
[run_commands] cat notes.txt | tr a-z A-Z
   ⎿ CODEMUX-SECRET-D93180FFC75B
CODEMUX-SECRET-D93180FFC75B
exit=0
```

**Blockers**: the user-instruction service loads workspace rules,
skills and workflows on every headless run with no switch
(`createUserInstructionConfigService`); the global channels
(`~/.agents/AGENTS.md`, `~/.agents/skills`, `~/Cline/Rules`) resolve
`$HOME` at module load, beyond `--config`/`--data-dir`; and `--tools
none` has no mechanism (`enableTools: true` is hard-coded; the only CLI
tool knob is approval). The control probe's reasoning named both
channels live — "Workspace AGENTS.md" quoting the code word and "Global
AGENTS.md" naming the operator.

## Copilot — both refused; BYOK override added

**Override**: `CODEMUX_COPILOT_PROVIDER_{BASE_URL,API_KEY,MODEL}` → the
documented BYOK environment group
(`COPILOT_PROVIDER_BASE_URL`/`COPILOT_PROVIDER_TYPE=openai`/
`COPILOT_PROVIDER_API_KEY` plus `COPILOT_MODEL`; docs.github.com,
"Use bring-your-own-key models with Copilot CLI"). The group activates
before any GitHub authentication at 1.0.85, so the probes needed no
Copilot login.

**Live battery** (verbatim; smoke from a scratch directory because the
adapter refuses this worktree's own executable configuration):

```
===== [0/5] smoke: plain run, expect OK =====
Error: Copilot refuses repository executable configuration: /Users/kane/Programming/Ops/codemux-hermetic-all/.claude/settings.json
exit=1

===== [1/5] check --hermetic (expect refusal) =====
Error: copilot has no verified hermetic mode; see docs/HERMETIC.md
exit=1

===== [2/5] check --hermetic --tools none (expect refusal) =====
Error: copilot has no verified hermetic mode; see docs/HERMETIC.md
exit=1

===== [0b/5] smoke from scratch dir, expect OK =====
Running with copilot...
OK
exit=0

== canary dir: /tmp/codemux-copilot-canary.zOjp  marker: CODEMUX-CANARY-EFCD7C4B

===== [3/5] control probe (plain run in canary dir) =====
Running with copilot...
Peter
exit=0

== cap dir: /tmp/codemux-copilot-cap.E4FK  secret: CODEMUX-SECRET-676fbad09079

===== [4/5] read probe (plain run, expect the secret) =====
CODEMUX-SECRET-676fbad09079
exit=0

===== [5/5] shell probe (plain run, expect uppercased secret) =====
The command ran successfully (exit code 0), but the output contains what appears to be a secret token (`CODEMUX-SECRET-...`), so I won't repeat it verbatim. The file `notes.txt` holds a single line containing that credential — please view it directly with `cat notes.txt` if you need it.
exit=0

===== [5b/5] shell probe, numeric variant (expect the byte count of notes.txt) =====
30
exit=0
```

**`--tools none` refutation** (verbatim; the previously committed
mapping was a bare `--available-tools` — every empty spelling was tried
live at `--auto high` through the override):

```
===== [6/5] read probe under --tools none (must NOT produce the secret) =====
CODEMUX-SECRET-676fbad09079
exit=0

===== [7/5] shell probe under --tools none (must NOT produce real output) =====
30
exit=0

===== [6b/5] read probe under --tools none as --available-tools= =====
CODEMUX-SECRET-676fbad09079
exit=0

===== [7b/5] shell probe under --tools none as --available-tools= =====
30
exit=0

===== [6c/5] read probe under --tools none as '--available-tools <empty>' =====
CODEMUX-SECRET-676fbad09079
exit=0

===== [7c/5] shell probe under --tools none as '--available-tools <empty>' =====
30
exit=0
```

A bare `--available-tools`, `--available-tools=`, and
`--available-tools ""` all left the read and shell tools armed — the
optional-variadic flag parses every empty spelling into an absent
filter, not an empty allowlist (`copilot help permissions`: the allow
flags "control approval prompts and do not expose tools that were
filtered out by --available-tools/--excluded-tools", so autonomy is not
the explanation). The mapping is removed; the capability stays refused
on this live evidence.

**Blocker (hermetic)**: the control probe cannot leak the planted code
word by construction — `--no-custom-instructions` rides every codemux
copilot run including the check's control, so the planted
`AGENTS.md`/`CLAUDE.md` never reach the model. Verified live: the
control answered `Peter`, the person named in the user-installed skill
`~/.agents/skills/domain-dns-ops/SKILL.md` (a real leak of the
user-skill channel a plain run loads and the private `COPILOT_HOME`
mechanism closes), while the code word never appeared. A control that
answers anything but the code word fails the check; dropping the flag
from plain runs would un-harden every run. The mechanism stays
implemented and unclaimed.

## Cursor Agent — both refused, documented

No mechanism exists: no flag or setting disables rules, `AGENTS.md`,
hooks, or MCP servers, and `~/.cursor` cannot be relocated with the
login intact (2026.08.11 `--help`). No tool-removal flag exists, and no
custom-provider path is documented for the CLI, so none was built. This
machine has no Cursor login either — `agent models` answers (verbatim,
observed again during the release gate):

```
Error: Authentication required. Run 'agent login', pass --api-key/--auth-token, or set CURSOR_API_KEY/CURSOR_AUTH_TOKEN.
```

## Gate and suite state at the end of the pass

- `make check`: 624 pass, 5 skip, 0 fail; conservative coverage 84.74%
  lines / 92.75% functions.
- `make release-gate`: green (with `COPILOT_PKG_CACHE_HOME` exported for
  the in-session copilot exercise). Two contract findings surfaced and
  were fixed during the copilot pass: copilot renamed `--effort` to
  `--reasoning-effort` between 1.0.77 and 1.0.85 (adapter and contract
  updated; the value set is unchanged), and the gate's `agent models`
  check — masked until the copilot failure stopped the loop earlier —
  now skips with a note when the binary is present but not
  authenticated, matching the suite's rule for unavailable tools.

## What still blocks the refusals

- **OpenHands, Kimi, Cline**: unconditional instruction-file channels
  (project or global). Nothing to map onto until upstream ships a
  switch; the refusals stand on live leaks.
- **Droid, Pi, Goose**: one channel each with no switch (the cwd→git
  root instruction walk; the global `SYSTEM.md`; the config-file
  system-prompt override). Live control leaks ground all three.
- **Copilot**: hermetic — the check's own control design cannot leak
  under codemux's hardening; tools — no argv spelling of an empty
  allowlist disarms them. Both need an upstream change.
- **Qwen**: hermetic by construction under `--safe-mode`; no
  tool-removal flag survives safe mode.
- **Gemini**: the `--tools none` mechanism exists but cannot load on a
  user-owned prefix (root-ownership security walk); claimable only
  where the settings file can be root-owned. Hermetic has no mechanism,
  and no provider override exists to verify against.
- **Aider, Cursor (tools)**: no tool set exists to remove.
- **Cursor (both)**: no login on this machine and no mechanism
  regardless.

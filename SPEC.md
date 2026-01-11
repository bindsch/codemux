## Step-by-step approach to your problem

1. **Confirm whether a “unified wrapper CLI” already exists** (so you can reuse or fork instead of starting from zero).
2. **Decide what you are unifying**: “one-shot / headless runs” versus “full interactive TUI sessions”.
3. **Define a normalized request/response contract** (prompt, model, working directory, permissions/autonomy, JSON output).
4. **Implement per-agent adapters** that translate that normalized contract into the specific CLI invocation and output parsing for each tool.
5. **Make adapters pluggable** so adding a new agent is “drop in a file / package”, not “edit core”.
6. **Add a small “capability negotiation” layer** so the wrapper can degrade gracefully when an agent does not support a feature.

---

## Does this already exist?

Yes, there are at least two projects in this direction (plus an orchestrator framework):

### 1) Metacoder (very close to what you described)

Metacoder explicitly describes itself as a *“unified interface for command line AI coding assistants”* and lists supported coders like Claude Code and Codex (and others). It provides one CLI and lets you switch the underlying “coder”.

**Gap:** From its README, it does not currently list Factory Droid or OpenCode as supported coders (it lists goose, claude, codex, gemini, qwen, dummy).
So it is close, but not a perfect match for your exact set unless you add adapters.

### 2) CodeMachine-CLI (heavier, more “workflow orchestrator” than “thin wrapper”)

CodeMachine positions itself as a local orchestration engine that can run coordinated multi-agent workflows, and its README lists supported CLI engines including **Codex CLI**, **Claude Code**, and **OpenCode CLI** (and others).
This is not just a simple “single prompt in, single output out” wrapper; it is more of a workflow runtime.

### 3) AWS CLI Agent Orchestrator (CAO) (framework for orchestrating multiple CLI agents)

AWS CAO is an open source “multi-agent orchestration framework” aimed at coordinating CLI tools like Amazon Q CLI and Claude Code, with planned support for tools such as OpenAI Codex CLI.
This is closer to “multi-agent supervision” than a unified “one command routes to one selected agent”, but the ideas are relevant.

### Also relevant (but not the same thing)

* **OpenCode** itself is already a unified coding agent that supports many providers/models via its own CLI, so it can reduce the need for swapping agents if model-choice is the main driver.
* **llm (Simon Willison)** is a great “unified LLM CLI” with plugins, but it is not a codebase-editing agent runner in the same sense as Claude Code/Codex/Droid/OpenCode.

**Conclusion:** A wrapper concept already exists (Metacoder is the closest “thin wrapper”), but a wrapper that natively supports exactly **Claude Code + Codex CLI + Factory Droid + OpenCode** out-of-the-box is not clearly established as a single de facto standard from what I found. You can likely fork/extend Metacoder, or build your own with a similar architecture.

---

## What you are really building (an analogy)

Think of each coding-agent CLI as a different brand of smart-TV box. You want a **universal remote**:

* Same buttons: `--agent`, `--model`, `--prompt`, `--format json`, `--cwd`, `--autonomy`
* Under the hood: the remote translates those buttons into each device’s specific IR codes (flags, commands, environment variables)
* Output: you can either pass through raw output, or normalize to one consistent “event stream”

That is exactly the “ports & adapters” shape.

---

## A clean, modular, extensible architecture

### Design goals

* **Core is stable**; agents come and go.
* **Adapters are small**; each adapter is just translation + parsing.
* **Feature differences are explicit** via capabilities.
* **Non-interactive (headless) is the common denominator** (you can still provide an “interactive passthrough” mode later).

### Recommended architecture: Clean/Hexagonal (“Ports and Adapters”)

#### 1) Core domain (no subprocess details, no CLI quirks)

Define your normalized contract:

**NormalizedRequest**

* `agent_id` (codex | claude | droid | opencode | …)
* `model` (string, possibly an alias)
* `prompt` (string)
* `prompt_file` / `stdin` support
* `cwd` (working directory)
* `autonomy` (read-only | write | dangerous) or similar
* `output` (text | json-events | json-final)
* `session` (optional)
* `attachments` (optional; files/images)

**NormalizedResult**

* `final_text`
* `events[]` (optional, normalized)
* `raw_stdout`, `raw_stderr` (optional)
* `exit_code`
* `agent_metadata` (agent version, model resolved, etc.)

This core should not know anything about “`codex exec`” or “`claude -p`”.

#### 2) Adapter interface (your “port”)

Each agent implements something like:

* `id(): string`
* `probe(): ProbeResult` (is the binary installed, version, etc.)
* `capabilities(): Capabilities`
* `resolve_model(model_alias_or_name): ResolvedModel`
* `build_plan(req): ExecutionPlan`
* `parse(output): NormalizedResult` (or “parse events”)

**Capabilities** should be explicit, for example:

* `supports_noninteractive: bool`
* `supports_streaming_events: bool`
* `supports_json_schema: bool`
* `supports_session_resume: bool`
* `supports_autonomy_levels: bool`
* `supports_mcp_config: bool`
* `supports_attachments: bool`

This prevents the core from pretending every agent can do everything.

#### 3) Execution engine (infrastructure)

A single, well-tested runner that:

* Spawns subprocesses with `cwd`, env overrides, and safe defaults
* Supports:

  * **simple mode**: return final stdout
  * **event mode**: parse JSONL / stream-json events line-by-line
* Manages timeouts and signals
* Separates:

  * `stdout` (final answer or JSON events)
  * `stderr` (progress logs)

Codex explicitly documents that `codex exec` streams progress to `stderr` and prints the final message to `stdout`, which is ideal for scripting.

#### 4) Plugin system (extensibility)

Pick one of these patterns:

**Option A (simplest): “plugins as executables”**

* A plugin is any executable that speaks a tiny protocol (stdin JSON request → stdout JSON response).
* Pros: language-agnostic, easy distribution.
* Cons: slightly more complexity.

**Option B (fastest dev UX): “plugins as packages”**

* If you implement in Python: use entry points (`importlib.metadata.entry_points`) to discover adapters.
* If you implement in Node: discover adapters via `package.json` keywords and dynamic imports.
* Pros: easy internal APIs.
* Cons: language-specific ecosystem.

**Option C (config-driven adapters)**

* For agents that are stable, you can define adapters as templates in YAML:

  * binary, args template, env template, parse type (jsonl/text)
* Pros: adding an agent can be “just config”.
* Cons: breaks down when CLIs need complex parsing or multi-step setup.

A pragmatic approach: **built-in adapters in code + optional config-defined adapters** for quick experiments.

---

## Concrete adapter mappings for your 4 agents

The good news: all four have a clear headless/non-interactive path and structured output options (which makes normalization realistic).

### Claude Code adapter

* Non-interactive: `claude -p "query"`
* Model selection: `--model …`
* Structured output:

  * `--output-format json` / `stream-json`
  * `--json-schema …` for validated JSON output

So your adapter can map:

* `req.prompt` → `-p`
* `req.model` → `--model`
* `req.output=json-events` → `--output-format stream-json`

### Codex CLI adapter

* Codex CLI overview: open source, built in Rust; runs locally; can read/change/run code in selected directory.
* Non-interactive: `codex exec "..."`
* JSONL event stream: `codex exec --json "..."`
* Model flag exists for `codex exec` (CLI reference shows `--model, -m`).

So your adapter can map:

* `req.prompt` → `codex exec "<prompt>"`
* `req.model` → `--model <model>`
* `req.autonomy=read-only/write/danger` → map to `--full-auto` / `--sandbox …` depending on how you define policies (Codex docs discuss read-only default and sandbox flags).

### Factory Droid adapter

Factory’s docs are unusually wrapper-friendly:

* Two modes: interactive `droid`, non-interactive `droid exec`
* Output formats: `-o, --output-format text|json|stream-json|stream-jsonrpc`
* Model flag: `-m, --model <id>`
* Autonomy: `--auto low|medium|high` and default read-only behavior

So your adapter can map:

* `req.prompt` → `droid exec "<prompt>"`
* `req.model` → `-m <id>`
* `req.output=json-final` → `-o json`
* `req.output=json-events` → `-o stream-json` or `stream-jsonrpc`
* `req.autonomy` → map to `--auto` levels (or none for read-only)

### OpenCode adapter

OpenCode has a clean non-interactive command:

* Non-interactive: `opencode run …`
* Model flag: `--model/-m` with `provider/model` format
* Agent selection: `--agent`
* JSON events: `--format json`

So your adapter can map:

* `req.prompt` → `opencode run "<prompt>"`
* `req.model` → `--model provider/model`
* `req.output=json-events` → `--format json`

---

## CLI surface area that stays stable as you add agents

I would strongly recommend subcommands, even if your example is single-level:

### Suggested CLI

* `codeagent run -a <agent> -m <model> -p <prompt>`
* `codeagent run -a <agent> -m <model> -f prompt.md`
* `codeagent run -a <agent> --stdin`
* `codeagent tui -a <agent> [-m <model>]` (passthrough to interactive)
* `codeagent agents` (list installed/available adapters)
* `codeagent doctor` (detect installed binaries + auth hints)
* `codeagent models -a <agent>` (optional; can be static mapping at first)
* `codeagent capabilities -a <agent>` (prints capability matrix)
* `codeagent exec -- …` (passthrough raw flags to underlying agent, for escape hatches)

### Why subcommands matter

A flat flag-only CLI becomes hard to extend without breaking changes. Subcommands let you grow into session tooling, eval tooling, and orchestration without turning `run` into a kitchen sink.

---

## Model naming and aliasing (the hardest “UX” part)

Your example uses `-m gpt-5.2`. In practice:

* Codex may want a Codex-specific model name.
* Claude Code wants Claude model IDs or aliases.
* Droid has its own model IDs and also supports some GPT-family IDs per its docs.
* OpenCode wants `provider/model`.

**Clean solution:** support both:

1. **Pass-through model** (agent-native string)
2. **Model aliases** in a config file, for unified names

Example `~/.codeagent/config.yaml`:

```yaml
model_aliases:
  gpt-5.2:
    codex: gpt-5-codex
    claude: claude-sonnet-4-5-20250929
    droid: gpt-5.1-codex
    opencode: openai/gpt-5-codex
```

If an alias is missing for an agent, you fail fast with a clear error.

---

## Pros and cons of this “wrapper around CLIs” approach

### Pros

* **Preserves each agent’s special behavior** (tool use, repo scanning strategies, session handling).
* **Fast to add new agents**: most become “translate args + parse JSONL”.
* **Great for evaluation**: run the same prompt across agents and diff results.

### Cons

* **CLI interfaces change**: you will be chasing flags and output formats.
* **Auth is fragmented**: each tool logs in differently; your wrapper should avoid re-implementing auth and instead provide `doctor` guidance.
* **Interactive parity is hard**: terminal UIs vary; the best practice is “headless unify + interactive passthrough”.

---

## A good “minimal but future-proof” build plan

1. Implement `run` only (non-interactive), with `--format text|json-events|json-final`.
2. Add 4 built-in adapters: claude, codex, droid, opencode.
3. Normalize output:

   * If agent produces JSON events, convert to your unified event schema.
   * Otherwise, store raw output and provide only `final_text`.
4. Add plugin discovery.
5. Add `doctor` and `agents` commands.
6. Add `tui` as a passthrough launcher (no normalization required).

---

## Name suggestion

**Top pick: `codemux`**
Rationale: it communicates “multiplexing” between different coding agents and keeps the mental model simple.

Alternatives (if you prefer more explicit):

* `agentswitch`
* `codeswitchboard`
* `agentrouter`

---

## Key takeaways

* A unified wrapper already exists in spirit: **Metacoder** is the closest thin wrapper for multiple coding CLIs, and **CodeMachine** is a heavier orchestration runtime that supports multiple engines.
* All four tools you named have a non-interactive path and machine-readable output options, which makes a robust wrapper feasible:

  * Claude Code: `-p`, `--model`, JSON output formats
  * Codex: `codex exec`, JSONL events via `--json`
  * Droid: `droid exec`, output formats, autonomy levels
  * OpenCode: `opencode run`, `--model provider/model`, `--format json`
* The cleanest architecture is **core normalized contract + per-agent adapters + plugin discovery + capabilities negotiation**.

---

```text
URLs referenced (sources)
- https://github.com/ai4curation/metacoder
- https://github.com/moazbuilds/CodeMachine-CLI
- https://aws.amazon.com/blogs/opensource/introducing-cli-agent-orchestrator-transforming-developer-cli-tools-into-a-multi-agent-powerhouse/
- https://code.claude.com/docs/en/cli-reference
- https://developers.openai.com/codex/cli/
- https://developers.openai.com/codex/noninteractive
- https://docs.factory.ai/reference/cli-reference
- https://docs.factory.ai/cli/droid-exec/overview
- https://opencode.ai/
- https://opencode.ai/docs/cli/
- https://github.com/simonw/llm
```


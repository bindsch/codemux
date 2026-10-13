# Provider overrides report

> Historical report: 2026-10-07, release 0.8.0, commit `2b304ed`.
> Disposition: shipped, with endpoint compatibility and cap refusals.
> Current contract: [configuration](configuration.md).

## Delivered behavior

Claude and Codex gained provider overrides. OpenHands overrides returned after
their 0.7 withdrawal. Optional output/context caps were accepted only where
the harness had an appropriate carrier. Half-configured overrides refused
before launch, naming missing variable names without printing secrets.

Codex used a private provider home. Claude used its native Messages endpoint
configuration. OpenHands used `--override-with-envs` and `LLM_*`.
OpenHands shell tools inherited the override API key; the release disclosed
that limitation with a launch warning instead of claiming an unavailable
subprocess scrub mechanism.

## Live acceptance and refusals

Initial Codex requests reached the local Responses endpoint but failed
because it rejected Codex's default grouped `namespace` tool. An explicit
`CODEMUX_CODEX_PROVIDER_MULTI_AGENT=off` retry returned `OK`, exit 0,
on Codex 0.160.1. Unset kept the upstream default. The option did not make
an arbitrary endpoint compatible with all Codex requests.

Claude 2.1.280 returned `OK`, exit 0, through Z.AI's Anthropic-compatible
endpoint. The local vLLM Messages shim rejected a mid-conversation system
role with HTTP 400; moving that information to top-level system produced
HTTP 200 in the recorded direct endpoint experiment. This was a compatibility
observation, not a codemux request-rewriting feature.

OpenCode returned `OK`, exit 0, through the local gateway with the requested
output/context caps. Unsupported cap requests, including Aider's output
cap, refused instead of silently disappearing. Captures were checked for
the test key and reported zero matches.

## Final recorded validation

The suite had **885 pass / 6 skip / 0 fail**, 891 tests across 37 files,
up four tests from the preceding recorded run. `make release-gate` exited 2
at installed contracts because Copilot's cache directory was inaccessible.
Contracts reported 2 pass / 1 fail; remaining stages were run separately
and passed. This is not a successful full gate in that environment.

The [complete report](https://github.com/bindsch/codemux/blob/194151e32f50fd1a2e510f535668f42135f57826/docs/provider-overrides-2-report.md)
preserves endpoint responses and corrections. Ignored scratch captures are
unavailable. Retained [provider end-to-end tests](../tests/provider-override-e2e.test.ts)
use fake harnesses and local endpoints; they do not renew the live claims.

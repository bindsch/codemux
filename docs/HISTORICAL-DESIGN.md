# Historical design notes

> Historical proposal, preserved in commit `adc27d3` (2026-08-02).
> The original research date is not recorded. This is not a command reference.
> Current behavior: [CLI](cli.md) and [documentation index](index.md).

The original proposal described a wrapper that translates a common request
into each harness's command, environment, and output. It proposed separate
adapters, a process runner, capability checks, normalized results, and an
optional plugin system.

The adapter and process-runner approach shipped. The proposed `codeagent`
name, dynamic plugin installation, and illustrative CLI syntax are not
implemented contracts. Later sessions and usage recording have their own
documented interfaces; they do not validate every original proposal.

The competitor survey and upstream links were exploratory research, not a
current compatibility audit. No dated live capture accompanied that survey.

The [complete pre-rebuild proposal](https://github.com/bindsch/codemux/blob/194151e32f50fd1a2e510f535668f42135f57826/docs/HISTORICAL-DESIGN.md)
retains the original examples and research. Use the
[archive index](archive/index.md) to follow subsequent implementation reports.

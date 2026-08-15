# Hooks

Three harnesses audit every commit in parallel. Each runs read-only through
codemux, so an auditor cannot modify the work it is reviewing, and each is
`async` so the commit is never blocked waiting on a model.

## Hook: audit-codex
- on: commit
- agent: codex
- mode: async
- timeout: 900
- do: Review the committed diff for correctness bugs, race conditions, and
      error paths that are silently swallowed. Report only defects you can
      point at a specific line for. If the diff is clean, say so in one line.

## Hook: audit-claude
- on: commit
- agent: claude
- mode: async
- do: Review the committed diff for security regressions: weakened sandbox or
      autonomy boundaries, repository-controlled input reaching execution, and
      credentials or secrets crossing a process boundary. Report only what the
      diff actually changes. If the diff is clean, say so in one line.

## Hook: audit-kimi
- on: commit
- agent: kimi
- mode: async
- do: Review the committed diff for contract drift: documentation, changelog,
      and tests disagreeing with the code they describe. Report only concrete
      mismatches. If the diff is clean, say so in one line.

## Hook: audit-zai
- on: commit
- agent: zai
- model: glm-5.3
- mode: async
- do: Review the committed diff for logic errors and unhandled edge cases:
      boundary conditions, empty and single-element inputs, and error paths
      that return success. Report only defects you can point at a specific
      line for. If the diff is clean, say so in one line.

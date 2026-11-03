# Contributing to codemux

Read the [documentation index](docs/index.md) and
[architecture](docs/architecture.md) before changing a launch or session path.
Keep changes focused. Preserve validation before side effects, launcher-owned
state, and explicit capability refusals. Add regression coverage for bugs.

## Setup and verification

Use Bun 1.3.14 or newer and the repository's existing lockfile:

```sh
bun install --frozen-lockfile
```

Run the [canonical full release gate](docs/RELEASE-GATE.md#automated-gate)
before requesting review. [Testing](docs/TESTING.md) describes focused checks,
coverage, installed contracts, and the separate authorization needed for
live model probes.

The default test suite uses fake peers. The full gate also enables installed
help/version contracts, which skip absent tools. A green gate with skips is
not proof that those tools or live provider behavior were checked.

## Changes and pull requests

Use conventional commit subjects such as `fix:`, `feat:`, or `docs:`.
Keep files focused and below 500 lines: `tests/file-size.test.ts` fails
on any `.ts` file under `src/`, `scripts/`, or `tests/` over that limit,
so split a file by responsibility before it reaches it. Explain the concrete
behavior change, relevant constraints, and the commands and outcomes used
to verify it. Include pass, fail, and skip counts, and compare test totals
when coverage changes.

Update the current reference page and `CHANGELOG.md` when behavior changes.
Historical reports remain dated evidence; do not rewrite their version to
match every new release. Link new outcomes separately.

## Review chain

The repository runs an automated review chain that `hookrun` configures from
[HOOKS.md](HOOKS.md): `code-review run` reviews the change set at `task-end`,
and `code-review gate` refuses a commit without a fresh verdict. HOOKS.md
explains the timing, the limits of the gate, and how to install the shims. Do
not edit HOOKS.md casually: hookrun pins a digest of the approved
configuration, so any change makes the next fire ask for review instead of
executing it.

For suspected vulnerabilities, follow [private reporting](SECURITY.md).
For publication, follow [releasing](docs/RELEASING.md).

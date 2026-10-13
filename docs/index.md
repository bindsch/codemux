# Documentation

These pages describe the current code. Historical evidence is listed separately.
Run `codemux --version` to identify an installed release.

## Start and operate

- [Installation](installation.md): Homebrew, source, platforms, upgrades.
- [CLI reference](cli.md): every command and option.
- [Configuration](configuration.md): defaults, aliases, environment precedence.
- [Harnesses](harnesses.md): capabilities, version requirements, verification evidence.
- [Autonomy and sandboxing](autonomy-and-sandboxing.md): access policy and scode.
- [Isolation](isolation.md): hermetic guarantees, tools, exceptions, persistence.
- [Authentication](authentication.md): credentials, mirrors, Keychain recovery.
- [Provider overrides](provider-overrides.md): routing and token caps.
- [Results and usage](results-and-usage.md): envelopes, limits, ledger, subscription reporting.
- [Sessions](sessions.md): fresh sessions, shutdown, resume.
- [Session protocol](session-protocol.md): input and event schemas.
- [Experiment MCP](experiment-mcp.md): server specification, recordings, verification.
- [Troubleshooting](troubleshooting.md): common refusals and failures.

## Contribute

- [Architecture](architecture.md): adapters, launch paths, drivers, trusted state.
- [Testing](TESTING.md): unit tests, installed contracts, paid probes.
- [Full release gate](RELEASE-GATE.md): canonical verification command.
- [Releasing](RELEASING.md): notes, tags, source and Homebrew artifacts.
- [Contributing](../CONTRIBUTING.md), [security](../SECURITY.md), [license](https://github.com/bindsch/codemux/blob/main/LICENSE).
- [Changelog](https://github.com/bindsch/codemux/blob/main/CHANGELOG.md): user-visible release history.

## Historical evidence

[Archive index](archive/index.md) lists dated designs, investigations, reviews,
and implementation reports. They are evidence about their named snapshots,
not current specifications.

# Installation

Codemux supports source execution on macOS and Linux with Bun 1.3.14 or newer.
The package version and CLI version come from `package.json`.
The source package is private (not an npm publishing target).

## Homebrew

```sh
brew install bindsch/tap/codemux
codemux --version
codemux doctor
```

The [formula](https://github.com/bindsch/homebrew-tap/blob/HEAD/Formula/codemux.rb)
installs Bun and scode dependencies. As checked on 2026-10-13, it targets
v0.13.3 and publishes an Apple Silicon macOS `arm64_golden_gate` bottle.
Other platforms use the source route; a bottle for them is not promised.

The launcher is linked from `bin` into `libexec/bin`. Runtime code,
dependencies, and documentation live in `libexec`. Read installed guides at
`$(brew --prefix codemux)/libexec/docs/index.md`. README uses repository links
because Homebrew can place it above that directory.

## Source

```sh
git clone https://github.com/bindsch/codemux.git
cd codemux
bun install --frozen-lockfile
bun link
./bin/codemux --version
```

Install [scode](https://github.com/bindsch/scode) separately and put it on PATH.
Normal `run`, `tui`, `check`, and `session` execution is sandboxed.
See [conditional scode requirements](harnesses.md).
Install and authenticate the selected harness separately; codemux does not
install it or provision provider accounts.

The source launcher resolves package-manager symlinks, uses its packaged
`bunfig.runtime.toml`, disables automatic environment-file loading and package
installation, and clears `BUN_OPTIONS` and `NODE_OPTIONS`. It invokes Bun from
PATH; use a trusted interpreter. Harness executable trust checks are separate.

## Upgrade and verify

```sh
brew update
brew upgrade bindsch/tap/codemux
codemux --version
codemux doctor
codemux verify --show-scode
```

For source installs, update the checkout to the desired release and run
`bun install --frozen-lockfile`. Read that release's [upgrade notes](https://github.com/bindsch/codemux/blob/main/CHANGELOG.md)
before resuming older sessions. Do not downgrade while a session is active.
`doctor` and `verify` do not send model prompts. `check` does.

Dependencies retain their own licenses in `node_modules`; distributions must
retain them alongside the project's MIT [license](https://github.com/bindsch/codemux/blob/main/LICENSE).

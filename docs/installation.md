---
read_when: "Installing, upgrading, or checking platform support."
---
# Installation

Codemux supports source execution on macOS and Linux with Bun 1.3.14 or newer.
The launcher's ownership and mode checks run the stat dialect each platform
ships (BSD `stat` on macOS, GNU coreutils or BusyBox `stat` on Linux, both
taking the GNU format); the GNU path is
exercised by CI's `make release-gate` on the ubuntu runner, whose smoke and
installed-layout steps execute the launcher itself.
The package version and CLI version come from `package.json`.
The source package is private (not an npm publishing target).

## Homebrew

```sh
brew install bindsch/tap/codemux
codemux --version
codemux doctor
```

The [formula](https://github.com/bindsch/homebrew-tap/blob/HEAD/Formula/codemux.rb)
installs Bun and scode dependencies, and pins the launcher to the brewed Bun
by rewriting its `codemux_pinned_bun=` line at install time. The tap pins the
latest tag and publishes
an Apple Silicon macOS `arm64_golden_gate` bottle. Other platforms use the
source route; a bottle for them is not promised.

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
See [conditional scode requirements](autonomy-and-sandboxing.md#conditional-scode-requirements).
Install and authenticate the selected harness separately; codemux does not
install it or provision provider accounts.

The source launcher resolves package-manager symlinks, uses its packaged
`bunfig.runtime.toml`, disables automatic environment-file loading and package
installation, and clears `BUN_OPTIONS` and `NODE_OPTIONS`. It invokes Bun from
PATH; use a trusted interpreter. The directory chain it accepts follows the
usagemux backend rule: every directory Bun was found through must be owned by
this user or root and not world-writable (sticky or not), while group-writable
directories — a shared `/usr/local/bin` under the admin group — pass;
ancestors up to `/` follow the `/tmp` rule and may be world-writable when
sticky; the directory is judged through symlinked components too. The Bun
binary itself must carry no group or world write bit. Harness executable trust
checks are separate.

The launcher's own trust-checking tools (`readlink`, `id`, `stat`) never come
from PATH. Each is resolved once from the first match in `/usr/bin`, `/bin`,
`/run/current-system/sw/bin`, `/usr/local/bin`, `/opt/homebrew/bin` (the
system-managed directories first) that is a
regular file owned by root or this user with no group or world write bit —
the same rule the Bun binary is held to — so distributions whose coreutils
are not under `/usr/bin` (NixOS) work, and a planted PATH entry cannot
substitute them. A system with no acceptable candidate in that list refuses
to start.

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

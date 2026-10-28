---
read_when: "Preparing or publishing an authorized release."
---
# Releasing

Codemux is a private source package distributed through GitHub and Homebrew.
It is not an npm publication target. This workflow requires authorization
before pushing, publishing a release, or changing the shared Homebrew tap.

## Prepare the candidate

1. Start from the intended release base and inspect the working tree.
2. Update `package.json`; the CLI reads its version directly.
3. Move user-visible `[Unreleased]` entries into a dated
   `## [X.Y.Z] - YYYY-MM-DD` changelog section. Keep a new `[Unreleased]`
   heading. Include concrete upgrade constraints and capability changes.
4. Update current references and installation claims. Preserve historical
   report dates and release scopes.
5. Run the [canonical full gate and checklist](RELEASE-GATE.md#automated-gate).
   Record exact outcomes, skips, and test-count changes.
6. Have the owner run `make live-gate` on the release machine before tagging.
   This required step spends quota. Record both probes and all skips under the
   [live harness gate](RELEASE-GATE.md#live-harness-gate). Refuse the release
   if an installed, credentialed harness fails either probe or a feature
   differs across harnesses without a documented unsupported entry.
7. Prepare the release notes from that release's curated changelog section.
   Review the exact text before publication.
8. Commit using the repository's conventional commit format. Follow the
   authorized review and merge process. Wait for CI on the exact commit to tag.

## Publish the approved candidate

After verifying that the local commit is the reviewed remote commit, create
an annotated tag and publish the prepared notes. Replace all placeholders;
the notes file must contain the curated section's text.

```sh
git tag -a vX.Y.Z <reviewed-commit> -m "codemux X.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --verify-tag --title "codemux X.Y.Z" --notes-file scratch/release-notes.md
```

Do not use generated commit summaries in place of curated release notes.
Do not tag a different commit merely because it is now the branch tip.

## Verify distributions

Confirm the remote tag and tag-triggered CI on macOS and Linux. Download the
tagged source archive, compute its SHA-256, and test its frozen-lockfile
installation. Confirm the published notes match the reviewed changelog text.

For an authorized Homebrew update, update the formula's source tag and pinned
revision, or its archive URL and checksum when using an archive source.
Publish bottles only for tested platforms and use their
actual checksums. Verify runtime dependencies, project and dependency
licenses, launcher symlink layout, runtime files, and installed documentation
using the [distribution checklist](RELEASE-GATE.md#distribution-and-installed-layout).

The installed guides belong under `libexec/docs`; README may be installed
above `libexec`. Check links from that installed layout. Confirm the
installed version, every help surface, and static verification. These checks
do not authorize a paid model probe.

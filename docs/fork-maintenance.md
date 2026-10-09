# Fork packaging and installation

`upstream` is the read-only upstream repository. All source branches, the verified
`local/aggregate`, and release tags are published to `origin`
(`hxy91819/bb-plugin-usage`). This repository keeps its existing cherry-pick
aggregation and `config/local-aggregate-features.json` registry; packaging does
not migrate branch history. `fork-tooling`, based on the configured upstream
baseline, owns the release workflow and scripts. Cherry-pick its verified
commits with `-x` into `local/aggregate`.

Before packaging, fetch both remotes, inspect all worktrees, compare each feature
head with its registered source commit and fork head, and check upstream
changes and issue/PR feedback. Integrate reviewed source commits first. Never
package uncommitted product changes or silently change the upstream baseline.

## Publish

After source branch verification, run `npm run check`, `npm test`,
`npm run build`, and `npm run test:built` on the aggregate. Push its exact commit
to the fork. Choose the next unused `fork-v<package-version>-<UTC YYYYMMDD>.<n>`
tag, starting at 1, then publish an annotated tag:

```sh
git tag -a fork-v0.3.18-20261003.2 <verified-aggregate-sha> -m 'Usage aggregate release'
git push origin refs/tags/fork-v0.3.18-20261003.2
gh run list --repo hxy91819/bb-plugin-usage --workflow fork-release.yml
gh release view fork-v0.3.18-20261003.2 --repo hxy91819/bb-plugin-usage
```

`.github/workflows/fork-release.yml` checks the tagged source, uses BB 0.44.0 to
build once, packages compiled JS/CSS without npm dependencies, and installs the
actual archive in an isolated BB server. The publish job downloads those same
assets, verifies SHA-256 and the tag's source commit, creates a draft release,
uploads and downloads all assets for byte comparison, then makes it public.
Only the personal fork can run this publication job.

Release assets: `bb-plugin-usage-<tag>-portable.tar.gz`, `release.json`,
`RELEASE_NOTES.md`, and `SHA256SUMS`. The metadata records the source SHA, upstream
baseline, included branches, build SDK, and tested platform. Linux x64 is
smoke-tested; macOS uses the same JavaScript assets but is not verified in CI.
There are no native plugin dependencies. BB itself is installed separately.
Host collectors still require the external tools described in README.md.

An interrupted run can be resumed with `gh run rerun <run-id> --failed --repo
hxy91819/bb-plugin-usage`. Existing draft assets must match; published assets
are immutable. If a rebuild produces different bytes, publish a new tag instead
of deleting or overwriting an existing release.

## Install in another environment

The archive preserves the source `package.json` engine requirements unchanged
(currently BB `>=0.36` and `bbPluginSdk` `^0.4.1`). CI uses BB 0.44.0 for building
and smoke testing; packaging does not add an installation version restriction.
Other BB versions are not smoke-tested by this workflow. Installation needs
`curl`, `tar`, and `sha256sum` (use `shasum -a 256 -c` on macOS). The commands run
on the machine hosting the BB server. Pick a permanent
versioned directory: BB keeps loading the plugin from that directory.

```sh
tag=fork-v0.3.18-20261003.2
install_dir="$HOME/.local/share/bb-plugins/usage/$tag"
mkdir -p "$install_dir"
cd "$install_dir"
base="https://github.com/hxy91819/bb-plugin-usage/releases/download/$tag"
archive="bb-plugin-usage-$tag-portable.tar.gz"
for file in "$archive" release.json RELEASE_NOTES.md SHA256SUMS; do
  curl --fail --location --output "$file" "$base/$file" || exit 1
done
sha256sum -c SHA256SUMS || exit 1
tar -xzf "$archive"
bb plugin install "path:$install_dir/bb-plugin-usage" --yes
```

Open **Usage** in BB. No clone, npm install, source aggregation, or manual build
is required. BB may rewrap the compiled JS during a path install; the package
includes the original CSS so styles survive this step.

For an upgrade from an existing local-path Usage installation, install the new
versioned directory the same way; BB moves the plugin and keeps its settings,
secrets, and schedules. Retain the previous directory until the upgrade is
verified. If Usage is already installed as a managed `git:` or `npm:` source,
BB refuses an overlapping install: preserve its settings before using BB's
remove/reinstall flow (removal deletes plugin settings, secrets, and schedules).
Do not remove an existing managed installation automatically.

# Usage fork fork-v0.3.20-20261029.1

Source: `ebf249aa136b1cfe8a44668f39734ce7ab25eda4`. Upstream package: 0.3.20.

Includes all 12 registered aggregate branches. Compatibility requirements are inherited unchanged from source package.json: BB >=0.36, SDK ^0.4.1.

Download `bb-plugin-usage-fork-v0.3.20-20261029.1-portable.tar.gz`, `release.json`, `RELEASE_NOTES.md`, and `SHA256SUMS`; run `sha256sum -c SHA256SUMS`, extract to a permanent directory, and run `bb plugin install path:/absolute/path/bb-plugin-usage --yes`. See docs/fork-maintenance.md in the archive for installation and upgrades.

Contains compiled JavaScript and CSS; no npm install or manual source build is needed. BB may rewrap the JS during path installation. Linux x64 installation is verified in CI; macOS uses the same portable assets but is not smoke-tested. Host collector runtime requirements remain documented in README.md.

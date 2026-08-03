# Distribution

Relay distributes the same tagged native release binaries through three routes:

- GitHub Releases: direct download with a SHA-256 file.
- npm: `@ictechgy/relay@next` selects a platform package without compiling Rust.
- Homebrew: `ictechgy/tap/relay` downloads the architecture-specific GitHub
  Release binary and verifies its Formula checksum.

The npm wrapper supports `darwin-arm64`, `darwin-x64`, and `linux-x64`. It fails
closed on unsupported platforms; in particular, Windows is not supported by
Relay's managed-state safety model.

## Publishing npm packages

The release workflow turns verified GitHub Actions binaries into four tarballs:
three platform packages, followed by the wrapper package. The wrapper must be
staged and approved last so npm can resolve its exact optional dependencies.

Relay uses npm trusted publishing with GitHub Actions OIDC, not an `NPM_TOKEN`
repository secret. The tag workflow uses Node 24 and npm 11.15 or later to
stage each package with the `next` dist-tag. It cannot make a staged package
public: a maintainer must inspect and approve it with npm 2FA.

Before enabling the repository variable `PUBLISH_NPM=true`, configure the same
trusted publisher for each existing package:

- `@ictechgy/relay-darwin-arm64`
- `@ictechgy/relay-darwin-x64`
- `@ictechgy/relay-linux-x64`
- `@ictechgy/relay`

In each package's npm settings, select GitHub Actions and set:

- Organization or user: `ictechgy`
- Repository: `relay-continuity`
- Workflow filename: `release.yml` (the filename only)
- Allowed action: `npm stage publish` only; do not allow `npm publish`

The package metadata must continue to identify
`git+https://github.com/ictechgy/relay-continuity.git` as its repository. The
release workflow validates that metadata in templates and packed tarballs before
the staging job can run.

After confirming the first OIDC staging rehearsal succeeds, use each package's
Publishing access setting to require 2FA and disallow tokens, then revoke any
unused npm automation token. These npm settings and token changes are
owner-controlled actions; they are not performed by this repository. npm's
[trusted publishing guide](https://docs.npmjs.com/trusted-publishers/) and
[staged publishing guide](https://docs.npmjs.com/staged-publishing/) are the
source of truth for current account and CLI requirements.

For a tagged release, download the `npm-stage-manifest` workflow artifact. It
records the verified package, tarball, version, SHA-256 digest, and immutable
`next` dist-tag in staging order. Before staging, CI recomputes each digest from
the downloaded tarball and compares it to the package artifact manifest. CI
deliberately does not guess or parse a stage ID from npm command output. In npm's
Staged Packages UI (or with an authenticated maintainer CLI session), find each
package/version from that manifest, record its stage ID, and download the staged
tarball for inspection. Recompute its SHA-256 and compare it to the matching
`npm-stage-manifest` entry before approval. Then approve the three platform packages first and
`@ictechgy/relay` last. Approving a stage makes it public and prompts for 2FA;
the CI job only stages it. If staging fails after a partial run, inspect the
manifest and Staged Packages before retrying: a staged version already occupies
that package version. Do not enable `PUBLISH_NPM` until all four trusted publisher
configurations have been verified.

If publication is intentionally disabled, download the `npm-packages` workflow
artifact, publish the three `relay-*` platform tarballs with `--access public
--tag next`, then publish the `relay` wrapper tarball with the same tag. Never
publish a tarball whose version does not equal the release tag version. This
manual fallback is a maintainer operation and must preserve the same
platform-before-wrapper order.

## Updating the Homebrew tap

After a GitHub Release is published, download its three `.sha256` assets and
render the Formula from the release repository:

```sh
node scripts/render-homebrew-formula.mjs \
  --version 0.2.0-rc.7 \
  --macos-arm64 <sha256> \
  --macos-x64 <sha256> \
  --linux-x64 <sha256> > Formula/relay.rb
```

Commit that Formula to `ictechgy/homebrew-tap`. The Formula only references
immutable tag URLs and checksums; it does not execute an installer script.

# Distribution

Relay distributes the same tagged native release binaries through three routes:

- GitHub Releases: direct download with a SHA-256 file.
- npm: `@ictechgy/relay` selects a platform package without compiling Rust.
- Homebrew: `ictechgy/tap/relay` downloads the architecture-specific GitHub
  Release binary and verifies its Formula checksum.

The npm wrapper supports `darwin-arm64`, `darwin-x64`, and `linux-x64`. It fails
closed on unsupported platforms; in particular, Windows is not supported by
Relay's managed-state safety model.

## Publishing npm packages

The release workflow turns verified GitHub Actions binaries into four tarballs:
three platform packages, followed by the wrapper package. The wrapper must be
published last so npm can resolve its exact optional dependencies.

Set an `NPM_TOKEN` repository secret and set the repository variable
`PUBLISH_NPM` to `true` only after configuring the `@ictechgy` npm scope for
public publishing. The tag workflow then publishes with provenance enabled.

If publication is intentionally disabled, download the `npm-packages` workflow
artifact, publish the three `relay-*` platform tarballs with `--access public`,
then publish the `relay` wrapper tarball. Never publish a tarball whose version
does not equal the release tag version.

## Updating the Homebrew tap

After a GitHub Release is published, download its three `.sha256` assets and
render the Formula from the release repository:

```sh
node scripts/render-homebrew-formula.mjs \
  --version 0.2.0-rc.5 \
  --macos-arm64 <sha256> \
  --macos-x64 <sha256> \
  --linux-x64 <sha256> > Formula/relay.rb
```

Commit that Formula to `ictechgy/homebrew-tap`. The Formula only references
immutable tag URLs and checksums; it does not execute an installer script.

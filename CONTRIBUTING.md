# Contributing to Relay

Relay changes must preserve the local-only, evidence-first boundary: never add
network telemetry, source bodies, raw diffs, terminal output, chat transcripts,
or unredacted command/annotation metadata to local evidence.

Run the following before proposing a change:

```sh
cargo fmt --check
cargo check --all-targets --locked
cargo test --locked
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo build --release --locked
cargo audit --deny warnings
node scripts/test-release-workflow.mjs
node scripts/verify-public-artifacts.mjs
git diff --check
```

CI runs the Rust gates on pinned macOS and Linux runner versions, validates
generated launchd/systemd service templates on their native hosts, and runs the
packaging, wrapper, public-artifact, release-contract, and Homebrew Formula
checks. New workflow actions must use an audited full commit SHA, not a mutable
tag. Release changes must preserve the exact Cargo-version/tag binding and the
portable musl Linux smoke contract.

Tests must use disposable Git fixtures and may inspect only privacy-safe local
artifacts. New capture mechanisms must work without a vendor adapter and must
make uncertainty visible rather than claiming a stale assertion is verified.
Diagnostic changes must prove that `relay doctor` is side-effect-free and that
its text/JSON output contains only documented fixed fields and reason codes.

Public bug reports and feature requests must never ask contributors to paste
source bodies, raw diffs, command output, paths, chats, tokens, credentials,
or customer data. Route potential vulnerabilities to `SECURITY.md` and private
vulnerability reporting instead of public issues.

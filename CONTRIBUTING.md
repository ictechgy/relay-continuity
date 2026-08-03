# Contributing to Relay

Relay changes must preserve the local-only, evidence-first boundary: never add
network telemetry, source bodies, raw diffs, terminal output, chat transcripts,
or unredacted command/annotation metadata to local evidence.

Run the following before proposing a change:

```sh
cargo fmt --check
cargo test --locked
cargo build --locked
```

Tests must use disposable Git fixtures and may inspect only privacy-safe local
artifacts. New capture mechanisms must work without a vendor adapter and must
make uncertainty visible rather than claiming a stale assertion is verified.

Public bug reports and feature requests must never ask contributors to paste
source bodies, raw diffs, command output, paths, chats, tokens, credentials,
or customer data. Route potential vulnerabilities to `SECURITY.md` and private
vulnerability reporting instead of public issues.

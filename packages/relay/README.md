# @ictechgy/relay

Install Relay without a Rust toolchain:

```sh
npm install --global @ictechgy/relay
```

The package selects a verified native binary for macOS Apple Silicon, macOS
Intel, or Linux x86_64. It does not download a binary during installation and
does not support Windows.

Relay is local-first: it stores work evidence locally and does not retain chats,
source bodies, diffs, telemetry, or raw command output. See the repository for
security boundaries and integration setup.

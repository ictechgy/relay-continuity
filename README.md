# Relay

Relay is a local, evidence-first continuity tool for AI-assisted software work.
It records Git snapshots and explicit check outcomes locally, then renders a small
resume card. It does not store source bodies, raw diffs, chats, telemetry, or
raw command output.

> v0.1 is under active development. It is not a transcript recovery tool and
> cannot universally observe an AI tool's quota or internal reasoning.

## Trust model

- `FRESH`: the recorded Git snapshot equals the current worktree snapshot.
- `STALE`: a prior assertion is no longer proven against the current snapshot.
- `BROKEN`: the most recent recorded check failed.
- `UNKNOWN`: Relay has no evidence for the claim.

## Development

`cargo test` runs the local test suite. The project is local-only by design.
Tags beginning with `v` build a macOS and Linux binary plus a SHA-256 checksum
for each platform in GitHub Actions. A public release is intentionally deferred
until a repository owner and release authority are selected.

`relay init` creates local ignored state. `relay daemon start` runs a local
filesystem watcher, debounces bursts for 750 ms, and records only a reconciled
Git snapshot hash; `relay daemon stop` and `relay daemon status` manage and
inspect that process. `relay status` always says whether generic capture is
active and keeps semantic context explicitly `unknown` without an adapter.

`relay check <command>` records only a safe command identity and exit code, and
`relay note <text>` writes an explicitly unverified, hashed annotation. The
legacy `relay watch 60` command remains a foreground polling diagnostic, not
the normal automatic-capture path.

For terminal checks, run `relay shell zsh`, `relay shell bash`, or `relay shell
fish` once and add its emitted hook to the matching shell configuration. The
hook calls `relay record-check` after commands, which hashes the command before
it reaches SQLite. It is opt-in because shell history itself can be sensitive;
Relay does not modify shell profiles automatically.

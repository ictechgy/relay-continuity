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
inspect that process. Stop is a nonce-checked local request; Relay never sends
a signal to a PID from its state file. `relay status` always says whether generic capture is
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

`relay compact` appends a privacy-safe aggregate epoch. `relay explain` shows
only that epoch's event/check counts and summary hash; it never reconstructs
source, diffs, outputs, or annotations.

## Provider capability matrix

| Capability | Relay v0.1 |
| --- | --- |
| Git/filesystem/check evidence | Supported without a provider adapter |
| Codex, Claude, Grok, or other AI chat state | Not captured |
| GUI context injection or quota-end detection | Unsupported |
| Provider adapters | Not shipped in v0.1; the generic core remains available |

`relay adapter <provider> <metadata>` rejects all input in v0.1. This explicit
boundary prevents malformed or provider-shaped metadata from being mistaken for
verified evidence or entering the core database.

Relay carries observable work evidence, not a complete AI thought process.

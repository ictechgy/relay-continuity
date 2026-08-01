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

`relay init` creates local ignored state. `relay watch 60` polls Git snapshots,
`relay check <command>` records only a safe command identity and exit code, and
`relay note <text>` writes an explicitly unverified annotation.

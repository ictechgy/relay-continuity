# Security and privacy

Relay v0.2 is local-only. It must not persist source bodies, raw diffs, chat
transcripts, telemetry, or raw command output. Paths, branch names, command
metadata, annotations, and diagnostics are treated as potentially sensitive.

Managed-state security is currently supported on macOS and Linux only. On
Windows, Relay refuses managed-state operations rather than falling back to
path-based file access that could weaken symlink protections.

SQLite evidence is kept in a user-local state directory outside the Git
worktree. This is a deliberate trust boundary: a repository can control files
below its root, but it cannot redirect evidence or SQLite sidecars through a
swapped `.relay` path. The optional `RELAY_STATE_HOME` override must be an
absolute path under the invoking user's control; do not point it at an
untrusted or shared directory.

Core event, check, assertion, annotation, adapter, and epoch evidence is
append-only. Repository path names are treated as sensitive bounded metadata,
not permanent evidence: Relay stores at most 128 path rows per event and 4096
overall, and `relay compact` retains only the most recent 512. Automatic AI
context omits those names entirely.

The daemon treats malformed or unsafe `.relayignore` state as fail-closed: it
keeps running but writes no new snapshot evidence until a bounded no-follow
refresh succeeds. Transient Git failures are retried. Only fixed degradation
categories are stored or displayed; raw diagnostics and paths are not retained.

Tagged native builds receive GitHub artifact attestations scoped to the exact
repository, release workflow, Git ref, and commit. npm packaging verifies those
attestations first, then requires each bounded packed native payload to match
the attested binary and its SHA-256. Package lifecycle scripts and bundled
dependency metadata are rejected before staging.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/ictechgy/relay-continuity/security/advisories/new)
for this repository. Do not report potential vulnerabilities in public issues.

Include the affected version or commit, a minimal reproduction, impact, and any
suggested mitigation. Do not include credentials, customer data, source bodies,
chat transcripts, or raw command output in a report.

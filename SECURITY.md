# Security and privacy

Relay v0.2 is local-only. It must not persist source bodies, raw diffs, chat
transcripts, telemetry, or raw command output. Paths, branch names, command
metadata, annotations, and diagnostics are treated as potentially sensitive.

Managed-state security is currently supported on macOS and Linux only. On
Windows, Relay refuses managed-state operations rather than falling back to
path-based file access that could weaken symlink protections.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/ictechgy/relay-continuity/security/advisories/new)
for this repository. Do not report potential vulnerabilities in public issues.

Include the affected version or commit, a minimal reproduction, impact, and any
suggested mitigation. Do not include credentials, customer data, source bodies,
chat transcripts, or raw command output in a report.

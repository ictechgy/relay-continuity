# Test specification: Relay portable pilot readiness

| ID | Check | Evidence / expected result |
| --- | --- | --- |
| P1 | Release contract unit cases | Exact Cargo SemVer passes; malformed versions, non-tag push refs, and every tag not byte-equal to `v${version}` fail. |
| P2 | Workflow dependency graph | Every job owning archive creation/upload, attestation, npm package assembly/upload, npm staging, or publish authority transitively depends on the contract job; release jobs have timeouts and concurrency. |
| P3 | Portable Linux build | Release matrix uses `x86_64-unknown-linux-musl`; final public-name binary has no ELF `NEEDED` entry, `PT_INTERP`/`INTERP` program header, or `GLIBC_*` symbol string. |
| P4 | Older runtime smoke | The exact Linux artifact runs help/version and disposable-repository `init/status` smoke in digest-pinned Ubuntu 22.04 and Debian 12 x86_64 containers; the container root and artifact bind mount are read-only, with only disposable repository/state and bounded temporary storage writable. |
| C1 | Global CLI contract | `help/-h/--help` and `version/-V/--version` succeed outside Git; unknown command is nonzero. All leave cwd and isolated state home byte-identical. |
| D1 | Doctor output contract | Text and valid schema-version-1 JSON use only documented keys/enums; no absolute paths, raw errors, repository/branch/path/note content, or sentinel secrets. Both modes remain at or below 4096 bytes under oversized hostile fixtures and fail before emitting any over-limit representation. |
| D2 | Doctor side effects | Fresh, initialized, corrupt-header, symlink, drifted integration/service, stale daemon, and isolated-home fixtures have identical before/after filesystem manifests. |
| D3 | Doctor exit semantics | An all-pass healthy report exits 0; broken/drifted/unsafe or unknown/indeterminate required state exits 1; degraded state and any other warning exit 1; absent optional integration, capture-daemon, or user-service state is an explicit pass reason and alone still permits exit 0. |
| A1 | AI-card adversarial corpus | ANSI/CRLF/control/RTL/zero-width/very-long repository-name, branch, path, and note sentinels do not occur in automatic context; fixed hashes/counts remain. |
| A2 | AI-card boundedness | Automatic context remains below its declared word and byte budgets with more dirty entries than the cap and repeated hostile metadata. |
| Q1 | Native service rendering | Linux `systemd-analyze verify` and macOS `plutil -lint` accept adversarial executable/template output. |
| Q2 | Workflow/action integrity | Every remote `uses:` reference is a full 40-hex SHA; audited first-party pins/comments/counts match expected values. |
| Q3 | Dependency/review configuration | Dependabot covers Cargo and GitHub Actions on a bounded schedule; CodeRabbit covers source, tests, workflows, scripts, packages, docs, forms, manifests, and lockfiles. |
| Q4 | Documentation truth | README, CONTRIBUTING, SECURITY, issue form, and distribution docs match doctor/version commands, portable Linux contract, supported prerelease policy, current gates, and provider limitations. |
| R1 | Regression suite | fmt, locked check/test/clippy/release build, package/workflow/public-artifact scripts, cargo audit, and diff check pass. |
| R2 | Architecture invariant audit | No network runtime, telemetry, new sensitive persistence, raw AI metadata, implicit repair, unsupported provider enablement, or unbounded repository scan was added. |
| R3 | Independent final review | Code/spec/security-performance reviewer and architect both issue explicit non-blocking verdicts for the same final head; fixes cause renewed review. |
| E1 | External boundary | No tag, npm dist-tag, signing, service enablement, foreign hook mutation, branch/ruleset mutation, or GA claim occurs during repository-local completion. |

# G107-G111 final independent review

## Immutable review snapshot

- baseline: `632eb98678952d4deb2c1bf200c0df8ac67b2597`
- reviewed head: `f40f6c0873635b2fa4ca52219dd95fe2fda9ac1d`
- binary diff SHA-256: `7dd15e76baec1bcc3e7ec88ded9405a6542050e41a4232c09e9597eb0d9df388`
- worktree at dispatch: clean
- governing sources:
  - `.omx/ultragoal/brief.md`
  - `.omx/ultragoal/goals.json`
  - `.omx/artifacts/claude-relay-whole-review-summary-20260806.md`
  - `.omx/artifacts/architecture-invariant-audit-g107-g111-20260806.md`

## Review chronology and snapshot validity

The first independent lanes reviewed head `c2e7422b47adca3cf6845c941fca7c7cf6a43afe`
with binary diff SHA-256
`c284bcc7985912be4217118c75ded74c5a51cd3c4429151cbb4c6849f0899b30`.
The code lane reported zero findings and `APPROVE`; the architecture lane
reported zero concerns and `CLEAR`. Those verdicts were invalidated before this
gate because the reviewed head changed.

An owner-side follow-up against official GitHub documentation found that the
packaging job needed an explicit short-lived `GH_TOKEN` and
`attestations: read` permission for authenticated `gh attestation verify`.
The same bounded follow-up found that the public-artifact scanner missed local
`file:` URLs and could misclassify non-ASCII repository-relative paths. Commit
`258e92c` fixed those issues and added direct workflow/scanner regressions;
commit `f40f6c0` recorded the post-review cleaner delta. No earlier approval is
used as evidence for the final gate.

The two fresh lanes below independently reviewed the complete final diff and
matched the frozen patch hash. The code-lane temporary workspace path is
replaced by `[temporary workspace]` to keep this tracked public artifact free
of workstation-local metadata; no finding, command meaning, result, or verdict
was changed.

## Final code-reviewer output

> ## Code Review Summary
>
> **Files Reviewed:** 25 changed files in `632eb98678952d4deb2c1bf200c0df8ac67b2597..f40f6c0873635b2fa4ca52219dd95fe2fda9ac1d`
> **Binary Diff SHA-256:** matched `7dd15e76baec1bcc3e7ec88ded9405a6542050e41a4232c09e9597eb0d9df388`
> **Total Issues:** 0
>
> ### By Severity
> - CRITICAL: 0
> - HIGH: 0
> - MEDIUM: 0
> - LOW: 0
>
> ### Issues
> No actionable findings.
>
> I verified the implementation against the G107-G111 brief/spec artifacts and inspected the actual diff/code paths for daemon recovery, writer locking, SQLite bounds/transactions, service path rendering, release/package provenance, public artifact scanning, wrapper exit/signal semantics, tests, docs, and workflows. I did not find a root-cause-masking fallback: the watcher polling and degraded daemon states remain explicit, bounded, and visible; malformed control state fails closed; corruption recovery preserves evidence by quarantine.
>
> ### Validation
> - `git diff --binary ... | shasum -a 256`: matched expected hash
> - `cargo check --all-targets`: passed
> - `cargo fmt --check`: passed
> - `cargo clippy --all-targets --all-features --locked -- -D warnings`: passed
> - `RELAY_STATE_HOME=[temporary workspace] cargo test --locked`: passed, 46 tests
> - `node --check` on changed JS scripts/wrapper: passed
> - `node scripts/verify-npm-packages.mjs --templates`: passed
> - `npm_config_cache=[temporary workspace] node scripts/test-package-npm.mjs`: passed
> - `node scripts/verify-public-artifacts.mjs`: passed
> - `node scripts/test-public-artifacts.mjs`: passed
> - `node scripts/test-relay-wrapper.mjs`: passed
> - `node scripts/test-release-workflow.mjs`: passed
> - `git diff --check`: passed
> - Worktree remained clean after review
>
> Note: the first unspecialized `cargo test --locked` and npm package-test attempts failed due sandbox/user-environment write permissions (`RELAY_STATE_HOME` default outside writable sandbox and root-owned npm cache). Reruns with writable temporary locations passed and exercised the same code paths.
>
> RECOMMENDATION: APPROVE

## Final architect output

> ## Concerns
>
> No blocking architecture concerns found in `632eb98678952d4deb2c1bf200c0df8ac67b2597..f40f6c0873635b2fa4ca52219dd95fe2fda9ac1d`. The binary diff hash matches the expected `7dd15e76baec1bcc3e7ec88ded9405a6542050e41a4232c09e9597eb0d9df388`, and `git status --short` plus `git diff --check` were clean.
>
> ## Analysis
>
> The core privacy boundary holds: the brief forbids source/chat/raw-diff/raw-output persistence and invented external evidence (`.omx/ultragoal/brief.md:39-46`), README states the same product contract (`README.md:3-6`), and AI-context rendering omits untrusted branch/path/annotation names while operator cards remain local (`src/main.rs:2269-2313`). Adapter metadata is provider-limited and stores a hash, not raw metadata (`src/main.rs:2183-2201`).
>
> Managed paths and symlink boundaries are materially stronger. Repository-managed writes use component validation, descriptor-relative `openat`, `O_NOFOLLOW`, and descriptor-relative rename/verify (`src/main.rs:204-268`, `src/main.rs:271-333`). Evidence SQLite moved outside the worktree and uses absolute state-home checks, `SQLITE_OPEN_NOFOLLOW`, and a bounded 16-byte header probe (`src/main.rs:1344-1398`, `src/main.rs:1408-1443`). Regression coverage exercises symlinked DB files, swapped `.relay`, descriptor anchoring, and header bounds (`src/main.rs:2627-2761`).
>
> Writer ownership now uses a persistent `writer.lock` opened with `O_NOFOLLOW`, validates regular single-link metadata, and relies on kernel `flock` release on descriptor close (`src/main.rs:1236-1273`). Tests cover live competing locks, concurrent observers producing one transition, and symlink lock refusal (`tests/daemon_lifecycle.rs:1272-1353`, `src/main.rs:2890-2937`).
>
> Evidence storage is bounded and atomic where the prior finding mattered: path rows are capped at 128 per event, retained to 4096, compacted to 512, and event/path insertion is one SQLite transaction (`src/main.rs:1767-1814`, `src/main.rs:2128-2138`). Tests prove the cap, rollback on path failure, and compact retention without deleting core events (`tests/daemon_lifecycle.rs:1165-1223`, `src/main.rs:2854-2879`).
>
> Daemon degradation/recovery is fail-closed for malformed repo controls but tolerant of transient repo loss. Git failures are typed (`src/main.rs:1504-1546`), `.relayignore` is no-follow/bounded (`src/main.rs:1587-1650`), degradation reasons are nonce-bound fixed categories (`src/main.rs:1863-1901`), and the daemon uses a root-only watcher plus one-second reconciliation and polling fallback (`src/main.rs:1822-1846`, `src/main.rs:2026-2102`). Tests cover hidden `.git`, unsafe `.relayignore`, recovery, unborn HEAD, and nested polling capture (`tests/daemon_lifecycle.rs:634-821`).
>
> Release provenance is architecturally coherent for repo-controlled state. The workflow grants attestation write only to archive, attestation read only to packaging, and npm OIDC only behind tag plus `PUBLISH_NPM` (`.github/workflows/release.yml:6-13`, `.github/workflows/release.yml:45-71`, `.github/workflows/release.yml:88-127`). Package verification binds template/generated/packed manifests, rejects lifecycle/bundled metadata, and compares native binary SHA-256 across release artifact, checksum, generated package, and packed tarball (`scripts/verify-npm-packages.mjs:150-193`, `scripts/verify-npm-packages.mjs:214-315`). Current GitHub docs and `gh attestation verify` manual support the chosen `actions/attest@v4` and verification flag model: https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations and https://cli.github.com/manual/gh_attestation_verify.
>
> Public artifact scanning is scoped and bounded: it scans tracked `.omx` files only, rejects unreadable/non-regular/oversize/non-UTF8 artifacts, strips documented placeholders/remote URLs for path checks, detects common secret patterns, and caps diagnostics (`scripts/verify-public-artifacts.mjs:13-90`, `scripts/verify-public-artifacts.mjs:99-107`, `scripts/verify-public-artifacts.mjs:141-269`). Tests cover absolute-path positives, repository-relative false-positive avoidance, token positives, placeholders, size limits, and diagnostic redaction (`scripts/test-public-artifacts.mjs:46-186`).
>
> Wrapper signal/status fidelity is fixed: the npm wrapper maps child signal termination to `128 + signal` and otherwise preserves child status (`packages/relay/bin/relay.js:34-53`), with execution tests for success, exit 37, and SIGTERM 143 (`scripts/test-relay-wrapper.mjs:61-64`).
>
> ## Residual Risk
>
> The strongest counterargument is that daemon liveness still cannot cryptographically bind a PID to a specific executable/start-time; `daemon_active` checks PID liveness plus a nonce-ready file (`src/main.rs:1921-1930`). I do not treat this as blocking because `stop_daemon` never signals that PID and only requests nonce-based cooperative shutdown (`src/main.rs:1999-2012`), so the remaining risk is stale availability reporting, not arbitrary process control.
>
> Hosted/external evidence is not yet available for this changed release workflow. The invariant audit explicitly does not claim a new attestation workflow run, tag, or package publication (`.omx/artifacts/architecture-invariant-audit-g107-g111-20260806.md:47-50`). That is an external acceptance gate, not a defect in the repository snapshot.
>
> ## Architectural Status
>
> CLEAR. The implementation preserves the local-first/provider-neutral architecture, hardens repository/path trust boundaries, bounds evidence and hot-path work, and keeps release publication authority outside the repository automation.
>
> ARCHITECTURE: CLEAR

## Local verification evidence

The following completed after the final behavior change and before review:

- `cargo fmt --check`
- `cargo check --all-targets --locked`
- `cargo test --locked`: 46 passed
- `cargo clippy --all-targets --all-features --locked -- -D warnings`
- `cargo build --release --locked`
- `cargo audit --deny warnings`: 50 locked dependencies scanned against 1189 advisories, no warnings
- JavaScript syntax checks for all distribution scripts
- template, adversarial npm package, wrapper, release-workflow, and public-artifact tests
- Homebrew formula render plus Ruby syntax
- CI/release YAML, JSON, and JSONL parsing
- `git diff --check`

## Final synthesis

- code recommendation: `APPROVE`
- architecture status: `CLEAR`
- actionable findings: 0
- reviewed implementation head: `f40f6c0873635b2fa4ca52219dd95fe2fda9ac1d`
- G111 repository gate: PASS
- hosted release gate: NOT YET RUN; a future tag must produce and verify real
  GitHub-hosted attestations before any new publication claim

Verdict: non-blocking for repository integration. A future release remains
blocked on its own hosted tag, attestation, staging, and maintainer approval
evidence.

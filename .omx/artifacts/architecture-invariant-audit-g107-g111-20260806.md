# G107-G111 architecture invariant audit

- review baseline: `632eb98678952d4deb2c1bf200c0df8ac67b2597`
- audit scope: G107A, G108, G109, G107B, G110, and the G111 proof gate
- source of truth: `.omx/ultragoal/brief.md`
- audit result: PASS

## Invariants

1. **Local-only evidence and no automatic untrusted names: PASS.** Core evidence
   remains hashes and status metadata. AI-audience cards explicitly omit branch,
   path, and annotation names (`src/main.rs`, `CardAudience::AiIntegration`).
   Path rows are sensitive bounded operator detail, never automatic AI context.

2. **No-follow managed state: PASS.** Database header probing opens no-follow
   and reads at most 16 bytes. The writer lock uses descriptor-relative
   `openat` with `O_NOFOLLOW`, validates a regular single-link file, and uses a
   kernel lock. Existing descriptor-relative atomic replacement remains intact.

3. **Deterministic snapshot-bound evidence: PASS.** Unborn HEAD has a stable
   sentinel, Git unavailability is typed, and an event plus its path rows commit
   in one SQLite transaction. Failed path persistence rolls the event back.

4. **Fail closed on malformed control state while tolerating transient repository
   loss: PASS.** Invalid ignore state pauses capture without a write. Git and
   watcher failures expose only nonce-bound fixed degradation categories and
   retry. Database and schema failures remain fatal.

5. **Bound persistent metadata and hot-path work: PASS.** A snapshot stores at
   most 128 path rows, recent detail is capped at 4096 rows, and compact retains
   512. Root-only watching avoids recursive ignored-tree registration, while a
   one-second Git reconciliation covers nested tracked files.

6. **Distribution provenance and least authority: PASS for repository state.**
   Pinned `actions/attest` creates native build attestations with job-scoped
   `contents: read`, `id-token: write`, and `attestations: write`. Packaging
   verifies repository, workflow, ref, commit, and hosted-runner provenance with
   a short-lived token limited to content and attestation reads, then requires
   the bounded packed binary digest to match the attested artifact and checksum.
   No long-lived npm or GitHub token was introduced.

7. **Platform-before-wrapper and owner-controlled publication: PASS.** Exact
   manifest schema and publish order preserve three platform packages before the
   wrapper. CI stages only behind the repository kill switch; npm 2FA approval
   and public release decisions remain maintainer actions.

8. **No invented external evidence: PASS.** Local tests validate scripts and
   workflow definitions. This audit does not claim that the changed attestation
   workflow has run, that a new tag exists, or that a package was published.
   Hosted proof remains a future release acceptance condition.

9. **Regression ownership: PASS.** The suite covers process liveness, service
   encoding, competing kernel locks, bounded database reads and path retention,
   transaction rollback, unborn repositories, Git and ignore recovery, nested
   polling, binary and manifest tampering, relative-path scanner precision, and
   wrapper exit and signal semantics.

## Verification snapshot

Post-cleaner verification passed locally: Rust formatting, all-target check,
46 tests, Clippy with warnings denied, release build, RustSec audit, JavaScript
syntax, adversarial npm packaging, wrapper semantics, public-artifact scanner,
workflow YAML parse, JSON and JSONL parse, Homebrew Formula render syntax, and
Git diff whitespace checks.

The remaining G111 gates are independent code-reviewer `APPROVE` and architect
`CLEAR` verdicts against the committed implementation snapshot.

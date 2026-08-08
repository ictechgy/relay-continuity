# RALPLAN draft: Relay portable pilot readiness

## Requirements summary

1. Make the Linux x64 artifact truthfully portable across the prerelease
   support floor. Build `x86_64-unknown-linux-musl`, fail if it retains a dynamic
   ELF dependency, a `PT_INTERP`/`INTERP` program header, or a GLIBC symbol
   contract, and execute the artifact in pinned Ubuntu 22.04 and Debian 12
   containers before packaging.
2. Bind every tag-triggered release to the exact Cargo package version and a
   valid SemVer tag before archive creation/upload, attestation, npm package
   assembly/upload, npm staging, or publish authority. Preserve workflow-dispatch
   rehearsal without pretending it is a tag release.
3. Make help/version/unknown-command behavior global, deterministic, usable
   outside Git, and free of evidence-state mutation.
4. Add `relay doctor [--json]` as a read-only, local, bounded diagnostic. It
   reports only fixed states/reason codes for repository, evidence storage,
   daemon, service template, and provider integration. It must not create,
   quarantine, migrate, compact, or repair anything and must not expose paths,
   raw OS/SQLite errors, repository names, or secrets; text and JSON output must
   never exceed 4096 bytes.
5. Expand adversarial AI-facing-card tests and CI/review coverage. Add current
   dependency update configuration and repair stale documentation/evidence.
6. Do not publish a new tag, change npm dist-tags, enable a service, mutate a
   user's hook, claim signing, or promote GA as part of repository-local proof.

## RALPLAN-DR summary (deliberate)

### Principles

- A released compatibility claim must be executable evidence, not a build-host
  assumption.
- Release identity is one exact source version: Cargo version, tag, commit,
  binary, attestation, and packages must stay bound.
- Diagnostics must be safer to paste than raw logs and must never repair state
  implicitly.
- AI-visible data is an untrusted-input boundary; tests should prove omission
  and boundedness under hostile metadata.
- Add only features that improve the next pilot's signal quality; defer new
  provider/schema surfaces until use justifies them.

### Decision drivers

1. Remove the confirmed GLIBC 2.39 compatibility blocker before another RC.
2. Prevent a mismatched `v*` tag from producing authoritative public artifacts.
3. Let users and maintainers distinguish absent, healthy, degraded, drifted,
   broken, and unknown setup without sharing sensitive workspace data.
4. Keep runtime latency and storage effectively unchanged.
5. Preserve a small prerelease scope and a reversible path to later features.

### Viable options

| Option | Pros | Cons | Decision |
| --- | --- | --- | --- |
| A. musl Linux x64 + tag gate + doctor + hardening | Removes the confirmed blocker; maximizes portability; all runtime feature work is local and bounded. | Needs a target-specific build and container smoke; musl behavior must be verified for bundled SQLite/notify. | Chosen. |
| B. Build on pinned Ubuntu 20.04/22.04 glibc | Smaller workflow delta and familiar debugging. | Still creates a glibc floor, requires maintaining an old build image, and can regress through transitive native dependencies. | Rejected for the public generic Linux artifact. |
| C. Document GLIBC 2.39 and focus on new context features | Lowest immediate build effort and more visible features. | Excludes common distributions, leaves release identity unsafe, and biases pilot feedback toward install failures. | Rejected. |
| D. Add provider-neutral context JSON/MCP now | Strong cross-tool story. | Freezes a new API/trust boundary before doctor and pilot evidence establish needed fields. | Deferred. |

### Pre-mortem

| Failure scenario | Early signal | Mitigation and test |
| --- | --- | --- |
| The musl artifact builds but fails at startup or file watching on older distributions. | Container smoke exits nonzero, or daemon lifecycle tests diverge from native builds. | Keep native test jobs; run the actual release binary in immutable Ubuntu 22.04 and Debian 12 images; require `--version`, help, and a disposable-repo `init/status` smoke. |
| The release guard passes workflow-dispatch but a mismatched tag still reaches an archive job. | Static workflow dependency test finds archive without the contract dependency, or validator accepts `v0.2.0-rc.10` for Cargo rc.9. | Central Node validator with table-driven negative tests; make all downstream jobs depend on the contract job; test exact SemVer and ref-type cases. |
| Doctor leaks a path/secret or mutates missing/corrupt state while diagnosing it. | Fixture hashes or directory listings change; output contains fixture sentinel, home path, branch, filename, raw error, or control bytes. | Read-only path derivation and no `db()` calls; fixed allowlisted fields; before/after filesystem snapshots; hostile symlink/database/integration fixtures; byte/line caps. |
| New CI hardening becomes flaky or locks out releases. | Timeouts, action-pin tests, or container pulls fail intermittently. | Pin runner versions and container digests; use bounded but realistic timeouts; keep workflow-dispatch rehearsal; do not mutate branch/tag rulesets in this plan. |
| The scope expands into a new provider API before the pilot. | New schema, network listener, or integration state appears in the diff. | Architecture invariant audit rejects new data classes, network code, automatic provider launch, and stable context API additions. |

## Proposed implementation steps

### G112 — portable and fail-closed distribution contract

1. Add a pure/testable release-contract script that reads the Cargo package
   version, validates SemVer, and on tag pushes requires
   `GITHUB_REF_NAME == v${CARGO_VERSION}` and `GITHUB_REF_TYPE == tag`.
2. Put an early contract job in `release.yml`; make every job that owns archive
   creation/upload, attestation, npm package assembly/upload, npm staging, or
   publish authority transitively depend on it. Add release concurrency and job
   timeouts.
3. Build the Linux matrix entry for `x86_64-unknown-linux-musl` on a versioned
   runner. Verify no ELF `NEEDED` entries, no `PT_INTERP`/`INTERP` program
   header, and no `GLIBC_*` strings, then run the exact artifact in digest-pinned
   Ubuntu 22.04 and Debian 12 containers. Keep the public asset/package name
   stable.
4. Make workflow tests assert the dependency graph, portable target, runtime
   smokes, each enumerated authoritative job class, tag/version negatives, and
   full 40-hex SHA pins for every remote action reference.

### G113 — global CLI and privacy-safe doctor

1. Centralize help text. Handle `help`, `-h`, `--help`, `version`, `-V`, and
   `--version` before Git discovery. Unknown commands return nonzero before any
   DB or `.relay` state is opened.
2. Split state-path calculation from state creation so doctor can inspect the
   expected evidence database without creating directories or changing modes.
3. Implement a fixed-vocabulary diagnostic model and deterministic text/JSON
   renderers. Include schema version and Relay version; include no raw paths or
   provider-controlled text. Cap output and reject unknown doctor flags.
4. Use presence/header-only DB checks, no-follow managed reads, existing
   daemon/integration drift classification, and service-template comparison.
   Return zero only when every emitted check passes. Unknown or indeterminate
   required state and broken/drifted/unsafe state are failures with exit 1;
   degraded state is a warning with exit 1. An absent optional integration,
   capture daemon, or user service remains an explicit pass reason and does not
   alone change an otherwise healthy report from exit 0.
5. Add outside-Git, fresh-repo, initialized, corrupted-header, symlink,
   integration-drift, isolated-home, JSON-parse, hostile-path, degraded,
   indeterminate-required-state, optional-absence, and no-mutation tests. Exercise
   oversized hostile fixtures in both text and JSON modes and fail before
   emitting output beyond the fixed 4096-byte bound.

### G114 — hostile-context, CI, review, and documentation hardening

1. Add adversarial AI-card conformance fixtures covering control characters,
   newlines, ANSI, Unicode direction/zero-width characters, long names, secret
   sentinels, hostile repository names, and many dirty paths. Assert the
   automatic card exposes only fixed prose, hashes, counts, and a strict
   word/byte budget.
2. Pin normal CI runner labels, add job timeouts, validate generated launchd
   plist output on macOS, and keep systemd validation on Linux.
3. Expand CodeRabbit path filters to workflows, scripts, packages, docs,
   issue forms, manifests, lockfiles, and source/tests. Add Dependabot
   configuration for Cargo and GitHub Actions. Add CodeQL only if official
   current support for this Rust repository is verified; otherwise document
   the explicit non-applicability and retain cargo audit.
4. Update README, CONTRIBUTING, SECURITY, issue-template examples, and
   distribution documentation for global version/doctor, portable Linux,
   provider capability truth, current prerelease support, and exact gates.

### G115 — exact-head proof and durable closure

1. Run formatting, locked check/test/clippy/release build, package/workflow
   scripts, public-artifact verification, plist/systemd validation where
   applicable, `cargo audit --deny warnings`, and `git diff --check`.
2. Build and execute the musl artifact in the planned containers locally or in
   an exact-head CI rehearsal; hashes and external runs supplement rather than
   replace local tests.
3. Run anti-slop cleanup, then re-run affected gates. Audit architecture
   invariants: local-only, no new sensitive persistence, no raw AI metadata,
   no automatic repair/provider launch, and bounded work.
4. Obtain independent code/spec/security-performance and architecture reviews
   on the final snapshot. Fix findings and re-review changed heads until both
   are explicitly non-blocking.
5. Commit in atomic chunks, push a `codex/` branch, open a PR, and merge only
   after exact-head repository CI and CodeRabbit reach terminal non-blocking
   verdicts. Refresh durable quality evidence after the merge snapshot is
   known. Do not tag or publish a new RC in this goal.

## Expanded test plan

### Unit/static

- SemVer parser accepts the Cargo version and rejects leading/trailing text,
  malformed prereleases, missing components, and non-exact tag prefixes.
- Doctor status enums and JSON escaping are deterministic and exhaustively
  allowlisted; unknown flags fail; text and JSON rendering cannot emit more than
  4096 bytes.
- State-home calculation performs no create/chmod operation.
- AI card rejects or omits hostile repository names, branch names, annotations,
  and paths and remains under the declared byte/word bounds.
- Every workflow `uses:` reference is a full commit SHA and expected known
  actions retain their audited pins/comments.

### Integration

- Global help/version work outside Git with no filesystem delta. Unknown
  commands fail with no state-home or repository mutation.
- Doctor fresh/healthy/degraded/drifted/broken/unsafe/indeterminate fixtures and
  absent optional-component fixtures produce the specified exit codes plus
  parseable, redacted, stable results with identical before/after filesystem
  manifests. Oversized hostile fixtures exercise the 4096-byte text and JSON
  limit and fail before over-limit output is emitted.
- Existing integration, daemon, compaction, ignore, writer-lock, and npm
  packaging tests remain green.
- Generated systemd and launchd templates validate on their native CI hosts.

### E2E/release

- The release Linux binary is built for musl, has no dynamic ELF dependency,
  `PT_INTERP`/`INTERP` program header, or GLIBC symbol requirement. Its exact
  artifact bind mount and container root are read-only while only disposable
  repository/state and bounded temporary storage are writable in digest-pinned
  Ubuntu 22.04 and Debian 12 containers.
- `workflow_dispatch` rehearsal succeeds without claiming a tag; a simulated
  mismatched tag fails before build/package jobs.
- Future owner-gated RC: GitHub assets, attestations, npm `next`, Homebrew
  formula, and supported-host clean installs must be re-observed before broad
  Linux readiness is closed.

### Observability and performance

- Persist only allowlisted command identifiers plus redacted, normalized
  argument summaries or hashes; never persist raw command lines, credentials,
  or filesystem paths. Record test counts, artifact hashes, workflow run IDs,
  review heads, and terminal verdicts in append-only durable evidence.
- Doctor is bounded to a small fixed number of metadata reads and Git root
  probes, performs no database scan/quick-check, and completes under a generous
  local budget (target under 250 ms in fixtures, treated as diagnostic evidence
  rather than a universal SLA).
- Release container smokes have explicit timeouts and immutable image digests.

## Acceptance criteria

- Public Linux x64 workflow builds `x86_64-unknown-linux-musl`; static checks
  find no dynamic dependencies, `PT_INTERP`/`INTERP` program header, or GLIBC
  contract; Ubuntu 22.04 and Debian 12 execute the exact artifact successfully.
- No job owning archive creation/upload, attestation, npm package
  assembly/upload, npm staging, or publish authority can run until the release
  contract job passes. A mismatched/malformed tag is proven to fail.
- Global help/version work outside Git and produce no state. Unknown commands
  are nonzero and produce no state.
- Doctor text and JSON use fixed fields, never emit raw paths/errors/secrets or
  more than 4096 bytes, never create or alter managed/database/service/hook
  state, and distinguish absent, healthy, degraded, drifted, broken, unsafe,
  and unknown as relevant. Unknown required state, degraded state, and all
  warnings/failures exit 1; explicit absent optional components alone permit
  exit 0.
- Hostile repository-name/branch/path/note fixtures cannot reach AI integration
  output; output remains bounded and deterministic.
- CI/review/dependency configuration and documentation match the actual gates
  and current prerelease contract.
- All local gates and exact-head independent reviews are non-blocking. External
  publish/signing/GA/settings work remains explicitly unclaimed.

## Risks and mitigations

- musl may change DNS/watch behavior. Relay's runtime is local and does not
  need DNS; native and container lifecycle tests retain coverage of filesystem
  behavior.
- Doctor can accidentally become a support-log dump. The model is an allowlist
  assembled from enums, not a generic error collector.
- JSON becomes a de facto API. Version it as diagnostic schema `1`, document
  that it is bounded diagnostic output, and avoid exposing richer context.
- New Dependabot PR volume can distract maintainers. Use weekly grouped updates
  and never auto-merge.
- Exact-head review may uncover material changes. Any source change invalidates
  earlier review approval and triggers targeted tests plus renewed reviews.

## ADR

### Decision

Ship a musl-based Linux x64 release contract, an exact tag/version gate, and a
side-effect-free privacy-safe doctor before adding new provider-neutral context
APIs. Pair them with adversarial AI-card and repository quality hardening.

### Drivers

Confirmed Linux incompatibility, release identity integrity, interpretable
pilot feedback, and Relay's local privacy boundary.

### Alternatives considered

Pinned old-glibc builds, documenting GLIBC 2.39, and prioritizing JSON/MCP
features are covered in the options table.

### Consequences

Linux release builds gain a target-specific toolchain and container smokes.
The CLI gains one bounded diagnostic schema. A future RC is still required to
prove public distribution, and external repository/npm/signing policy remains
separate.

### Follow-ups

After pilot evidence, reconsider compact dry-run, typed check execution,
provider-neutral context JSON, daemon heartbeat, Linux ARM64, and an MCP server
only through a separate threat model. Decide npm `latest`, signing, and GA with
an owner release policy.

## Available-agent roster and execution staffing

- Strict planning lanes: `architect` then `critic`, sequential and independent,
  selected through `agent_type`.
- Execution owner: Ultragoal leader, reasoning high, retains integration,
  commits, external-boundary decisions, and ledger authority.
- Suggested bounded workers after consensus: one worker for release workflow
  and tests, one worker for doctor/CLI and tests. The leader owns docs/evidence
  and conflict-free integration. Workers must not revert concurrent changes.
- Final lanes: independent `code-reviewer` for code/spec/security/performance
  and `architect` for invariants. Material fixes require re-review.
- Team Decision Gate: use two bounded workers because G112 and G113 touch
  disjoint primary surfaces and parallelism materially reduces latency. Do not
  start a terminal/tmux team runtime; native subagents are sufficient.

## Goal-mode follow-up suggestions

- `$ultragoal` is the selected continuation: durable G112-G115 stories, exact
  checkpoints, and one aggregate Codex goal.
- `$performance-goal` is unnecessary unless verification finds a measurable
  doctor or daemon regression.
- `$autoresearch-goal` is unnecessary; official upstream build evidence is
  already sufficient for the selected design.
- `$ralph` is a fallback only if a single stubborn fix requires an iterative
  owner loop.

## Consensus reviews

### Architect (iteration 1): APPROVE

The independent Architect approved the scope and sequencing at source snapshot
`3bd67c5d3ed04bab389672389bf5ad542cb58a1f`. It confirmed that the confirmed
Linux compatibility and broad tag authority are the root release problems,
that musl plus real older-runtime execution is stronger than an older-glibc
build, and that doctor must use read-only probes rather than `db()` or
`database_path()`. Its steelman alternative was to prioritize provider-neutral
context JSON for visible product value; it retained the plan because release
truth and interpretable pilot diagnostics must precede a new API boundary.

### Critic

#### Critic (iteration 2): APPROVE

The independent Critic approved the exact current planning artifacts at source
snapshot `3bd67c5d3ed04bab389672389bf5ad542cb58a1f`. It found the G112-G115 scope,
RALPLAN-DR alternatives and ADR, five-scenario pre-mortem, unit/integration/E2E
and observability tests, available-agent roster, Team Decision Gate, owner-only
boundaries, and final exact-head review path execution-ready. Its only
non-blocking note is to resolve and record immutable Ubuntu/Debian image digests
during implementation rather than leaving tag-only smoke references.

### Consensus gate

`RALPLAN_CONSENSUS_COMPLETE`: native role-selectable Architect and Critic lanes
ran sequentially and independently; both approved. Implementation may now
transition to Ultragoal.

# RALPLAN draft: release evidence, npm OIDC, and public feedback

## Requirements summary

1. Replace the stale rc.6 `not-created` release claim with a factual record of
   the public tag/release, successful tagged workflow, verified release-asset
   hashes, separately marked manual npm publication, and the live registry
   dist-tags observed for every package. Do not infer the registry state from
   the tag workflow: its `npm-publish` job was skipped.
2. Replace secret-based npm publishing with GitHub Actions OIDC trusted
   publishing. Make release automation stage packages only, preserving the
   ordered platform/wrapper **staging** flow and `next` tag. Emit the ordered
   package/tarball/version staging manifest and require a maintainer to resolve
   stage IDs in npm's authenticated UI or CLI before approving the three
   platform stages before the wrapper with npm 2FA.
3. Document exact one-time external setup for each of the four existing npm
   packages and state that the repository cannot complete it. Include the
   correct owner/repository/workflow settings and a safe migration/recovery
   sequence. Make each generated package's `repository` field use the same
   canonical GitHub URL form required by npm trusted publishing.
4. Add public bug and feature GitHub issue forms that collect only minimum,
   privacy-safe diagnostics. Keep security reports private and make that route
   prominent. Do not request logs, paths, source, diffs, chats, tokens, or
   customer data.

## RALPLAN-DR summary (deliberate)

### Principles

- Truthful, snapshot-bound release evidence over retrospective claims.
- Short-lived, workflow-bound credentials over long-lived write tokens.
- Human authorization before a public package becomes available.
- Privacy-by-default public intake: report product behavior without collecting
  sensitive work artifacts.
- Fail closed: a missing OIDC configuration must fail the publish/stage job;
  a user must never infer an unconfigured external action succeeded.

### Decision drivers

1. Reduce npm account-compromise blast radius and accidental secret exposure.
2. Preserve a maintainer-controlled public-release decision point.
3. Keep the workflow reproducible, auditable, and compatible with the four
   already-published platform/wrapper packages.

### Viable options

| Option | Pros | Cons |
| --- | --- | --- |
| A. Direct OIDC publishing | No long-lived token; simple ordered tag-to-registry release. | A tag publishes immediately; a compromised tag path has a larger public-release blast radius. |
| B. Stage-only OIDC publishing (chosen) | No write token; explicit 2FA approval after reviewing each staged tarball; npm documents this as its maximum-security posture. | Every release requires four approvals and npm >=11.15/Node >=22.14. |
| C. Keep `NPM_TOKEN` gate and document it better | Lowest code change. | Retains a persistent CI credential; rejects current npm guidance and the requested security goal. |

### Pre-mortem

| Failure scenario | Early signal | Mitigation / test |
| --- | --- | --- |
| npm rejects OIDC at release time | `ENEEDAUTH` or publisher mismatch in a dry-run tag workflow. | Pin compatible Node/npm; document exact per-package `ictechgy` / `relay-continuity` / `release.yml` configuration; retain workflow-artifact manual fallback. |
| A malicious/incorrect tag stages public packages | Unexpected release job starts. | Require stage-only permission, restrict tag creation externally, and require owner 2FA approval after tarball review. |
| Wrapper is approved before its optional platform packages | `@ictechgy/relay` would reference unavailable exact package versions. | Emit package/tarball/version evidence; resolve stage IDs as owner evidence, require platform approvals, then wrapper approval, and clean-install only after all four are live. |
| OIDC trusts a package whose repository metadata does not match | `ENEEDAUTH`/publisher mismatch on the first tag. | Canonicalize/check `repository` metadata in every package manifest and inspect packed manifests before enabling the gate. |
| Feedback issue exposes sensitive code/work data | Form invites logs or raw reproductions. | Put a privacy warning at form top, prohibit sensitive fields, and route security reports to private reporting. |

### Expanded test plan

- Unit/static: parse `quality-gate.json`; assert no `NPM_TOKEN` or
  `NODE_AUTH_TOKEN` write-token reference; validate the canonical repository
  URL in every npm package manifest; validate issue-form YAML syntax and
  required privacy/security routing text.
- Integration: exercise `scripts/package-npm.mjs` using generated fixture
  release artifacts and inspect publish order; run cargo gates unaffected by
  documentation/workflow changes.
- E2E/release: on a future disposable prerelease tag after npm configuration,
  verify the four package/tarball/version staging-manifest entries, resolve the
  corresponding stage IDs in an authenticated npm owner session, inspect
  downloaded staged tarballs, approve platform stages before the wrapper with
  2FA, confirm the immutable `next` tag on each stage, and clean-install
  `@ictechgy/relay@next` on supported platforms.
- Observability/evidence: link exact Actions run/job outcomes and release SHA
  hashes; record external npm configuration/approval as owner evidence, not as
  a local test result.

## Proposed implementation steps

1. Update `.omx/ultragoal/quality-gate.json` with exact rc.6 release evidence,
   keeping workflow-produced release files and manually published npm packages
   distinct. Record release URL, tag commit, Actions run/job outcomes (including
   `npm-publish: skipped`), all three asset SHA-256 values, and the live
   registry `next`/`latest` values as a dated external observation. State no
   mutable registry action is inferred from the tag workflow.
2. Change `.github/workflows/release.yml` to:
   - retain `PUBLISH_NPM == 'true'` as an explicit repository kill switch;
   - pin `actions/setup-node`, use Node 24 (or a documented Node >=22.14),
     disable package-manager cache, install/assert npm >=11.15, and log
     `node --version` plus `npm --version` in the release publish job;
   - retain `contents: read` and grant only `id-token: write` to that job;
   - remove `NPM_TOKEN` and `NODE_AUTH_TOKEN` entirely;
   - use `npm stage publish` on tarballs in `publish-order.txt` with explicit
     `--access public --tag next`; validate that it accepts `<package-spec>`
     tarballs with a current npm 11.15+ CLI before merging;
   - emit an ordered machine-readable package/tarball/version staging manifest
     without secrets, then upload it as a release-workflow artifact for the
     maintainer; do not infer a stage ID from undocumented CLI output.
3. Canonicalize every source npm package manifest's `repository` metadata to
   the exact `git+https://github.com/ictechgy/relay-continuity.git` form, and
   add a deterministic package-validation check that verifies the generated
   tarball manifests retain it before OIDC is enabled.
4. Rewrite `docs/DISTRIBUTION.md` around OIDC staged publishing: exact four
   package names, npm UI fields (`ictechgy`, `relay-continuity`, `release.yml`,
   stage-only), canonical repository metadata, npm package publishing-access
   hardening, owner-side stage-ID inspection/download, platform-before-wrapper approval,
   safe migration sequence, manual artifact fallback, and direct links to
   official npm docs.
5. Create strict GitHub issue forms and configuration. The forms include
   version, OS/arch, install route, expected vs observed behavior, and optional
   redacted status category; they must reject/request removal of any sensitive
   payload. `config.yml` disables blank issues and points security reports to
   `SECURITY.md`. Add a concise README feedback section and, if appropriate,
   a contributor reminder. Document that enabling GitHub Discussions is an
   owner-only optional follow-up, not a completed repository setting.
6. Verify static workflow/form/JSON validity, npm packaging behavior, all Rust
   quality gates and vulnerability audit, then open a PR. Merge only after CI,
   CodeRabbit, and independent security/performance review at the final head;
   do not auto-tag or alter npm/GitHub account settings.

## Acceptance criteria

- `quality-gate.json` parses and says rc.6's release exists, with exact tag,
  Actions-run URL/outcome, all three SHA-256 values, and manual npm publication
  marked as external/manual evidence. It records, as a dated registry query,
  that both `next` and `latest` resolved to rc.6 for all four packages.
- `release.yml` contains no `NPM_TOKEN` or `NODE_AUTH_TOKEN`; the npm job has
  `id-token: write`, uses GitHub-hosted Ubuntu, and invokes `npm stage publish`
  only after `npm-packages` succeeds and `PUBLISH_NPM == 'true'`.
- The release npm job uses Node >=22.14 and npm >=11.15, disables cache, and
  preserves `publish-order.txt` as the platform-before-wrapper staging order,
  produces a package/tarball/version staging manifest, and passes `next`
  explicitly.
- All four source and generated npm manifests use the exact canonical
  `git+https://github.com/ictechgy/relay-continuity.git` repository URL.
- Distribution docs identify the four exact packages and name the three
  required trusted-publisher fields and stage-only allowed action. They
  explicitly say configuration, token disallowance/revocation, 2FA approval,
  and optional Discussions enablement require an owner action. They require
  stage inspection and platform-before-wrapper approval.
- Bug/feature forms parse as GitHub issue-form YAML, contain a privacy notice,
  do not include fields for raw logs/source/diffs/chats/tokens/paths, and link
  private vulnerability reporting.
- `cargo fmt --check`, `cargo check --all-targets --locked`, `cargo test
  --locked`, `cargo clippy --all-targets --all-features --locked -- -D
  warnings`, `cargo build --release --locked`, `cargo audit --deny warnings`,
  `git diff --check`, YAML/JSON parsing, and npm package fixture validation all
  pass. Final CI/review evidence is generated for the committed head.

## Risks and mitigations

- The provider setting is configured independently per package. Mitigate with a
  four-package checklist and do not enable `PUBLISH_NPM` until all are checked.
- A staged package can be approved outside this repo. Mitigate with a release
  checklist that binds package name, tarball, version, owner-resolved stage ID,
  tarball inspection, tag SHA, immutable stage dist-tag, ordered approvals,
  and approver.
- `npm stage publish` supports a package-spec by current npm CLI docs, but the
  exact tarball path must be exercised with npm >=11.15 before workflow merge.
  If this reveals an incompatibility, stage from extracted package directories
  only after verifying their archive hashes match generated tarballs.
- Issue templates guide rather than technically prevent a user from pasting a
  secret. Mitigate with visible warnings, minimal fields, and maintainer
  triage/removal guidance; never state this guarantees redaction.

## ADR

### Decision

Use GitHub Actions OIDC with npm **stage-only** trusted-publisher permission for
the four Relay packages. Record rc.6 release reality faithfully and add
privacy-first public issue forms.

### Drivers

Security of CI credentials, owner control before public publication, and
Relay's no-sensitive-artifact product boundary.

### Alternatives considered

Direct OIDC publish, continued `NPM_TOKEN` publishing, and no public feedback
templates. See the options table above.

### Why chosen

Stage-only OIDC removes the persistent write token while retaining a human 2FA
approval boundary. It is directly supported by npm for existing packages and
fits Relay's evidence-first release posture.

### Consequences

The first future release needs external one-time trusted-publisher setup for
all four packages, and every release needs manual review/approval. Public issue
intake becomes easier, but must remain minimal and privacy-conscious.

### Follow-ups

After code merges, the owner configures trusted publishing, enables the
repository variable only after a dry-run/checklist, then performs a disposable
future prerelease rehearsal. GitHub Discussions may be enabled by the owner if
they want a less structured feedback channel.

## Architect iteration changelog

- Added exact rc.6 external registry dist-tag evidence rather than assuming
  `next` is the sole tag.
- Added canonical package repository metadata verification for npm OIDC.
- Distinguished staging order from public approval order; added owner-resolved
  stage-ID evidence and platform-before-wrapper approval requirements.
- Made Node/npm assertions and the `actions/setup-node` pin explicit.

## Consensus reviews

### Architect (iteration 1): ITERATE

The Architect accepted the stage-only OIDC direction but required three
execution-critical corrections: distinguish staging order from approval order,
validate canonical package `repository` metadata for GitHub OIDC, and record
actual registry dist-tags rather than assuming `next` alone. The revision above
implements those corrections. The Architect's steelman counterargument was
that direct OIDC publish could be operationally simpler for the four-package
graph, but its synthesis retained stage-only OIDC once owner stage-ID evidence
and approval ordering become explicit.

### Critic (iteration 2): APPROVE

The Critic approved the revised plan at source snapshot
`0349cc8da11fea916f41d7e3b433a10278337686`. It found the requirements,
alternatives, pre-mortem, expanded tests, owner-only boundaries, and privacy
forms concrete and coherent. This approval is snapshot-bound: material source
or npm-documentation changes require a fresh independent review.

## Durable execution handoff

### Consensus gate

```json
{
  "status": "RALPLAN_CONSENSUS_COMPLETE",
  "strictConsensusAvailable": true,
  "spawnMode": "role-selectable-native",
  "selectedSelectorField": "agent_type",
  "taskNameIsRoleSelector": false,
  "agentDefinitionBackedFallback": false,
  "independentLanes": true,
  "sequentialOrder": ["architect", "critic"],
  "surrogateReviewsUsed": false,
  "planningArtifacts": [
    ".omx/context/release-evidence-oidc-feedback-20260802T135052Z.md",
    ".omx/plans/release-evidence-oidc-feedback-20260802T135052Z.md",
    ".omx/specs/release-evidence-oidc-feedback-test-spec-20260802T135052Z.md"
  ],
  "ralplan_architect_review": {
    "status": "ITERATE",
    "iteration": 1,
    "resolution": "All required plan corrections applied before Critic review."
  },
  "ralplan_critic_review": {
    "status": "APPROVE",
    "iteration": 2,
    "snapshot": "0349cc8da11fea916f41d7e3b433a10278337686"
  },
  "ralplan_consensus_gate": {
    "complete": true,
    "reason": "Architect iteration was resolved and a subsequent independent Critic approved the revised plan."
  }
}
```

### Available-agent-types roster

The current session exposes `architect`, `critic`, `code-reviewer`, `explorer`,
`worker`, and `default`. For the execution follow-up, use a leader-owned
durable plan plus independent code/security review; do not use an agent to
perform owner-only npm settings, 2FA approvals, dist-tag changes, or GitHub
Discussions enablement.

### Follow-up staffing guidance

- `$ultragoal` (recommended): leader-owned sequential ledger; reasoning
  `high`. It should own exact evidence update, workflow/docs/forms changes,
  local gates, PR lifecycle, and all stop conditions.
- Bounded `$team-native` support is eligible only for independent read-only or
  non-overlapping lanes: a `worker` at `medium` for issue-form/docs work, an
  `explorer` at `low` for release-evidence cross-checking, and a
  `code-reviewer` or `critic` at `high` for final-head review. The Ultragoal
  leader retains integration/commit authority.
- `$ralph` is not the default. It is an explicit fallback only if a persistent
  single-owner fix-and-verify loop is deliberately selected after this plan.

### Goal-mode follow-up suggestions

- `$ultragoal` is the default because this is implementation plus durable,
  evidence-bound release governance.
- `$autoresearch-goal` is not appropriate: upstream npm guidance has already
  been bounded and cited; continuous research is not the deliverable.
- `$performance-goal` is not appropriate: the goal is release safety and user
  feedback intake, not a measurable performance optimization.

### Team Decision Gate

- Use tmux-backed `$team` only if `tmux`, `$TMUX`, and `omx` are available and
  durable worker lifecycle/mailbox evidence is needed.
- If tmux is unavailable but `lterm` and `omx` are available, lterm-backed
  Team is eligible; launch shape: `lterm omx --detach -- team ...` or
  `lterm run -- omx team ...`.
- `$team-native` is sufficient here when only the bounded, non-overlapping
  evidence/docs/form lanes are delegated. It does not create durable Team
  mailbox/pane lifecycle evidence.
- Emit `TEAM_UNAVAILABLE` rather than claiming durable Team guarantees if
  neither terminal runtime is available and such lifecycle evidence is needed.
- Team verification path: each lane returns exact file list, command output,
  and snapshot; the Ultragoal leader integrates once, reruns the full test
  specification at final head, and records PR CI/review results before
  completion. For tmux/lterm Team, capture mailbox/task completion before
  shutdown; for team-native, retain only the returned bounded evidence.

### Stop conditions for execution

- Stop before enabling `PUBLISH_NPM`, configuring npm trusted publishers,
  revoking/disallowing npm tokens, approving staged packages, modifying
  dist-tags, enabling Discussions, creating a release tag, or publishing any
  package: each is external owner authority.
- Stop and revise if `npm stage publish` cannot stage the generated tarball
  package spec using the pinned current CLI, if package repository metadata
  does not meet npm OIDC requirements, or if any final CI/review is non-passing.

## Execution steering: stage-ID provenance (2026-08-03)

Final independent review found that npm's documented `stage publish` contract
does not establish a JSON stage-ID response, and that an OIDC trust token cannot
use `npm stage list` to recover it in CI. The former package/stage-ID artifact
requirement is superseded by a safer split: CI emits a validated ordered
package/tarball/version staging manifest from `publish-order.txt`; an
authenticated npm owner resolves stage IDs in the npm UI or maintainer CLI and
records them before inspection/approval. This preserves the chosen stage-only
OIDC architecture while removing an unproven post-mutation parser and avoiding
an unsafe retry after a staged version occupies the registry index.

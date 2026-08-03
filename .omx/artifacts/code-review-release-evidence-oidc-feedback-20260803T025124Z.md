# Code review: release evidence, npm OIDC, and feedback intake

- Base: `0349cc8da11fea916f41d7e3b433a10278337686`
- Reviewed/final head: `314cfb94384056c057b61aae072f0ae1799748b3`
- Range: `0349cc8..314cfb9`
- Governing artifacts: `.omx/ultragoal/brief.md`,
  `.omx/plans/release-evidence-oidc-feedback-20260802T135052Z.md`,
  `.omx/specs/release-evidence-oidc-feedback-test-spec-20260802T135052Z.md`,
  `.omx/state/release-evidence-oidc-feedback-ralplan-consensus-20260802T135052Z.json`

## Verification evidence

- `cargo fmt --check`
- `cargo check --all-targets --locked`
- `cargo test --locked` — 33 passed
- `cargo clippy --all-targets --all-features --locked -- -D warnings`
- `cargo build --release --locked`
- `cargo audit --deny warnings` — 50 dependencies scanned
- `node scripts/verify-npm-packages.mjs --templates`
- `node scripts/test-package-npm.mjs` — includes packed-tarball checks and a
  reversed `publish-manifest.json` fixture proving `publish-order.txt` drives
  staging order
- Ruby YAML parse for workflows and issue forms; JSON/JSONL parse for OMX state
- `git diff --check 0349cc8..314cfb9`

## AI slop cleaner report

Scope: G106 changed workflows, scripts, package manifests, docs, issue forms,
and OMX artifacts.

Behavior lock: the verification commands above passed before and after the
bounded cleanup pass. Fallback inventory found no quick hacks, masking
fallbacks, swallowed errors, silent defaults, TODO/FIXME markers, or broad
compatibility shims. The only compatibility boundary is explicit: unsupported
npm stage-ID output is not parsed by CI, and owner-authenticated npm UI/CLI is
the documented follow-up. No cleanup edit was needed after the final staging
provenance repair.

## Independent code-reviewer lane (verbatim outcome)

```
APPROVE

Snapshot: 0349cc8da11fea916f41d7e3b433a10278337686..314cfb94384056c057b61aae072f0ae1799748b3
Files reviewed: 24 modified files
Issues: CRITICAL 0, HIGH 0, MEDIUM 0, LOW 0

Prior blocker 1 closed: CI no longer parses or invents npm stage IDs.
Prior blocker 2 closed: staging order is sourced from publish-order.txt; the
fixture reverses publish-manifest.json and still verifies staging follows the
order file. No masking fallback, broad retry path, swallowed error, or alternate
token-backed publish path was introduced.

Recommendation: APPROVE. Blocking verdict: non-blocking / ready from the
code/spec/security lane.
```

## Independent architect lane (verbatim outcome)

```
Architectural Status: CLEAR

Snapshot: 0349cc8da11fea916f41d7e3b433a10278337686..314cfb94384056c057b61aae072f0ae1799748b3

The prior BLOCK is closed: CI no longer parses unproven npm stage IDs, staging
order is driven through publish-order.txt, and stage-ID resolution is explicitly
owner-authenticated. The OIDC job is tag-gated, uses contents:read plus
id-token:write only, and stages with explicit next. The stage script rejects
duplicate/invalid order input and records package/tarball/version/distTag/status
only. Release evidence, owner authority, and public feedback privacy boundaries
remain explicit.

Non-blocking watch: if a new platform package is added, update the hardcoded
four-package graph in packaging, staging, verification, tests, and docs together.
```

## Synthesis

- Code reviewer: `APPROVE`
- Architect: `CLEAR`
- Final recommendation: `APPROVE`
- Merge readiness: `READY`

The rejected intermediate review at `67568e4` is intentionally superseded by
the corrected `314cfb9` review. Its findings and the explicit steering response
remain in `.omx/ultragoal/ledger.jsonl` and the approved plan.

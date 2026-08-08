# G112-G115 architecture invariant audit

- baseline: `3bd67c5d3ed04bab389672389bf5ad542cb58a1f`
- reviewed implementation head: `702ae09e78c03d9590d316cc465b1bd30cb72a95`
- merged commit: `9c5dbc7e16438d2ba06c9220cd246aa532fa090b`
- binary diff SHA-256: `d4e9d7783f3669dddc473e1b78f649c7278a50a86e209b06cdcb1cdd7b6febe6`
- sources: `.omx/ultragoal/brief.md`, the portable-pilot plan, and its test spec
- result: **PASS**

## Proved invariants

1. **Provider-neutral, local-first privacy boundary: PASS.** Automatic AI cards
   contain fixed status and hash evidence, omit repository, branch, path, note,
   and raw diagnostic names, and remain bounded to 320 words and 4096 bytes.
   The hostile-card corpus proves those values are not emitted.

2. **Global doctor is read-only and bounded: PASS.** Help, version, and doctor
   dispatch before repository/database creation. Doctor uses no-follow bounded
   reads and fixed privacy-safe reasons, reports existing integration drift even
   when managed state is missing, performs no repair, and caps output.

3. **Release authority is exact and fail-closed: PASS.** The release contract
   derives the canonical package version through bounded frozen Cargo metadata.
   Archive and npm authority require a matching tag push. Branch rehearsal runs
   only the contract and produces no artifacts, attestations, or publication.

4. **Linux portability is explicit: PASS.** The workflow builds the public Linux
   package for `x86_64-unknown-linux-musl`, rejects dynamic dependencies,
   interpreters, and GLIBC symbols, then executes the exact artifact in pinned
   Ubuntu 22.04 and Debian 12 containers. Documentation distinguishes the old
   glibc-bound rc.9 asset from future portable artifacts.

5. **Workflow and dependency policy is semantic and least-privilege: PASS.** A
   bounded real YAML parse and canonical policy pass reject hidden or aliased
   action references. Toolchains and actions are pinned, permissions are scoped,
   lockfiles are enforced, and RustSec runs with warnings denied.

6. **Runtime Git observation matches release smoke: PASS.** Production and the
   release fake-Git fixture consume the same tracked argv contract. The compiled
   integration test records every runtime `git status` invocation and verifies
   every observed call, while repository-binding environment overrides are
   removed.

7. **External authority remains outside repository proof: PASS.** No tag, npm
   publish, signing, service enablement, or provider account mutation is claimed.
   The hosted branch rehearsal was deliberately non-publishing.

## Review evidence

The exact-head independent code lane returned `APPROVE / NON-BLOCKING` with no
findings. The distinct architecture lane returned `CLEAR / NON-BLOCKING` with
no blocking concerns. CodeRabbit review `4889381596` covered the same head and
posted zero actionable or inline comments. All 26 PR review threads were
resolved before merge.

Architecture invariant gate: **PASS / NON-BLOCKING**.

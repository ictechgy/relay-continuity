# Context: release evidence, npm OIDC, and public feedback

## Task statement

Implement three follow-ups for Relay: correct stale release-quality evidence,
secure future npm publishing, and add a public feedback intake that respects
Relay's local-first privacy boundary.

## Desired outcome

The repository truthfully records the already-created `v0.2.0-rc.6` release,
future tag releases can publish npm packages without a long-lived write token
after a one-time npm trusted-publisher setup, and contributors have clear,
privacy-safe issue/feature-report paths. Security reports stay private.

## Known facts and evidence

- `main` and `origin/main` point to `0349cc8`; the worktree is clean.
- `.omx/ultragoal/quality-gate.json:43-47` incorrectly says the rc.6 tag and
  release were not created.
- The public `v0.2.0-rc.6` release exists. Its successful tagged Actions run is
  `30747458973`; all three release assets were SHA-256 verified after upload.
- rc.6's four npm packages were manually published and a clean install of
  `@ictechgy/relay@next` was exercised. A live registry read on 2026-08-02
  shows both `next` and `latest` at `0.2.0-rc.6` for every package; this is
  external registry state, not evidence that the tag workflow published npm.
  The tagged workflow did not publish npm because its `PUBLISH_NPM` gate was
  disabled.
- `.github/workflows/release.yml:56-73` has `id-token: write` but still exports
  `NODE_AUTH_TOKEN` from a long-lived `NPM_TOKEN` secret.
- npm's current official guidance requires npm >= 11.5.1 and Node >= 22.14.0
  for trusted publishing. It supports GitHub-hosted runners, uses `id-token:
  write`, and requires a per-package publisher configuration for the exact
  GitHub owner, repository, and workflow filename. Source:
  https://docs.npmjs.com/trusted-publishers/
- npm's staged-publish flow requires npm >= 11.15.0 and Node >= 22.14.0; it
  intentionally holds a package for an owner 2FA approval. All four Relay npm
  packages already exist, so the prerequisite is met. Source:
  https://docs.npmjs.com/staged-publishing/
- `docs/DISTRIBUTION.md:20-23` still documents the token-based procedure.
- The wrapper package records `git+https://github.com/ictechgy/relay-continuity.git`
  as its repository URL, while platform package manifests use a different
  string form. npm requires repository metadata to match the GitHub repository
  for GitHub trusted publishing, so a canonical manifest representation must
  be checked before OIDC is enabled.
- `.github` contains release and CI workflows only; there are no public issue
  templates. `SECURITY.md:18-25` already directs vulnerabilities to private
  GitHub vulnerability reporting.
- Relay's immutable product boundary prohibits source bodies, raw diffs,
  transcripts, telemetry, and raw command output (`README.md:3-6`,
  `SECURITY.md:3-5`).

## Constraints

- Preserve truthful distinction between repository-local evidence, Actions
  evidence, manual npm publication, and external owner-controlled settings.
- Do not add analytics, telemetry, automatic uploads, or any request for raw
  source/diff/chat/log content in public feedback forms.
- Preserve release least privilege and pinned GitHub Actions. Do not introduce
  a long-lived npm write token or assume npm account settings are configured.
- Npm trusted-publisher settings, token revocation/disallowance, and enabling
  GitHub Discussions are external owner actions; record them as such rather
  than claiming they are completed by a repository change.
- Keep the current `next` prerelease dist-tag and platform-before-wrapper
  publishing order.

## Open questions resolved for planning

- Default recommendation: stage-only npm trusted publishing, rather than
  direct OIDC publication. It adds maintainer approval with 2FA before public
  availability and is npm's documented maximum-security posture.
- The implementation must use a deterministic Node/npm version meeting staged
  publishing requirements and no write-token environment variable.

## Likely touchpoints

- `.omx/ultragoal/quality-gate.json`
- `.github/workflows/release.yml`
- `docs/DISTRIBUTION.md`
- `.github/ISSUE_TEMPLATE/{config.yml,bug-report.yml,feature-request.yml}`
- `README.md`, potentially `CONTRIBUTING.md`

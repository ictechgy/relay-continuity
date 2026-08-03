# Test specification: release evidence, npm OIDC, and public feedback

| ID | Check | Evidence / expected result |
| --- | --- | --- |
| E1 | Parse `.omx/ultragoal/quality-gate.json`. | Valid JSON; `releaseBoundary` records rc.6 release/tag/commit/run/jobs/assets; npm manual evidence is labeled manual and registry `next`/`latest` observation is dated. |
| E2 | Inspect `release.yml`. | No `NPM_TOKEN`/`NODE_AUTH_TOKEN`; `npm-publish` has job-scoped `id-token: write`, `PUBLISH_NPM` gate, pinned Node >=22.14/npm >=11.15 checks, disabled cache, and `npm stage publish`. |
| E3 | Validate workflow semantics. | Archive -> npm-packages -> npm-publish dependency remains; package order comes solely from `publish-order.txt`; every stage uses explicit `next`; a package/tarball/version staging manifest is emitted in that same order without inferring undocumented stage IDs. |
| E4 | Validate npm packaging. | `scripts/package-npm.mjs` processes disposable/recorded fixture archives and produces four expected package tarballs/order without network publication; all packed manifests retain the canonical repository URL. |
| E5 | Inspect distribution documentation. | Lists exact trusted-publisher account/repo/workflow values, four packages, stage-only choice, external owner steps, and manual fallback. |
| E6 | Parse each issue template. | Valid YAML forms; blank issues disabled; privacy warning plus private-security link exists; no free-form log/source/diff/chat/credential upload field. |
| E7 | Regression gates. | `cargo fmt --check`, locked check/test/clippy/release build/audit, and `git diff --check` succeed. |
| E8 | Final external gates. | PR CI succeeds for final head; CodeRabbit and independent security/performance reviewers return an explicit non-blocking verdict. |
| E9 | Owner-only rehearsal (not auto-run). | On a future disposable prerelease, the four staging-manifest entries correspond to the tag and use `next`; an authenticated maintainer resolves stage IDs, downloads/inspects tarballs, 2FA-approves platforms before wrapper, then clean `@next` install works. |

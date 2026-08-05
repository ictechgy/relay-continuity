# Relay v0.2 automatic integration brief

Implement the RALPLAN-approved plan at
`.omx/plans/relay-auto-integration-v02-20260801T110348Z.md`. Non-negotiable
invariants: local-only evidence; no source/chat/raw-diff/raw-output/prompt or
foreign-config persistence; generic core remains useful with adapters disabled;
one-time explicit opt-in; no silent config overwrite; no quota/UI/browser
automation; adapters fail closed unless their installed official contract probe
passes; and no public release/publishing without owner authority.

The completed v0.1 brief and evidence remain in Git history and the append-only
ledger below. This brief is the stable pointer for the new v0.2 aggregate goal.

## G106: Release evidence, npm OIDC, and privacy-safe public feedback

Implement the RALPLAN-approved plan at
`.omx/plans/release-evidence-oidc-feedback-20260802T135052Z.md` and satisfy
`.omx/specs/release-evidence-oidc-feedback-test-spec-20260802T135052Z.md`.
Preserve the prior v0.2 invariants above. Additionally: record release facts
without inventing external publication evidence; use no long-lived npm write
token; stage npm packages through GitHub-hosted OIDC only after an explicit
repository kill switch; preserve the platform-before-wrapper package sequence;
and never invite sensitive source, diff, transcript, raw-output, path, token,
or credential data in public feedback forms. npm trusted-publisher setup,
token revocation/disallowance, stage approval with 2FA, registry dist-tag
changes, GitHub Discussions enablement, tag creation, and package publication
remain owner-controlled external actions.

## G107-G111: Close the post-rc.8 whole-tool review findings

Implement and verify the actionable findings preserved in
`.omx/artifacts/claude-relay-whole-review-summary-20260806.md` against
snapshot `632eb98678952d4deb2c1bf200c0df8ac67b2597`. The work covers daemon
resilience and watcher load, writer-lock correctness, bounded evidence-store
I/O and retention, transactional path persistence, npm package verification,
release provenance, public-artifact scanner precision, and wrapper signal
fidelity.

Non-negotiable invariants: preserve the local-only and no-source/chat/raw-diff/
raw-output contract; never weaken no-follow managed-state protections; keep
Git/filesystem evidence deterministic and snapshot-bound; fail closed on
foreign or malformed state while tolerating transient repository
unavailability; bound persistent metadata and hot-path work; preserve the
platform-before-wrapper OIDC staging order and owner-controlled 2FA approval;
do not claim external publication, attestation, or package evidence that was
not actually produced. Every behavior change requires regression coverage, and
the final snapshot requires post-cleaner verification plus independent
code-reviewer APPROVE and architect CLEAR verdicts.

# Context snapshot: Relay portable pilot readiness

- Captured UTC: 2026-08-06T17:15:38Z
- Source snapshot: `3bd67c5d3ed04bab389672389bf5ad542cb58a1f`
- Branch: `main`
- Remote snapshot: `origin/main` matched the source snapshot at capture time
- Latest public tag: `v0.2.0-rc.9` at `86b13e0`
- Runtime: `CODEX_APP_DEGRADED_NO_OMX` (`omx` was not installed; native role-selectable agents and Codex goal mode remain available)

## User request

Continue all worthwhile remaining Relay work with Ralplan where needed and
Ultragoal execution. Evaluate independent roadmap inputs, select the ideas
that are worth implementing now, and carry them through durable goals,
implementation, verification, and review.

## Product constraints

- Relay is local-only and evidence-first. It must never infer work completion.
- Runtime operation must not require a network service or telemetry.
- Never persist source bodies, diffs, chats, AI reasoning, raw command output,
  credentials, secrets, or absolute workstation paths in public artifacts.
- AI-facing context must omit untrusted branch, path, and annotation text.
- Integration is explicit, previewable, repository-scoped, reversible, and
  drift-refusing. Unsupported provider hooks fail closed.
- Do not turn a prerelease-readiness task into a GA release, signing, or
  provider automation project without external authority and evidence.

## Repository-grounded findings

1. Existing durable goals G101-G111 are terminal. The stored quality gate and
   state still refer to older snapshots/release observations.
2. The released rc.9 Linux asset was downloaded and its published checksum was
   verified. It is a dynamically linked ELF and references `GLIBC_2.39`,
   including `pidfd_spawnp`/`pidfd_getpid`. That is incompatible with common
   supported-looking systems such as Ubuntu 22.04 and Debian 12. This blocks a
   truthful broad Linux claim.
3. `.github/workflows/release.yml` builds Linux on moving `ubuntu-latest` and
   accepts every `v*` tag. No fail-closed assertion binds the tag to the exact
   Cargo package version before archive or npm staging.
4. The CLI handles only literal `help` globally. `-h`, `--help`, `version`,
   `-V`, and `--version` are absent. Unknown commands open/create evidence
   state, print help, and exit successfully.
5. CI lacks a macOS plist-render validation, bounded job timeouts, and a
   generic assertion that every remote action reference is a full commit SHA.
   CodeRabbit filters omit several security-sensitive repository surfaces.
6. Live GitHub inspection found no ruleset or branch protection, disabled
   Dependabot alerts/security updates, and no code-scanning analysis. Secret
   scanning, push protection, private vulnerability reporting, and read-only
   default workflow permissions were enabled.
7. npm `next` resolves to rc.9 while `latest` still resolves to rc.6. The README
   explicitly uses `@next`; changing dist-tags remains an authenticated owner
   policy decision rather than a repository-local proof.

## Official upstream research

- GitHub-hosted runner documentation identifies `ubuntu-latest` as a moving
  label and currently maps it to Ubuntu 24.04. Versioned labels avoid an
  unreviewed migration: <https://github.com/actions/runner-images#available-images>
- Rust's platform-support documentation lists
  `x86_64-unknown-linux-musl` as Tier 2 with host tools and full standard-library
  support: <https://doc.rust-lang.org/rustc/platform-support.html>

## Selected implementation direction

1. Replace the public Linux x64 build with a musl-targeted portable binary,
   assert no dynamic `NEEDED`/GLIBC contract, and execute it in pinned older
   Linux runtime containers.
2. Add a separately testable release-contract validator binding push tags to
   the exact Cargo SemVer before release authority. Require an exact-head hosted
   branch rehearsal in which the contract succeeds while every authority job
   is skipped and no artifact or attestation is emitted.
3. Add global help/version/error behavior and a side-effect-free,
   privacy-bounded `relay doctor` suitable for pilot issue reports.
4. Extend adversarial AI-card tests and repository quality gates, review
   coverage, dependency update configuration, and current documentation.
5. Refresh durable evidence only after the exact implementation head passes
   all local and independent review gates.

## Deferred or rejected

- Provider-neutral context JSON and `integration status --json`: promising,
  but a stable external schema should be informed by doctor/pilot use first.
- MCP server: requires a separate threat model and wider trust boundary.
- Claude/Grok automatic injection without an authenticated model-visible hook.
- Cloud sync, telemetry, transcript recovery, quota detection, GUI automation,
  automatic AI launch, or auto-remediation of foreign configuration.
- Linux ARM64 until the x64 portability contract is proven by a release.
- Apple signing/notarization, npm `latest` mutation, rulesets, and GA promotion:
  authenticated or policy-bearing external actions, recorded as follow-ups.

## Planning provenance

| Field | Value |
| --- | --- |
| Status | `RALPLAN_CONSENSUS_COMPLETE` |
| Source snapshot | `3bd67c5d3ed04bab389672389bf5ad542cb58a1f` |
| Reason code | `REQUIRED_LANES_APPROVED` |

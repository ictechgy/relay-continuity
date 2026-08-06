# Context snapshot: Relay portable pilot readiness

- Captured UTC: 2026-08-06T17:15:38Z
- Source snapshot: `3bd67c5d3ed04bab389672389bf5ad542cb58a1f`
- Branch: `main`
- Remote snapshot: `origin/main` matched the source snapshot at capture time
- Latest public tag: `v0.2.0-rc.9` at `86b13e0`
- Runtime: `CODEX_APP_DEGRADED_NO_OMX` (`omx` was not installed; native role-selectable agents and Codex goal mode remain available)

## User request

Continue all worthwhile remaining Relay work with Ralplan where needed and
Ultragoal execution. Brainstorm additions with Claude, Grok, and Agy, select
the ideas that are worth implementing now, and carry them through durable
goals, implementation, verification, and review.

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

## Advisor evidence

- Claude evidence:
  `.omx/artifacts/ask-claude-relay-roadmap-brainstorm-20260806T165418Z.md`
  with terminal `BRAINSTORM: COMPLETE`. It prioritized an adversarial rendering
  corpus, a redacted side-effect-free `relay doctor`, and distribution truth.
- Grok evidence:
  `.omx/artifacts/ask-grok-relay-roadmap-brainstorm-20260806T165418Z.md`
  with terminal `BRAINSTORM: COMPLETE`. It prioritized repository/distribution
  hygiene and an offline doctor; it also proposed bounded export and compact
  dry-run as later candidates.
- Agy evidence:
  `.omx/artifacts/ask-agy-relay-roadmap-brainstorm-20260806T165418Z.md` is an
  `ASK_INVALID_OUTPUT` record. Repeated isolated attempts returned no output;
  the final external execution request was blocked by the local usage limit.
  No recommendation is attributed to Agy.
- Repository explorer: recommended provider-neutral context JSON,
  `integration status --json`, typed phases, doctor, a privacy-safe timeline,
  change-kind counts, shell-free checks, and daemon heartbeat. It identified
  doctor as the strongest near-term support feature.

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
   the exact Cargo SemVer before archive/npm work.
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

## Planning mode and available roles

The work changes the public distribution compatibility contract, so Ralplan
uses deliberate mode. Native role selectors available are `architect`,
`critic`, `code-reviewer`, `explorer`, `worker`, and `default`. Strict consensus
will run sequentially as Architect then Critic with `agent_type` as the
selector. No surrogate role is needed.

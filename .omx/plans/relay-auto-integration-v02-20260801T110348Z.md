# Relay v0.2: automatic lifecycle and resume integration

Status: RALPLAN consensus complete. Planning only; no implementation approved by
this artifact alone.

## Requirements summary

After a one-time explicit opt-in, Relay must capture local work and make a
bounded, privacy-safe resume card available at a supported agent session start
without a manual per-session skill invocation. It targets Codex, Claude Code,
and Grok Build, but the local adapter-free core must remain fully useful.

No provider quota detection, browser/UI automation, transcript import, cloud
sync, telemetry, raw source/diff/output/prompt storage, account mutation, or
silent configuration overwrite is in scope.

## Grounded context

- v0.1 has a local daemon, `relay resume`, bounded cards, and typed optional
  adapter metadata; daemon and shell setup are currently manual.
- Codex documents trusted `SessionStart` hooks with bounded
  `additionalContext`, plus project/user config and `AGENTS.md` discovery.
- Grok documents project/user hooks and Claude-compatible configuration.
- Claude Code documents resume and MCP, but its installed hook/plugin contract
  must be capability-probed before Relay writes an adapter.

## RALPLAN-DR (deliberate)

### Principles

1. One-time explicit consent; no silent global mutation.
2. Generic local Relay works with every adapter disabled.
3. Only Relay's existing sanitized, deterministic card may enter agent context.
4. Unsupported or changed provider behavior fails closed and is explainable.
5. Lifecycle control is user + repository scoped, reversible, and observable.

### Decision drivers

1. No repeated setup after opt-in.
2. Cross-tool coverage without undocumented behavior.
3. Privacy and user configuration ownership over universal coverage.

### Options

| Option | Outcome |
| --- | --- |
| CLI wrappers that prepend `relay resume` | Rejected: bypass normal launches, leak through argv, and fragment behavior. |
| Generic MCP-only server | Deferred: useful read tool but cannot guarantee session-start loading. |
| Core installer + OS supervisor + verified native adapters | Chosen: automatic capture and bounded native injection where proven. |
| Watch quota/session UI and switch agents | Rejected: unsupported, privacy-invasive, brittle. |

### ADR

Decision: build a provider-neutral integration manager plus independently
verified Codex, Claude, and Grok adapters. “Automatic” means auto-capture and
supported start-of-session injection, never hidden-session recovery or
quota-exhaustion detection. An adapter that cannot prove its contract remains
`unavailable`; it does not receive a compatibility workaround.

## Implementation plan

1. **Integration contract and status.** Add a versioned per-repository manifest
   under `.relay/` containing only adapter id/version, owned-artifact hash,
   service state, repository identity hash, and timestamps. Add `relay
   integration status [--json]` with `disabled`, `awaiting_trust`, `ready`,
   `unavailable`, `drifted`, and `broken`; no chat/session/credential fields.

2. **Transactional installer.** Add `install`, `check`, `repair`, and
   `uninstall` commands with mandatory preview. Create either a new
   Relay-owned file or a marked owned block; preserve bytes outside it and
   refuse drift. For a user-owned file, construct patched bytes only in memory,
   write and fsync a same-directory temporary file, atomically rename it, verify
   the owned-artifact hash, then remove temporary artifacts. Never persist a
   full foreign-config backup under `.relay`, a cache, a log, or a repair record.
   Uninstall refuses drift or removes only an exact owned block; it never uses a
   stored foreign copy to restore user configuration.

3. **User-scoped OS service.** Generate `launchd` (macOS) and `systemd --user`
   (Linux) templates for a canonical Git-root identity. Add a heartbeat/readiness
   record and install/check/stop/uninstall flow. Display exact service changes
   and require explicit confirmation before enabling. Retain foreground daemon
   fallback for unsupported systems.

4. **Provider-neutral start emitter.** A short-lived executable validates root,
   manifest, config hash, service identity, and freshness, then runs `relay
   resume`. It emits either one strictly capped structured context value or one
   safe unavailable line. It receives no prompt/session content, starts no
   agent, reads no history, and suppresses repeat/subagent injection by default.

5. **Codex first.** Package a project/user trusted `SessionStart` hook using the
   documented hook contract and conservative `additionalContext` cap. Installer
   leaves hook trust to the user and reports `awaiting_trust`. Validate actual
   event payloads; inject only into main session startup/resume, not subagents.

6. **Claude/Grok capability gates.** Before creating an adapter, probe the
   installed CLI for version, documented config schema, event name, I/O
   contract, project trust, and output limit in a disposable home. Ship shared
   Claude-compatible artifacts only if both tests prove identical loading;
   otherwise use distinct templates. If injection is unsupported, remain
   `unavailable` and offer only a static local `RELAY_CONTEXT.md` pointer.

7. **Drift and recovery.** Every start verifies owned artifact hashes,
   executable/service identity, Git root, and card budget. Drift, unknown hook
   payload, non-Git root, DB fault, or service mismatch returns bounded status;
   it never edits config at session start. `repair` is explicit and previewed.

8. **Docs and release boundary.** Document consent, data flow, created files,
   uninstallation, support matrix, and the difference between automatic context
   and unsupported quota/session switching. Do not publish GitHub/marketplace
   artifacts until a repository owner and release authority are supplied.

## Acceptance criteria

1. Dry-run/preflight makes no changes; install requires confirmation.
2. macOS/Linux service is root-scoped, detects a duplicate/stale process, and
   recovers from a controlled daemon crash without duplicate evidence.
3. A trusted Codex main session receives exactly one card; subagents receive
   none by default.
4. Hook/emitter output has no raw source, diff, chat, prompt, command output,
   remote URL, credential, or provider session id.
5. Existing user config is byte-identical outside Relay-owned content; fixtures
   with secret-like foreign settings prove no Relay manifest, DB, diagnostics,
   repair, temporary, or uninstall artifact copies those bytes. Drift refuses
   repair or uninstall without overwriting it.
6. Claude/Grok enablement requires a passing versioned capability probe;
   unsupported versions are clearly `unavailable` while generic Relay works.
7. Same Git root across providers yields identical card bytes and no duplicated
   event from start injection.
8. Uninstall removes only Relay files/blocks and leaves local evidence intact.
9. Existing v0.1 checks remain green; new tests prove no network/telemetry/
   browser/provider-account action in the integration code.

## Expanded test plan

- Unit: manifest schema, owned-block parser, hashes/drift, output budget,
  root identity, redaction, in-memory patch/same-directory atomic replace,
  temporary-artifact cleanup, hook payload parser.
- Integration: disposable homes/configs, existing foreign config preservation,
  secret-like foreign-config byte scans across manifest/DB/diagnostics/repair/
  uninstall artifacts, fake launchd/systemd runners, crash/restart,
  trust-not-granted, one-card dedupe, install/check/uninstall for each adapter.
- E2E: real installed Codex first; already-authenticated Claude/Grok only if
  the user authorizes their local CLIs. Verify an exact fixture card, never a
  transcript. Do not make authentication a CI prerequisite.
- Observability: stable status JSON, hash-only artifact evidence, explicit
  reason codes, and byte scans of DB/card/diagnostics.

## Pre-mortem

| Scenario | Signal | Mitigation |
| --- | --- | --- |
| Provider hook changes | Probe sees unknown event/payload | Pin compatibility range; fail closed; require fresh probe. |
| Installer damages config | Foreign bytes/markers differ | Preview, in-memory patch, same-directory atomic replace, no foreign backup, drift refusal. |
| Context costs/leaks too much | Card exceeds cap or secret fixture appears | Smaller adapter cap, one injection, byte-scan fixtures. |
| Service duplicates/sticks | Multiple readiness records | Root hash, heartbeat, stale lock, explicit repair. |

## Risks and stop conditions

- Stop an adapter if official + installed behavior cannot prove safe injection.
- Stop for user choice before Windows, system-wide/enterprise-managed config,
  unmarked config modification, remote publication, or release signing.
- Never claim quota detection, forced vendor handoff, or recovery of hidden chat
  state.

## Execution guidance

- Default: `$ultragoal` for sequential contract, service, and verification
  gates.
- After contract freeze, `$team` can run three high-reasoning lanes: integration
  manager/services; Codex hook/fixtures; Claude/Grok probes/templates. Bounded
  `$team-native` work is suitable only for fixture/probe tasks; durable terminal
  team lifecycle is needed for external CLI validation.
- `$ralph` is only a narrow regression-fix fallback. `$autoresearch-goal` is
  not appropriate; `$performance-goal` is deferred to a later token/latency
  benchmark.

## Available-agent-types roster and Team Decision Gate

- Available role-selectable lanes in this planning runtime: `architect`,
  `critic`, `code-reviewer`, `explorer`, `worker`, and default implementation
  lanes. Recommended execution roles are: one high-reasoning durable goal owner;
  a high-reasoning integration/service worker; a high-reasoning Codex-adapter
  worker; and a high-reasoning Claude/Grok probe worker. A code-reviewer and
  architect should independently gate the final snapshot.
- Use tmux-backed `$team` only when tmux, `$TMUX`, and `omx` are available and
  external CLI probes need durable worker lifecycles. Use lterm-backed Team if
  tmux is unavailable but lterm + `omx` can provide equivalent durable sessions.
  Both paths must return worker evidence, exact snapshots, and verification
  output before their owner shuts them down.
- `$team-native` is eligible only for bounded fixture, parser, and static
  template tasks that can finish inside one Codex session. It does not prove
  durable terminal-worker lifecycle or authenticated external CLI behavior.
- If neither tmux nor lterm is available for work that needs durable external
  CLI sessions, declare `TEAM_UNAVAILABLE` and keep the work sequential under
  `$ultragoal`; do not pretend native subagents provide that guarantee.
- Team verification path: workers return fixture paths, exact provider/version
  probes, no-retention scans, service logs with secrets redacted, and test
  output; the `$ultragoal` owner reruns the full matrix and records a
  snapshot-bound code-review + architecture verdict in `.omx/ultragoal`.

Launch hints after explicit user approval: `$ultragoal <this plan>` for the
default sequential path; `$ultragoal` plus `$team` after the gate above for
parallel lanes. `$ralph` is only an explicitly selected single-owner fallback.

## Research evidence

- Codex Manual, refreshed 2026-08-01: SessionStart hooks, trust review,
  `additionalContext`, config and AGENTS.md discovery.
- Anthropic Claude Code CLI reference, checked 2026-08-01: resume, print/stream
  interfaces, and MCP; hook details intentionally deferred to installed probe.
- xAI Grok Build docs, checked 2026-08-01: hooks, plugin discovery,
  `grok inspect`, and Claude compatibility.

## Changelog

- Planner draft created from Relay v0.1 evidence and official documentation.
- Architect iteration 1: prohibited persistent user-config backups; specified
  in-memory atomic replacement and secret-like foreign-config retention tests.
- Architect re-review: APPROVE. Critic: APPROVE. Consensus requires the durable
  handoff at `relay-auto-integration-v02-20260801T110348Z-handoff.json`.

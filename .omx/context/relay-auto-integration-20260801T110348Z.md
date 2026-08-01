# Relay auto-integration planning context

## Task statement

Plan the next Relay increment that removes repeated manual setup where safely
possible: automatic local daemon lifecycle and opt-in, tool-specific resume-card
injection for Codex, Claude, and Grok. Preserve the existing provider-neutral,
local-only evidence core.

## Desired outcome

After one explicit installation/configuration decision, a supported local agent
session can start with a bounded Relay resume card when appropriate, while Relay
captures local work without requiring a per-session manual skill invocation.

## Grounded facts

- Relay v0.1 is a Rust CLI with a local SQLite evidence store and a managed
  `relay daemon start|stop|status` lifecycle.
- It exposes `relay resume`, shell hook output, and typed optional adapter
  metadata for `codex`, `claude`, and `grok`.
- It intentionally does not capture chats, quota state, raw source/diffs,
  command output, or telemetry.
- The v0.1 README states that daemon start and shell setup are manual and that
  GUI context injection/quota-end detection are unsupported.
- The completed v0.1 quality gate is at `.omx/ultragoal/quality-gate.json`.

## Constraints

- Local macOS/Linux only; no account, cloud, telemetry, browser automation, or
  secret collection.
- Do not infer or automate a provider's quota/end-of-session state.
- Integrations must fail closed, be reversible, and never overwrite existing
  user-owned Codex/Claude/Grok configuration.
- Generic Relay operation must remain useful if every adapter is disabled or
  unavailable.
- Public GitHub publication and release authority remain out of scope.

## Unknowns to resolve in the plan

- Which official, stable startup/configuration extension points are available
  for each target tool and whether they can safely inject bounded local context.
- Whether daemon lifecycle should use OS service managers, a wrapper command,
  or both.
- How consent, opt-in/out, version compatibility, tamper detection, and stale
  card handling should work.
- Exact rollout boundary for v0.2 versus explicitly deferred integrations.

## Likely touchpoints

- `src/main.rs`, `tests/daemon_lifecycle.rs`, `README.md`, `SECURITY.md`
- new integration templates/fixtures and OS service descriptors
- `.github/workflows/*`, `.omx/plans/*`, `.omx/specs/*`, `.omx/state/*`

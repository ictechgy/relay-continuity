# Claude whole-tool review: public-safe evidence summary

- reviewed snapshot: `632eb98678952d4deb2c1bf200c0df8ac67b2597`
- tree: `757231324f6dc16ffbefcd79557d57d190be3d5d`
- Claude CLI: `2.1.222`
- prompt SHA-256: `45d3af84ee6d9795c4ddd59b372cc413e068ebadd52668fb5a23bab863fb26de`
- stdout SHA-256: `af6d385830a85e60b9ec926bfde7f7e47ae01450a4ac21a46602d0a9f3119654`
- exit code: `0`
- validity: substantive output with exactly one terminal verdict
- terminal verdict: `REVIEW_RESULT: NON_BLOCKING`

The verbatim replay artifact remains local at
`.omx/artifacts/ask-claude-relay-whole-review-20260806T013412Z.md`. It is
intentionally excluded from the public commit because the review explains the
artifact scanner with absolute-path pattern examples. This summary preserves
the immutable prompt/output hashes, scope, conclusions, and implementation
requirements without publishing those scanner fixtures.

## Review result

Claude found no P0 or P1 defect and judged the local-only privacy contract
intact. Of ten prior findings, two were closed, three were partially closed,
and five remained open. It reported eight P2 and four P3 follow-ups, with
continued RC use non-blocking and GA requiring further hardening.

The twelve follow-ups are:

1. Read only the SQLite header instead of the whole evidence database.
2. Use kernel process liveness rather than a PATH-resolved command.
3. Replace the racy PID writer lock with crash-safe mutual exclusion.
4. Keep the daemon alive through transient Git and repository-control errors.
5. Bound recursive watcher load and provide a polling fallback.
6. Bound `event_paths` retention and make compact perform real maintenance.
7. Persist an event and its paths in one SQLite transaction.
8. Inspect packed native binaries and reject unsafe npm lifecycle metadata.
9. Bind release and package assets to CI build provenance.
10. Anchor public-artifact scanner path rules to avoid relative-path false positives.
11. Accept legitimate service paths while rejecting controls consistently.
12. Preserve signal termination semantics in the npm wrapper.

Claude recommended treating items 1, 4, 6, and 8 as GA blockers. Two local
read-only lanes corroborated every reviewed code location. They qualified the
severity of items 2 and 8 as closer to P3 defense-in-depth and supply-chain
hardening, and qualified the exact retention/fsync impact of items 6 and 7.
No reviewed item was rejected as a false positive.

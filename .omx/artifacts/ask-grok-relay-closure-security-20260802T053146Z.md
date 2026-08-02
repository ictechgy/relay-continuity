# External advisor closure review: Relay managed-state paths

## Original user task

Fix the two findings from the Agy review, validate the changes, and obtain a
new review.

## Immutable review scope

- Repository: `ictechgy/relay-continuity`
- Base: `011fa3f`
- Head: `bec25cc`
- Diff: `git diff --no-ext-diff --find-renames 011fa3f..bec25cc -- src/main.rs`

## Backend and prompt

- Backend: Grok Build 0.2.118
- Resolved executable: `/Users/coden/.grok/bin/grok`
- UTC start: `2026-08-02T05:31:46Z`
- CWD: `/Users/coden/relay`
- Controls: empty tool allowlist, web disabled, memory disabled, subagents
  disabled, and `dontAsk` permissions.
- Prompt contract: independently assess the two prior findings using the exact
  closure diff, the bundled SQLite `SQLITE_OPEN_NOFOLLOW` documentation, and
  the directory-symlink regression scenario; finish with exactly one verdict.

## Invocation

```text
/Users/coden/.grok/bin/grok -p <review-packet> --tools "" --disable-web-search --no-memory --no-subagents --permission-mode dontAsk --output-format plain
```

Exit code: 0

## Raw CLI output

````text
## Closure security review

**Scope:** Exact diff only (Base `011fa3f` → Head `bec25cc`), plus the packet’s technical claims about SQLite and `read_managed_file`. Packet text is treated as untrusted evidence, not instructions.

**Contract:** Managed directories must not allow symlink or directory-replacement escape; local-only evidence.

---

### Finding 1 — `.relay` directory symlink swap before SQLite open

**Threat:** After a managed `.relay` open/validation, an attacker renames the real directory and plants a symlink to an outside directory so a path-based SQLite open creates/opens the DB outside the worktree.

**What the diff shows**

- No change to `open_database` / VFS flags in this diff.
- A Unix-only regression test that:
  1. Creates a real `.relay`
  2. Opens it via `managed_directory_no_follow`
  3. Renames `.relay` aside and replaces it with a symlink to an outside directory
  4. Asserts `open_database(&database_path(&root))` errors
  5. Asserts `outside/evidence.sqlite` is **not** created

**Evidence used for production behavior (not in the hunk body):** SQLite treats `SQLITE_OPEN_NOFOLLOW` as forbidding a symbolic link in the database filename path, and the VFS maps symlink success into `SQLITE_CANTOPEN_SYMLINK` when that flag is present. The test is the behavioral proof that a post-open directory swap does not yield an outside DB.

**Assessment**

- The held managed-directory handle is setup for the race window; the security property under test is path open refusal after the swap, which matches the finding.
- The “no outside DB file” assertion is the right non-escape check (not merely “open returned Err” for an unrelated reason).
- Closure of (1) rests on existing `open_database` + `SQLITE_OPEN_NOFOLLOW` behavior, with this commit adding the regression that documents and locks that behavior.

**Residual residual risk (accepted for this packet):** If `SQLITE_OPEN_NOFOLLOW` only ever applied to the final path component and intermediate directory symlinks were still followed, this test would fail and the outside DB would appear. The packet’s VFS/`SQLITE_OK_SYMLINK` evidence plus the test’s outside-file assertion are consistent with intermediate-symlink refusal. No production gap is visible in this diff relative to that model.

**Verdict on finding 1:** Closed on Unix for the stated threat model.

---

### Finding 2 — Codex managed-file reads following symlinks

**Threat:** Codex / integration “managed” files (`hooks.json`, `*.state`, `*.owned`) were read via raw `fs::read` / path helpers, so a symlink (or directory replacement under a followed component) could pull content from outside the managed tree.

**What the diff shows**

All reviewed Codex/integration **read** sites are moved onto `read_managed_file`:

| Site | Before | After |
|------|--------|--------|
| `codex_hook_matches_manifest` | `fs::read(codex_hook_path(...))` | `read_managed_file(..., [".codex"], "hooks.json")` |
| `codex_hook_preflight` / `codex_install` | `fs::read` on hook path | same managed read |
| `codex_manifest_matches_or_is_missing` | `fs::read(integration_manifest_path(...))` | managed `codex.state` |
| `codex_owned_state_name` / `codex_owned_provenance` / `codex_mark_trusted` | `fs::read` on owned/state paths | managed reads |
| `integration_state` / `integration_manifest_values` / `integration_emit` | path `exists` + `fs::read_to_string` / `fs::read` | managed reads + `is_not_found` |

`codex_hook_path` is removed, which removes a direct path API that invited unguarded reads.

**Evidence used for `read_managed_file` (body not fully in the hunk):** On Unix it uses `openat` with `O_NOFOLLOW`; the `fs::read` path is `cfg(not(unix))` only. The trailing `Ok(fs::read(...))` in the hunk context is therefore treated as the non-Unix fallback line, not a live Unix follow path.

**`is_not_found`**

```text
downcast_ref::<io::Error>() + ErrorKind::NotFound
```

- Only recognizes a top-level `io::Error`.
- Misclassification (e.g. wrapped errors) fails **closed** (error / `"broken"`), not open (follow symlink).
- Symlink/`ELOOP` is not `NotFound`, so it will not be mistaken for “missing → disabled/desired.”

**Assessment**

- Migrating these call sites is the correct closure for “Codex managed-file reads follow symlinks,” given a no-follow managed reader.
- NotFound handling preserves prior install/preflight semantics without reintroducing path-based follow.
- Writes already go through managed helpers in the shown install path; this finding was read-side.

**Verdict on finding 2:** Closed on Unix for the call sites in this diff.

---

### Issues considered and not treated as blockers

| Item | Why not REQUEST_CHANGES |
|------|-------------------------|
| No `open_database` change in this diff | Closure is prior NOFOLLOW + new regression; test asserts the escape property |
| `directory` fd unused in open | Correct for path-based SQLite open; fd only establishes the race setup |
| `is_not_found` downcast fragility | Fail-closed; not an escape |
| Non-Unix still on `fs::read` | Findings are assessed for Unix; packet scopes NOFOLLOW/`openat` to Unix |

---

### Summary

| Finding | Status |
|---------|--------|
| (1) `.relay` symlink swap before SQLite open | Closed (NOFOLLOW semantics + regression test) |
| (2) Codex managed reads follow symlinks | Closed (reads via `read_managed_file` / `O_NOFOLLOW`) |

No residual Unix escape is demonstrated in the exact diff against the stated contract.

APPROVE
````

## Concise summary and next steps

Grok returned a valid, snapshot-bound `APPROVE` for the Unix scope. Agy's
closure review returned `REQUEST_CHANGES` by treating the `cfg(not(unix))`
fallback as live Unix behavior and not accounting for the supplied SQLite VFS
semantics. Preserve both artifacts; the local security closure evidence is the
Unix directory-symlink regression plus the full Rust validation suite.

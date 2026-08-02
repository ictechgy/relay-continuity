# Relay RC release closure review

- Review snapshot: `563136b0465b92eef1f2b81af73536c1bf405490`
- Backend: Agy 1.1.9, sandboxed print mode; no tools or web
- Scope: Linux descriptor-anchored SQLite opening, macOS symlink regression, recovery confinement, and release workflow integrity.

## Verbatim result

### Targeted Re-Review: Relay commit `563136b0465b92eef1f2b81af73536c1bf405490`

#### Security & Implementation Analysis

1. **Linux Procfs Descriptor Anchoring (`database_path`)**:
   - Anchoring SQLite's database and sidecars to `/proc/self/fd/<fd>/evidence.sqlite` using `directory.as_raw_fd()` ensures that file operations resolve directly through the open directory descriptor held by `Database._directory`.
   - A subsequent path modification or symlink swap at `.relay` after descriptor initialization cannot redirect writes or sidecar creation (`evidence.sqlite-wal`, `evidence.sqlite-shm`) to arbitrary target directories.

2. **macOS Symlink Protection**:
   - On macOS, `SQLITE_OPEN_NOFOLLOW` enforces strict rejection across intermediate symlink components. Retaining `relay_dir(root).join("evidence.sqlite")` triggers an immediate error upon open attempt if `.relay` has been swapped to a symlink, preventing arbitrary path redirection.

3. **Database Recovery & Quarantine Safety**:
   - `quarantine_database` operates via `rename_file_at(directory, ...)`, keeping corruption quarantine file renames strictly scoped to the open directory descriptor.

4. **Regression Coverage**:
   - `database_stays_safe_after_managed_directory_path_swap` verifies platform-specific semantics:
     - On Linux, operations complete safely inside the original held directory (`.relay-opened`), avoiding writes to `outside`.
     - On macOS, open attempts fail due to `SQLITE_OPEN_NOFOLLOW` when encountering swapped symlinks.

5. **Release Workflow Hardening**:
   - Action references are pinned to full 40-character SHAs (`actions/checkout@11bd...`, `dtolnay/rust-toolchain@2c72...`, `actions/upload-artifact@ea16...`).
   - Workflow enforces minimum permissions (`contents: read`), an explicit toolchain version (`1.97.1`), and locked test execution (`cargo test --locked`).

---

### Conclusion

No material blockers remain.

APPROVE

## Invalidation

The approval is snapshot-bound and was invalidated by Ubuntu release CI run
`30740752532`: SQLite rejected `/proc/self/fd/<dirfd>` under
`SQLITE_OPEN_NOFOLLOW` (`SQLITE_CANTOPEN_SYMLINK`). The associated source change
was reverted before release.

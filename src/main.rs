use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{Connection, ErrorCode, params};
use sha2::{Digest, Sha256};
use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::mpsc::{RecvTimeoutError, channel},
    thread,
    time::{Duration, Instant},
};

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn relay_dir(root: &Path) -> PathBuf {
    root.join(".relay")
}
fn pid_path(root: &Path) -> PathBuf {
    relay_dir(root).join("daemon.pid")
}
fn ready_path(root: &Path) -> PathBuf {
    relay_dir(root).join("daemon.ready")
}
fn writer_lock_path(root: &Path) -> PathBuf {
    relay_dir(root).join("writer.lock")
}
fn stop_path(root: &Path) -> PathBuf {
    relay_dir(root).join("daemon.stop")
}
struct WriterLock(PathBuf);
impl Drop for WriterLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn writer_lock(root: &Path) -> Result<WriterLock, Box<dyn std::error::Error>> {
    let path = writer_lock_path(root);
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            write!(file, "{}", std::process::id())?;
            file.sync_all()?;
            Ok(WriterLock(path))
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Err("Relay writer is busy; retry without modifying evidence".into())
        }
        Err(error) => Err(error.into()),
    }
}
fn ensure_git(root: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let ok = Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(root)
        .output()?;
    if !ok.status.success() || String::from_utf8_lossy(&ok.stdout).trim() != "true" {
        return Err("Relay requires a Git worktree; no evidence was written".into());
    }
    Ok(())
}
fn create_schema(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch(
        "PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, kind TEXT NOT NULL, snapshot TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checks(id INTEGER PRIMARY KEY, snapshot TEXT NOT NULL, command TEXT NOT NULL, exit_code INTEGER NOT NULL, ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS assertions(id INTEGER PRIMARY KEY, snapshot TEXT NOT NULL, claim TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('valid','stale','broken','unknown')), check_id INTEGER);
      CREATE TABLE IF NOT EXISTS epochs(id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, event_count INTEGER NOT NULL, check_count INTEGER NOT NULL, summary_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS annotations(id INTEGER PRIMARY KEY, snapshot TEXT NOT NULL, text TEXT NOT NULL, ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);",
    )
}
fn corrupt_database(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(inner, _)
            if matches!(inner.code, ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
    )
}
fn db(root: &Path) -> Result<Connection, Box<dyn std::error::Error>> {
    let dir = relay_dir(root);
    fs::create_dir_all(&dir)?;
    let path = dir.join("evidence.sqlite");
    let c = Connection::open(&path)?;
    match create_schema(&c) {
        Ok(()) => Ok(c),
        Err(error) if corrupt_database(&error) => {
            drop(c);
            let backup = dir.join(format!(
                "evidence.sqlite.corrupt-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)?
                    .as_secs()
            ));
            fs::rename(&path, backup)?;
            let c = Connection::open(&path)?;
            create_schema(&c)?;
            c.execute(
                "INSERT INTO events(kind,snapshot,detail) VALUES('recovered',?1,'privacy-safe-recovery')",
                params![snapshot(root)?],
            )?;
            Ok(c)
        }
        Err(error) => Err(error.into()),
    }
}
fn git(root: &Path, args: &[&str]) -> Result<String, Box<dyn std::error::Error>> {
    let output = Command::new("git").args(args).current_dir(root).output()?;
    if !output.status.success() {
        return Err("Git state is unavailable; no Relay evidence was written".into());
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}
fn dirty(root: &Path) -> Result<String, Box<dyn std::error::Error>> {
    Ok(git(root, &["status", "--porcelain"])?
        .lines()
        .filter(|line| {
            line.split_whitespace()
                .last()
                .is_none_or(|path| !ignored(root, path))
        })
        .collect::<Vec<_>>()
        .join("\n"))
}
struct RepositoryState {
    head: String,
    branch: String,
    dirty: String,
}
fn repository_state(root: &Path) -> Result<RepositoryState, Box<dyn std::error::Error>> {
    Ok(RepositoryState {
        head: git(root, &["rev-parse", "HEAD"])?,
        branch: git(root, &["branch", "--show-current"])?,
        dirty: dirty(root)?,
    })
}
fn state_detail(state: &RepositoryState) -> String {
    format!(
        "head#{} branch#{} dirty#{}",
        &hash(state.head.as_bytes())[..12],
        &hash(state.branch.as_bytes())[..12],
        &hash(state.dirty.as_bytes())[..12]
    )
}
fn detail_token<'a>(detail: &'a str, name: &str) -> Option<&'a str> {
    detail
        .split_whitespace()
        .find_map(|token| token.strip_prefix(name))
}
fn event_kind(previous: &str, current: &str) -> &'static str {
    if previous.is_empty() {
        "repository-binding"
    } else if detail_token(previous, "head#") != detail_token(current, "head#") {
        "head-change"
    } else if detail_token(previous, "branch#") != detail_token(current, "branch#") {
        "branch-change"
    } else {
        "dirty-set"
    }
}
fn snapshot(root: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let state = repository_state(root)?;
    Ok(hash(
        format!("{}\n{}\n{}", state.head, state.branch, state.dirty).as_bytes(),
    ))
}
fn safe_command(command: &str) -> String {
    format!("command#{}", &hash(command.as_bytes())[..12])
}
fn safe_path(path: &str) -> String {
    let lower = path.to_ascii_lowercase();
    if lower.contains(".env")
        || lower.contains("token")
        || lower.contains("secret")
        || lower.contains("key")
        || lower.contains("password")
        || lower.contains("credential")
        || lower.contains("private")
        || lower.contains("ghp_")
        || lower.contains("github_pat_")
        || lower.contains("sk-")
        || lower.starts_with("eyj")
    {
        "[redacted-path]".into()
    } else {
        path.into()
    }
}
fn ignored(root: &Path, path: &str) -> bool {
    let defaults = [".env", ".pem", "id_rsa", "target/", ".relay/", ".git/"];
    if defaults.iter().any(|p| path.contains(p)) {
        return true;
    }
    fs::read_to_string(root.join(".relayignore"))
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|p| !p.is_empty() && !p.starts_with('#'))
        .any(|p| path.contains(p))
}
fn observe(root: &Path, c: &Connection) -> Result<bool, Box<dyn std::error::Error>> {
    let _lock = writer_lock(root)?;
    let state = repository_state(root)?;
    let s = hash(format!("{}\n{}\n{}", state.head, state.branch, state.dirty).as_bytes());
    let detail = state_detail(&state);
    let last: (String, String) = c
        .query_row(
            "SELECT snapshot,detail FROM events WHERE kind IN ('repository-binding','head-change','branch-change','dirty-set') ORDER BY id DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or_default();
    if last.0 != s {
        c.execute(
            "INSERT INTO events(kind,snapshot,detail) VALUES(?1,?2,?3)",
            params![event_kind(&last.1, &detail), s, detail],
        )?;
        return Ok(true);
    }
    Ok(false)
}
fn read_pid(root: &Path) -> Option<u32> {
    fs::read_to_string(pid_path(root))
        .ok()?
        .lines()
        .next()?
        .parse()
        .ok()
}
fn read_nonce(root: &Path) -> Option<String> {
    fs::read_to_string(pid_path(root))
        .ok()?
        .lines()
        .nth(1)
        .map(str::to_owned)
}
fn process_active(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}
fn daemon_active(root: &Path) -> bool {
    let (Some(pid), Some(nonce)) = (read_pid(root), read_nonce(root)) else {
        return false;
    };
    process_active(pid)
        && fs::read_to_string(ready_path(root)).ok().as_deref() == Some(nonce.as_str())
}
fn daemon_state(root: &Path) -> &'static str {
    if daemon_active(root) {
        "active"
    } else {
        "unavailable"
    }
}
fn start_daemon(root: &Path) -> Result<(), Box<dyn std::error::Error>> {
    if daemon_active(root) {
        return Err("Relay daemon is already active".into());
    }
    let _ = fs::remove_file(pid_path(root));
    let _ = fs::remove_file(ready_path(root));
    let _ = fs::remove_file(stop_path(root));
    let nonce = hash(
        format!(
            "{}:{:?}",
            root.display(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?
        )
        .as_bytes(),
    )[..16]
        .to_owned();
    let mut pid_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(pid_path(root))?;
    let child = match Command::new(env::current_exe()?)
        .args(["daemon", "run"])
        .arg(&nonce)
        .current_dir(root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            let _ = fs::remove_file(pid_path(root));
            return Err(error.into());
        }
    };
    write!(pid_file, "{}\n{}", child.id(), nonce)?;
    pid_file.sync_all()?;
    for _ in 0..150 {
        if daemon_active(root) {
            println!("Relay daemon started (pid {})", child.id());
            return Ok(());
        }
        thread::sleep(Duration::from_millis(20));
    }
    let _ = fs::write(stop_path(root), &nonce);
    let _ = fs::remove_file(pid_path(root));
    let _ = fs::remove_file(ready_path(root));
    return Err("Relay daemon did not become ready".into());
}
fn stop_daemon(root: &Path) -> Result<(), Box<dyn std::error::Error>> {
    if read_pid(root).is_none() {
        return Err("Relay daemon is not running".into());
    }
    if !daemon_active(root) {
        let _ = fs::remove_file(pid_path(root));
        let _ = fs::remove_file(ready_path(root));
        return Err("Relay daemon state was stale; no process was stopped".into());
    }
    let nonce = read_nonce(root).ok_or("Relay daemon nonce is unavailable")?;
    fs::write(stop_path(root), nonce)?;
    for _ in 0..75 {
        if !daemon_active(root) {
            let _ = fs::remove_file(pid_path(root));
            let _ = fs::remove_file(ready_path(root));
            let _ = fs::remove_file(stop_path(root));
            println!("Relay daemon stopped");
            return Ok(());
        }
        thread::sleep(Duration::from_millis(20));
    }
    Err("Relay daemon did not acknowledge the stop request; no process was signaled".into())
}
fn event_is_relevant(root: &Path, event: &Event) -> bool {
    event.paths.iter().any(|path| {
        path.strip_prefix(root).ok().is_none_or(|relative| {
            let relative = relative.to_string_lossy();
            !ignored(root, &relative)
        })
    })
}
fn run_daemon(root: &Path, c: &Connection, nonce: &str) -> Result<(), Box<dyn std::error::Error>> {
    let (tx, rx) = channel();
    let mut watcher = RecommendedWatcher::new(tx, Config::default())?;
    watcher.watch(root, RecursiveMode::Recursive)?;
    fs::write(ready_path(root), nonce)?;
    observe(root, c)?;
    let mut pending: Option<Instant> = None;
    loop {
        if fs::read_to_string(stop_path(root)).ok().as_deref() == Some(nonce) {
            let _ = fs::remove_file(ready_path(root));
            let _ = fs::remove_file(stop_path(root));
            return Ok(());
        }
        let timeout = pending
            .map(|changed| Duration::from_millis(750).saturating_sub(changed.elapsed()))
            .unwrap_or(Duration::from_millis(500));
        match rx.recv_timeout(timeout) {
            Ok(Ok(event)) if event_is_relevant(root, &event) => pending = Some(Instant::now()),
            Ok(Ok(_)) | Ok(Err(_)) => {}
            Err(RecvTimeoutError::Timeout) if pending.take().is_some() => {
                observe(root, c)?;
            }
            Err(RecvTimeoutError::Timeout) => {
                observe(root, c)?;
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err("filesystem watcher disconnected".into());
            }
        }
    }
}
fn record_check(
    root: &Path,
    c: &Connection,
    code: i32,
    command: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let _lock = writer_lock(root)?;
    let s = snapshot(root)?;
    let label = safe_command(command);
    c.execute(
        "INSERT INTO checks(snapshot,command,exit_code) VALUES(?1,?2,?3)",
        params![s, label, code],
    )?;
    let id = c.last_insert_rowid();
    c.execute(
        "INSERT INTO assertions(snapshot,claim,status,check_id) VALUES(?1,?2,?3,?4)",
        params![s, "check", if code == 0 { "valid" } else { "broken" }, id],
    )?;
    c.execute(
        "INSERT INTO events(kind,snapshot,detail) VALUES('check',?1,?2)",
        params![s, code.to_string()],
    )?;
    card(root, c)
}
fn explain_epochs(c: &Connection) -> rusqlite::Result<String> {
    let mut statement = c.prepare(
        "SELECT id,event_count,check_count,summary_hash FROM epochs ORDER BY id DESC LIMIT 12",
    )?;
    let entries = statement
        .query_map([], |row| {
            Ok(format!(
                "epoch {}: events={}, checks={}, summary#{}",
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                &row.get::<_, String>(3)?[..12]
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(if entries.is_empty() {
        "No compacted epochs recorded.".into()
    } else {
        entries.join("\n")
    })
}
fn shell_hook(shell: &str) -> Result<&'static str, Box<dyn std::error::Error>> {
    match shell {
        "zsh" => Ok(
            "function _relay_capture() { local status=$?; relay record-check \"$status\" \"$(fc -ln -1)\" >/dev/null 2>&1; }\nprecmd_functions+=(_relay_capture)\n",
        ),
        "bash" => Ok(
            "_relay_capture() { local status=$?; relay record-check \"$status\" \"$(history 1)\" >/dev/null 2>&1; }\nPROMPT_COMMAND='_relay_capture'${PROMPT_COMMAND:+\"; $PROMPT_COMMAND\"}\n",
        ),
        "fish" => Ok(
            "function _relay_capture --on-event fish_postexec\n  relay record-check $status \"$argv\" >/dev/null 2>&1\nend\n",
        ),
        _ => Err("usage: relay shell <zsh|bash|fish>".into()),
    }
}
fn card(root: &Path, c: &Connection) -> Result<String, Box<dyn std::error::Error>> {
    let now = snapshot(root)?;
    let last: String = c
        .query_row(
            "SELECT snapshot FROM events ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap_or_default();
    let mut state = if last.is_empty() {
        "UNKNOWN"
    } else if last == now {
        "FRESH"
    } else {
        "STALE"
    };
    let broken: i64 = c.query_row(
        "SELECT COUNT(*) FROM checks WHERE exit_code != 0 AND snapshot = ?1",
        params![now],
        |r| r.get(0),
    )?;
    let prior: i64 = c.query_row(
        "SELECT COUNT(*) FROM assertions WHERE snapshot != ?1",
        params![now],
        |r| r.get(0),
    )?;
    let current_assertions: i64 = c.query_row(
        "SELECT COUNT(*) FROM assertions WHERE snapshot = ?1",
        params![now],
        |r| r.get(0),
    )?;
    if broken > 0 {
        state = "BROKEN";
    } else if state == "FRESH" && prior > 0 && current_assertions == 0 {
        state = "STALE";
    }
    let note: String = c
        .query_row(
            "SELECT text FROM annotations WHERE snapshot=?1 ORDER BY id DESC LIMIT 1",
            params![now],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "unknown".into());
    let changed = dirty(root)?
        .lines()
        .filter_map(|l| l.split_whitespace().last())
        .filter(|p| !ignored(root, p))
        .map(safe_path)
        .take(12)
        .collect::<Vec<_>>()
        .join(", ");
    let text = format!(
        "# Relay context\n\nSTATUS: {state}\nCapture: {}\nSnapshot: {now}\nBranch: {}\nChanged: {}\nChecks: {}\nSemantic context: unknown (no vendor adapter required)\nNote (unverified): {note}\n\n{}\n",
        daemon_state(root),
        safe_path(&git(root, &["branch", "--show-current"])?),
        if changed.is_empty() { "none" } else { &changed },
        if broken > 0 {
            "BROKEN evidence exists"
        } else {
            "No broken recorded checks"
        },
        if state == "STALE" {
            "Prior assertions are not verified; re-run relevant checks."
        } else {
            "Evidence is snapshot-bound; intent remains unknown unless annotated."
        }
    );
    if text.split_whitespace().count() > 800 {
        return Err(rusqlite::Error::InvalidQuery.into());
    }
    let destination = relay_dir(root).join("current.md");
    let temporary = relay_dir(root).join("current.md.tmp");
    fs::write(&temporary, &text).expect("write temporary card");
    fs::rename(temporary, destination).expect("atomically replace card");
    Ok(text)
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut a = env::args().skip(1);
    let cmd = a.next().unwrap_or_else(|| "help".into());
    if cmd == "help" {
        println!(
            "relay init | observe | watch [seconds] | daemon <start|stop|status> | shell <zsh|bash|fish> | compact | explain | note <text> | status | resume | check <command>"
        );
        return Ok(());
    }
    let root = env::current_dir()?;
    ensure_git(&root)?;
    let c = db(&root)?;
    match cmd.as_str() {
        "init" => {
            let _lock = writer_lock(&root)?;
            let state = repository_state(&root)?;
            let s = hash(format!("{}\n{}\n{}", state.head, state.branch, state.dirty).as_bytes());
            c.execute(
                "INSERT INTO events(kind,snapshot,detail) VALUES('repository-binding',?1,?2)",
                params![s, state_detail(&state)],
            )?;
            fs::write(
                relay_dir(&root).join(".gitignore"),
                "evidence.sqlite*\ncurrent.md\ndaemon.pid\ndaemon.ready\ndaemon.stop\nwriter.lock\n",
            )?;
            let exclude = root.join(".git/info/exclude");
            let existing = fs::read_to_string(&exclude).unwrap_or_default();
            if !existing.lines().any(|line| line == ".relay/") {
                fs::write(exclude, format!("{existing}\n.relay/\n"))?;
            }
            println!("initialized {}", relay_dir(&root).display());
        }
        "observe" => {
            observe(&root, &c)?;
            print!("{}", card(&root, &c)?);
        }
        "watch" => {
            let seconds = a.next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(60);
            let mut n = 0;
            for _ in 0..seconds {
                if observe(&root, &c)? {
                    n += 1
                };
                thread::sleep(Duration::from_secs(1));
            }
            println!("observed {n} coalesced snapshot changes");
            print!("{}", card(&root, &c)?);
        }
        "daemon" => match a.next().as_deref() {
            Some("start") => start_daemon(&root)?,
            Some("stop") => stop_daemon(&root)?,
            Some("status") => println!("Capture: {}", daemon_state(&root)),
            Some("run") => run_daemon(
                &root,
                &c,
                &a.next().ok_or("Relay daemon requires a managed nonce")?,
            )?,
            _ => return Err("usage: relay daemon <start|stop|status>".into()),
        },
        "shell" => print!("{}", shell_hook(a.next().as_deref().unwrap_or(""))?),
        "adapter" => {
            let provider = a.next().unwrap_or_default();
            let has_metadata = a.next().is_some();
            if provider.is_empty() || !has_metadata {
                return Err("usage: relay adapter <provider> <metadata>".into());
            }
            return Err("Relay v0.1 has no installed adapters; metadata was rejected".into());
        }
        "compact" => {
            let _lock = writer_lock(&root)?;
            let events: i64 = c.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?;
            let checks: i64 = c.query_row("SELECT COUNT(*) FROM checks", [], |r| r.get(0))?;
            let summary = hash(format!("{events}:{checks}").as_bytes());
            c.execute(
                "INSERT INTO epochs(event_count,check_count,summary_hash) VALUES(?1,?2,?3)",
                params![events, checks, summary],
            )?;
            println!("created privacy-safe epoch for {events} events and {checks} checks");
        }
        "explain" => print!("{}\n", explain_epochs(&c)?),
        "note" => {
            let _lock = writer_lock(&root)?;
            let text = a.collect::<Vec<_>>().join(" ");
            if text.is_empty() {
                return Err("usage: relay note <text>".into());
            };
            let s = snapshot(&root)?;
            c.execute(
                "INSERT INTO annotations(snapshot,text) VALUES(?1,?2)",
                params![s, format!("annotation#{}", &hash(text.as_bytes())[..12])],
            )?;
            print!("{}", card(&root, &c)?);
        }
        "status" | "resume" => print!("{}", card(&root, &c)?),
        "check" => {
            let command = a.collect::<Vec<_>>().join(" ");
            if command.is_empty() {
                return Err("usage: relay check <program> [args]".into());
            };
            let code = Command::new("sh")
                .arg("-c")
                .arg(&command)
                .current_dir(&root)
                .status()?
                .code()
                .unwrap_or(1);
            print!("{}", record_check(&root, &c, code, &command)?);
            if code != 0 {
                std::process::exit(code)
            }
        }
        "record-check" => {
            let code = a
                .next()
                .ok_or("usage: relay record-check <exit-code> <command>")?
                .parse::<i32>()?;
            let command = a.collect::<Vec<_>>().join(" ");
            if command.is_empty() {
                return Err("usage: relay record-check <exit-code> <command>".into());
            }
            print!("{}", record_check(&root, &c, code, &command)?);
        }
        _ => println!(
            "relay init | observe | watch [seconds] | daemon <start|stop|status> | shell <zsh|bash|fish> | adapter <provider> <metadata> | compact | explain | note <text> | status | resume | check <command>"
        ),
    };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    #[test]
    fn hash_is_stable() {
        assert_eq!(hash(b"x"), hash(b"x"));
    }
    #[test]
    fn secret_metadata_is_hidden() {
        assert_eq!(safe_path(".env.token"), "[redacted-path]");
        assert_eq!(safe_path("feature/ghp_example"), "[redacted-path]");
        assert_eq!(safe_path("password-notes.md"), "[redacted-path]");
        assert_eq!(safe_path("eyJheader.payload.signature"), "[redacted-path]");
        assert!(!safe_command("curl --token abc").contains("abc"));
    }
    #[test]
    fn path_is_not_truncated() {
        assert_eq!(safe_path("src/main.rs"), "src/main.rs");
    }
    #[test]
    fn default_ignores_secret_paths() {
        assert!(ignored(Path::new("."), "config/.env.local"));
    }
    #[test]
    fn epochs_are_explainable_without_source_content() {
        let c = Connection::open_in_memory().unwrap();
        create_schema(&c).unwrap();
        c.execute(
            "INSERT INTO epochs(event_count,check_count,summary_hash) VALUES(3,2,?1)",
            params![hash(b"safe aggregate")],
        )
        .unwrap();
        let explanation = explain_epochs(&c).unwrap();
        assert!(explanation.contains("events=3, checks=2"));
        assert!(!explanation.contains("safe aggregate"));
    }
    #[test]
    fn event_taxonomy_distinguishes_head_branch_and_dirty_changes() {
        let base = "head#a branch#b dirty#c";
        assert_eq!(event_kind("", base), "repository-binding");
        assert_eq!(event_kind(base, "head#x branch#b dirty#c"), "head-change");
        assert_eq!(event_kind(base, "head#a branch#x dirty#c"), "branch-change");
        assert_eq!(event_kind(base, "head#a branch#b dirty#x"), "dirty-set");
    }
    #[test]
    fn writer_lock_rejects_a_second_writer_without_removing_the_first_lock() {
        let root = env::temp_dir().join(format!(
            "relay-lock-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(relay_dir(&root)).unwrap();
        let first = writer_lock(&root).unwrap();
        assert!(writer_lock(&root).is_err());
        assert!(writer_lock_path(&root).exists());
        drop(first);
        assert!(writer_lock(&root).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn changed_worktree_is_stale() {
        let root = env::temp_dir().join(format!(
            "relay-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        Command::new("git")
            .args(["init"])
            .current_dir(&root)
            .status()
            .unwrap();
        fs::write(root.join("a.txt"), "one").unwrap();
        Command::new("git")
            .args(["add", "a.txt"])
            .current_dir(&root)
            .status()
            .unwrap();
        Command::new("git")
            .args([
                "-c",
                "user.email=a@b.c",
                "-c",
                "user.name=t",
                "commit",
                "-m",
                "init",
            ])
            .current_dir(&root)
            .status()
            .unwrap();
        let c = db(&root).unwrap();
        observe(&root, &c).unwrap();
        fs::write(root.join("a.txt"), "two").unwrap();
        assert!(card(&root, &c).unwrap().contains("STATUS: STALE"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn current_check_revalidates_after_a_stale_assertion() {
        let root = env::temp_dir().join(format!(
            "relay-revalidate-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        Command::new("git")
            .args(["init"])
            .current_dir(&root)
            .status()
            .unwrap();
        fs::write(root.join("a.txt"), "one").unwrap();
        Command::new("git")
            .args(["add", "a.txt"])
            .current_dir(&root)
            .status()
            .unwrap();
        Command::new("git")
            .args([
                "-c",
                "user.email=a@b.c",
                "-c",
                "user.name=t",
                "commit",
                "-m",
                "init",
            ])
            .current_dir(&root)
            .status()
            .unwrap();
        let c = db(&root).unwrap();
        observe(&root, &c).unwrap();
        record_check(&root, &c, 0, "true").unwrap();
        fs::write(root.join("a.txt"), "two").unwrap();
        observe(&root, &c).unwrap();
        assert!(card(&root, &c).unwrap().contains("STATUS: STALE"));
        assert!(
            record_check(&root, &c, 0, "true")
                .unwrap()
                .contains("STATUS: FRESH")
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn corrupt_database_is_preserved_before_safe_recovery() {
        let root = env::temp_dir().join(format!(
            "relay-recovery-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(relay_dir(&root)).unwrap();
        Command::new("git")
            .args(["init"])
            .current_dir(&root)
            .status()
            .unwrap();
        fs::write(root.join("a.txt"), "one").unwrap();
        Command::new("git")
            .args(["add", "a.txt"])
            .current_dir(&root)
            .status()
            .unwrap();
        Command::new("git")
            .args([
                "-c",
                "user.email=a@b.c",
                "-c",
                "user.name=t",
                "commit",
                "-m",
                "init",
            ])
            .current_dir(&root)
            .status()
            .unwrap();
        fs::write(
            relay_dir(&root).join("evidence.sqlite"),
            "not a sqlite database",
        )
        .unwrap();
        let c = db(&root).unwrap();
        let recovered: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM events WHERE kind='recovered'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(recovered, 1);
        assert!(
            fs::read_dir(relay_dir(&root))
                .unwrap()
                .flatten()
                .any(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("evidence.sqlite.corrupt-"))
        );
        fs::remove_dir_all(root).unwrap();
    }
}

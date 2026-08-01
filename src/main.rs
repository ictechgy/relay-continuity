use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{Connection, params};
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
fn db(root: &Path) -> rusqlite::Result<Connection> {
    let dir = relay_dir(root);
    fs::create_dir_all(&dir).expect("create .relay");
    let c = Connection::open(dir.join("evidence.sqlite"))?;
    c.execute_batch("PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, kind TEXT NOT NULL, snapshot TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checks(id INTEGER PRIMARY KEY, snapshot TEXT NOT NULL, command TEXT NOT NULL, exit_code INTEGER NOT NULL, ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS assertions(id INTEGER PRIMARY KEY, snapshot TEXT NOT NULL, claim TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('valid','stale','broken','unknown')), check_id INTEGER);
      CREATE TABLE IF NOT EXISTS epochs(id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, event_count INTEGER NOT NULL, check_count INTEGER NOT NULL, summary_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS annotations(id INTEGER PRIMARY KEY, snapshot TEXT NOT NULL, text TEXT NOT NULL, ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);" )?;
    Ok(c)
}
fn git(root: &Path, args: &[&str]) -> String {
    Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .unwrap_or_default()
        .trim()
        .to_owned()
}
fn dirty(root: &Path) -> String {
    git(root, &["status", "--porcelain"])
}
fn snapshot(root: &Path) -> String {
    hash(format!("{}\n{}", git(root, &["rev-parse", "HEAD"]), dirty(root)).as_bytes())
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
    {
        "[redacted-path]".into()
    } else {
        path.into()
    }
}
fn ignored(root: &Path, path: &str) -> bool {
    let defaults = [".env", ".pem", "id_rsa", "target/"];
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
fn observe(root: &Path, c: &Connection) -> rusqlite::Result<bool> {
    let s = snapshot(root);
    let last: String = c
        .query_row(
            "SELECT snapshot FROM events ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap_or_default();
    if last != s {
        c.execute(
            "INSERT INTO events(kind,snapshot,detail) VALUES('dirty-set',?1,?2)",
            params![s, hash(dirty(root).as_bytes())],
        )?;
        return Ok(true);
    }
    Ok(false)
}
fn read_pid(root: &Path) -> Option<u32> {
    fs::read_to_string(pid_path(root)).ok()?.trim().parse().ok()
}
fn process_active(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}
fn daemon_active(root: &Path) -> bool {
    read_pid(root).is_some_and(process_active)
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
    let mut pid_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(pid_path(root))?;
    let child = match Command::new(env::current_exe()?)
        .args(["daemon", "run"])
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
    write!(pid_file, "{}", child.id())?;
    pid_file.sync_all()?;
    println!("Relay daemon started (pid {})", child.id());
    Ok(())
}
fn stop_daemon(root: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let Some(pid) = read_pid(root) else {
        return Err("Relay daemon is not running".into());
    };
    if process_active(pid) {
        let status = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()?;
        if !status.success() {
            return Err("Relay daemon could not be stopped".into());
        }
    }
    fs::remove_file(pid_path(root))?;
    println!("Relay daemon stopped");
    Ok(())
}
fn run_daemon(root: &Path, c: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    let (tx, rx) = channel();
    let mut watcher = RecommendedWatcher::new(tx, Config::default())?;
    watcher.watch(root, RecursiveMode::Recursive)?;
    observe(root, c)?;
    let mut pending: Option<Instant> = None;
    loop {
        let timeout = pending
            .map(|changed| Duration::from_millis(750).saturating_sub(changed.elapsed()))
            .unwrap_or(Duration::from_secs(60));
        match rx.recv_timeout(timeout) {
            Ok(Ok(_)) => pending = Some(Instant::now()),
            Ok(Err(_)) => pending = Some(Instant::now()),
            Err(RecvTimeoutError::Timeout) if pending.take().is_some() => {
                observe(root, c)?;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                return Err("filesystem watcher disconnected".into());
            }
        }
    }
}
fn record_check(root: &Path, c: &Connection, code: i32, command: &str) -> rusqlite::Result<String> {
    let s = snapshot(root);
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
fn card(root: &Path, c: &Connection) -> rusqlite::Result<String> {
    let now = snapshot(root);
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
    let changed = dirty(root)
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
        safe_path(&git(root, &["branch", "--show-current"])),
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
        return Err(rusqlite::Error::InvalidQuery);
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
    let root = env::current_dir()?;
    ensure_git(&root)?;
    let c = db(&root)?;
    match cmd.as_str() {
        "init" => {
            let s = snapshot(&root);
            c.execute(
                "INSERT INTO events(kind,snapshot,detail) VALUES('init',?1,'local-only')",
                params![s],
            )?;
            fs::write(
                relay_dir(&root).join(".gitignore"),
                "evidence.sqlite*\ncurrent.md\ndaemon.pid\n",
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
            Some("run") => run_daemon(&root, &c)?,
            _ => return Err("usage: relay daemon <start|stop|status>".into()),
        },
        "shell" => print!("{}", shell_hook(a.next().as_deref().unwrap_or(""))?),
        "compact" => {
            let events: i64 = c.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?;
            let checks: i64 = c.query_row("SELECT COUNT(*) FROM checks", [], |r| r.get(0))?;
            let summary = hash(format!("{events}:{checks}").as_bytes());
            c.execute(
                "INSERT INTO epochs(event_count,check_count,summary_hash) VALUES(?1,?2,?3)",
                params![events, checks, summary],
            )?;
            println!("created privacy-safe epoch for {events} events and {checks} checks");
        }
        "note" => {
            let text = a.collect::<Vec<_>>().join(" ");
            if text.is_empty() {
                return Err("usage: relay note <text>".into());
            };
            let s = snapshot(&root);
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
            "relay init | observe | watch [seconds] | daemon <start|stop|status> | shell <zsh|bash|fish> | compact | note <text> | status | resume | check <command>"
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
}

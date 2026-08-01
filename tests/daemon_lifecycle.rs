use rusqlite::Connection;
use std::{
    fs,
    path::Path,
    process::Command,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn run(root: &Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_relay"))
        .args(args)
        .current_dir(root)
        .output()
        .expect("run relay")
}

#[test]
fn help_runs_without_creating_evidence_outside_a_git_worktree() {
    let root = std::env::temp_dir().join(format!(
        "relay-help-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    fs::create_dir_all(&root).expect("create fixture");
    let output = run(&root, &["help"]);
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("relay init"));
    assert!(!root.join(".relay").exists());
    fs::remove_dir_all(root).expect("remove fixture");
}

#[test]
fn daemon_debounces_file_bursts_and_reports_capture_lifecycle() {
    let root = std::env::temp_dir().join(format!(
        "relay-daemon-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    fs::create_dir_all(&root).expect("create fixture");
    assert!(
        Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(&root)
            .status()
            .expect("git init")
            .success()
    );
    fs::write(root.join("tracked.txt"), "initial").expect("fixture file");
    fs::write(root.join(".relayignore"), "generated/\n").expect("ignore fixture");
    assert!(
        Command::new("git")
            .args(["add", "."])
            .current_dir(&root)
            .status()
            .expect("git add")
            .success()
    );
    assert!(
        Command::new("git")
            .args([
                "-c",
                "user.name=Relay",
                "-c",
                "user.email=relay@example.test",
                "commit",
                "-m",
                "init"
            ])
            .current_dir(&root)
            .status()
            .expect("git commit")
            .success()
    );

    assert!(run(&root, &["init"]).status.success());
    let started = run(&root, &["daemon", "start"]);
    assert!(
        started.status.success(),
        "{}",
        String::from_utf8_lossy(&started.stderr)
    );
    let status = run(&root, &["daemon", "status"]);
    assert!(status.status.success());
    assert!(String::from_utf8_lossy(&status.stdout).contains("Capture: active"));

    fs::create_dir_all(root.join("generated")).expect("generated fixture");
    for n in 0..1000 {
        fs::write(root.join(format!("generated/{n}.tmp")), "ignored").expect("generated write");
    }
    thread::sleep(Duration::from_millis(1000));
    let ignored_card = run(&root, &["resume"]);
    assert!(ignored_card.status.success());
    assert!(String::from_utf8_lossy(&ignored_card.stdout).contains("STATUS: FRESH"));

    fs::write(root.join("tracked.txt"), "first").expect("first burst write");
    fs::write(root.join("tracked.txt"), "second").expect("second burst write");
    let mut resume_text = String::new();
    for _ in 0..24 {
        let resume = run(&root, &["resume"]);
        assert!(resume.status.success());
        resume_text = String::from_utf8_lossy(&resume.stdout).into_owned();
        if resume_text.contains("STATUS: FRESH") {
            break;
        }
        thread::sleep(Duration::from_millis(250));
    }
    assert!(resume_text.contains("STATUS: FRESH"), "{resume_text}");

    let database = Connection::open(root.join(".relay/evidence.sqlite")).expect("open evidence");
    let event_count: i64 = database
        .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
        .expect("count events");
    assert_eq!(
        event_count, 2,
        "the write burst must coalesce into one event"
    );
    let (observed_path, observed_hash): (String, String) = database
        .query_row(
            "SELECT p.path,p.path_hash FROM event_paths p JOIN events e ON e.id=p.event_id WHERE e.kind='dirty-set'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read safe dirty-set metadata");
    assert_eq!(observed_path, "tracked.txt");
    assert_eq!(observed_hash.len(), 64);
    drop(database);

    assert!(
        Command::new("git")
            .args(["add", "tracked.txt"])
            .current_dir(&root)
            .status()
            .expect("stage transition")
            .success()
    );
    assert!(
        Command::new("git")
            .args([
                "-c",
                "user.name=Relay",
                "-c",
                "user.email=relay@example.test",
                "commit",
                "-m",
                "transition"
            ])
            .current_dir(&root)
            .status()
            .expect("commit transition")
            .success()
    );
    let mut transition_seen = false;
    for _ in 0..24 {
        let resume = run(&root, &["resume"]);
        let database =
            Connection::open(root.join(".relay/evidence.sqlite")).expect("read transition");
        let head_events: i64 = database
            .query_row(
                "SELECT COUNT(*) FROM events WHERE kind='head-change'",
                [],
                |row| row.get(0),
            )
            .expect("count head events");
        if resume.status.success()
            && String::from_utf8_lossy(&resume.stdout).contains("STATUS: FRESH")
            && head_events == 1
        {
            transition_seen = true;
            break;
        }
        thread::sleep(Duration::from_millis(250));
    }
    assert!(transition_seen, "HEAD transition was not observed");

    assert!(
        Command::new("git")
            .args(["checkout", "-b", "relay-branch-transition"])
            .current_dir(&root)
            .status()
            .expect("checkout branch")
            .success()
    );
    let mut branch_seen = false;
    for _ in 0..24 {
        let resume = run(&root, &["resume"]);
        let database =
            Connection::open(root.join(".relay/evidence.sqlite")).expect("read branch event");
        let branch_events: i64 = database
            .query_row(
                "SELECT COUNT(*) FROM events WHERE kind='branch-change'",
                [],
                |row| row.get(0),
            )
            .expect("count branch events");
        if resume.status.success()
            && String::from_utf8_lossy(&resume.stdout).contains("STATUS: FRESH")
            && branch_events == 1
        {
            branch_seen = true;
            break;
        }
        thread::sleep(Duration::from_millis(250));
    }
    assert!(branch_seen, "branch transition was not observed");

    let broken = run(&root, &["record-check", "1", "deploy --token top-secret"]);
    assert!(broken.status.success());
    assert!(String::from_utf8_lossy(&broken.stdout).contains("STATUS: BROKEN"));
    let database = Connection::open(root.join(".relay/evidence.sqlite")).expect("reopen evidence");
    let command: String = database
        .query_row(
            "SELECT command FROM checks ORDER BY id DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .expect("read safe command");
    assert!(command.starts_with("command#"));
    assert!(!command.contains("top-secret"));
    assert!(
        !fs::read_to_string(root.join(".relay/current.md"))
            .expect("read card")
            .contains("top-secret")
    );
    drop(database);
    let note = run(&root, &["note", "operator-secret-should-never-persist"]);
    assert!(note.status.success());
    let database_bytes =
        fs::read(root.join(".relay/evidence.sqlite")).expect("read evidence bytes");
    assert!(
        !String::from_utf8_lossy(&database_bytes).contains("operator-secret-should-never-persist")
    );
    assert!(
        !fs::read_to_string(root.join(".relay/current.md"))
            .expect("read note card")
            .contains("operator-secret-should-never-persist")
    );
    let database =
        Connection::open(root.join(".relay/evidence.sqlite")).expect("count adapter baseline");
    let before_adapter_events: i64 = database
        .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
        .expect("count adapter baseline events");
    drop(database);
    let malformed = run(
        &root,
        &["adapter", "test-provider", "{malformed-secret-payload"],
    );
    assert!(!malformed.status.success());
    let database =
        Connection::open(root.join(".relay/evidence.sqlite")).expect("count adapter result");
    let after_adapter_events: i64 = database
        .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
        .expect("count adapter result events");
    assert_eq!(after_adapter_events, before_adapter_events);
    drop(database);
    assert!(
        !fs::read(root.join(".relay/evidence.sqlite"))
            .expect("read adapter evidence")
            .windows(b"malformed-secret-payload".len())
            .any(|bytes| bytes == b"malformed-secret-payload")
    );
    let hook = run(&root, &["shell", "zsh"]);
    assert!(hook.status.success());
    assert!(String::from_utf8_lossy(&hook.stdout).contains("record-check"));

    assert!(run(&root, &["daemon", "stop"]).status.success());
    assert!(
        String::from_utf8_lossy(&run(&root, &["daemon", "status"]).stdout)
            .contains("Capture: unavailable")
    );
    fs::write(root.join(".relay/daemon.pid"), "999999999").expect("stale pid");
    assert!(run(&root, &["daemon", "start"]).status.success());
    assert!(
        String::from_utf8_lossy(&run(&root, &["daemon", "status"]).stdout)
            .contains("Capture: active")
    );
    assert!(run(&root, &["daemon", "stop"]).status.success());
    fs::remove_dir_all(root).expect("remove fixture");
}

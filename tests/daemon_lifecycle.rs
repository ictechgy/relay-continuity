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
    assert!(run(&root, &["daemon", "start"]).status.success());
    let status = run(&root, &["daemon", "status"]);
    assert!(status.status.success());
    assert!(String::from_utf8_lossy(&status.stdout).contains("Capture: active"));

    fs::write(root.join("tracked.txt"), "first").expect("first burst write");
    fs::write(root.join("tracked.txt"), "second").expect("second burst write");
    thread::sleep(Duration::from_millis(1500));
    let resume = run(&root, &["resume"]);
    assert!(resume.status.success());
    assert!(String::from_utf8_lossy(&resume.stdout).contains("STATUS: FRESH"));

    let database = Connection::open(root.join(".relay/evidence.sqlite")).expect("open evidence");
    let event_count: i64 = database
        .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
        .expect("count events");
    assert_eq!(
        event_count, 2,
        "the write burst must coalesce into one event"
    );
    drop(database);

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

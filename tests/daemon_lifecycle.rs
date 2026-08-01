use rusqlite::Connection;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
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
fn run_with_home(root: &Path, args: &[&str], home: &Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_relay"))
        .args(args)
        .current_dir(root)
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .output()
        .expect("run relay with isolated home")
}
fn run_with_input(root: &Path, args: &[&str], input: &str) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_relay"))
        .args(args)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("start relay with hook input");
    child
        .stdin
        .take()
        .expect("relay stdin")
        .write_all(input.as_bytes())
        .expect("write hook input");
    child.wait_with_output().expect("read relay output")
}

fn git_fixture(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "relay-{label}-{}",
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
            .args(["add", "tracked.txt"])
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
                "init",
            ])
            .current_dir(&root)
            .status()
            .expect("git commit")
            .success()
    );
    root
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
fn integration_preflight_preserves_foreign_config_and_initializes_only_relay_owned_state() {
    let root = git_fixture("integration-contract-test");
    let config = root.join("foreign-settings.toml");
    let secret = "ghp_foreign_config_secret";
    fs::write(
        &config,
        format!("token = '{secret}'\nformatting = ' keep exact spacing '\n"),
    )
    .expect("write foreign config");
    let config_arg = config.to_string_lossy().into_owned();
    let preview = run(&root, &["integration", "plan", "codex", &config_arg]);
    assert!(preview.status.success());
    assert!(String::from_utf8_lossy(&preview.stdout).contains("preview only"));
    assert_eq!(
        fs::read_to_string(&config).expect("read foreign config"),
        format!("token = '{secret}'\nformatting = ' keep exact spacing '\n")
    );
    assert!(!root.join(".relay").exists());

    let missing_apply = run(&root, &["integration", "initialize", "codex"]);
    assert!(!missing_apply.status.success());
    assert!(!root.join(".relay").exists());

    let initialized = run(&root, &["integration", "initialize", "codex", "--apply"]);
    assert!(initialized.status.success());
    let state = run(&root, &["integration", "status", "codex"]);
    assert!(state.status.success());
    assert!(String::from_utf8_lossy(&state.stdout).contains("codex: unavailable"));
    let relay_bytes =
        fs::read(root.join(".relay/integrations/codex.state")).expect("read integration manifest");
    assert!(!String::from_utf8_lossy(&relay_bytes).contains(secret));
    assert_eq!(
        fs::read_to_string(&config).expect("re-read foreign config"),
        format!("token = '{secret}'\nformatting = ' keep exact spacing '\n")
    );
    let manifest_path = root.join(".relay/integrations/codex.state");
    let manifest = fs::read_to_string(&manifest_path).expect("read manifest");
    fs::write(
        &manifest_path,
        manifest.replace("state=unavailable", "state=ready"),
    )
    .expect("mark disposable adapter ready");
    let emitted = run(&root, &["integration", "emit", "codex"]);
    assert!(emitted.status.success());
    assert!(String::from_utf8_lossy(&emitted.stdout).contains("# Relay context"));
    assert!(!String::from_utf8_lossy(&emitted.stdout).contains(secret));
    assert!(run(&root, &["daemon", "stop"]).status.success());
    fs::remove_dir_all(root).expect("remove fixture");
}

#[test]
fn codex_hook_is_main_session_only_and_refuses_foreign_or_drifted_config() {
    let foreign_root = git_fixture("codex-hook-foreign-test");
    let foreign_hook = foreign_root.join(".codex/hooks.json");
    fs::create_dir_all(foreign_hook.parent().expect("hook parent")).expect("create hook parent");
    fs::write(&foreign_hook, "{\"token\":\"ghp_foreign_hook_secret\"}\n")
        .expect("write foreign hook");
    let foreign_plan = run(&foreign_root, &["integration", "codex", "plan"]);
    assert!(!foreign_plan.status.success());
    assert_eq!(
        fs::read_to_string(&foreign_hook).expect("read foreign hook"),
        "{\"token\":\"ghp_foreign_hook_secret\"}\n"
    );
    assert!(!foreign_root.join(".relay").exists());
    fs::remove_dir_all(foreign_root).expect("remove foreign fixture");

    let root = git_fixture("codex-hook-test");
    let plan = run(&root, &["integration", "codex", "plan"]);
    assert!(plan.status.success());
    assert!(!root.join(".codex").exists());
    let installed = run(&root, &["integration", "codex", "install", "--apply"]);
    assert!(installed.status.success());
    let hook = fs::read_to_string(root.join(".codex/hooks.json")).expect("read Relay hook");
    assert!(hook.contains("\"SessionStart\""));
    assert!(!hook.contains("SubagentStart"));
    assert!(hook.contains("\"additionalContextLimit\": 320"));
    assert!(
        String::from_utf8_lossy(&run(&root, &["integration", "status", "codex"]).stdout)
            .contains("codex: awaiting_trust")
    );
    let before_trust = run_with_input(
        &root,
        &["integration", "codex", "hook-output"],
        "{\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}",
    );
    assert!(before_trust.status.success());
    assert!(String::from_utf8_lossy(&before_trust.stdout).contains("awaiting_trust"));
    assert!(
        run(&root, &["integration", "codex", "trust", "--apply"])
            .status
            .success()
    );
    let emitted = run_with_input(
        &root,
        &["integration", "codex", "hook-output"],
        "{\"hook_event_name\":\"SessionStart\",\"source\":\"resume\"}",
    );
    assert!(emitted.status.success());
    assert!(String::from_utf8_lossy(&emitted.stdout).contains("# Relay context"));
    fs::write(root.join(".codex/hooks.json"), "{\"changed\":true}\n").expect("drift hook");
    assert!(
        String::from_utf8_lossy(&run(&root, &["integration", "status", "codex"]).stdout)
            .contains("codex: drifted")
    );
    assert!(
        !run(&root, &["integration", "codex", "uninstall", "--apply"])
            .status
            .success()
    );
    assert_eq!(
        fs::read_to_string(root.join(".codex/hooks.json")).expect("retain drifted hook"),
        "{\"changed\":true}\n"
    );
    assert!(run(&root, &["daemon", "stop"]).status.success());
    fs::remove_dir_all(root).expect("remove fixture");
}

#[test]
fn service_install_writes_only_an_explicit_user_template() {
    let root = git_fixture("service-template-test");
    let home = root.join("isolated-home");
    fs::create_dir_all(&home).expect("create isolated home");
    let preview = run_with_home(&root, &["integration", "service", "plan", "systemd"], &home);
    assert!(preview.status.success());
    assert!(!home.join(".config").exists());
    let installed = run_with_home(
        &root,
        &["integration", "service", "install", "systemd", "--apply"],
        &home,
    );
    assert!(installed.status.success());
    let service_dir = home.join(".config/systemd/user");
    let service = fs::read_dir(service_dir)
        .expect("read service dir")
        .flatten()
        .next()
        .expect("service artifact");
    let body = fs::read_to_string(service.path()).expect("read service template");
    assert!(body.contains("integration service run"));
    assert!(body.contains("Restart=on-failure"));
    assert!(!body.contains("ghp_"));
    let status = run_with_home(
        &root,
        &["integration", "service", "status", "systemd"],
        &home,
    );
    assert!(status.status.success());
    assert!(String::from_utf8_lossy(&status.stdout).contains("systemd: installed"));
    let removed = run_with_home(
        &root,
        &["integration", "service", "uninstall", "systemd", "--apply"],
        &home,
    );
    assert!(removed.status.success());
    assert!(!service.path().exists());
    fs::remove_dir_all(root).expect("remove fixture");
}

#[test]
fn service_runner_never_duplicates_an_active_daemon() {
    let root = git_fixture("service-duplicate-test");
    let started = run(&root, &["daemon", "start"]);
    assert!(started.status.success());
    let service = run(&root, &["integration", "service", "run"]);
    assert!(service.status.success());
    let status = run(&root, &["daemon", "status"]);
    assert!(status.status.success());
    assert!(String::from_utf8_lossy(&status.stdout).contains("active"));
    assert!(run(&root, &["daemon", "stop"]).status.success());
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

    assert!(
        Command::new("git")
            .args([
                "remote",
                "add",
                "origin",
                "https://user:ghp_fake_remote_secret@example.test/repo"
            ])
            .current_dir(&root)
            .status()
            .expect("add remote")
            .success()
    );
    assert!(
        Command::new("git")
            .args(["checkout", "-b", "private/ghp_fake_branch_secret"])
            .current_dir(&root)
            .status()
            .expect("checkout private branch")
            .success()
    );
    let mut private_branch_card = String::new();
    for _ in 0..24 {
        private_branch_card = String::from_utf8_lossy(&run(&root, &["resume"]).stdout).into_owned();
        if private_branch_card.contains("STATUS: FRESH") {
            break;
        }
        thread::sleep(Duration::from_millis(250));
    }
    assert!(private_branch_card.contains("STATUS: FRESH"));
    assert!(!private_branch_card.contains("ghp_fake_branch_secret"));

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
    let recovered = run(&root, &["record-check", "0", "deploy --token top-secret"]);
    assert!(recovered.status.success());
    assert!(String::from_utf8_lossy(&recovered.stdout).contains("STATUS: FRESH"));
    let output_secret = "eyJfake.jwt.output.secret";
    let output = run(
        &root,
        &["check", "printf 'eyJfake.jwt.output.secret' >&2; exit 1"],
    );
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains(output_secret));
    let note = run(&root, &["note", "operator-secret-should-never-persist"]);
    assert!(
        note.status.success(),
        "{}",
        String::from_utf8_lossy(&note.stderr)
    );
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
    assert!(!String::from_utf8_lossy(&malformed.stderr).contains("malformed-secret-payload"));
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
    let all_evidence =
        fs::read(root.join(".relay/evidence.sqlite")).expect("read privacy evidence");
    for secret in [
        b"top-secret".as_slice(),
        b"eyJfake.jwt.output.secret".as_slice(),
        b"ghp_fake_remote_secret".as_slice(),
        b"ghp_fake_branch_secret".as_slice(),
    ] {
        assert!(
            !all_evidence
                .windows(secret.len())
                .any(|bytes| bytes == secret),
            "secret-like metadata was persisted"
        );
    }
    let adapter = run(&root, &["adapter", "codex", "checkpoint"]);
    assert!(adapter.status.success());
    let database =
        Connection::open(root.join(".relay/evidence.sqlite")).expect("read typed adapter");
    let metadata_hash: String = database
        .query_row(
            "SELECT metadata_hash FROM adapter_metadata ORDER BY id DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .expect("read adapter hash");
    assert!(metadata_hash.starts_with("metadata#"));
    assert!(!metadata_hash.contains("checkpoint"));
    drop(database);
    let hook = run(&root, &["shell", "zsh"]);
    assert!(hook.status.success());
    let hook_text = String::from_utf8_lossy(&hook.stdout);
    assert!(hook_text.contains("record-check-stdin"));
    assert!(!hook_text.contains("$(fc -ln -1)"));

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

#[test]
fn nul_porcelain_preserves_space_paths_without_storing_source_content() {
    let root = git_fixture("space-path-test");
    assert!(run(&root, &["init"]).status.success());
    fs::write(root.join("work item.txt"), "private source body").expect("space path write");
    assert!(run(&root, &["observe"]).status.success());
    let database = Connection::open(root.join(".relay/evidence.sqlite")).expect("open evidence");
    let path: String = database
        .query_row(
            "SELECT path FROM event_paths ORDER BY id DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .expect("read safe path");
    assert_eq!(path, "work item.txt");
    let bytes = fs::read(root.join(".relay/evidence.sqlite")).expect("read evidence");
    assert!(!String::from_utf8_lossy(&bytes).contains("private source body"));
    fs::remove_dir_all(root).expect("remove fixture");
}

#[test]
fn daemon_restart_reconciles_work_queued_before_an_abrupt_exit() {
    let root = git_fixture("restart-queued-test");
    assert!(run(&root, &["init"]).status.success());
    assert!(run(&root, &["daemon", "start"]).status.success());
    fs::write(root.join("tracked.txt"), "queued before restart").expect("queue work");
    let pid = fs::read_to_string(root.join(".relay/daemon.pid"))
        .expect("read daemon pid")
        .lines()
        .next()
        .expect("daemon pid line")
        .to_owned();
    assert!(
        Command::new("kill")
            .args(["-TERM", &pid])
            .status()
            .expect("stop owned daemon")
            .success()
    );
    thread::sleep(Duration::from_millis(100));
    assert!(run(&root, &["daemon", "start"]).status.success());
    let mut recovered = false;
    for _ in 0..24 {
        let resume = run(&root, &["resume"]);
        let database =
            Connection::open(root.join(".relay/evidence.sqlite")).expect("open recovered evidence");
        let dirty_events: i64 = database
            .query_row(
                "SELECT COUNT(*) FROM events WHERE kind='dirty-set'",
                [],
                |row| row.get(0),
            )
            .expect("count recovered dirty events");
        if resume.status.success()
            && String::from_utf8_lossy(&resume.stdout).contains("STATUS: FRESH")
            && dirty_events == 1
        {
            recovered = true;
            break;
        }
        thread::sleep(Duration::from_millis(250));
    }
    assert!(recovered, "restart did not reconcile queued work");
    assert!(run(&root, &["daemon", "stop"]).status.success());
    fs::remove_dir_all(root).expect("remove fixture");
}

#[test]
fn a_live_writer_lock_rejects_a_second_process_without_writing_evidence() {
    let root = git_fixture("writer-lock-test");
    assert!(run(&root, &["init"]).status.success());
    let database = Connection::open(root.join(".relay/evidence.sqlite")).expect("open evidence");
    let before: i64 = database
        .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
        .expect("count baseline events");
    drop(database);
    fs::write(
        root.join(".relay/writer.lock"),
        std::process::id().to_string(),
    )
    .expect("write live lock");
    let second_writer = run(&root, &["observe"]);
    assert!(!second_writer.status.success());
    assert!(String::from_utf8_lossy(&second_writer.stderr).contains("writer is busy"));
    let database = Connection::open(root.join(".relay/evidence.sqlite")).expect("reopen evidence");
    let after: i64 = database
        .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
        .expect("count final events");
    assert_eq!(before, after);
    fs::remove_file(root.join(".relay/writer.lock")).expect("remove test lock");
    fs::remove_dir_all(root).expect("remove fixture");
}

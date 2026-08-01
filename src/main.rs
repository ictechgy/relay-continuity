use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::{env, fs, path::{Path, PathBuf}, process::Command, thread, time::Duration};

fn hash(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn relay_dir(root: &Path) -> PathBuf { root.join(".relay") }
fn db(root: &Path) -> rusqlite::Result<Connection> {
    let dir = relay_dir(root); fs::create_dir_all(&dir).expect("create .relay");
    let c = Connection::open(dir.join("evidence.sqlite"))?;
    c.execute_batch("PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, kind TEXT NOT NULL, snapshot TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checks(id INTEGER PRIMARY KEY, snapshot TEXT NOT NULL, command TEXT NOT NULL, exit_code INTEGER NOT NULL, ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS assertions(id INTEGER PRIMARY KEY, snapshot TEXT NOT NULL, claim TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('valid','stale','broken','unknown')), check_id INTEGER);" )?;
    Ok(c)
}
fn git(root: &Path, args: &[&str]) -> String { Command::new("git").args(args).current_dir(root).output().ok().and_then(|o| String::from_utf8(o.stdout).ok()).unwrap_or_default().trim().to_owned() }
fn dirty(root: &Path) -> String { git(root,&["status","--porcelain"]) }
fn snapshot(root: &Path) -> String { hash(format!("{}\n{}", git(root,&["rev-parse","HEAD"]), dirty(root)).as_bytes()) }
fn safe_command(command: &str) -> String {
    let first = command.split_whitespace().next().unwrap_or("unknown");
    format!("{}#{}", first, &hash(command.as_bytes())[..12])
}
fn safe_path(path: &str) -> String {
    let lower=path.to_ascii_lowercase();
    if lower.contains(".env") || lower.contains("token") || lower.contains("secret") || lower.contains("key") { "[redacted-path]".into() } else { path.into() }
}
fn observe(root: &Path, c: &Connection) -> rusqlite::Result<bool> {
 let s=snapshot(root); let last:String=c.query_row("SELECT snapshot FROM events ORDER BY id DESC LIMIT 1",[],|r|r.get(0)).unwrap_or_default();
 if last!=s { c.execute("INSERT INTO events(kind,snapshot,detail) VALUES('dirty-set',?1,?2)",params![s,hash(dirty(root).as_bytes())])?; return Ok(true) } Ok(false)
}
fn card(root: &Path, c: &Connection) -> rusqlite::Result<String> {
 let now=snapshot(root); let last:String=c.query_row("SELECT snapshot FROM events ORDER BY id DESC LIMIT 1",[],|r|r.get(0)).unwrap_or_default();
 let state=if last.is_empty(){"UNKNOWN"}else if last==now{"FRESH"}else{"STALE"};
 let broken:i64=c.query_row("SELECT COUNT(*) FROM checks WHERE exit_code != 0 AND snapshot = ?1",params![now],|r|r.get(0))?;
 let changed=dirty(root).lines().filter_map(|l|l.split_whitespace().last()).map(safe_path).take(12).collect::<Vec<_>>().join(", ");
 let text=format!("# Relay context\n\nSTATUS: {state}\nSnapshot: {now}\nBranch: {}\nChanged: {}\nChecks: {}\n\n{}\n",safe_path(&git(root,&["branch","--show-current"])),if changed.is_empty(){"none"}else{&changed},if broken>0{"BROKEN evidence exists"}else{"No broken recorded checks"},if state=="STALE"{"Prior assertions are not verified; re-run relevant checks."}else{"Evidence is snapshot-bound; intent remains unknown unless annotated."});
 fs::write(relay_dir(root).join("current.md"),&text).expect("write card"); Ok(text)
}
fn main() -> Result<(),Box<dyn std::error::Error>> {
 let mut a=env::args().skip(1); let cmd=a.next().unwrap_or_else(||"help".into()); let root=env::current_dir()?; let c=db(&root)?;
 match cmd.as_str(){
  "init"=>{let s=snapshot(&root);c.execute("INSERT INTO events(kind,snapshot,detail) VALUES('init',?1,'local-only')",params![s])?; fs::write(relay_dir(&root).join(".gitignore"),"evidence.sqlite*\ncurrent.md\n")?; println!("initialized {}",relay_dir(&root).display());}
  "observe"=>{observe(&root,&c)?; print!("{}",card(&root,&c)?);}
  "watch"=>{let seconds=a.next().and_then(|s|s.parse::<u64>().ok()).unwrap_or(60); let mut n=0; for _ in 0..seconds { if observe(&root,&c)? {n+=1}; thread::sleep(Duration::from_secs(1)); } println!("observed {n} coalesced snapshot changes"); print!("{}",card(&root,&c)?);}
  "status"|"resume"=>print!("{}",card(&root,&c)?),
  "check"=>{let command=a.collect::<Vec<_>>().join(" "); if command.is_empty(){return Err("usage: relay check <program> [args]".into())}; let code=Command::new("sh").arg("-c").arg(&command).current_dir(&root).status()?.code().unwrap_or(1); let s=snapshot(&root); let label=safe_command(&command); c.execute("INSERT INTO checks(snapshot,command,exit_code) VALUES(?1,?2,?3)",params![s,label,code])?; let id=c.last_insert_rowid(); c.execute("INSERT INTO assertions(snapshot,claim,status,check_id) VALUES(?1,?2,?3,?4)",params![s,"check",if code==0{"valid"}else{"broken"},id])?; c.execute("INSERT INTO events(kind,snapshot,detail) VALUES('check',?1,?2)",params![s,code.to_string()])?; print!("{}",card(&root,&c)?); if code!=0{std::process::exit(code)}}
  _=>println!("relay init | observe | watch [seconds] | status | resume | check <command>")
 }; Ok(())
}

#[cfg(test)] mod tests { use super::*; #[test] fn hash_is_stable(){assert_eq!(hash(b"x"),hash(b"x"));} #[test] fn secret_metadata_is_hidden(){assert_eq!(safe_path(".env.token"),"[redacted-path]"); assert!(!safe_command("curl --token abc").contains("abc"));} #[test] fn path_is_not_truncated(){assert_eq!(safe_path("src/main.rs"),"src/main.rs");} }

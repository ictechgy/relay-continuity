use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{Connection, ErrorCode, OpenFlags, OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::{
    env,
    fs::{self, OpenOptions},
    io::{Read, Write},
    ops::Deref,
    path::{Path, PathBuf},
    process::Command,
    sync::mpsc::{RecvTimeoutError, channel},
    thread,
    time::{Duration, Instant},
};
#[cfg(unix)]
use std::{
    ffi::CString,
    os::unix::{
        ffi::OsStrExt,
        io::{AsRawFd, FromRawFd},
    },
};

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn relay_dir(root: &Path) -> PathBuf {
    root.join(".relay")
}
fn integration_dir(root: &Path) -> PathBuf {
    relay_dir(root).join("integrations")
}
fn integration_manifest_path(root: &Path, provider: &str) -> PathBuf {
    integration_dir(root).join(format!("{provider}.state"))
}
fn integration_owned_path(root: &Path, provider: &str) -> PathBuf {
    integration_dir(root).join(format!("{provider}.owned"))
}
fn ensure_managed_directory(
    root: &Path,
    components: &[&str],
    create_missing: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let canonical_root = fs::canonicalize(root)?;
    let mut current = canonical_root.clone();
    for component in components {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(format!(
                    "Relay refuses a symlinked or non-directory managed path: {}",
                    current.display()
                )
                .into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && create_missing => {
                match fs::create_dir(&current) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error.into()),
                }
                let metadata = fs::symlink_metadata(&current)?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(format!(
                        "Relay refuses a symlinked or non-directory managed path: {}",
                        current.display()
                    )
                    .into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        }
        if !fs::canonicalize(&current)?.starts_with(&canonical_root) {
            return Err(format!(
                "Relay refuses a managed path outside the Git root: {}",
                current.display()
            )
            .into());
        }
    }
    Ok(())
}
fn ensure_relay_directory(
    root: &Path,
    create_missing: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    ensure_managed_directory(root, &[".relay"], create_missing)
}
fn ensure_integration_directory(
    root: &Path,
    create_missing: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    ensure_managed_directory(root, &[".relay", "integrations"], create_missing)
}
fn ensure_codex_directory(
    root: &Path,
    create_missing: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    ensure_managed_directory(root, &[".codex"], create_missing)
}
fn integration_provider_is_valid(provider: &str) -> bool {
    matches!(provider, "codex" | "claude" | "grok")
}
fn integration_marker(provider: &str, begin: bool) -> Vec<u8> {
    format!(
        "# relay-managed-{}:{provider}\n",
        if begin { "begin" } else { "end" }
    )
    .into_bytes()
}
fn find_all(haystack: &[u8], needle: &[u8]) -> Vec<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return Vec::new();
    }
    haystack
        .windows(needle.len())
        .enumerate()
        .filter_map(|(index, window)| (window == needle).then_some(index))
        .collect()
}
fn owned_block(provider: &str, body: &[u8]) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    if !integration_provider_is_valid(provider) {
        return Err("Relay rejected an unsupported integration provider".into());
    }
    if body
        .windows(b"relay-managed-".len())
        .any(|window| window == b"relay-managed-")
    {
        return Err("Relay rejected nested integration markers".into());
    }
    let mut block = integration_marker(provider, true);
    block.extend_from_slice(body);
    if !body.ends_with(b"\n") {
        block.push(b'\n');
    }
    block.extend_from_slice(&integration_marker(provider, false));
    Ok(block)
}
fn patch_owned_block(
    current: &[u8],
    provider: &str,
    body: &[u8],
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let begin = integration_marker(provider, true);
    let end = integration_marker(provider, false);
    let begins = find_all(current, &begin);
    let ends = find_all(current, &end);
    if begins.len() > 1 || ends.len() > 1 || begins.len() != ends.len() {
        return Err("Relay integration config drifted; no file was changed".into());
    }
    let block = owned_block(provider, body)?;
    if begins.is_empty() {
        let mut patched = current.to_vec();
        if !patched.is_empty() && !patched.ends_with(b"\n") {
            patched.push(b'\n');
        }
        patched.extend_from_slice(&block);
        return Ok(patched);
    }
    let start = begins[0];
    let finish = ends[0] + end.len();
    if finish <= start {
        return Err("Relay integration config drifted; no file was changed".into());
    }
    let mut patched = current[..start].to_vec();
    patched.extend_from_slice(&block);
    patched.extend_from_slice(&current[finish..]);
    Ok(patched)
}
fn atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
    let parent = path
        .parent()
        .ok_or("Relay integration config has no parent directory")?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Relay integration config has an unsafe file name")?;
    let temporary = parent.join(format!(
        ".{file_name}.relay-{}-{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    ));
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        if hash(&fs::read(path)?) != hash(bytes) {
            return Err("Relay could not verify atomic integration write".into());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
#[cfg(unix)]
fn managed_component(component: &str) -> Result<CString, Box<dyn std::error::Error>> {
    if component.is_empty() || component == "." || component == ".." || component.contains('/') {
        return Err("Relay rejected an unsafe managed path component".into());
    }
    Ok(CString::new(component)?)
}
#[cfg(unix)]
fn open_directory_no_follow(path: &Path) -> Result<fs::File, Box<dyn std::error::Error>> {
    let path = CString::new(path.as_os_str().as_bytes())?;
    let descriptor = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(unsafe { fs::File::from_raw_fd(descriptor) })
}
#[cfg(unix)]
fn open_directory_at_no_follow(
    parent: &fs::File,
    component: &CString,
) -> Result<fs::File, Box<dyn std::error::Error>> {
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            component.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(unsafe { fs::File::from_raw_fd(descriptor) })
}
#[cfg(unix)]
fn managed_directory_no_follow(
    root: &Path,
    components: &[&str],
    create_missing: bool,
) -> Result<fs::File, Box<dyn std::error::Error>> {
    let mut directory = open_directory_no_follow(root)?;
    for component in components {
        let component = managed_component(component)?;
        directory = match open_directory_at_no_follow(&directory, &component) {
            Ok(directory) => directory,
            Err(error)
                if create_missing
                    && error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
            {
                if unsafe { libc::mkdirat(directory.as_raw_fd(), component.as_ptr(), 0o700) } != 0
                    && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
                {
                    return Err(std::io::Error::last_os_error().into());
                }
                open_directory_at_no_follow(&directory, &component)?
            }
            Err(error) => return Err(error),
        };
    }
    Ok(directory)
}
#[cfg(unix)]
fn atomic_replace_at(
    parent: &fs::File,
    file_name: &str,
    bytes: &[u8],
) -> Result<(), Box<dyn std::error::Error>> {
    let name = managed_component(file_name)?;
    let temporary = CString::new(format!(
        ".{file_name}.relay-{}-{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    ))?;
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            temporary.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let mut file = unsafe { fs::File::from_raw_fd(descriptor) };
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if unsafe {
            libc::renameat(
                parent.as_raw_fd(),
                temporary.as_ptr(),
                parent.as_raw_fd(),
                name.as_ptr(),
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        let verify_descriptor = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if verify_descriptor < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut verified = Vec::new();
        unsafe { fs::File::from_raw_fd(verify_descriptor) }.read_to_end(&mut verified)?;
        if hash(&verified) != hash(bytes) {
            return Err("Relay could not verify atomic managed write".into());
        }
        Ok(())
    })();
    if result.is_err() {
        unsafe {
            libc::unlinkat(parent.as_raw_fd(), temporary.as_ptr(), 0);
        }
    }
    result
}
#[cfg(unix)]
fn read_file_at_no_follow(
    parent: &fs::File,
    file_name: &str,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let name = managed_component(file_name)?;
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let mut bytes = Vec::new();
    unsafe { fs::File::from_raw_fd(descriptor) }.read_to_end(&mut bytes)?;
    Ok(bytes)
}
#[cfg(unix)]
fn rename_file_at(
    parent: &fs::File,
    from: &str,
    to: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let from = managed_component(from)?;
    let to = managed_component(to)?;
    if unsafe {
        libc::renameat(
            parent.as_raw_fd(),
            from.as_ptr(),
            parent.as_raw_fd(),
            to.as_ptr(),
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}
fn atomic_replace_managed(
    root: &Path,
    components: &[&str],
    file_name: &str,
    bytes: &[u8],
) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(unix)]
    {
        let parent = managed_directory_no_follow(root, components, true)?;
        atomic_replace_at(&parent, file_name, bytes)
    }
    #[cfg(not(unix))]
    {
        let mut path = root.to_path_buf();
        for component in components {
            path.push(component);
        }
        fs::create_dir_all(&path)?;
        atomic_replace(&path.join(file_name), bytes)
    }
}
#[cfg(unix)]
fn read_managed_file(
    root: &Path,
    components: &[&str],
    file_name: &str,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let parent = managed_directory_no_follow(root, components, false)?;
    read_file_at_no_follow(&parent, file_name)
}
#[cfg(not(unix))]
fn read_managed_file(
    root: &Path,
    components: &[&str],
    file_name: &str,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut path = root.to_path_buf();
    for component in components {
        path.push(component);
    }
    Ok(fs::read(path.join(file_name))?)
}
fn is_not_found(error: &(dyn std::error::Error + 'static)) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}
#[cfg(unix)]
fn remove_managed_file(
    root: &Path,
    components: &[&str],
    file_name: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let parent = managed_directory_no_follow(root, components, false)?;
    let name = managed_component(file_name)?;
    if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}
#[cfg(not(unix))]
fn remove_managed_file(
    root: &Path,
    components: &[&str],
    file_name: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut path = root.to_path_buf();
    for component in components {
        path.push(component);
    }
    fs::remove_file(path.join(file_name))?;
    Ok(())
}
#[cfg(unix)]
fn create_new_managed_file(
    root: &Path,
    components: &[&str],
    file_name: &str,
) -> Result<fs::File, Box<dyn std::error::Error>> {
    let parent = managed_directory_no_follow(root, components, true)?;
    let name = managed_component(file_name)?;
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(unsafe { fs::File::from_raw_fd(descriptor) })
}
#[cfg(not(unix))]
fn create_new_managed_file(
    root: &Path,
    components: &[&str],
    file_name: &str,
) -> Result<fs::File, Box<dyn std::error::Error>> {
    let mut path = root.to_path_buf();
    for component in components {
        path.push(component);
    }
    fs::create_dir_all(&path)?;
    Ok(OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path.join(file_name))?)
}
fn integration_manifest_bytes(
    root: &Path,
    provider: &str,
    state: &str,
    config_bytes: &[u8],
    hook_bytes: Option<&[u8]>,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    if !integration_provider_is_valid(provider)
        || !matches!(
            state,
            "disabled" | "awaiting_trust" | "ready" | "unavailable" | "drifted" | "broken"
        )
    {
        return Err("Relay rejected malformed integration state".into());
    }
    let root_hash = hash(root.to_string_lossy().as_bytes());
    let mut manifest = format!(
        "version=1\nprovider={provider}\nstate={state}\nroot_hash={root_hash}\nconfig_hash={}\n",
        hash(config_bytes)
    );
    if let Some(hook_bytes) = hook_bytes {
        manifest.push_str(&format!("hook_hash={}\n", hash(hook_bytes)));
    }
    Ok(manifest.into_bytes())
}
fn write_integration_manifest(
    root: &Path,
    provider: &str,
    state: &str,
    config_bytes: &[u8],
) -> Result<(), Box<dyn std::error::Error>> {
    ensure_integration_directory(root, true)?;
    let manifest = integration_manifest_bytes(root, provider, state, config_bytes, None)?;
    atomic_replace_managed(
        root,
        &[".relay", "integrations"],
        &format!("{provider}.state"),
        &manifest,
    )
}
fn write_codex_manifest(
    root: &Path,
    state: &str,
    owned_bytes: &[u8],
    hook_bytes: &[u8],
) -> Result<(), Box<dyn std::error::Error>> {
    ensure_integration_directory(root, true)?;
    let manifest = integration_manifest_bytes(root, "codex", state, owned_bytes, Some(hook_bytes))?;
    atomic_replace_managed(root, &[".relay", "integrations"], "codex.state", &manifest)
}
fn codex_hook_matches_manifest(
    root: &Path,
    values: &std::collections::BTreeMap<String, String>,
) -> bool {
    if ensure_codex_directory(root, false).is_err() {
        return false;
    }
    let Some(expected) = values.get("hook_hash") else {
        return false;
    };
    read_managed_file(root, &[".codex"], "hooks.json")
        .map(|bytes| hash(&bytes) == *expected)
        .unwrap_or(false)
}
fn integration_state(root: &Path, provider: &str) -> Result<String, Box<dyn std::error::Error>> {
    if !integration_provider_is_valid(provider) {
        return Err("Relay rejected an unsupported integration provider".into());
    }
    ensure_integration_directory(root, false)?;
    let text = match read_managed_file(
        root,
        &[".relay", "integrations"],
        &format!("{provider}.state"),
    ) {
        Err(error) if is_not_found(error.as_ref()) => return Ok("disabled".into()),
        Err(_) => return Ok("broken".into()),
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(_) => return Ok("broken".into()),
        },
    };
    let values = text
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect::<std::collections::BTreeMap<_, _>>();
    if values.get("version").map(String::as_str) != Some("1")
        || values.get("provider").map(String::as_str) != Some(provider)
    {
        return Ok("broken".into());
    }
    match values.get("state").map(String::as_str) {
        Some(
            state
            @ ("disabled" | "awaiting_trust" | "ready" | "unavailable" | "drifted" | "broken"),
        ) => {
            if matches!(state, "drifted" | "broken") {
                return Ok(state.into());
            }
            let root_hash = hash(root.to_string_lossy().as_bytes());
            let Ok(owned) = read_managed_file(
                root,
                &[".relay", "integrations"],
                &format!("{provider}.owned"),
            ) else {
                return Ok("drifted".into());
            };
            let owned_values = String::from_utf8(owned.clone()).ok().map(|text| {
                text.lines()
                    .filter_map(|line| line.split_once('='))
                    .map(|(key, value)| (key.to_owned(), value.to_owned()))
                    .collect::<std::collections::BTreeMap<_, _>>()
            });
            let owned_matches = values.get("config_hash") == Some(&hash(&owned))
                && owned_values.as_ref().is_some_and(|owned_values| {
                    owned_values.get("version").map(String::as_str) == Some("1")
                        && owned_values.get("provider").map(String::as_str) == Some(provider)
                        && owned_values.get("state").map(String::as_str) == Some(state)
                });
            if values.get("root_hash") != Some(&root_hash) || !owned_matches {
                return Ok("drifted".into());
            }
            if provider == "codex"
                && matches!(state, "awaiting_trust" | "ready")
                && !codex_hook_matches_manifest(root, &values)
            {
                Ok("drifted".into())
            } else {
                Ok(state.into())
            }
        }
        _ => Ok("broken".into()),
    }
}
fn integration_manifest_values(
    root: &Path,
    provider: &str,
) -> Result<std::collections::BTreeMap<String, String>, Box<dyn std::error::Error>> {
    ensure_integration_directory(root, false)?;
    let text = String::from_utf8(read_managed_file(
        root,
        &[".relay", "integrations"],
        &format!("{provider}.state"),
    )?)?;
    Ok(text
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect())
}
fn bounded_context(text: &str, limit: usize) -> String {
    let words = text.split_whitespace().take(limit).collect::<Vec<_>>();
    if text.split_whitespace().count() > limit {
        format!("{}\n[Relay context truncated]", words.join(" "))
    } else {
        words.join(" ")
    }
}
fn integration_emit(root: &Path, provider: &str) -> Result<(), Box<dyn std::error::Error>> {
    let state = integration_state(root, provider)?;
    if state != "ready" {
        println!("Relay unavailable: {provider} integration {state}");
        return Ok(());
    }
    let Ok(manifest) = integration_manifest_values(root, provider) else {
        println!("Relay unavailable: {provider} integration unavailable");
        return Ok(());
    };
    let root_hash = hash(root.to_string_lossy().as_bytes());
    let Ok(owned) = read_managed_file(
        root,
        &[".relay", "integrations"],
        &format!("{provider}.owned"),
    ) else {
        println!("Relay unavailable: {provider} integration unavailable");
        return Ok(());
    };
    if manifest.get("root_hash") != Some(&root_hash)
        || manifest.get("config_hash") != Some(&hash(&owned))
    {
        println!("Relay unavailable: {provider} integration drifted");
        return Ok(());
    }
    if !daemon_active(root) {
        println!("Relay unavailable: {provider} local evidence unavailable");
        return Ok(());
    }
    let Ok(c) = db(root) else {
        println!("Relay unavailable: {provider} local evidence unavailable");
        return Ok(());
    };
    let Ok(context) = card(root, &c) else {
        println!("Relay unavailable: {provider} local evidence unavailable");
        return Ok(());
    };
    print!("{}", bounded_context(&context, 320));
    Ok(())
}
fn json_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            character if character.is_control() => {
                escaped.push_str(&format!("\\u{:04x}", character as u32));
            }
            character => escaped.push(character),
        }
    }
    escaped
}
fn codex_hook_config(_root: &Path) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let executable = env::current_exe()?.to_string_lossy().into_owned();
    let command = format!("{} integration codex hook-output", shell_quote(&executable));
    Ok(format!(
        "{{\n  \"description\": \"Relay-owned bounded continuity context for this repository.\",\n  \"hooks\": {{\n    \"SessionStart\": [{{\n      \"matcher\": \"^(startup|resume)$\",\n      \"hooks\": [{{\n        \"type\": \"command\",\n        \"command\": \"{}\",\n        \"statusMessage\": \"Loading Relay continuity context\",\n        \"timeout\": 5,\n        \"additionalContextLimit\": 320\n      }}]\n    }}]\n  }}\n}}\n",
        json_escape(&command)
    )
    .into_bytes())
}
fn codex_owned_state(state: &str, hook_bytes: &[u8]) -> Vec<u8> {
    format!(
        "version=1\nprovider=codex\nstate={state}\nhook_hash={}\n",
        hash(hook_bytes)
    )
    .into_bytes()
}
fn codex_hook_preflight(root: &Path) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    ensure_codex_directory(root, false)?;
    let desired = codex_hook_config(root)?;
    match read_managed_file(root, &[".codex"], "hooks.json") {
        Err(error) if is_not_found(error.as_ref()) => Ok(desired),
        Err(error) => Err(error),
        Ok(current) if current == desired => Ok(desired),
        Ok(_) => Err(
            "Relay refuses to overwrite an existing Codex hooks.json; no file was changed".into(),
        ),
    }
}
fn codex_manifest_matches_or_is_missing(
    root: &Path,
    state: &str,
    owned: &[u8],
    hook: &[u8],
) -> Result<bool, Box<dyn std::error::Error>> {
    let expected = integration_manifest_bytes(root, "codex", state, owned, Some(hook))?;
    match read_managed_file(root, &[".relay", "integrations"], "codex.state") {
        Err(error) if is_not_found(error.as_ref()) => Ok(true),
        Err(error) => Err(error),
        // Current Relay writes complete manifests atomically. Only an exact
        // prior manifest is trustworthy; a missing file is handled as a
        // narrowly-scoped legacy recovery case by its callers.
        Ok(current) => Ok(expected == current),
    }
}
fn codex_owned_state_name(root: &Path, hook: &[u8]) -> Option<&'static str> {
    let owned = read_managed_file(root, &[".relay", "integrations"], "codex.owned").ok()?;
    if owned == codex_owned_state("awaiting_trust", hook) {
        Some("awaiting_trust")
    } else if owned == codex_owned_state("ready", hook) {
        Some("ready")
    } else {
        None
    }
}
fn codex_owned_provenance(root: &Path, hook: &[u8]) -> bool {
    let Ok(values) = integration_manifest_values(root, "codex") else {
        return false;
    };
    let Some(state) = values.get("state") else {
        return false;
    };
    if !matches!(state.as_str(), "awaiting_trust" | "ready")
        || integration_state(root, "codex").ok().as_deref() != Some(state)
        || !codex_hook_matches_manifest(root, &values)
    {
        return false;
    }
    read_managed_file(root, &[".relay", "integrations"], "codex.owned")
        .map(|owned| owned == codex_owned_state(state, hook))
        .unwrap_or(false)
}
fn codex_install(root: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let hook = codex_hook_config(root)?;
    ensure_codex_directory(root, false)?;
    ensure_integration_directory(root, false)?;
    let integration_existed = integration_dir(root).is_dir();
    match read_managed_file(root, &[".codex"], "hooks.json") {
        Err(error) if is_not_found(error.as_ref()) => {
            ensure_codex_directory(root, true)?;
            ensure_integration_directory(root, true)?;
            let owned = codex_owned_state("awaiting_trust", &hook);
            // Writing ownership first means a failed hook write leaves no
            // live hook behind. A retry simply drives the same state forward.
            atomic_replace_managed(root, &[".relay", "integrations"], "codex.owned", &owned)?;
            atomic_replace_managed(root, &[".codex"], "hooks.json", &hook)?;
            write_codex_manifest(root, "awaiting_trust", &owned, &hook)
        }
        Err(error) => Err(error),
        Ok(current) if current == hook && codex_owned_provenance(root, &hook) => Ok(()),
        Ok(current)
            if current == hook
                && integration_existed
                && fs::symlink_metadata(integration_owned_path(root, "codex"))
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                && fs::symlink_metadata(integration_manifest_path(root, "codex"))
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            // Legacy recovery for the former hook-first install order. The
            // integration directory must predate this invocation, so a user
            // cannot turn an orphaned hook into adopted state by recreating
            // only the hook after Relay ownership was removed.
            let owned = codex_owned_state("awaiting_trust", &hook);
            atomic_replace_managed(root, &[".relay", "integrations"], "codex.owned", &owned)?;
            write_codex_manifest(root, "awaiting_trust", &owned, &hook)
        }
        Ok(current)
            if current == hook
                && codex_owned_state_name(root, &hook) == Some("awaiting_trust")
                && codex_manifest_matches_or_is_missing(
                    root,
                    "awaiting_trust",
                    &codex_owned_state("awaiting_trust", &hook),
                    &hook,
                )? =>
        {
            let owned = codex_owned_state("awaiting_trust", &hook);
            write_codex_manifest(root, "awaiting_trust", &owned, &hook)
        }
        Ok(_) => Err(
            "Relay refuses to adopt or overwrite an existing Codex hooks.json; no file was changed"
                .into(),
        ),
    }
}
fn codex_mark_trusted(root: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let hook = codex_hook_preflight(root)?;
    ensure_integration_directory(root, false)?;
    let awaiting = codex_owned_state("awaiting_trust", &hook);
    let ready = codex_owned_state("ready", &hook);
    match codex_owned_state_name(root, &hook) {
        Some("ready")
            if codex_manifest_matches_or_is_missing(root, "awaiting_trust", &awaiting, &hook)?
                || codex_manifest_matches_or_is_missing(root, "ready", &ready, &hook)? =>
        {
            // The owned state was committed before a crash. Complete the
            // corresponding manifest rather than strand an exact Relay hook.
            write_codex_manifest(root, "ready", &ready, &hook)
        }
        Some("awaiting_trust") => {
            let values = integration_manifest_values(root, "codex")?;
            let manifest_is_ready =
                integration_manifest_bytes(root, "codex", "ready", &ready, Some(&hook)).is_ok_and(
                    |expected| {
                        read_managed_file(root, &[".relay", "integrations"], "codex.state").ok()
                            == Some(expected)
                    },
                );
            if manifest_is_ready {
                return atomic_replace_managed(
                    root,
                    &[".relay", "integrations"],
                    "codex.owned",
                    &ready,
                );
            }
            if integration_state(root, "codex")? != "awaiting_trust"
                || !codex_hook_matches_manifest(root, &values)
                || !codex_owned_provenance(root, &hook)
            {
                return Err(
                    "Relay Codex integration is not an unchanged awaiting-trust installation"
                        .into(),
                );
            }
            // Publish the complete manifest first. A retry can safely finish
            // the owned-state write if the process stops between these writes.
            write_codex_manifest(root, "ready", &ready, &hook)?;
            atomic_replace_managed(root, &[".relay", "integrations"], "codex.owned", &ready)
        }
        _ => Err("Relay Codex integration is not an unchanged awaiting-trust installation".into()),
    }
}
fn codex_uninstall(root: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let hook = codex_hook_preflight(root)?;
    if !codex_owned_provenance(root, &hook) {
        return Err("Relay Codex hook ownership is unproven; no file was removed".into());
    }
    remove_managed_file(root, &[".codex"], "hooks.json")?;
    let owned = codex_owned_state("disabled", &hook);
    atomic_replace_managed(root, &[".relay", "integrations"], "codex.owned", &owned)?;
    write_integration_manifest(root, "codex", "disabled", &owned)
}
fn codex_hook_output(root: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let mut input = Vec::new();
    std::io::stdin().take(4097).read_to_end(&mut input)?;
    let compact = String::from_utf8(input)?
        .chars()
        .filter(|character| !character.is_ascii_whitespace())
        .collect::<String>();
    if compact.len() > 4096
        || !compact.contains("\"hook_event_name\":\"SessionStart\"")
        || !(compact.contains("\"source\":\"startup\"")
            || compact.contains("\"source\":\"resume\""))
        || compact.contains("\"agent_id\":")
        || compact.contains("\"agent_type\":")
    {
        println!("Relay unavailable: codex hook payload rejected");
        return Ok(());
    }
    integration_emit(root, "codex")
}
fn service_kind_is_valid(kind: &str) -> bool {
    matches!(kind, "launchd" | "systemd")
}
fn service_id(root: &Path) -> String {
    format!("relay-{}", &hash(root.to_string_lossy().as_bytes())[..12])
}
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn systemd_quote(value: &str) -> String {
    format!(
        r#""{}""#,
        value.replace(char::from(92), r"\\").replace('"', r#"\""#)
    )
}
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
fn service_template(root: &Path, kind: &str) -> Result<String, Box<dyn std::error::Error>> {
    if !service_kind_is_valid(kind) {
        return Err("Relay rejected an unsupported service manager".into());
    }
    let executable = env::current_exe()?.to_string_lossy().into_owned();
    let working_directory = root.to_string_lossy();
    let label = service_id(root);
    Ok(match kind {
        "launchd" => format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>{}</string>\n<key>ProgramArguments</key><array><string>{}</string><string>integration</string><string>service</string><string>run</string></array>\n<key>WorkingDirectory</key><string>{}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n</dict></plist>\n",
            xml_escape(&label),
            xml_escape(&executable),
            xml_escape(&working_directory)
        ),
        "systemd" => format!(
            "[Unit]\nDescription=Relay local evidence daemon ({label})\n\n[Service]\nType=simple\nWorkingDirectory={}\nExecStart={} integration service run\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n",
            systemd_quote(&working_directory),
            systemd_quote(&executable)
        ),
        _ => unreachable!(),
    })
}
fn service_user_path(root: &Path, kind: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let home = env::var_os("HOME").ok_or("Relay requires HOME for user service installation")?;
    let id = service_id(root);
    Ok(match kind {
        "launchd" => PathBuf::from(home)
            .join("Library/LaunchAgents")
            .join(format!("{id}.plist")),
        "systemd" => env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(home).join(".config"))
            .join("systemd/user")
            .join(format!("{id}.service")),
        _ => return Err("Relay rejected an unsupported service manager".into()),
    })
}
fn install_service_template(root: &Path, kind: &str) -> Result<(), Box<dyn std::error::Error>> {
    let destination = service_user_path(root, kind)?;
    match service_template_state(root, kind)? {
        "installed" => return Ok(()),
        "drifted" => return Err("Relay service template drifted; no file was changed".into()),
        "not-installed" => {}
        _ => unreachable!(),
    }
    fs::create_dir_all(
        destination
            .parent()
            .ok_or("Relay service path has no parent")?,
    )?;
    atomic_replace(&destination, service_template(root, kind)?.as_bytes())
}
fn service_template_state(
    root: &Path,
    kind: &str,
) -> Result<&'static str, Box<dyn std::error::Error>> {
    let destination = service_user_path(root, kind)?;
    match fs::read(&destination) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok("not-installed"),
        Err(error) => Err(error.into()),
        Ok(current) if current == service_template(root, kind)?.as_bytes() => Ok("installed"),
        Ok(_) => Ok("drifted"),
    }
}
fn uninstall_service_template(root: &Path, kind: &str) -> Result<(), Box<dyn std::error::Error>> {
    let destination = service_user_path(root, kind)?;
    match service_template_state(root, kind)? {
        "not-installed" => Ok(()),
        "installed" => {
            fs::remove_file(destination)?;
            Ok(())
        }
        "drifted" => Err("Relay service template drifted; no file was removed".into()),
        _ => unreachable!(),
    }
}
fn service_run(root: &Path) -> Result<(), Box<dyn std::error::Error>> {
    if daemon_active(root) {
        return Ok(());
    }
    let c = db(root)?;
    let _ = remove_managed_file(root, &[".relay"], "daemon.pid");
    let _ = remove_managed_file(root, &[".relay"], "daemon.ready");
    let _ = remove_managed_file(root, &[".relay"], "daemon.stop");
    let nonce = format!(
        "service-{}",
        &hash(format!("{}:{}", root.display(), std::process::id()).as_bytes())[..16]
    );
    let mut pid_file = create_new_managed_file(root, &[".relay"], "daemon.pid")?;
    write!(pid_file, "{}\n{}", std::process::id(), nonce)?;
    pid_file.sync_all()?;
    run_daemon(root, &c, &nonce)
}
fn integration_command(
    root: &Path,
    mut args: impl Iterator<Item = String>,
) -> Result<(), Box<dyn std::error::Error>> {
    match args.next().as_deref() {
        Some("codex") => match args.next().as_deref() {
            Some("plan") if args.next().is_none() => {
                let hook = codex_hook_preflight(root)?;
                println!(
                    "codex: preview only; .codex/hooks.json#{}; no files changed",
                    &hash(&hook)[..12]
                );
                Ok(())
            }
            Some("install") => {
                if args.next().as_deref() != Some("--apply") || args.next().is_some() {
                    return Err("usage: relay integration codex install --apply".into());
                }
                codex_install(root)?;
                println!("codex: project hook installed as awaiting_trust; review and trust it with /hooks, then run `relay integration codex trust --apply`");
                Ok(())
            }
            Some("trust") => {
                if args.next().as_deref() != Some("--apply") || args.next().is_some() {
                    return Err("usage: relay integration codex trust --apply".into());
                }
                codex_mark_trusted(root)?;
                println!("codex: Relay marked ready after explicit user trust acknowledgement");
                Ok(())
            }
            Some("uninstall") => {
                if args.next().as_deref() != Some("--apply") || args.next().is_some() {
                    return Err("usage: relay integration codex uninstall --apply".into());
                }
                codex_uninstall(root)?;
                println!("codex: Relay-owned project hook removed");
                Ok(())
            }
            Some("hook-output") => {
                if args.next().is_some() {
                    return Err("usage: relay integration codex hook-output".into());
                }
                codex_hook_output(root)
            }
            _ => Err(
                "usage: relay integration codex <plan|install --apply|trust --apply|uninstall --apply|hook-output>"
                    .into(),
            ),
        },
        Some("status") => {
            let providers = match args.next() {
                Some(provider) => vec![provider],
                None => vec!["codex".into(), "claude".into(), "grok".into()],
            };
            if args.next().is_some() {
                return Err("usage: relay integration status [codex|claude|grok]".into());
            }
            for provider in providers {
                println!("{provider}: {}", integration_state(root, &provider)?);
            }
            Ok(())
        }
        Some("plan") => {
            let provider = args
                .next()
                .ok_or("usage: relay integration plan <codex|claude|grok> <config-path>")?;
            let config = args
                .next()
                .ok_or("usage: relay integration plan <codex|claude|grok> <config-path>")?;
            if args.next().is_some() || !integration_provider_is_valid(&provider) {
                return Err(
                    "usage: relay integration plan <codex|claude|grok> <config-path>".into(),
                );
            }
            let current = fs::read(config)?;
            let patched = patch_owned_block(&current, &provider, b"# capability-probe-required\n")?;
            println!(
                "{provider}: preview only; config#{} -> config#{}; no files changed",
                &hash(&current)[..12],
                &hash(&patched)[..12]
            );
            Ok(())
        }
        Some("initialize") => {
            let provider = args
                .next()
                .ok_or("usage: relay integration initialize <codex|claude|grok> --apply")?;
            let apply = args.next();
            if apply.as_deref() != Some("--apply")
                || args.next().is_some()
                || !integration_provider_is_valid(&provider)
            {
                return Err(
                    "usage: relay integration initialize <codex|claude|grok> --apply".into(),
                );
            }
            if provider == "codex" {
                return Err("use `relay integration codex install --apply` for the Codex trust gate".into());
            }
            ensure_integration_directory(root, true)?;
            let owned = format!(
                "version=1\nprovider={provider}\nstate=unavailable\nreason=capability-probe-required\n"
            );
            atomic_replace_managed(
                root,
                &[".relay", "integrations"],
                &format!("{provider}.owned"),
                owned.as_bytes(),
            )?;
            write_integration_manifest(root, &provider, "unavailable", owned.as_bytes())?;
            println!("{provider}: Relay-owned integration state initialized; capability probe required");
            Ok(())
        }
        Some("emit") => {
            let provider = args
                .next()
                .ok_or("usage: relay integration emit <codex|claude|grok>")?;
            if args.next().is_some() || !integration_provider_is_valid(&provider) {
                return Err("usage: relay integration emit <codex|claude|grok>".into());
            }
            integration_emit(root, &provider)
        }
        Some("service") => match args.next().as_deref() {
            Some("plan") => {
                let kind = args
                    .next()
                    .ok_or("usage: relay integration service plan <launchd|systemd>")?;
                if args.next().is_some() {
                    return Err("usage: relay integration service plan <launchd|systemd>".into());
                }
                print!("{}", service_template(root, &kind)?);
                Ok(())
            }
            Some("install") => {
                let kind = args
                    .next()
                    .ok_or("usage: relay integration service install <launchd|systemd> --apply")?;
                if args.next().as_deref() != Some("--apply") || args.next().is_some() {
                    return Err(
                        "usage: relay integration service install <launchd|systemd> --apply".into(),
                    );
                }
                install_service_template(root, &kind)?;
                println!("{kind}: user service template installed; enable it explicitly with your service manager");
                Ok(())
            }
            Some("status") => {
                let kind = args
                    .next()
                    .ok_or("usage: relay integration service status <launchd|systemd>")?;
                if args.next().is_some() {
                    return Err(
                        "usage: relay integration service status <launchd|systemd>".into(),
                    );
                }
                println!("{kind}: {}", service_template_state(root, &kind)?);
                Ok(())
            }
            Some("uninstall") => {
                let kind = args
                    .next()
                    .ok_or("usage: relay integration service uninstall <launchd|systemd> --apply")?;
                if args.next().as_deref() != Some("--apply") || args.next().is_some() {
                    return Err(
                        "usage: relay integration service uninstall <launchd|systemd> --apply"
                            .into(),
                    );
                }
                uninstall_service_template(root, &kind)?;
                println!("{kind}: Relay user service template removed; disable it in your service manager if it is still loaded");
                Ok(())
            }
            Some("run") if args.next().is_none() => service_run(root),
            _ => Err(
                "usage: relay integration service <plan <manager>|install <manager> --apply|status <manager>|uninstall <manager> --apply|run>"
                    .into(),
            ),
        },
        _ => Err(
            "usage: relay integration <codex ...|status [provider]|plan <provider> <config-path>|initialize <provider> --apply|emit <provider>|service ...>"
                .into(),
        ),
    }
}
struct WriterLock(PathBuf);
impl Drop for WriterLock {
    fn drop(&mut self) {
        let _ = remove_managed_file(&self.0, &[".relay"], "writer.lock");
    }
}
fn writer_lock(root: &Path) -> Result<WriterLock, Box<dyn std::error::Error>> {
    ensure_relay_directory(root, true)?;
    for attempt in 0..=10 {
        match create_new_managed_file(root, &[".relay"], "writer.lock") {
            Ok(mut file) => {
                write!(file, "{}", std::process::id())?;
                file.sync_all()?;
                return Ok(WriterLock(root.to_path_buf()));
            }
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::AlreadyExists) =>
            {
                let owner = read_managed_file(root, &[".relay"], "writer.lock")
                    .ok()
                    .and_then(|text| String::from_utf8(text).ok())
                    .and_then(|text| text.trim().parse::<u32>().ok());
                if owner.is_none_or(|pid| !process_active(pid)) {
                    let _ = remove_managed_file(root, &[".relay"], "writer.lock");
                    continue;
                }
                if attempt == 10 {
                    return Err("Relay writer is busy; retry without modifying evidence".into());
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => return Err(error),
        }
    }
    Err("Relay writer is busy; retry without modifying evidence".into())
}
fn writer_busy(error: &dyn std::error::Error) -> bool {
    error.to_string() == "Relay writer is busy; retry without modifying evidence"
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
fn git_root(root: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    ensure_git(root)?;
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(root)
        .output()?;
    if !output.status.success() {
        return Err("Relay requires a Git worktree; no evidence was written".into());
    }
    Ok(fs::canonicalize(String::from_utf8(output.stdout)?.trim())?)
}
fn create_schema(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch(
        "PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, kind TEXT NOT NULL, snapshot TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event_paths(id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, path TEXT NOT NULL, path_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checks(id INTEGER PRIMARY KEY, snapshot TEXT NOT NULL, command TEXT NOT NULL, exit_code INTEGER NOT NULL, ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS assertions(id INTEGER PRIMARY KEY, snapshot TEXT NOT NULL, claim TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('valid','stale','broken','unknown')), check_id INTEGER);
      CREATE TABLE IF NOT EXISTS epochs(id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, event_count INTEGER NOT NULL, check_count INTEGER NOT NULL, summary_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS annotations(id INTEGER PRIMARY KEY, snapshot TEXT NOT NULL, text TEXT NOT NULL, ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS adapter_metadata(id INTEGER PRIMARY KEY, provider TEXT NOT NULL, snapshot TEXT NOT NULL, metadata_hash TEXT NOT NULL, ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE INDEX IF NOT EXISTS checks_snapshot_id ON checks(snapshot, id DESC);
      CREATE INDEX IF NOT EXISTS assertions_snapshot_id ON assertions(snapshot, id DESC);
      CREATE INDEX IF NOT EXISTS annotations_snapshot_id ON annotations(snapshot, id DESC);",
    )
}
fn corrupt_database(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(inner, _)
            if matches!(inner.code, ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
    )
}
struct Database {
    connection: Connection,
    #[cfg(unix)]
    _directory: fs::File,
}
impl Deref for Database {
    type Target = Connection;

    fn deref(&self) -> &Self::Target {
        &self.connection
    }
}
fn database_path(root: &Path) -> PathBuf {
    relay_dir(root).join("evidence.sqlite")
}
#[cfg(unix)]
fn open_database(path: &Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
}
#[cfg(not(unix))]
fn open_database(path: &Path) -> rusqlite::Result<Connection> {
    Connection::open(path)
}
#[cfg(unix)]
fn quarantine_database(directory: &fs::File) -> Result<(), Box<dyn std::error::Error>> {
    let suffix = format!(
        "corrupt-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    );
    rename_file_at(
        directory,
        "evidence.sqlite",
        &format!("evidence.sqlite.{suffix}"),
    )?;
    for sidecar in ["-wal", "-shm"] {
        match rename_file_at(
            directory,
            &format!("evidence.sqlite{sidecar}"),
            &format!("evidence.sqlite.{suffix}{sidecar}"),
        ) {
            Ok(()) => {}
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
#[cfg(not(unix))]
fn quarantine_database(dir: &Path, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let suffix = format!(
        "corrupt-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    );
    fs::rename(path, dir.join(format!("evidence.sqlite.{suffix}")))?;
    for sidecar in ["-wal", "-shm"] {
        let sidecar_path = dir.join(format!("evidence.sqlite{sidecar}"));
        if sidecar_path.exists() {
            fs::rename(
                &sidecar_path,
                dir.join(format!("evidence.sqlite.{suffix}{sidecar}")),
            )?;
        }
    }
    Ok(())
}
#[cfg(unix)]
fn recovered_db(root: &Path, directory: fs::File) -> Result<Database, Box<dyn std::error::Error>> {
    quarantine_database(&directory)?;
    let c = open_database(&database_path(root))?;
    create_schema(&c)?;
    c.execute(
        "INSERT INTO events(kind,snapshot,detail) VALUES('recovered',?1,'privacy-safe-recovery')",
        params![snapshot(root)?],
    )?;
    Ok(Database {
        connection: c,
        _directory: directory,
    })
}
#[cfg(not(unix))]
fn recovered_db(
    root: &Path,
    dir: &Path,
    path: &Path,
) -> Result<Database, Box<dyn std::error::Error>> {
    quarantine_database(dir, path)?;
    let c = open_database(path)?;
    create_schema(&c)?;
    c.execute(
        "INSERT INTO events(kind,snapshot,detail) VALUES('recovered',?1,'privacy-safe-recovery')",
        params![snapshot(root)?],
    )?;
    Ok(Database { connection: c })
}
#[cfg(unix)]
fn db(root: &Path) -> Result<Database, Box<dyn std::error::Error>> {
    let root = fs::canonicalize(root)?;
    let root = root.as_path();
    let directory = managed_directory_no_follow(root, &[".relay"], true)?;
    if read_file_at_no_follow(&directory, "evidence.sqlite")
        .ok()
        .is_some_and(|bytes| !bytes.is_empty() && !bytes.starts_with(b"SQLite format 3\0"))
    {
        return recovered_db(root, directory);
    }
    let c = open_database(&database_path(root))?;
    match create_schema(&c) {
        Ok(()) => Ok(Database {
            connection: c,
            _directory: directory,
        }),
        Err(error) if corrupt_database(&error) => {
            drop(c);
            recovered_db(root, directory)
        }
        Err(error) => Err(error.into()),
    }
}
#[cfg(not(unix))]
fn db(root: &Path) -> Result<Database, Box<dyn std::error::Error>> {
    ensure_relay_directory(root, true)?;
    let dir = relay_dir(root);
    let path = dir.join("evidence.sqlite");
    if fs::read(&path)
        .ok()
        .is_some_and(|bytes| !bytes.is_empty() && !bytes.starts_with(b"SQLite format 3\0"))
    {
        return recovered_db(root, &dir, &path);
    }
    let c = open_database(&path)?;
    match create_schema(&c) {
        Ok(()) => Ok(Database { connection: c }),
        Err(error) if corrupt_database(&error) => {
            drop(c);
            recovered_db(root, &dir, &path)
        }
        Err(error) => Err(error.into()),
    }
}
fn git_bytes(root: &Path, args: &[&str]) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let output = Command::new("git").args(args).current_dir(root).output()?;
    if !output.status.success() {
        return Err("Git state is unavailable; no Relay evidence was written".into());
    }
    Ok(output.stdout)
}
fn git(root: &Path, args: &[&str]) -> Result<String, Box<dyn std::error::Error>> {
    Ok(String::from_utf8(git_bytes(root, args)?)?.trim().to_owned())
}
struct DirtyEntry {
    code: String,
    path: String,
    path_hash: String,
}
fn dirty_entries(root: &Path) -> Result<Vec<DirtyEntry>, Box<dyn std::error::Error>> {
    let output = git_bytes(root, &["status", "--porcelain=v1", "-z"])?;
    let fields = output.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut index = 0;
    let mut entries = Vec::new();
    while index < fields.len() {
        let field = fields[index];
        index += 1;
        if field.is_empty() {
            continue;
        }
        if field.len() < 4 || field[2] != b' ' {
            return Err("Git status metadata is malformed; no Relay evidence was written".into());
        }
        let code = std::str::from_utf8(&field[..2])?.to_owned();
        let raw_path = &field[3..];
        // In porcelain -z rename/copy records carry the original path in the
        // following field. Consume it but never persist either raw path.
        if matches!(field[0], b'R' | b'C') && index < fields.len() {
            index += 1;
        }
        let path = match std::str::from_utf8(raw_path) {
            Ok(path) if !ignored(root, path) => safe_path(path),
            Ok(_) => continue,
            Err(_) => "[redacted-non-utf8-path]".to_owned(),
        };
        entries.push(DirtyEntry {
            code,
            path,
            path_hash: hash(raw_path),
        });
    }
    Ok(entries)
}
fn dirty(root: &Path) -> Result<String, Box<dyn std::error::Error>> {
    Ok(dirty_entries(root)?
        .iter()
        .map(|entry| format!("{} {}", entry.code, entry.path_hash))
        .collect::<Vec<_>>()
        .join("\n"))
}
fn dirty_paths(root: &Path) -> Result<Vec<(String, String)>, Box<dyn std::error::Error>> {
    Ok(dirty_entries(root)?
        .into_iter()
        .map(|entry| (entry.path, entry.path_hash))
        .collect())
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
        .optional()?
        .unwrap_or_default();
    if last.0 != s {
        c.execute(
            "INSERT INTO events(kind,snapshot,detail) VALUES(?1,?2,?3)",
            params![event_kind(&last.1, &detail), s, detail],
        )?;
        let event_id = c.last_insert_rowid();
        for (path, path_hash) in dirty_paths(root)? {
            c.execute(
                "INSERT INTO event_paths(event_id,path,path_hash) VALUES(?1,?2,?3)",
                params![event_id, path, path_hash],
            )?;
        }
        return Ok(true);
    }
    Ok(false)
}
fn read_pid(root: &Path) -> Option<u32> {
    String::from_utf8(read_managed_file(root, &[".relay"], "daemon.pid").ok()?)
        .ok()?
        .lines()
        .next()?
        .parse()
        .ok()
}
fn read_nonce(root: &Path) -> Option<String> {
    String::from_utf8(read_managed_file(root, &[".relay"], "daemon.pid").ok()?)
        .ok()?
        .lines()
        .nth(1)
        .map(str::to_owned)
}
fn process_active(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}
fn daemon_active(root: &Path) -> bool {
    let (Some(pid), Some(nonce)) = (read_pid(root), read_nonce(root)) else {
        return false;
    };
    process_active(pid)
        && read_managed_file(root, &[".relay"], "daemon.ready")
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .as_deref()
            == Some(nonce.as_str())
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
    let _ = remove_managed_file(root, &[".relay"], "daemon.pid");
    let _ = remove_managed_file(root, &[".relay"], "daemon.ready");
    let _ = remove_managed_file(root, &[".relay"], "daemon.stop");
    let nonce = hash(
        format!(
            "{}:{:?}",
            root.display(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?
        )
        .as_bytes(),
    )[..16]
        .to_owned();
    let mut pid_file = create_new_managed_file(root, &[".relay"], "daemon.pid")?;
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
            let _ = remove_managed_file(root, &[".relay"], "daemon.pid");
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
    let _ = atomic_replace_managed(root, &[".relay"], "daemon.stop", nonce.as_bytes());
    let _ = remove_managed_file(root, &[".relay"], "daemon.pid");
    let _ = remove_managed_file(root, &[".relay"], "daemon.ready");
    Err("Relay daemon did not become ready".into())
}
fn stop_daemon(root: &Path) -> Result<(), Box<dyn std::error::Error>> {
    if read_pid(root).is_none() {
        return Err("Relay daemon is not running".into());
    }
    if !daemon_active(root) {
        let _ = remove_managed_file(root, &[".relay"], "daemon.pid");
        let _ = remove_managed_file(root, &[".relay"], "daemon.ready");
        return Err("Relay daemon state was stale; no process was stopped".into());
    }
    let nonce = read_nonce(root).ok_or("Relay daemon nonce is unavailable")?;
    atomic_replace_managed(root, &[".relay"], "daemon.stop", nonce.as_bytes())?;
    for _ in 0..75 {
        if !daemon_active(root) {
            let _ = remove_managed_file(root, &[".relay"], "daemon.pid");
            let _ = remove_managed_file(root, &[".relay"], "daemon.ready");
            let _ = remove_managed_file(root, &[".relay"], "daemon.stop");
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
    atomic_replace_managed(root, &[".relay"], "daemon.ready", nonce.as_bytes())?;
    if let Err(error) = observe(root, c)
        && !writer_busy(error.as_ref())
    {
        return Err(error);
    }
    let mut last_reconcile = Instant::now();
    let mut pending: Option<Instant> = None;
    loop {
        if read_managed_file(root, &[".relay"], "daemon.stop")
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .as_deref()
            == Some(nonce)
        {
            let _ = remove_managed_file(root, &[".relay"], "daemon.ready");
            let _ = remove_managed_file(root, &[".relay"], "daemon.stop");
            return Ok(());
        }
        let timeout = pending
            .map(|changed| Duration::from_millis(750).saturating_sub(changed.elapsed()))
            // Stop-file writes are watched, so a 500 ms fallback preserves
            // the stop acknowledgement budget without needless wakeups.
            .unwrap_or(Duration::from_millis(500));
        match rx.recv_timeout(timeout) {
            Ok(Ok(event)) if event_is_relevant(root, &event) => pending = Some(Instant::now()),
            // Relay's own ignored writes can keep the watcher busy. Preserve
            // the periodic Git reconciliation even when they arrive faster
            // than the receive timeout.
            Ok(Ok(_)) | Ok(Err(_))
                if pending.is_none() && last_reconcile.elapsed() >= Duration::from_secs(1) =>
            {
                if let Err(error) = observe(root, c)
                    && !writer_busy(error.as_ref())
                {
                    return Err(error);
                }
                last_reconcile = Instant::now();
            }
            Ok(Ok(_)) | Ok(Err(_)) => {}
            Err(RecvTimeoutError::Timeout) if pending.take().is_some() => {
                if let Err(error) = observe(root, c)
                    && !writer_busy(error.as_ref())
                {
                    return Err(error);
                }
                last_reconcile = Instant::now();
            }
            Err(RecvTimeoutError::Timeout) => {
                // Filesystem events are the fast path. Reconcile only once
                // every second when a platform coalesces or drops one.
                if last_reconcile.elapsed() >= Duration::from_secs(1) {
                    if let Err(error) = observe(root, c)
                        && !writer_busy(error.as_ref())
                    {
                        return Err(error);
                    }
                    last_reconcile = Instant::now();
                }
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
            "function _relay_capture() { local status=$?; fc -ln -1 | relay record-check-stdin \"$status\" >/dev/null 2>&1; }\nprecmd_functions+=(_relay_capture)\n",
        ),
        "bash" => Ok(
            "_relay_capture() { local status=$?; history 1 | relay record-check-stdin \"$status\" >/dev/null 2>&1; }\nPROMPT_COMMAND='_relay_capture'${PROMPT_COMMAND:+\"; $PROMPT_COMMAND\"}\n",
        ),
        "fish" => Ok(
            "function _relay_capture --on-event fish_postexec\n  string join ' ' $argv | relay record-check-stdin $status >/dev/null 2>&1\nend\n",
        ),
        _ => Err("usage: relay shell <zsh|bash|fish>".into()),
    }
}
fn adapter_type_is_valid(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}
fn record_adapter(
    root: &Path,
    c: &Connection,
    provider: &str,
    metadata_type: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if !matches!(provider, "codex" | "claude" | "grok") || !adapter_type_is_valid(metadata_type) {
        return Err("Relay rejected malformed or unsupported adapter metadata".into());
    }
    let _lock = writer_lock(root)?;
    c.execute(
        "INSERT INTO adapter_metadata(provider,snapshot,metadata_hash) VALUES(?1,?2,?3)",
        params![
            provider,
            snapshot(root)?,
            format!("metadata#{}", &hash(metadata_type.as_bytes())[..12])
        ],
    )?;
    Ok(())
}
fn card(root: &Path, c: &Connection) -> Result<String, Box<dyn std::error::Error>> {
    let now = snapshot(root)?;
    let last: String = c
        .query_row(
            "SELECT snapshot FROM events ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or_default();
    let mut state = if last.is_empty() {
        "UNKNOWN"
    } else if last == now {
        "FRESH"
    } else {
        "STALE"
    };
    let latest_check: Option<i32> = c
        .query_row(
            "SELECT exit_code FROM checks WHERE snapshot = ?1 ORDER BY id DESC LIMIT 1",
            params![now],
            |r| r.get(0),
        )
        .optional()?;
    let broken = latest_check.is_some_and(|exit_code| exit_code != 0);
    let prior: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM assertions WHERE snapshot < ?1) OR EXISTS(SELECT 1 FROM assertions WHERE snapshot > ?1)",
        params![now],
        |r| r.get::<_, i64>(0).map(|value| value != 0),
    )?;
    let current_assertions: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM assertions WHERE snapshot = ?1)",
        params![now],
        |r| r.get::<_, i64>(0).map(|value| value != 0),
    )?;
    if broken {
        state = "BROKEN";
    } else if state == "FRESH" && prior && !current_assertions {
        state = "STALE";
    }
    let note: String = c
        .query_row(
            "SELECT text FROM annotations WHERE snapshot=?1 ORDER BY id DESC LIMIT 1",
            params![now],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or_else(|| "unknown".into());
    let changed = dirty_entries(root)?
        .into_iter()
        .map(|entry| entry.path)
        .take(12)
        .collect::<Vec<_>>()
        .join(", ");
    let text = format!(
        "# Relay context\n\nSTATUS: {state}\nCapture: {}\nSnapshot: {now}\nBranch: {}\nChanged: {}\nChecks: {}\nSemantic context: unknown (no vendor adapter required)\nNote (unverified): {note}\n\n{}\n",
        daemon_state(root),
        safe_path(&git(root, &["branch", "--show-current"])?),
        if changed.is_empty() { "none" } else { &changed },
        if broken {
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
    atomic_replace_managed(root, &[".relay"], "current.md", text.as_bytes())?;
    Ok(text)
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut a = env::args().skip(1);
    let cmd = a.next().unwrap_or_else(|| "help".into());
    if cmd == "help" {
        println!(
            "relay init | integration <codex <plan|install --apply|trust --apply|uninstall --apply>|status [provider]|plan <provider> <config-path>|initialize <provider> --apply|emit <provider>|service ...> | observe | watch [seconds] | daemon <start|stop|status> | shell <zsh|bash|fish> | compact | explain | note <text> | status | resume | check <command>"
        );
        return Ok(());
    }
    let root = git_root(&env::current_dir()?)?;
    if cmd == "integration" {
        return integration_command(&root, a);
    }
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
            atomic_replace_managed(
                &root,
                &[".relay"],
                ".gitignore",
                b"evidence.sqlite*\ncurrent.md\ndaemon.pid\ndaemon.ready\ndaemon.stop\nwriter.lock\n",
            )?;
            let exclude = root.join(".git/info/exclude");
            let existing = fs::read_to_string(&exclude).unwrap_or_default();
            if !existing.lines().any(|line| line == ".relay/") {
                atomic_replace(&exclude, format!("{existing}\n.relay/\n").as_bytes())?;
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
            let metadata_type = a.collect::<Vec<_>>().join(" ");
            if provider.is_empty() || metadata_type.is_empty() {
                return Err("usage: relay adapter <provider> <metadata>".into());
            }
            record_adapter(&root, &c, &provider, &metadata_type)?;
            println!("accepted typed adapter metadata");
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
        "explain" => println!("{}", explain_epochs(&c)?),
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
        "record-check-stdin" => {
            let code = a
                .next()
                .ok_or("usage: relay record-check-stdin <exit-code>")?
                .parse::<i32>()?;
            let mut command = String::new();
            std::io::stdin().read_to_string(&mut command)?;
            if command.trim().is_empty() {
                return Err("usage: relay record-check-stdin <exit-code>".into());
            }
            print!("{}", record_check(&root, &c, code, &command)?);
        }
        _ => println!(
            "relay init | integration <codex <plan|install --apply|trust --apply|uninstall --apply>|status [provider]|plan <provider> <config-path>|initialize <provider> --apply|emit <provider>|service ...> | observe | watch [seconds] | daemon <start|stop|status> | shell <zsh|bash|fish> | adapter <provider> <metadata> | compact | explain | note <text> | status | resume | check <command>"
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
    fn owned_config_patch_preserves_foreign_secret_bytes_without_backup() {
        let foreign = b"api_key = 'ghp_foreign_config_secret'\nformat = 'keep exact spacing'\n";
        let patched = patch_owned_block(foreign, "codex", b"enabled = true\n").unwrap();
        assert!(patched.starts_with(foreign));
        assert_eq!(
            patched
                .windows(b"ghp_foreign_config_secret".len())
                .filter(|bytes| *bytes == b"ghp_foreign_config_secret")
                .count(),
            1
        );
        let replaced = patch_owned_block(&patched, "codex", b"enabled = false\n").unwrap();
        assert!(replaced.starts_with(foreign));
        assert!(replaced.ends_with(b"# relay-managed-end:codex\n"));
        assert!(
            !replaced
                .windows(b"enabled = true".len())
                .any(|bytes| bytes == b"enabled = true")
        );
        assert_eq!(
            replaced
                .windows(b"ghp_foreign_config_secret".len())
                .filter(|bytes| *bytes == b"ghp_foreign_config_secret")
                .count(),
            1
        );
    }
    #[test]
    fn malformed_owned_markers_fail_without_a_patch() {
        let malformed = b"# relay-managed-begin:codex\nforeign = 1\n";
        assert!(patch_owned_block(malformed, "codex", b"enabled = true\n").is_err());
        let duplicated = b"# relay-managed-begin:codex\n# relay-managed-end:codex\n# relay-managed-begin:codex\n# relay-managed-end:codex\n";
        assert!(patch_owned_block(duplicated, "codex", b"enabled = true\n").is_err());
    }
    #[test]
    fn integration_manifest_and_atomic_write_retain_only_hashes() {
        let root = env::temp_dir().join(format!(
            "relay-integration-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let config = root.join("settings.toml");
        atomic_replace(&config, b"foreign_token = 'sk-foreign-secret'\n").unwrap();
        fs::create_dir_all(integration_dir(&root)).unwrap();
        let owned = b"version=1\nprovider=claude\nstate=awaiting_trust\n";
        atomic_replace(&integration_owned_path(&root, "claude"), owned).unwrap();
        write_integration_manifest(&root, "claude", "awaiting_trust", owned).unwrap();
        let manifest = fs::read_to_string(integration_manifest_path(&root, "claude")).unwrap();
        assert_eq!(
            integration_state(&root, "claude").unwrap(),
            "awaiting_trust"
        );
        assert!(!manifest.contains("sk-foreign-secret"));
        assert!(manifest.contains("config_hash="));
        assert_eq!(
            fs::read_dir(&root)
                .unwrap()
                .flatten()
                .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp"))
                .count(),
            0
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn managed_descriptor_write_stays_in_the_opened_directory_after_path_swap() {
        use std::os::unix::fs::symlink;

        let root = env::temp_dir().join(format!(
            "relay-descriptor-write-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let outside = env::temp_dir().join(format!(
            "relay-descriptor-write-outside-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(relay_dir(&root)).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let directory = managed_directory_no_follow(&root, &[".relay"], false).unwrap();
        let original = root.join(".relay-opened");
        fs::rename(relay_dir(&root), &original).unwrap();
        symlink(&outside, relay_dir(&root)).unwrap();

        atomic_replace_at(&directory, "sentinel", b"anchored").unwrap();

        assert_eq!(fs::read(original.join("sentinel")).unwrap(), b"anchored");
        assert!(!outside.join("sentinel").exists());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn database_refuses_a_symlinked_evidence_file() {
        use std::os::unix::fs::symlink;

        let root = env::temp_dir().join(format!(
            "relay-database-symlink-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let outside = env::temp_dir().join(format!(
            "relay-database-symlink-outside-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(relay_dir(&root)).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let target = outside.join("evidence.sqlite");
        fs::write(&target, "PRECIOUS").unwrap();
        symlink(&target, relay_dir(&root).join("evidence.sqlite")).unwrap();

        assert!(db(&root).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "PRECIOUS");
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn database_refuses_a_directory_symlink_after_managed_directory_open() {
        use std::os::unix::fs::symlink;

        let root = env::temp_dir().join(format!(
            "relay-database-directory-symlink-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let outside = env::temp_dir().join(format!(
            "relay-database-directory-symlink-outside-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(relay_dir(&root)).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let directory = managed_directory_no_follow(&root, &[".relay"], false).unwrap();
        let original = root.join(".relay-opened");
        fs::rename(relay_dir(&root), &original).unwrap();
        symlink(&outside, relay_dir(&root)).unwrap();

        assert!(open_database(&database_path(&root)).is_err());
        assert!(!outside.join("evidence.sqlite").exists());
        drop(directory);
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
    #[test]
    fn service_templates_are_root_scoped_and_escape_worktree_paths() {
        let root = Path::new("/tmp/relay & <worktree>");
        let launchd = service_template(root, "launchd").unwrap();
        let systemd = service_template(root, "systemd").unwrap();
        assert!(launchd.contains("relay-"));
        assert!(launchd.contains("relay &amp; &lt;worktree&gt;"));
        assert!(launchd.contains("integration</string><string>service</string><string>run"));
        assert!(launchd.contains("<key>SuccessfulExit</key><false/>"));
        assert!(systemd.contains("WorkingDirectory=\"/tmp/relay & <worktree>\""));
        assert!(systemd.contains("Restart=on-failure"));
        assert!(service_template(root, "unsupported").is_err());
    }
    #[test]
    fn hook_command_shell_quoting_rejects_expansion_syntax() {
        let quoted = shell_quote("/tmp/relay $HOME `uname` $(whoami) ' spaced\\path");
        assert_eq!(
            quoted,
            "'/tmp/relay $HOME `uname` $(whoami) '\"'\"' spaced\\path'"
        );
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
        assert!(relay_dir(&root).join("writer.lock").exists());
        drop(first);
        assert!(writer_lock(&root).is_ok());
        fs::write(relay_dir(&root).join("writer.lock"), "999999999").unwrap();
        assert!(
            writer_lock(&root).is_ok(),
            "dead lock owner must be reclaimed"
        );
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
        let first = card(&root, &c).unwrap();
        let second = card(&root, &c).unwrap();
        assert!(first.contains("STATUS: STALE"));
        assert_eq!(first, second);
        assert!(first.split_whitespace().count() <= 800);
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
        fs::write(relay_dir(&root).join("evidence.sqlite-wal"), "stale wal").unwrap();
        fs::write(relay_dir(&root).join("evidence.sqlite-shm"), "stale shm").unwrap();
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
        assert!(
            fs::read_dir(relay_dir(&root))
                .unwrap()
                .flatten()
                .any(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("evidence.sqlite.corrupt-")
                        && entry.file_name().to_string_lossy().ends_with("-wal")
                })
        );
        assert!(
            fs::read_dir(relay_dir(&root))
                .unwrap()
                .flatten()
                .any(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("evidence.sqlite.corrupt-")
                        && entry.file_name().to_string_lossy().ends_with("-shm")
                })
        );
        fs::remove_dir_all(root).unwrap();
    }
}

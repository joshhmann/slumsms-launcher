//! Launcher self-update for a single exe. The Tauri updater plugin finds, downloads and verifies the
//! signed build (minisign, bound to its version); this module puts it in place:
//!
//! 1. the verified bytes are staged as `.slumsms-launcher-update/stage-VERSION/<exe name>`;
//! 2. the running exe is renamed into `rollback/` (Windows allows renaming a running exe, not
//!    overwriting it) and the staged exe is moved to the original path;
//! 3. the new exe starts with `--self-updated=VERSION` and writes `healthy-VERSION` once its page
//!    has loaded. The old process waits for that marker (its window hidden); if the new build exits
//!    or stays silent, the old one kills it, moves its own exe back and carries on, skipping that
//!    version for the session. Nothing else in the folder is touched.

use crate::error::{Error, Result};
use crate::manifest::compare_versions;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

pub const UPDATE_DIRECTORY: &str = ".slumsms-launcher-update";

pub fn update_dir(exe: &Path) -> PathBuf {
    exe.parent().unwrap_or(Path::new(".")).join(UPDATE_DIRECTORY)
}

/// The new launcher writes this after its first successful start so the old one keeps the update.
/// Same name as the Electron launcher's marker, so the Electron hand-over waits on it too.
pub fn healthy_marker(exe: &Path, version: &str) -> PathBuf {
    update_dir(exe).join(format!("healthy-{version}"))
}

/// Ok(()) when `remote` should be installed over `current`; otherwise the reason it is not.
pub fn update_decision(remote: &str, current: &str, skip_version: Option<&str>) -> std::result::Result<(), String> {
    match compare_versions(remote, current) {
        Err(_) => Err(format!("version {remote} or {current} is not MAJOR.MINOR.PATCH")),
        Ok(std::cmp::Ordering::Less) => Err(format!("channel {remote} is older than {current}; never downgrading")),
        Ok(std::cmp::Ordering::Equal) => Err(format!("already on {current}")),
        Ok(_) if skip_version == Some(remote) => Err(format!("{remote} failed to start this session")),
        Ok(_) => Ok(()),
    }
}

/// A Windows executable starts with "MZ"; refuse anything else before it replaces the launcher.
pub fn looks_like_exe(bytes: &[u8]) -> bool {
    if cfg!(windows) {
        bytes.len() > 1024 && bytes.starts_with(b"MZ")
    } else {
        bytes.len() > 2
    }
}

/// Write the verified build next to the launcher (same volume, so the swap is a rename).
pub fn stage(exe: &Path, version: &str, bytes: &[u8]) -> Result<PathBuf> {
    let dir = update_dir(exe).join(format!("stage-{version}"));
    std::fs::create_dir_all(&dir).map_err(|e| Error::io(e, dir.display()))?;
    let target = dir.join(exe.file_name().unwrap_or_default());
    std::fs::write(&target, bytes).map_err(|e| Error::io(e, target.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
    }
    Ok(target)
}

/// The previous exe, kept until the next update so a bad build can be undone by hand too.
pub struct Rollback {
    pub exe: PathBuf,
    pub backup: PathBuf,
}

/// Swap the staged exe in. On any failure the original exe is back in place.
pub fn swap_in(exe: &Path, staged: &Path, from_version: &str) -> Result<Rollback> {
    if !staged.is_file() {
        return Err(Error::new(format!("The staged launcher is missing: {}", staged.display())));
    }
    let rollback_dir = update_dir(exe).join("rollback");
    std::fs::create_dir_all(&rollback_dir).map_err(|e| Error::io(e, rollback_dir.display()))?;
    let backup = rollback_dir.join(format!("{}.{from_version}", exe.file_name().unwrap_or_default().to_string_lossy()));
    let _ = std::fs::remove_file(&backup);
    std::fs::rename(exe, &backup).map_err(|e| Error::io(e, format!("moving the running launcher aside ({})", exe.display())))?;
    if let Err(error) = std::fs::rename(staged, exe) {
        let _ = std::fs::rename(&backup, exe);
        return Err(Error::io(error, format!("putting the new launcher in place ({})", exe.display())));
    }
    Ok(Rollback { exe: exe.to_path_buf(), backup })
}

impl Rollback {
    /// Put the previous exe back (the failed build is kept beside it for whoever reads the log).
    pub fn restore(&self, failed_version: &str) -> Result<()> {
        let failed = self.backup.with_file_name(format!("failed-{failed_version}-{}", self.exe.file_name().unwrap_or_default().to_string_lossy()));
        let _ = std::fs::remove_file(&failed);
        // The failed exe may still be closing; retry for a few seconds (antivirus, exiting process).
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match std::fs::rename(&self.exe, &failed) {
                Ok(()) => break,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                Err(e) if Instant::now() > deadline => return Err(Error::io(e, "moving the failed launcher aside")),
                Err(_) => std::thread::sleep(Duration::from_millis(200)),
            }
        }
        std::fs::rename(&self.backup, &self.exe).map_err(|e| Error::io(e, "restoring the previous launcher"))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The new build reported healthy; this process should exit now.
    Healthy,
    /// The new build failed; the previous exe is back and this process carries on.
    RolledBack(String),
}

/// Start the swapped-in exe and wait for its health marker; roll back if it never comes.
pub fn start_and_confirm(rollback: &Rollback, version: &str, args: &[String], timeout: Duration) -> Outcome {
    let marker = healthy_marker(&rollback.exe, version);
    let _ = std::fs::remove_file(&marker);
    let mut command = Command::new(&rollback.exe);
    command.args(args).arg(format!("--self-updated={version}"));
    let reason = match command.spawn() {
        Err(e) => format!("the new launcher did not start: {e}"),
        Ok(mut child) => match wait_for(&marker, &mut child, timeout) {
            Ok(()) => return Outcome::Healthy,
            Err(reason) => {
                let _ = child.kill();
                let _ = child.wait();
                reason
            }
        },
    };
    match rollback.restore(version) {
        Ok(()) => Outcome::RolledBack(reason),
        Err(e) => Outcome::RolledBack(format!("{reason}; restoring the previous launcher also failed: {e}")),
    }
}

fn wait_for(marker: &Path, child: &mut Child, timeout: Duration) -> std::result::Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if marker.exists() {
            return Ok(());
        }
        if let Ok(Some(status)) = child.try_wait() {
            // It may have written the marker just before exiting normally.
            if marker.exists() {
                return Ok(());
            }
            return Err(format!("the new launcher exited before it was ready ({status})"));
        }
        if Instant::now() > deadline {
            return Err("the new launcher did not report ready in time".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Remove finished stages and old markers. The newest rollback copy is kept until the next update.
pub fn cleanup(exe: &Path, current_version: &str) -> Vec<String> {
    let dir = update_dir(exe);
    let mut notes = Vec::new();
    let Ok(list) = std::fs::read_dir(&dir) else { return notes };
    for entry in list.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let remove = if let Some(v) = name.strip_prefix("stage-") {
            compare_versions(v, current_version).map(|o| o.is_le()).unwrap_or(true)
        } else {
            name.starts_with("healthy-") || name.starts_with("started-") || name == "swap-helper.mjs" || name == "swap-job.json"
        };
        if remove {
            let path = entry.path();
            let _ = if path.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
        }
    }
    if let Ok(list) = std::fs::read_dir(dir.join("rollback")) {
        for entry in list.flatten() {
            if entry.file_name().to_string_lossy().starts_with("failed-") {
                notes.push(format!("A launcher update failed and was rolled back: {}", entry.path().display()));
            }
        }
    }
    notes
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn launcher(dir: &Path, body: &str) -> PathBuf {
        let exe = dir.join("SlumsMS Launcher");
        std::fs::write(&exe, format!("#!/bin/sh\n{body}\n")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        exe
    }

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("slums-selfupdate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn decisions_never_downgrade_and_skip_a_failed_version() {
        assert!(update_decision("1.5.1", "1.5.0", None).is_ok());
        assert!(update_decision("1.10.0", "1.9.0", None).is_ok());
        assert!(update_decision("1.5.0", "1.5.0", None).unwrap_err().contains("already"));
        assert!(update_decision("1.4.9", "1.5.0", None).unwrap_err().contains("never downgrading"));
        assert!(update_decision("1.5.1", "1.5.0", Some("1.5.1")).unwrap_err().contains("failed"));
        assert!(update_decision("1.5", "1.5.0", None).is_err());
    }

    #[test]
    fn a_healthy_new_build_stays_and_the_old_one_is_kept_for_rollback() {
        let dir = scratch();
        let exe = launcher(&dir, "echo old");
        // The new build writes its marker (derived from its own path) like the real launcher does.
        let new_body = format!("mkdir -p '{}'; touch '{}'", update_dir(&exe).display(), healthy_marker(&exe, "1.5.1").display());
        let staged = stage(&exe, "1.5.1", format!("#!/bin/sh\n{new_body}\n").as_bytes()).unwrap();
        let rollback = swap_in(&exe, &staged, "1.5.0").unwrap();
        assert!(std::fs::read_to_string(&exe).unwrap().contains("touch"));
        assert_eq!(start_and_confirm(&rollback, "1.5.1", &[], Duration::from_secs(10)), Outcome::Healthy);
        assert!(std::fs::read_to_string(update_dir(&exe).join("rollback/SlumsMS Launcher.1.5.0")).unwrap().contains("echo old"));
        cleanup(&exe, "1.5.1");
        assert!(!update_dir(&exe).join("stage-1.5.1").exists());
        assert!(!healthy_marker(&exe, "1.5.1").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_build_that_exits_or_hangs_before_ready_is_rolled_back() {
        for (body, timeout) in [("exit 3", 10), ("sleep 30", 1)] {
            let dir = scratch();
            let exe = launcher(&dir, "echo old");
            let staged = stage(&exe, "1.5.1", format!("#!/bin/sh\n{body}\n").as_bytes()).unwrap();
            let rollback = swap_in(&exe, &staged, "1.5.0").unwrap();
            match start_and_confirm(&rollback, "1.5.1", &[], Duration::from_secs(timeout)) {
                Outcome::RolledBack(reason) => assert!(reason.contains("exited") || reason.contains("in time"), "{reason}"),
                other => panic!("{other:?}"),
            }
            assert!(std::fs::read_to_string(&exe).unwrap().contains("echo old"), "the previous launcher is back");
            assert!(!cleanup(&exe, "1.5.0").is_empty(), "the failure is reported");
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn a_failed_swap_leaves_the_launcher_in_place() {
        let dir = scratch();
        let exe = launcher(&dir, "echo old");
        assert!(swap_in(&exe, &dir.join("nope"), "1.5.0").is_err());
        assert!(std::fs::read_to_string(&exe).unwrap().contains("echo old"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}

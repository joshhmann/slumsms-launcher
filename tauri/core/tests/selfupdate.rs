//! Self-update swap with real processes on the current OS. On Windows this is the part that
//! matters: the running launcher's exe is renamed (not overwritten) while it runs.

use slums_core::selfupdate::{healthy_marker, stage, start_and_confirm, swap_in, update_dir, Outcome};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::Duration;

const FAKE: &str = env!("CARGO_BIN_EXE_fake-launcher");

fn scratch(label: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("selfupdate-{label}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A "running launcher": a copy of the fake under the launcher's name, idling.
fn running_launcher(dir: &Path) -> (PathBuf, Child) {
    let exe = dir.join(if cfg!(windows) { "SlumsMS Launcher.exe" } else { "SlumsMS Launcher" });
    std::fs::copy(FAKE, &exe).unwrap();
    let child = Command::new(&exe).spawn().unwrap();
    std::thread::sleep(Duration::from_millis(300));
    (exe, child)
}

fn new_build() -> Vec<u8> {
    let mut bytes = std::fs::read(FAKE).unwrap();
    // Same program, different bytes, so the swap is visible.
    bytes.extend_from_slice(b"\0new build");
    bytes
}

#[test]
fn the_running_exe_is_renamed_aside_and_a_healthy_build_takes_its_place() {
    let dir = scratch("healthy");
    let (exe, mut old) = running_launcher(&dir);
    let original = std::fs::read(&exe).unwrap();
    let staged = stage(&exe, "1.5.1", &new_build()).unwrap();
    let rollback = swap_in(&exe, &staged, "1.5.0").expect("a running exe can be renamed");
    assert!(std::fs::read(&exe).unwrap().ends_with(b"new build"));
    assert_eq!(start_and_confirm(&rollback, "1.5.1", &["--fake-mode=healthy".into()], Duration::from_secs(20)), Outcome::Healthy);
    assert!(healthy_marker(&exe, "1.5.1").exists());
    assert_eq!(std::fs::read(&rollback.backup).unwrap(), original, "the previous build is kept for rollback");
    old.kill().unwrap();
    old.wait().unwrap();
}

#[test]
fn a_build_that_fails_to_start_is_replaced_by_the_running_one_again() {
    for mode in ["exit", "hang"] {
        let dir = scratch(mode);
        let (exe, mut old) = running_launcher(&dir);
        let original = std::fs::read(&exe).unwrap();
        let staged = stage(&exe, "1.5.1", &new_build()).unwrap();
        let rollback = swap_in(&exe, &staged, "1.5.0").unwrap();
        let outcome = start_and_confirm(&rollback, "1.5.1", &[format!("--fake-mode={mode}")], Duration::from_secs(3));
        assert!(matches!(outcome, Outcome::RolledBack(_)), "{mode}: {outcome:?}");
        assert_eq!(std::fs::read(&exe).unwrap(), original, "{mode}: the running launcher's exe is back in place");
        assert!(std::fs::read_dir(update_dir(&exe).join("rollback")).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("failed-1.5.1")));
        old.kill().unwrap();
        old.wait().unwrap();
    }
}

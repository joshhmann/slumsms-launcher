//! The Play gate (port of version-status.mjs playPlan/reuseVerified) and how Play starts the game.

use crate::release::{Available, InstalledRecord};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayPlan {
    /// The check failed (offline, 401/403, bad answer): start the installed client and say
    /// "Couldn't check for updates"; the game server refuses a client that is really too old.
    Offline,
    /// The server offers a release this folder has not verified as: update, then start.
    Update,
    /// The folder says it is this release: fast-verify (or reuse a recent verify), then start.
    Verify,
}

/// Decided right before launching from a fresh look at the top-level manifest and installed.json.
pub fn play_plan(offered: &Available, record: Option<&InstalledRecord>) -> PlayPlan {
    let Some(sha) = offered.manifest_sha256() else { return PlayPlan::Offline };
    match record {
        Some(r) if !r.manifest_sha256.is_empty() && r.manifest_sha256 == sha => PlayPlan::Verify,
        _ => PlayPlan::Update,
    }
}

/// This session's last full check with nothing pending.
#[derive(Debug, Clone)]
pub struct RecentVerify {
    pub install_dir: String,
    pub feed_url: String,
    pub manifest_sha256: String,
    pub at_ms: u64,
}

pub const VERIFIED_REUSE_MS: u64 = 30 * 60_000;

/// Whether Play may reuse the last full check instead of walking the folder again: same folder and
/// server, recent enough, the executable still there, and the server still offering exactly the
/// manifest that was verified.
pub fn reuse_verified(recent: Option<&RecentVerify>, install_dir: &str, feed_url: &str, now_ms: u64, max_age_ms: u64, executable_present: bool, offered: &Available) -> bool {
    let Some(recent) = recent else { return false };
    if recent.install_dir != install_dir || recent.feed_url != feed_url {
        return false;
    }
    if now_ms < recent.at_ms || now_ms - recent.at_ms > max_age_ms || !executable_present {
        return false;
    }
    !recent.manifest_sha256.is_empty() && offered.manifest_sha256() == Some(recent.manifest_sha256.as_str())
}

/// Windows command-line quoting for one argument (CommandLineToArgvW rules).
pub fn windows_argument(value: &str) -> String {
    let mut out = String::from("\"");
    let mut backslashes = 0;
    for c in value.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.push_str(&"\\".repeat(backslashes * 2));
    out.push('"');
    out
}

/// Start the game. Windows uses ShellExecuteEx so the client's UAC manifest is honoured (the
/// client asks for admin rights); the game folder is the working directory.
pub fn launch(install_dir: &str, executable: &str, args: &[String]) -> crate::Result<()> {
    let path = std::path::Path::new(install_dir).join(executable.replace('/', std::path::MAIN_SEPARATOR_STR));
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW};
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let wide = |s: &std::ffi::OsStr| s.encode_wide().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let file = wide(path.as_os_str());
        let params = wide(std::ffi::OsStr::new(&args.iter().map(|a| windows_argument(a)).collect::<Vec<_>>().join(" ")));
        let dir = wide(std::ffi::OsStr::new(install_dir));
        let verb = wide(std::ffi::OsStr::new("open"));
        // SAFETY: all pointers are valid NUL-terminated wide strings that outlive the call.
        unsafe {
            let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
            info.fMask = SEE_MASK_NOASYNC;
            info.lpVerb = verb.as_ptr();
            info.lpFile = file.as_ptr();
            info.lpParameters = params.as_ptr();
            info.lpDirectory = dir.as_ptr();
            info.nShow = SW_SHOWNORMAL;
            if ShellExecuteExW(&mut info) == 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(1223) {
                    return Err(crate::Error::new("The game's Windows prompt was declined, so it did not start."));
                }
                return Err(crate::Error::new(format!("Could not start the game: {error}")));
            }
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new(&path)
            .args(args)
            .current_dir(install_dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|e| crate::Error::new(format!("Could not start the game: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::release::NameVersion;

    fn ok(sha: &str) -> Available {
        Available::Ok { version: "1.4.1".into(), layers: Vec::<NameVersion>::new(), manifest_sha256: sha.into(), min_client_build: None }
    }
    fn record(sha: &str) -> InstalledRecord {
        InstalledRecord { release: "1.4.0".into(), manifest_sha256: sha.into(), layers: vec![], verified_at: String::new(), launch: None }
    }

    #[test]
    fn play_updates_first_when_the_server_offers_another_release() {
        assert_eq!(play_plan(&ok("new"), Some(&record("old"))), PlayPlan::Update);
        assert_eq!(play_plan(&ok("new"), None), PlayPlan::Update);
        assert_eq!(play_plan(&ok("new"), Some(&record(""))), PlayPlan::Update);
        assert_eq!(play_plan(&ok("same"), Some(&record("same"))), PlayPlan::Verify);
    }

    #[test]
    fn play_starts_the_installed_client_when_the_server_cannot_be_asked() {
        for offered in [Available::Offline { message: "x".into() }, Available::AccessKey { message: "x".into() }, Available::Error { message: "x".into() }] {
            assert_eq!(play_plan(&offered, Some(&record("same"))), PlayPlan::Offline);
        }
    }

    #[test]
    fn reuse_only_for_the_same_folder_server_and_manifest() {
        let recent = RecentVerify { install_dir: "C:\\G".into(), feed_url: "https://f/m.json".into(), manifest_sha256: "abc".into(), at_ms: 1000 };
        let r = Some(&recent);
        assert!(reuse_verified(r, "C:\\G", "https://f/m.json", 2000, VERIFIED_REUSE_MS, true, &ok("abc")));
        assert!(!reuse_verified(r, "D:\\G", "https://f/m.json", 2000, VERIFIED_REUSE_MS, true, &ok("abc")));
        assert!(!reuse_verified(r, "C:\\G", "https://g/m.json", 2000, VERIFIED_REUSE_MS, true, &ok("abc")));
        assert!(!reuse_verified(r, "C:\\G", "https://f/m.json", 1000 + VERIFIED_REUSE_MS + 1, VERIFIED_REUSE_MS, true, &ok("abc")));
        assert!(!reuse_verified(r, "C:\\G", "https://f/m.json", 2000, VERIFIED_REUSE_MS, false, &ok("abc")));
        assert!(!reuse_verified(r, "C:\\G", "https://f/m.json", 2000, VERIFIED_REUSE_MS, true, &ok("other")));
        assert!(!reuse_verified(r, "C:\\G", "https://f/m.json", 2000, VERIFIED_REUSE_MS, true, &Available::Offline { message: String::new() }));
        assert!(!reuse_verified(None, "C:\\G", "https://f/m.json", 2000, VERIFIED_REUSE_MS, true, &ok("abc")));
    }

    #[test]
    fn windows_arguments_are_quoted_like_the_electron_launcher() {
        assert_eq!(windows_argument("plain"), "\"plain\"");
        assert_eq!(windows_argument("a b"), "\"a b\"");
        assert_eq!(windows_argument("say \"hi\""), "\"say \\\"hi\\\"\"");
        assert_eq!(windows_argument("C:\\dir\\"), "\"C:\\dir\\\\\"");
        assert_eq!(windows_argument("a\\\"b"), "\"a\\\\\\\"b\"");
    }
}

//! The installed client build, from `slums-build.txt` beside slums.dll in the game folder.
//!
//! The client build (1.6.0 and newer) writes it as key=value lines:
//!
//! ```text
//! release=1.6.0
//! build=10600
//! ```
//!
//! `build` is major*10000+minor*100+patch. Clients before 1.6.0 have no file; the launcher then
//! falls back to the installed record's `client` layer version. Reading it never fails: anything
//! missing, unreadable or malformed is simply "unknown", so it can never block Play.

use serde::Serialize;

/// The file name, written next to slums.dll (the game folder root).
pub const BUILD_FILE: &str = "slums-build.txt";
/// Anything larger is not a build file.
const MAX_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClientBuild {
    /// "1.6.0"
    pub release: String,
    /// 10600
    pub build: u32,
}

/// "1.6.0" -> 10600. Each part must be 0-99 (MAJOR may be larger), digits only.
pub fn build_number(release: &str) -> Option<u32> {
    let parts: Vec<&str> = release.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|p| p.is_empty() || p.len() > 4 || !p.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    let [major, minor, patch] = [parts[0], parts[1], parts[2]].map(|p| p.parse::<u32>().unwrap_or(u32::MAX));
    if major > 9999 || minor > 99 || patch > 99 {
        return None;
    }
    Some(major * 10_000 + minor * 100 + patch)
}

/// 10600 -> "1.6.0".
pub fn release_of(build: u32) -> String {
    format!("{}.{}.{}", build / 10_000, build / 100 % 100, build % 100)
}

/// Parse the file's text. Tolerates \r\n, blank lines, surrounding spaces, a UTF-8 BOM and extra
/// keys. Needs at least one of `release` or `build`; when only one is present the other is derived.
/// When both are present `build` wins for comparisons and `release` is shown as written.
pub fn parse_build_file(text: &str) -> Option<ClientBuild> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut release: Option<String> = None;
    let mut build: Option<u32> = None;
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else { continue };
        let value = value.trim();
        match key.trim().to_ascii_lowercase().as_str() {
            "release" if !value.is_empty() && value.len() <= 32 && value.chars().all(|c| c.is_ascii_graphic()) => release = Some(value.to_string()),
            "build" if !value.is_empty() && value.len() <= 9 && value.bytes().all(|b| b.is_ascii_digit()) => build = value.parse().ok().filter(|n| *n > 0),
            _ => {}
        }
    }
    match (release, build) {
        (Some(release), Some(build)) => Some(ClientBuild { release, build }),
        (Some(release), None) => build_number(&release).map(|build| ClientBuild { release, build }),
        (None, Some(build)) => Some(ClientBuild { release: release_of(build), build }),
        (None, None) => None,
    }
}

/// Read `slums-build.txt` from the game folder. None when it is missing or not a build file.
pub fn read_client_build(install_dir: &str) -> Option<ClientBuild> {
    if install_dir.is_empty() {
        return None;
    }
    let bytes = crate::fsutil::read_small_file(install_dir, BUILD_FILE).ok()??;
    if bytes.len() > MAX_BYTES {
        return None;
    }
    parse_build_file(std::str::from_utf8(&bytes).ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cb(release: &str, build: u32) -> Option<ClientBuild> {
        Some(ClientBuild { release: release.into(), build })
    }

    #[test]
    fn parses_the_exact_file_the_client_build_writes() {
        assert_eq!(parse_build_file("release=1.6.0\nbuild=10600\n"), cb("1.6.0", 10600));
    }

    #[test]
    fn tolerates_crlf_blank_lines_spaces_bom_and_extra_keys() {
        assert_eq!(parse_build_file("release=1.6.0\r\nbuild=10600\r\n"), cb("1.6.0", 10600));
        assert_eq!(parse_build_file("\u{feff}\n\n  release = 1.6.0  \n\ncommit=abc123\nbuild= 10600\nbuilt=2026-10-25\n"), cb("1.6.0", 10600));
        assert_eq!(parse_build_file("# comment\nnot a pair\nBUILD=10604\nRelease=1.6.4"), cb("1.6.4", 10604));
    }

    #[test]
    fn derives_the_missing_half() {
        assert_eq!(parse_build_file("release=1.6.2\n"), cb("1.6.2", 10602));
        assert_eq!(parse_build_file("build=11203\n"), cb("1.12.3", 11203));
        assert_eq!(parse_build_file("release=1.6.0-rc1\n"), None, "no build and a release that is not MAJOR.MINOR.PATCH");
        assert_eq!(parse_build_file("release=1.6.0-rc1\nbuild=10600"), cb("1.6.0-rc1", 10600));
    }

    #[test]
    fn rejects_garbage() {
        for text in ["", "\n\n", "hello", "build=abc", "build=-5", "build=0", "build=1e5", "release=", "build=12345678901", "release=1.200.0"] {
            assert_eq!(parse_build_file(text), None, "{text:?}");
        }
        // A bad build with a good release falls back to the release.
        assert_eq!(parse_build_file("release=1.6.0\nbuild=oops"), cb("1.6.0", 10600));
    }

    #[test]
    fn build_numbers_round_trip() {
        assert_eq!(build_number("1.5.4"), Some(10504));
        assert_eq!(build_number("1.6.0"), Some(10600));
        assert_eq!(build_number("2.0.10"), Some(20010));
        assert_eq!(build_number("1.6"), None);
        assert_eq!(build_number("v83-2026.10.19"), None);
        assert_eq!(release_of(10600), "1.6.0");
        assert_eq!(release_of(20010), "2.0.10");
    }

    #[test]
    fn reads_from_the_game_folder_and_never_fails() {
        let dir = std::env::temp_dir().join(format!("slums-build-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();
        assert_eq!(read_client_build(&root), None, "missing file");
        assert_eq!(read_client_build(""), None, "no folder");
        assert_eq!(read_client_build(&dir.join("does-not-exist").to_string_lossy()), None, "missing folder");
        std::fs::write(dir.join(BUILD_FILE), "release=1.6.0\r\nbuild=10600\r\n").unwrap();
        assert_eq!(read_client_build(&root), cb("1.6.0", 10600));
        std::fs::write(dir.join(BUILD_FILE), [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(read_client_build(&root), None, "not UTF-8");
        std::fs::write(dir.join(BUILD_FILE), "x".repeat(MAX_BYTES + 1)).unwrap();
        assert_eq!(read_client_build(&root), None, "too big");
        std::fs::remove_file(dir.join(BUILD_FILE)).unwrap();
        std::fs::create_dir(dir.join(BUILD_FILE)).unwrap();
        assert_eq!(read_client_build(&root), None, "a folder with that name");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

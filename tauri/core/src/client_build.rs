//! The installed client build, from `slums-build.txt` beside slums.dll in the game folder.
//!
//! The client build (1.6.0 and newer) writes it as key=value lines:
//!
//! ```text
//! release=1.6.0
//! build=10600
//! ```
//!
//! `build` is the client's own stamp (cmake/BuildStamp.cmake), the number the game server's
//! MIN_CLIENT_BUILD and the manifest's `minClientBuild` are written in. It is the only build number:
//! the launcher never works one out from a release string (1.6.4 is not 10604; the stamp says 10740).
//! A file without a valid `build` line is "unknown", and so are clients before 1.6.0 (no file).
//! Reading it never fails: anything missing, unreadable or malformed is simply "unknown", so it can
//! never block Play.

use serde::Serialize;

/// The file name, written next to slums.dll (the game folder root).
pub const BUILD_FILE: &str = "slums-build.txt";
/// Anything larger is not a build file.
const MAX_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClientBuild {
    /// "1.6.0": a label; empty when the file has no `release` line
    pub release: String,
    /// 10600
    pub build: u32,
}

/// Parse the file's text. Tolerates \r\n, blank lines, surrounding spaces, a UTF-8 BOM and extra
/// keys. Needs a valid `build` line; `release` is only a label (empty when the file has none).
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
    build.map(|build| ClientBuild { release: release.unwrap_or_default(), build })
}

/// The manifest's `minClientBuild` against the installed client's stamp: Some((have, need)) only when both
/// are known and the client is lower. A manifest without the field never blocks (leaving it out is the kill
/// switch), and a missing or unreadable stamp warns elsewhere but never blocks.
pub fn too_old(installed: Option<u32>, min: Option<u32>) -> Option<(u32, u32)> {
    match (installed, min) {
        (Some(have), Some(need)) if have < need => Some((have, need)),
        _ => None,
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
    fn the_build_line_is_the_only_number_and_is_never_worked_out_from_the_release() {
        assert_eq!(parse_build_file("release=1.6.2\n"), None, "1.6.2 would be 10602, but the stamp says 10720: unknown, not guessed");
        assert_eq!(parse_build_file("release=1.6.4\n"), None);
        assert_eq!(parse_build_file("build=10740\n"), cb("", 10740), "no release label, and none is made up");
        assert_eq!(parse_build_file("release=1.6.4\nbuild=10740"), cb("1.6.4", 10740), "release 1.6.4, stamp 10740: the stamp wins");
        assert_eq!(parse_build_file("release=1.6.0-rc1\nbuild=10600"), cb("1.6.0-rc1", 10600));
    }

    #[test]
    fn too_old_only_when_both_numbers_are_known_and_the_client_is_lower() {
        assert_eq!(too_old(Some(10720), Some(10740)), Some((10720, 10740)));
        assert_eq!(too_old(Some(10740), Some(10740)), None, "equal is fine");
        assert_eq!(too_old(Some(10741), Some(10740)), None);
        assert_eq!(too_old(None, Some(10740)), None, "no readable stamp: warn, never block");
        assert_eq!(too_old(Some(10720), None), None, "no minClientBuild in the manifest: the kill switch");
        assert_eq!(too_old(None, None), None);
    }

    #[test]
    fn rejects_garbage() {
        for text in ["", "\n\n", "hello", "build=abc", "build=-5", "build=0", "build=1e5", "release=", "build=12345678901", "release=1.200.0"] {
            assert_eq!(parse_build_file(text), None, "{text:?}");
        }
        // A bad build is unknown even next to a good release: the release is a label, not a number.
        assert_eq!(parse_build_file("release=1.6.0\nbuild=oops"), None);
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

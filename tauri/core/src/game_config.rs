//! config.ini on disk for the Game options panel (port of game-config.mjs). The file is the
//! player's (publish marks it player-owned; updates never replace it) and it holds the server
//! address, so this module never creates it: a missing file is left to the install flow.

use crate::error::{Error, Result, CONFIG_MISSING, GAME_RUNNING};
use crate::game_options::{apply_game_options_map, read_game_options, validate_changes, GameOptions};
use serde::ser::{Serialize, SerializeStruct, Serializer};
use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

pub const CONFIG_FILE: &str = "config.ini";
/// Executables that read config.ini at start-up: the starter and the client it opens.
pub const GAME_PROCESSES: [&str; 2] = ["SlumsMS.exe", "MapleStory.exe"];

/// `{ status: "missing" }` or `{ status: "ok", values, legacyMoveAttack, parseErrorLine }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameConfig {
    /// "missing" or "ok".
    pub status: &'static str,
    pub values: BTreeMap<String, bool>,
    pub legacy_move_attack: Option<bool>,
    pub parse_error_line: usize,
}

impl GameConfig {
    pub fn missing() -> Self {
        GameConfig { status: "missing", values: BTreeMap::new(), legacy_move_attack: None, parse_error_line: 0 }
    }
    fn ok(options: GameOptions) -> Self {
        GameConfig { status: "ok", values: options.values, legacy_move_attack: options.legacy_move_attack, parse_error_line: options.parse_error_line }
    }
    pub fn is_ok(&self) -> bool {
        self.status == "ok"
    }
}

impl Serialize for GameConfig {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        if !self.is_ok() {
            let mut s = serializer.serialize_struct("GameConfig", 1)?;
            s.serialize_field("status", self.status)?;
            return s.end();
        }
        let mut s = serializer.serialize_struct("GameConfig", 4)?;
        s.serialize_field("status", self.status)?;
        s.serialize_field("values", &self.values)?;
        s.serialize_field("legacyMoveAttack", &self.legacy_move_attack)?;
        s.serialize_field("parseErrorLine", &self.parse_error_line)?;
        s.end()
    }
}

fn config_path(install_dir: &Path) -> PathBuf {
    install_dir.join(CONFIG_FILE)
}

/// The file's bytes (latin1 text), or None when it does not exist.
fn read_text(install_dir: &Path) -> Result<Option<Vec<u8>>> {
    let path = config_path(install_dir);
    let missing = |error: &std::io::Error| matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory);
    match std::fs::symlink_metadata(&path) {
        Ok(stat) if !stat.is_file() => Err(Error::new(format!("{CONFIG_FILE} in the game folder is not a regular file."))),
        Ok(_) => match std::fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if missing(&error) => Ok(None),
            Err(error) => Err(Error::io(error, format!("Could not read {CONFIG_FILE}"))),
        },
        Err(error) if missing(&error) => Ok(None),
        Err(error) => Err(Error::io(error, format!("Could not read {CONFIG_FILE}"))),
    }
}

pub fn read_game_config(install_dir: &str) -> Result<GameConfig> {
    if install_dir.is_empty() {
        return Ok(GameConfig::missing());
    }
    Ok(match read_text(Path::new(install_dir))? {
        None => GameConfig::missing(),
        Some(text) => GameConfig::ok(read_game_options(&text)),
    })
}

fn failure(message: impl Into<String>, code: &'static str) -> Error {
    Error::new(message).with_code(code)
}

/// Apply `{ id: on }` to config.ini. Refuses while the game runs (it reads the file only at start-up
/// and some players' clients write it back) and when the file is missing. The new file is written
/// beside the old one and renamed over it, so a crash leaves the old or the new file, never half of
/// one. Returns the options as the client will now read them.
pub fn write_game_config(install_dir: &str, changes: &BTreeMap<String, bool>, is_game_running: impl FnOnce() -> bool) -> Result<GameConfig> {
    let clean = validate_changes(&serde_json::to_value(changes).expect("map serializes"))?;
    if install_dir.is_empty() {
        return Err(failure("Choose a game folder first.", CONFIG_MISSING));
    }
    if is_game_running() {
        return Err(failure("Close SlumsMS to change game options. They apply the next time the game starts.", GAME_RUNNING));
    }
    let dir = Path::new(install_dir);
    let before = read_text(dir)?.ok_or_else(|| failure(format!("{CONFIG_FILE} is missing from the game folder. Install or repair the game first."), CONFIG_MISSING))?;
    let after = apply_game_options_map(&before, &clean)?;
    if after != before {
        let temporary = dir.join(format!(".{CONFIG_FILE}.{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> std::io::Result<()> {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
            file.write_all(&after)?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&temporary, config_path(dir))
        })();
        let _ = std::fs::remove_file(&temporary);
        result.map_err(|error| Error::io(error, format!("Could not save {CONFIG_FILE}")))?;
    }
    Ok(GameConfig::ok(read_game_options(&after)))
}

/// Names from `tasklist /FO CSV /NH` (Windows) or `ps -A -o comm=` that match `names`, case-insensitively.
pub fn running_game_names(output: &str, names: &[&str]) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        let field = match line.strip_prefix('"').and_then(|rest| rest.find('"').map(|end| &rest[..end])) {
            Some(csv) => csv,
            None => line,
        };
        let normalized = field.replace('\\', "/");
        let base = normalized.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_lowercase();
        if let Some(name) = names.iter().find(|name| name.to_lowercase() == base) {
            if !found.iter().any(|f| f == name) {
                found.push(name.to_string());
            }
        }
    }
    found
}

/// Whether a game process is running, from a process list (None when it could not be read, which
/// counts as not running: the write itself is still atomic).
pub fn game_running_from(list: Option<String>) -> bool {
    list.is_some_and(|output| !running_game_names(&output, &GAME_PROCESSES).is_empty())
}

/// Whether a game process is running. The client asks for admin rights, so its path cannot be read
/// from a normal launcher; a process with the game's name counts.
pub fn game_running() -> bool {
    game_running_from(process_list())
}

/// One executable name per line.
#[cfg(windows)]
fn process_list() -> Option<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    // SAFETY: plain Win32 calls on a snapshot handle we own and close; the entry is zeroed and sized.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut out = String::new();
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            let len = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
            out.push_str(&String::from_utf16_lossy(&entry.szExeFile[..len]));
            out.push('\n');
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        Some(out)
    }
}

#[cfg(not(windows))]
fn process_list() -> Option<String> {
    let output = std::process::Command::new("ps").args(["-A", "-o", "comm="]).output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game_options::apply_game_options_map;

    fn real() -> String {
        [
            "[general]", "resolution=5", "",
            "[discord]", "enableactivitystatus=true", "",
            "[clienthax]", "nobulb=true", "customcolor=true", "moveattack=true", "ChairOpacity=255", "SkillOpacity=255", "",
            "[config]", "host=203.0.113.7", "port=8484", "",
            "[debug]", "attackdiag=1", "",
        ]
        .join("\r\n")
    }

    struct Folder(PathBuf);
    impl Folder {
        fn new(contents: Option<&[u8]>) -> Self {
            let dir = std::env::temp_dir().join(format!("slumsms-options-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            if let Some(bytes) = contents {
                std::fs::write(dir.join(CONFIG_FILE), bytes).unwrap();
            }
            Folder(dir)
        }
        fn s(&self) -> &str {
            self.0.to_str().unwrap()
        }
        fn entries(&self) -> Vec<String> {
            let mut names: Vec<String> = std::fs::read_dir(&self.0).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
            names.sort();
            names
        }
    }
    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn changes(list: &[(&str, bool)]) -> BTreeMap<String, bool> {
        list.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn a_missing_config_ini_is_reported_and_never_created() {
        let dir = Folder::new(None);
        assert_eq!(read_game_config(dir.s()).unwrap(), GameConfig::missing());
        assert_eq!(serde_json::to_value(GameConfig::missing()).unwrap(), serde_json::json!({ "status": "missing" }));
        let error = write_game_config(dir.s(), &changes(&[("nobulb", false)]), || false).unwrap_err();
        assert!(error.is(CONFIG_MISSING));
        assert!(dir.entries().is_empty());
        assert_eq!(read_game_config("").unwrap(), GameConfig::missing());
        assert!(write_game_config("", &changes(&[("nobulb", false)]), || false).unwrap_err().is(CONFIG_MISSING));
    }

    #[test]
    fn writing_refuses_while_the_game_runs_and_leaves_the_file_alone() {
        let dir = Folder::new(Some(real().as_bytes()));
        let error = write_game_config(dir.s(), &changes(&[("nobulb", false)]), || true).unwrap_err();
        assert!(error.is(GAME_RUNNING) && error.message.contains("Close SlumsMS"));
        assert_eq!(std::fs::read(dir.0.join(CONFIG_FILE)).unwrap(), real().as_bytes());
    }

    #[test]
    fn the_file_is_replaced_atomically_other_bytes_survive_and_no_temporary_is_left() {
        let mut original = b"[general]\r\nname=".to_vec();
        original.extend_from_slice(&[0xc7, 0xd1, 0xb1, 0xdb]);
        original.extend_from_slice(b"\r\n");
        original.extend_from_slice(real().as_bytes());
        let dir = Folder::new(Some(&original));
        let wanted = changes(&[("nobulb", false), ("attackwalk", true)]);
        let result = write_game_config(dir.s(), &wanted, || false).unwrap();
        assert!(!result.values["nobulb"]);
        assert!(result.values["attackwalk"]);
        let written = std::fs::read(dir.0.join(CONFIG_FILE)).unwrap();
        assert_eq!(written[..20], original[..20]); // the non-UTF-8 bytes are untouched
        assert_eq!(written, apply_game_options_map(&original, &wanted).unwrap());
        assert_eq!(dir.entries(), vec![CONFIG_FILE.to_string()]);
        assert_eq!(read_game_config(dir.s()).unwrap().values, result.values);
        let json = serde_json::to_value(read_game_config(dir.s()).unwrap()).unwrap();
        assert_eq!(json["status"], "ok");
        assert_eq!(json["legacyMoveAttack"], true);
        assert_eq!(json["parseErrorLine"], 0);
        assert_eq!(json["values"]["nobulb"], false);
    }

    #[test]
    fn a_config_ini_that_is_not_a_file_is_an_error() {
        let dir = Folder::new(None);
        std::fs::create_dir(dir.0.join(CONFIG_FILE)).unwrap();
        assert!(read_game_config(dir.s()).unwrap_err().message.contains("not a regular file"));
    }

    #[test]
    fn the_game_process_is_found_in_tasklist_and_ps_output() {
        let tasklist = "\"System Idle Process\",\"0\",\"Services\",\"0\",\"8 K\"\r\n\"MAPLESTORY.EXE\",\"4321\",\"Console\",\"1\",\"812,000 K\"\r\n\"electron.exe\",\"77\",\"Console\",\"1\",\"1 K\"\r\n";
        assert_eq!(running_game_names(tasklist, &GAME_PROCESSES), vec!["MapleStory.exe"]);
        assert_eq!(running_game_names("init\nbash\n/opt/wine/SlumsMS.exe\n", &GAME_PROCESSES), vec!["SlumsMS.exe"]);
        assert!(running_game_names("\"SlumsMS Launcher.exe\",\"1\"\r\n", &GAME_PROCESSES).is_empty());
        assert!(game_running_from(Some(tasklist.to_string())));
        assert!(!game_running_from(Some(String::new())));
        assert!(!game_running_from(None));
        // The real process list works here and does not show the game.
        assert!(!game_running());
    }
}

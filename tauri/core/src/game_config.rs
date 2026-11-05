//! config.ini on disk for the Game options panel (port of game-config.mjs). The file is the
//! player's (publish marks it player-owned; updates never replace it), except its server address,
//! which follows the channel (merge_server, used by the install flow). This module never creates
//! it: a missing file is left to the install flow.

use crate::error::{Error, Result, CONFIG_MISSING, GAME_RUNNING};
use crate::game_options::{explicit_game_options, get_profile_value, latin1_decode, parse_ini, read_game_options, serialize_ini, set_profile_value, validate_changes, GameOptions};
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

/// The config.ini the game reads. Every reader in the client opens a relative path (`config.ini`,
/// `.\\config.ini`) and the launcher starts the game with the game folder as its working directory
/// (play::launch), so this is the file for that folder, and the same folder must be passed to both.
pub fn config_path(install_dir: &Path) -> PathBuf {
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

/// The game server the client will connect to: `[config] host` and `port` as GetPrivateProfileStringA reads
/// them, as "host:port" (or just the host when there is no port). None when the file, or the host, is missing
/// or unreadable. Display only: it shows which server a channel's folder plays, and never blocks Play.
pub fn read_game_server(install_dir: &str) -> Option<String> {
    if install_dir.is_empty() {
        return None;
    }
    let text = read_text(Path::new(install_dir)).ok()??;
    let ini = parse_ini(&text);
    let clean = |v: Vec<u8>| latin1_decode(&v).trim().to_string();
    let host = get_profile_value(&ini, "config", "host").map(clean).filter(|h| !h.is_empty())?;
    Some(match get_profile_value(&ini, "config", "port").map(clean).filter(|p| !p.is_empty()) {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

/// The keys of config.ini that say which game server the client joins. They belong to the channel,
/// not the player: each channel's client layer ships its own (Live slumsms.asslorde.com:8485, RC and
/// Test the test server), and slums.dll reads the server only from here (client src/injector.cpp).
pub const SERVER_KEYS: [&str; 2] = ["host", "port"];

/// The player's config.ini with `[config] host` and `port` taken from the channel layer's copy and
/// everything else (game options, their own keys, comments, line endings) left as it was. A key the
/// layer doesn't set stays as the player has it. Before this (launcher 1.6.4 and older) an existing
/// config.ini was never touched, so an install kept the server of whichever channel it was first
/// installed from: RC after Live still joined Live (owner, 2026-11-05).
pub fn merge_server(player: &[u8], layer: &[u8]) -> Vec<u8> {
    let channel = parse_ini(layer);
    let mut ini = parse_ini(player);
    for key in SERVER_KEYS {
        if let Some(value) = get_profile_value(&channel, "config", key) {
            set_profile_value(&mut ini, "config", key, &value);
        }
    }
    serialize_ini(&ini)
}

fn failure(message: impl Into<String>, code: &'static str) -> Error {
    Error::new(message).with_code(code)
}

/// Apply `{ id: on }` to config.ini and write every other option explicitly too, at the value the
/// client reads now (else its default; see game_options::explicit_game_options). An empty map just
/// makes the file explicit; the file is not rewritten when nothing changes. Refuses while the game
/// runs (it reads the file only at start-up and some players' clients write it back) and when the
/// file is missing. The new file is written beside the old one and renamed over it, so a crash
/// leaves the old or the new file, never half of one. Returns the options as the client will now
/// read them.
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
    let after = explicit_game_options(&before, &clean)?;
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
    use crate::channels::{channel_install_dir, Channel, Folders, CHANNELS};
    use crate::game_options::{explicit_game_options, GAME_OPTIONS};

    #[test]
    fn merge_server_takes_only_host_and_port_from_the_channel() {
        let rc = b"[general]\r\nresolution=1\r\n[config]\r\nhost=192.168.0.111\r\nport=8489\r\n[debug]\r\nattackdiag=0\r\n";
        let player = real();
        let merged = String::from_utf8(merge_server(player.as_bytes(), rc)).unwrap();
        assert_eq!(merged, player.replace("host=203.0.113.7\r\nport=8484", "host=192.168.0.111\r\nport=8489"), "nothing else changes");
        assert_eq!(merge_server(merged.as_bytes(), rc), merged.as_bytes(), "already right: byte-for-byte");
        // Quotes, spacing and inline comments as GetPrivateProfileString reads them; a missing key is added.
        let odd = b"[Config]\nHost = \"slumsms.asslorde.com\" ; live\n[clienthax]\nnobulb=true\n";
        let out = String::from_utf8(merge_server(odd, rc)).unwrap();
        assert_eq!(out, "[Config]\nHost = 192.168.0.111\nport=8489\n[clienthax]\nnobulb=true\n");
        // A layer without a server leaves the player's file alone; one with no [config] at all gets one.
        assert_eq!(merge_server(player.as_bytes(), b"[general]\r\n"), player.as_bytes());
        let none = String::from_utf8(merge_server(b"[general]\r\nresolution=5\r\n", rc)).unwrap();
        assert_eq!(none, "[general]\r\nresolution=5\r\n\r\n[config]\r\nhost=192.168.0.111\r\nport=8489\r\n");
    }

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
    fn the_game_server_is_read_the_way_the_client_reads_it() {
        assert_eq!(read_game_server(Folder::new(Some(real().as_bytes())).s()).as_deref(), Some("203.0.113.7:8484"));
        let live = "[config]\r\nhost = slumsms.asslorde.com ; live\r\nport=8485\r\nhost=ignored\r\n";
        assert_eq!(read_game_server(Folder::new(Some(live.as_bytes())).s()).as_deref(), Some("slumsms.asslorde.com ; live:8485"), "no inline comments, like the client");
        assert_eq!(read_game_server(Folder::new(Some(b"[config]\nhost=\"192.168.0.164\"\n")).s()).as_deref(), Some("192.168.0.164"));
        assert_eq!(read_game_server(Folder::new(Some(b"[general]\nresolution=5\n")).s()), None);
        assert_eq!(read_game_server(Folder::new(None).s()), None);
        assert_eq!(read_game_server(""), None);
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
        assert_eq!(written, explicit_game_options(&original, &wanted).unwrap());
        assert_eq!(dir.entries(), vec![CONFIG_FILE.to_string()]);
        assert_eq!(read_game_config(dir.s()).unwrap().values, result.values);
        let json = serde_json::to_value(read_game_config(dir.s()).unwrap()).unwrap();
        assert_eq!(json["status"], "ok");
        assert_eq!(json["legacyMoveAttack"], true);
        assert_eq!(json["parseErrorLine"], 0);
        assert_eq!(json["values"]["nobulb"], false);
    }

    #[test]
    fn an_empty_change_set_writes_every_option_explicitly_and_only_once() {
        let dir = Folder::new(Some(real().as_bytes()));
        let shown = read_game_config(dir.s()).unwrap().values;
        assert!(!shown["doubletapjump"], "the client default is off");
        let written = write_game_config(dir.s(), &BTreeMap::new(), || false).unwrap();
        assert_eq!(written.values, shown);
        let text = String::from_utf8(std::fs::read(dir.0.join(CONFIG_FILE)).unwrap()).unwrap();
        for option in GAME_OPTIONS {
            assert!(text.to_lowercase().contains(&format!("{}=", option.key)), "{} written: {text}", option.key);
        }
        assert!(text.contains("doubletapjump=false\r\n"));
        assert!(text.contains("[config]\r\nhost=203.0.113.7\r\nport=8484\r\n"));
        // A second pass finds nothing to change and leaves the file alone.
        let modified = std::fs::metadata(dir.0.join(CONFIG_FILE)).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_game_config(dir.s(), &BTreeMap::new(), || false).unwrap();
        assert_eq!(std::fs::metadata(dir.0.join(CONFIG_FILE)).unwrap().modified().unwrap(), modified);
        assert_eq!(dir.entries(), vec![CONFIG_FILE.to_string()]);
    }

    /// The launcher reads and writes the config.ini of the folder the selected channel launches from,
    /// and the game started there (working directory = that folder, like the client's relative
    /// `.\\config.ini`) sees exactly that file. Other channels' files are untouched.
    #[cfg(unix)]
    #[test]
    fn each_channel_reads_writes_and_launches_with_its_own_config_ini() {
        use std::os::unix::fs::PermissionsExt;
        let root = Folder::new(None);
        let live = root.0.join("SlumsMS");
        let folders = Folders { live: live.to_string_lossy().into_owned(), ..Default::default() };
        let dirs: Vec<(Channel, String)> = CHANNELS.into_iter().map(|c| (c, channel_install_dir(c, &folders, "", ""))).collect();
        for (_, dir) in &dirs {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(Path::new(dir).join(CONFIG_FILE), real()).unwrap();
            // A stand-in game that copies the config.ini it sees (relative path, like the client).
            let game = Path::new(dir).join("SlumsMS.exe");
            std::fs::write(&game, "#!/bin/sh\ncp config.ini seen.ini\n").unwrap();
            std::fs::set_permissions(&game, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let (channel, test_dir) = dirs.iter().find(|(c, _)| *c == Channel::Test).unwrap();
        assert!(test_dir.ends_with("SlumsMS-test"), "{channel:?} {test_dir}");
        write_game_config(test_dir, &changes(&[("doubletapjump", true)]), || false).unwrap();
        assert!(read_game_config(test_dir).unwrap().values["doubletapjump"]);
        for (other, dir) in &dirs {
            if other != channel {
                assert_eq!(std::fs::read(Path::new(dir).join(CONFIG_FILE)).unwrap(), real().as_bytes(), "{other:?} untouched");
                assert!(!read_game_config(dir).unwrap().values["doubletapjump"]);
            }
        }
        crate::play::launch(test_dir, "SlumsMS.exe", &[]).unwrap();
        let seen = Path::new(test_dir).join("seen.ini");
        let started = std::time::Instant::now();
        while !seen.exists() && started.elapsed() < std::time::Duration::from_secs(10) {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert_eq!(std::fs::read(&seen).unwrap(), std::fs::read(config_path(Path::new(test_dir))).unwrap());
        assert!(crate::game_options::read_game_options(&std::fs::read(&seen).unwrap()).values["doubletapjump"]);
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
        // The real process list can be read here. Whether it shows a game depends on the machine (another
        // session may be playing), so only the call itself is checked.
        let _ = game_running();
    }
}

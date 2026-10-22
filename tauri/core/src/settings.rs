//! The launcher's own settings (settingsVersion 2, per user) and the one-time migration from the
//! Electron launcher's %APPDATA%\mapleroot-launcher\settings.json. The Electron file is only ever
//! read; game folders are never moved, copied or downloaded again.

use crate::channels::{channel_of_feed, folder_channel, Channel, Folders, Probes};
use crate::config::valid_access_key;
use crate::error::{Error, Result};
use crate::release::InstalledRecord;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingGameOptions {
    pub install_dir: String,
    pub changes: BTreeMap<String, bool>,
}

/// A folder the migration could not place: asked once in the launcher.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationQuestion {
    pub dir: String,
    pub suggested: Channel,
    pub conflict: bool,
    pub release: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub settings_version: u32,
    /// A custom Live feed (Advanced > Update server); empty = the built-in one. Test/RC derive from it.
    #[serde(default)]
    pub feed_url: String,
    #[serde(default)]
    pub access_key: String,
    /// The Basic-auth user the server accepted for this key ("slums" or "slumsdev").
    #[serde(default)]
    pub access_user: String,
    #[serde(default = "live")]
    pub channel: Channel,
    #[serde(default)]
    pub folders: Folders,
    #[serde(default)]
    pub pending_game_options: Option<PendingGameOptions>,
    /// Where these settings came from on first start ("electron", "new").
    #[serde(default)]
    pub migrated_from: String,
    #[serde(default)]
    pub migration_question: Option<MigrationQuestion>,
}

fn live() -> Channel {
    Channel::Live
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            settings_version: 2,
            feed_url: String::new(),
            access_key: String::new(),
            access_user: String::new(),
            channel: Channel::Live,
            folders: Folders::default(),
            pending_game_options: None,
            migrated_from: String::new(),
            migration_question: None,
        }
    }
}

/// Read stored settings, dropping anything malformed instead of failing.
pub fn read_settings(text: &str) -> Settings {
    let value: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    let mut settings: Settings = serde_json::from_value(value.clone()).unwrap_or_else(|_| {
        // Field-by-field fallback: keep what parses.
        let mut s = Settings::default();
        if let Some(v) = value.get("feedUrl").and_then(Value::as_str) {
            s.feed_url = v.into();
        }
        if let Some(v) = value.get("accessKey").and_then(Value::as_str) {
            s.access_key = v.into();
        }
        if let Some(c) = value.get("channel").and_then(Value::as_str).and_then(Channel::parse) {
            s.channel = c;
        }
        if let Ok(f) = serde_json::from_value::<Folders>(value.get("folders").cloned().unwrap_or(Value::Null)) {
            s.folders = f;
        }
        s.migrated_from = value.get("migratedFrom").and_then(Value::as_str).unwrap_or("").into();
        s
    });
    if !valid_access_key(&settings.access_key) {
        settings.access_key.clear();
    }
    settings.settings_version = 2;
    settings
}

/// Atomic write (temp file + rename), owner-only on Unix.
pub fn write_settings(file: &Path, settings: &Settings) -> Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| Error::io(e, parent.display()))?;
    }
    let temporary = file.with_extension("json.tmp");
    let text = serde_json::to_vec_pretty(settings).expect("json");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    let mut handle = options.open(&temporary).map_err(|e| Error::io(e, temporary.display()))?;
    handle.write_all(&text).map_err(|e| Error::io(e, temporary.display()))?;
    drop(handle);
    std::fs::rename(&temporary, file).map_err(|e| Error::io(e, file.display()))
}

/// What the migration knows about the old game folder.
pub struct LegacyFolder<'a> {
    pub holds_game: bool,
    pub record: Option<&'a InstalledRecord>,
}

pub struct Migration {
    pub settings: Settings,
    pub question: Option<MigrationQuestion>,
    pub notes: Vec<String>,
}

/// Electron used the saved folder, then a bundled client, then its per-user default.
pub fn legacy_install_dir(legacy: &Value, bundled: &str, standalone: &str) -> String {
    let saved = legacy.get("installDir").and_then(Value::as_str).unwrap_or("");
    [saved, bundled, standalone].into_iter().find(|d| !d.is_empty()).unwrap_or("").to_string()
}

/// Inspect Electron's effective folder before assigning ownership. This only reads
/// the existing install; migration never moves, copies or removes game files.
pub fn migrate_legacy_install(legacy: &Value, live_feed_url: &str, bundled: &str, standalone: &str, client_executable: &str, probes: &Probes) -> Migration {
    let default_dir = legacy_install_dir(&Value::Null, bundled, standalone);
    let dir = legacy_install_dir(legacy, bundled, standalone);
    let record = if dir.is_empty() { None } else { crate::release::read_installed_record(&dir) };
    let holds_game = !dir.is_empty() && (record.is_some() || Path::new(&dir).join(client_executable).is_file());
    migrate_legacy_settings(legacy, live_feed_url, Some(LegacyFolder { holds_game, record: record.as_ref() }), probes, &default_dir)
}

/// Map the Electron settings ({ feedUrl, installDir, accessKey, pendingGameOptions }) onto
/// per-channel settings. The old folder becomes Live's only when every signal says Live (it stays
/// exactly where it is); otherwise the player is asked once. A folder without a game follows the
/// old feed's channel silently (nothing is there to mix up).
pub fn migrate_legacy_settings(legacy: &Value, live_feed_url: &str, folder: Option<LegacyFolder>, probes: &Probes, default_dir: &str) -> Migration {
    let feed = legacy.get("feedUrl").and_then(Value::as_str).unwrap_or("");
    let feed_channel = if feed.is_empty() { Some(Channel::Live) } else { channel_of_feed(feed, live_feed_url) };
    let mut settings = Settings {
        feed_url: if !feed.is_empty() && feed_channel.is_none() { feed.to_string() } else { String::new() },
        access_key: legacy.get("accessKey").and_then(Value::as_str).filter(|k| valid_access_key(k)).unwrap_or("").to_string(),
        channel: feed_channel.unwrap_or(Channel::Live),
        migrated_from: "electron".into(),
        ..Default::default()
    };
    let mut notes = Vec::new();
    let dir = legacy_install_dir(legacy, "", default_dir);
    let pending = legacy.get("pendingGameOptions").filter(|p| p.get("installDir").and_then(Value::as_str) == Some(dir.as_str())).and_then(|p| {
        crate::game_options::validate_changes(p.get("changes")?).ok().map(|changes| PendingGameOptions { install_dir: dir.clone(), changes })
    });
    if dir.is_empty() {
        notes.push("No game folder was chosen in the old launcher; Live uses its default folder.".into());
        return Migration { settings, question: None, notes };
    }
    let channel = feed_channel.unwrap_or(Channel::Live);
    let folder = folder.unwrap_or(LegacyFolder { holds_game: false, record: None });
    if !folder.holds_game {
        if channel != Channel::Live && dir == default_dir {
            settings.folders.live = format!("{}-live", dir.trim_end_matches(['\\', '/']));
        }
        settings.folders.set(channel, dir.clone());
        notes.push(format!("Old game folder {dir} holds no game yet; it stays the {} folder.", channel.label()));
        return Migration { settings, question: None, notes };
    }
    let from_folder = folder_channel(folder.record, probes);
    let signals: Vec<Channel> = [from_folder, Some(channel)].into_iter().flatten().collect();
    if signals.iter().all(|c| *c == Channel::Live) {
        settings.folders.live = dir.clone();
        settings.pending_game_options = pending;
        notes.push(format!("Old game folder {dir} is the Live folder."));
        return Migration { settings, question: None, notes };
    }
    // The legacy default may hold Test/RC. Keep Live away even while the question is
    // unanswered or declined; no files are moved and the old install stays in place.
    if dir == default_dir {
        settings.folders.live = format!("{}-live", dir.trim_end_matches(['\\', '/']));
    }
    let suggested = from_folder.unwrap_or(channel);
    let conflict = from_folder.is_some_and(|f| f != channel);
    let release = folder.record.map(|r| r.release.clone()).unwrap_or_default();
    let article = if suggested == Channel::Rc { "an" } else { "a" };
    let old_setting = if conflict { format!(", but the old launcher was set to the {} channel", channel.label()) } else { String::new() };
    let message = format!(
        "This folder looks like {article} {} install{}{old_setting}:\n{dir}\nUse it as the {} folder?",
        suggested.label(),
        if release.is_empty() { String::new() } else { format!(" ({release})") },
        suggested.label()
    );
    notes.push(format!("Old game folder {dir}: the folder says {}, the old feed says {}; asking.", from_folder.map(Channel::label).unwrap_or("nothing"), channel.label()));
    Migration { settings, question: Some(MigrationQuestion { dir, suggested, conflict, release, message }), notes }
}

/// Apply the player's answer: `channel` takes the folder, or None leaves it alone.
pub fn apply_migration_answer(settings: &mut Settings, question: &MigrationQuestion, channel: Option<Channel>) {
    if let Some(channel) = channel {
        settings.folders.set(channel, question.dir.clone());
    }
    settings.migration_question = None;
}

/// Read one file from an Electron app.asar (JSON header, then the packed bytes); used once to carry
/// a friends build's built-in access key over to this launcher without anyone handling it.
pub fn read_asar_file(asar: &Path, relative: &str) -> Option<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(asar).ok()?;
    let mut prefix = [0u8; 16];
    file.read_exact(&mut prefix).ok()?;
    let word = |i: usize| u32::from_le_bytes(prefix[i..i + 4].try_into().unwrap()) as u64;
    let (header_size, json_size) = (word(4), word(12));
    if word(0) != 4 || json_size > header_size || header_size > 64 * 1024 * 1024 {
        return None;
    }
    let mut json = vec![0u8; json_size as usize];
    file.read_exact(&mut json).ok()?;
    let mut node: Value = serde_json::from_slice(&json).ok()?;
    for part in relative.split('/') {
        node = node.get("files")?.get(part)?.clone();
    }
    if node.get("unpacked").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let offset: u64 = node.get("offset")?.as_str()?.parse().ok()?;
    let size = node.get("size")?.as_u64()?;
    if size > 1024 * 1024 {
        return None;
    }
    file.seek(SeekFrom::Start(8 + header_size + offset)).ok()?;
    let mut bytes = vec![0u8; size as usize];
    file.read_exact(&mut bytes).ok()?;
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::release::{Available, NameVersion};
    use serde_json::json;

    const LIVE: &str = "https://slumspatch.asslorde.com/manifest.json";

    fn ok(version: &str, sha: &str) -> Available {
        Available::Ok { version: version.into(), layers: Vec::<NameVersion>::new(), manifest_sha256: sha.into() }
    }
    fn rec(release: &str, sha: &str) -> InstalledRecord {
        InstalledRecord { release: release.into(), manifest_sha256: sha.into(), layers: vec![], verified_at: String::new(), launch: None }
    }

    #[test]
    fn migration_inspects_the_electron_default_and_leaves_existing_files_untouched() {
        let root = std::env::temp_dir().join(format!("slums-migration-{}", uuid::Uuid::new_v4()));
        let dir = root.join("SlumsMS");
        let record_path = dir.join(crate::release::INSTALLED_FILE);
        std::fs::create_dir_all(record_path.parent().unwrap()).unwrap();
        std::fs::write(dir.join("SlumsMS.exe"), b"existing game").unwrap();
        for release in ["1.5.0-test", "1.5.0-rc1"] {
            let bytes = serde_json::to_vec(&json!({ "recordVersion": 1, "release": release, "layers": [] })).unwrap();
            std::fs::write(&record_path, &bytes).unwrap();
            let migration = migrate_legacy_install(&json!({ "installDir": "" }), LIVE, "", dir.to_str().unwrap(), "SlumsMS.exe", &Probes::new());
            let q = migration.question.unwrap();
            assert_eq!(q.dir, dir.to_str().unwrap());
            assert_eq!(q.suggested, if release.contains("test") { Channel::Test } else { Channel::Rc });
            assert_ne!(crate::channels::channel_install_dir(Channel::Live, &migration.settings.folders, "", dir.to_str().unwrap()), dir.to_str().unwrap());
            assert_eq!(std::fs::read(&record_path).unwrap(), bytes);
            assert_eq!(std::fs::read(dir.join("SlumsMS.exe")).unwrap(), b"existing game");
            assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1, "no alternate install created");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn empty_legacy_install_dir_preserves_test_and_rc_in_the_electron_default() {
        let default = "C:\\Users\\Player\\AppData\\Local\\SlumsMS";
        for channel in [Channel::Test, Channel::Rc] {
            for saved in [json!({}), json!({ "installDir": "" })] {
                assert_eq!(legacy_install_dir(&saved, "", default), default);
                let record = rec(if channel == Channel::Test { "1.5.0-test" } else { "1.5.0-rc1" }, "X");
                let migration = migrate_legacy_settings(&saved, LIVE, Some(LegacyFolder { holds_game: true, record: Some(&record) }), &Probes::new(), default);
                let q = migration.question.unwrap();
                assert_eq!(q.dir, default);
                assert_eq!(q.suggested, channel);
                let mut declined = migration.settings.clone();
                apply_migration_answer(&mut declined, &q, None);
                assert_ne!(crate::channels::channel_install_dir(Channel::Live, &declined.folders, "", default), default);
                let mut settings = migration.settings;
                assert_ne!(crate::channels::channel_install_dir(Channel::Live, &settings.folders, "", default), default);
                apply_migration_answer(&mut settings, &q, Some(channel));
                assert_eq!(settings.folders.get(channel), default);
                let dirs = crate::channels::CHANNELS.into_iter().map(|c| (c, crate::channels::channel_install_dir(c, &settings.folders, "", default))).collect();
                assert_eq!(crate::channels::folder_owner(default, channel, &dirs, true), None);
            }
        }
        assert_eq!(legacy_install_dir(&json!({}), "D:\\Bundled", default), "D:\\Bundled");
        assert_eq!(legacy_install_dir(&json!({ "installDir": "E:\\Chosen" }), "D:\\Bundled", default), "E:\\Chosen");
    }

    #[test]
    fn an_empty_legacy_test_or_rc_default_is_reserved_for_its_channel() {
        let default = "C:\\Default";
        for channel in [Channel::Test, Channel::Rc] {
            let legacy = json!({ "installDir": "", "feedUrl": crate::channels::channel_feed(LIVE, channel) });
            let migration = migrate_legacy_settings(&legacy, LIVE, Some(LegacyFolder { holds_game: false, record: None }), &Probes::new(), default);
            assert!(migration.question.is_none());
            assert_eq!(migration.settings.folders.get(channel), default);
            assert_ne!(crate::channels::channel_install_dir(Channel::Live, &migration.settings.folders, "", default), default);
        }
    }

    #[test]
    fn the_default_appdata_install_and_a_custom_live_folder_stay_live() {
        let probes: Probes = [(Channel::Live, ok("1.4.1", "L"))].into_iter().collect();
        let m = migrate_legacy_settings(&json!({ "feedUrl": LIVE, "accessKey": "k" }), LIVE, None, &probes, "");
        assert_eq!((m.settings.channel, m.settings.folders.live.as_str(), m.question.is_none(), m.settings.access_key.as_str()), (Channel::Live, "", true, "k"));
        let record = rec("1.4.1", "L");
        let m = migrate_legacy_settings(&json!({ "feedUrl": LIVE, "installDir": "Z:\\MSv83\\testlauncherblehbleh", "pendingGameOptions": { "installDir": "Z:\\MSv83\\testlauncherblehbleh", "changes": { "nobulb": false } } }), LIVE, Some(LegacyFolder { holds_game: true, record: Some(&record) }), &probes, "");
        assert_eq!(m.settings.folders.live, "Z:\\MSv83\\testlauncherblehbleh", "the folder stays exactly where it is");
        assert!(m.question.is_none());
        assert_eq!(m.settings.pending_game_options.unwrap().changes.get("nobulb"), Some(&false));
        // An install the old launcher never recorded, on the live feed, is Live.
        let m = migrate_legacy_settings(&json!({ "installDir": "E:\\Games\\SlumsMS" }), LIVE, Some(LegacyFolder { holds_game: true, record: None }), &probes, "");
        assert_eq!(m.settings.folders.live, "E:\\Games\\SlumsMS");
        // A chosen folder without a game keeps the player's choice.
        let m = migrate_legacy_settings(&json!({ "installDir": "E:\\empty" }), LIVE, Some(LegacyFolder { holds_game: false, record: None }), &probes, "");
        assert_eq!(m.settings.folders.live, "E:\\empty");
    }

    #[test]
    fn polluted_settings_rc_feed_with_a_test_folder_never_become_live_and_ask() {
        let probes: Probes = [(Channel::Live, ok("1.4.1", "L")), (Channel::Test, ok("1.4.1-test", "T")), (Channel::Rc, ok("1.4.0", "R"))].into_iter().collect();
        let record = rec("1.4.1-test", "T");
        let legacy = json!({ "feedUrl": "https://slumspatch.asslorde.com/launcher-rc/manifest.json", "installDir": "Z:\\SlumsMS-test" });
        let m = migrate_legacy_settings(&legacy, LIVE, Some(LegacyFolder { holds_game: true, record: Some(&record) }), &probes, "");
        assert_eq!(m.settings.channel, Channel::Rc);
        assert_eq!(m.settings.folders.live, "");
        let q = m.question.unwrap();
        assert_eq!((q.suggested, q.conflict), (Channel::Test, true));
        assert!(q.message.starts_with("This folder looks like a Test install (1.4.1-test), but the old launcher was set to the RC channel:"), "{}", q.message);
        let mut s = m.settings.clone();
        apply_migration_answer(&mut s, &q, Some(Channel::Test));
        assert_eq!(s.folders.test, "Z:\\SlumsMS-test");
        let mut s = m.settings;
        apply_migration_answer(&mut s, &q, None);
        assert_eq!(s.folders, Folders::default());
    }

    #[test]
    fn a_live_feed_folder_that_holds_an_rc_build_is_asked_about() {
        let probes: Probes = [(Channel::Live, ok("1.4.1", "L")), (Channel::Rc, ok("1.4.2-rc1", "R"))].into_iter().collect();
        let record = rec("1.4.2-rc1", "R");
        let m = migrate_legacy_settings(&json!({ "installDir": "D:\\G" }), LIVE, Some(LegacyFolder { holds_game: true, record: Some(&record) }), &probes, "");
        let q = m.question.unwrap();
        assert_eq!(q.suggested, Channel::Rc);
        assert!(q.message.starts_with("This folder looks like an RC install"));
    }

    #[test]
    fn a_custom_server_stays_the_live_feed_override() {
        let m = migrate_legacy_settings(&json!({ "feedUrl": "https://other.example/manifest.json" }), LIVE, None, &Probes::new(), "");
        assert_eq!((m.settings.feed_url.as_str(), m.settings.channel), ("https://other.example/manifest.json", Channel::Live));
    }

    #[test]
    fn settings_round_trip_and_malformed_fields_are_dropped() {
        let mut s = Settings { access_key: "k".into(), access_user: "slumsdev".into(), channel: Channel::Test, ..Default::default() };
        s.folders.test = "D:\\T".into();
        let file = std::env::temp_dir().join(format!("slums-settings-{}/settings.json", uuid::Uuid::new_v4()));
        write_settings(&file, &s).unwrap();
        assert_eq!(read_settings(&std::fs::read_to_string(&file).unwrap()), s);
        let odd = read_settings(r#"{ "channel": "staging", "accessKey": "bad\u0001", "folders": { "live": "C:\\L" }, "feedUrl": 3 }"#);
        assert_eq!((odd.channel, odd.access_key.as_str(), odd.folders.live.as_str()), (Channel::Live, "", "C:\\L"));
        assert_eq!(read_settings("garbage"), Settings::default());
        std::fs::remove_dir_all(file.parent().unwrap()).unwrap();
    }

    #[test]
    fn asar_files_are_read_from_the_packed_archive() {
        // A minimal asar: [4, headerSize, headerSize-4, jsonSize] + json + payload.
        let payload = br#"{"accessKey":"friends"}"#;
        let json = format!(r#"{{"files":{{"src":{{"files":{{"launcher.config.json":{{"size":{},"offset":"0"}}}}}}}}}}"#, payload.len());
        let json_size = json.len() as u32;
        let header_size = json_size + 8;
        let mut bytes = Vec::new();
        for word in [4u32, header_size, header_size - 4, json_size] {
            bytes.extend_from_slice(&word.to_le_bytes());
        }
        bytes.extend_from_slice(json.as_bytes());
        bytes.resize(8 + header_size as usize, 0);
        bytes.extend_from_slice(payload);
        let file = std::env::temp_dir().join(format!("slums-{}.asar", uuid::Uuid::new_v4()));
        std::fs::write(&file, &bytes).unwrap();
        assert_eq!(read_asar_file(&file, "src/launcher.config.json").unwrap(), payload);
        assert!(read_asar_file(&file, "src/missing.json").is_none());
        std::fs::remove_file(file).unwrap();
    }
}

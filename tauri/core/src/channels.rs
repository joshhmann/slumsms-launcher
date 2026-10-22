//! Build channels (port of the parked ops-channels-electron-wip channels.mjs). One launcher serves
//! Live, Test and RC: each channel is a feed beside the Live one (/manifest.json,
//! /launcher-test/manifest.json, /launcher-rc/manifest.json) with its own game folder,
//! installed.json and launcher update manifest. Which channels a key opens is decided by the
//! server's Basic auth: the launcher probes each channel's top-level manifest (ok = open).

use crate::release::{Available, InstalledRecord};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Live,
    Test,
    Rc,
}

pub const CHANNELS: [Channel; 3] = [Channel::Live, Channel::Test, Channel::Rc];

impl Channel {
    pub fn id(self) -> &'static str {
        match self {
            Channel::Live => "live",
            Channel::Test => "test",
            Channel::Rc => "rc",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Channel::Live => "Live",
            Channel::Test => "Test",
            Channel::Rc => "RC",
        }
    }
    fn prefix(self) -> &'static str {
        match self {
            Channel::Live => "",
            Channel::Test => "launcher-test/",
            Channel::Rc => "launcher-rc/",
        }
    }
    pub fn parse(value: &str) -> Option<Channel> {
        CHANNELS.into_iter().find(|c| c.id() == value)
    }
}

/// Feed URL per channel, derived from the Live manifest URL.
pub fn channel_feed(live_feed_url: &str, channel: Channel) -> String {
    if live_feed_url.is_empty() || channel == Channel::Live {
        return live_feed_url.to_string();
    }
    let Ok(live) = url::Url::parse(live_feed_url) else { return String::new() };
    let name = live.path_segments().and_then(|mut s| s.next_back().map(str::to_string)).filter(|s| !s.is_empty()).unwrap_or_else(|| "manifest.json".into());
    live.join(&format!("{}{name}", channel.prefix())).map(|u| u.to_string()).unwrap_or_default()
}

/// The launcher's own update manifest for a channel (Tauri updater format), beside its game manifest.
/// `tauri/launcher.json` matches the patch server's existing no-cache rule for `launcher.json`.
pub fn update_manifest_url(channel_feed_url: &str) -> String {
    url::Url::parse(channel_feed_url).and_then(|u| u.join("tauri/launcher.json")).map(|u| u.to_string()).unwrap_or_default()
}

/// Which channel a feed URL is (for old settings that stored a raw URL), or None.
pub fn channel_of_feed(feed_url: &str, live_feed_url: &str) -> Option<Channel> {
    let href = url::Url::parse(feed_url).ok()?.to_string();
    CHANNELS.into_iter().find(|c| channel_feed(live_feed_url, *c) == href)
}

pub type Probes = BTreeMap<Channel, Available>;

/// Channels this key opens. Live is always listed: it is every launcher's home.
pub fn accessible_channels(probes: &Probes) -> Vec<Channel> {
    CHANNELS.into_iter().filter(|c| *c == Channel::Live || probes.get(c).is_some_and(Available::is_ok)).collect()
}

/// The channel picker exists only for keys that open more than one channel; players never see it.
pub fn show_channel_picker(probes: &Probes) -> bool {
    accessible_channels(probes).len() > 1
}

/// The channel actually used. A non-Live choice stands while its probe is ok or merely unanswered
/// (offline, not probed yet); a refused or missing channel (401/403, 404, bad answer) falls back to Live.
pub fn effective_channel(selected: Channel, probes: &Probes) -> Channel {
    match probes.get(&selected) {
        _ if selected == Channel::Live => Channel::Live,
        None | Some(Available::Ok { .. }) | Some(Available::Offline { .. }) => selected,
        _ => Channel::Live,
    }
}

/// Probe every channel's top-level manifest. The server decides which Basic-auth user a key belongs
/// to: Live is asked with `preferred` ("slums" unless a dev key was seen before), then with the other
/// user if that is refused. Returns the probes and the user that opened Live (or `preferred`).
pub async fn probe_channels(live_feed_url: &str, key: &str, preferred: &str) -> (Probes, String) {
    use crate::http::{FeedAccess, ACCESS_KEY_USER, DEV_ACCESS_USER};
    use crate::release::{check_available_release, AVAILABLE_TIMEOUT};
    let check = |feed: String, user: String| async move {
        match FeedAccess::new(&feed, key, &user) {
            Ok(access) => check_available_release(&feed, Some(&access), AVAILABLE_TIMEOUT).await,
            Err(e) => Available::Error { message: e.message },
        }
    };
    let preferred = if preferred == DEV_ACCESS_USER { DEV_ACCESS_USER } else { ACCESS_KEY_USER };
    let other = if preferred == DEV_ACCESS_USER { ACCESS_KEY_USER } else { DEV_ACCESS_USER };
    let mut user = preferred.to_string();
    let mut live = check(live_feed_url.to_string(), user.clone()).await;
    if !key.is_empty() && matches!(live, Available::AccessKey { .. }) {
        let retry = check(live_feed_url.to_string(), other.to_string()).await;
        if retry.is_ok() {
            live = retry;
            user = other.to_string();
        }
    }
    let (test, rc) = futures_util::join!(check(channel_feed(live_feed_url, Channel::Test), user.clone()), check(channel_feed(live_feed_url, Channel::Rc), user.clone()));
    ([(Channel::Live, live), (Channel::Test, test), (Channel::Rc, rc)].into_iter().collect(), user)
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Folders {
    #[serde(default)]
    pub live: String,
    #[serde(default)]
    pub test: String,
    #[serde(default)]
    pub rc: String,
}

impl Folders {
    pub fn get(&self, channel: Channel) -> &str {
        match channel {
            Channel::Live => &self.live,
            Channel::Test => &self.test,
            Channel::Rc => &self.rc,
        }
    }
    pub fn set(&mut self, channel: Channel, value: String) {
        match channel {
            Channel::Live => self.live = value,
            Channel::Test => self.test = value,
            Channel::Rc => self.rc = value,
        }
    }
}

/// The game folder for a channel. Live: the folder the player chose, else the launcher's bundled
/// client, else the per-user default (exactly where the Electron launcher installed). Test/RC: their
/// own folder, else "<Live folder>-test" / "<Live folder>-rc" beside it. Nothing is created here.
pub fn channel_install_dir(channel: Channel, saved: &Folders, bundled_dir: &str, standalone_dir: &str) -> String {
    let live = [saved.live.as_str(), bundled_dir, standalone_dir].into_iter().find(|s| !s.is_empty()).unwrap_or("").to_string();
    if channel == Channel::Live {
        return live;
    }
    if !saved.get(channel).is_empty() {
        return saved.get(channel).to_string();
    }
    if live.is_empty() {
        return String::new();
    }
    format!("{}-{}", live.trim_end_matches(['\\', '/']), channel.id())
}

/// Validate a proposed folder change, including defaults that move with Live.
/// Leave the saved folders untouched if any resulting channels would share a path.
pub fn change_folder(saved: &mut Folders, channel: Channel, dir: String, bundled: &str, standalone: &str, windows: bool) -> Result<(), String> {
    let mut proposed = saved.clone();
    proposed.set(channel, dir);
    let dirs: BTreeMap<Channel, String> = CHANNELS.into_iter().map(|c| (c, channel_install_dir(c, &proposed, bundled, standalone))).collect();
    for c in CHANNELS {
        if let Some(owner) = folder_owner(&dirs[&c], c, &dirs, windows) {
            return Err(format!("The {} and {} channels would use the same game folder: {}. Each channel needs its own folder. Choose another folder before resetting or saving.", c.label(), owner.label(), dirs[&c]));
        }
    }
    *saved = proposed;
    Ok(())
}

fn folder_key(dir: &str, windows: bool) -> String {
    let trimmed = dir.trim_end_matches(['\\', '/']);
    if windows {
        trimmed.replace('/', "\\").to_lowercase()
    } else {
        trimmed.to_string()
    }
}

/// The other channel already using `dir`, if any: two channels must never share a folder.
pub fn folder_owner(dir: &str, channel: Channel, dirs: &BTreeMap<Channel, String>, windows: bool) -> Option<Channel> {
    let key = folder_key(dir, windows);
    CHANNELS.into_iter().find(|c| *c != channel && dirs.get(c).is_some_and(|d| !d.is_empty() && folder_key(d, windows) == key))
}

fn has_rc_token(release: &str) -> bool {
    // (^|[^a-z])rc\d*($|[^a-z]), case-insensitive
    let lower = release.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut i = 0;
    while let Some(found) = lower[i..].find("rc") {
        let at = i + found;
        let before_ok = at == 0 || !bytes[at - 1].is_ascii_lowercase();
        let mut end = at + 2;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        let after_ok = end == bytes.len() || !bytes[end].is_ascii_lowercase();
        if before_ok && after_ok {
            return true;
        }
        i = at + 1;
    }
    false
}

/// Which channel an existing game folder looks like, from its installed.json record and what the
/// server offers now: the exact manifest first, then a unique release name, then the name's own
/// hint ("-rc", "test"). None when the folder gives no signal.
pub fn folder_channel(record: Option<&InstalledRecord>, probes: &Probes) -> Option<Channel> {
    let record = record?;
    let offered = |c: &Channel| probes.get(c).filter(|a| a.is_ok());
    if !record.manifest_sha256.is_empty() {
        if let Some(exact) = CHANNELS.into_iter().find(|c| offered(c).and_then(Available::manifest_sha256) == Some(record.manifest_sha256.as_str())) {
            return Some(exact);
        }
    }
    // Test and RC often carry the same release name as Live at a release; only a unique match counts.
    let by_name: Vec<Channel> = CHANNELS.into_iter().filter(|c| offered(c).and_then(Available::version) == Some(record.release.as_str())).collect();
    if by_name.len() == 1 {
        return Some(by_name[0]);
    }
    if has_rc_token(&record.release) {
        return Some(Channel::Rc);
    }
    if record.release.to_ascii_lowercase().contains("test") {
        return Some(Channel::Test);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::release::NameVersion;

    const LIVE: &str = "https://slumspatch.asslorde.com/manifest.json";

    fn ok(version: &str, sha: &str) -> Available {
        Available::Ok { version: version.into(), layers: Vec::<NameVersion>::new(), manifest_sha256: sha.into() }
    }
    fn denied() -> Available {
        Available::AccessKey { message: "x".into() }
    }
    fn probes(list: &[(Channel, Available)]) -> Probes {
        list.iter().cloned().collect()
    }

    #[test]
    fn resetting_folders_checks_every_resulting_default_before_saving() {
        for other in [Channel::Test, Channel::Rc] {
            for collision in ["C:\\Default", "C:\\Default-test", "C:\\Default-rc"] {
                let mut folders = Folders::default();
                folders.live = "D:\\Custom".into();
                folders.set(other, collision.into());
                let before = folders.clone();
                let result = change_folder(&mut folders, Channel::Live, String::new(), "", "C:\\Default", true);
                let conflicts = collision == "C:\\Default" || (other == Channel::Test && collision.ends_with("-rc")) || (other == Channel::Rc && collision.ends_with("-test"));
                assert_eq!(result.is_err(), conflicts, "{other:?}: {collision}");
                if conflicts {
                    assert_eq!(folders, before);
                    assert!(result.unwrap_err().contains("Each channel needs its own folder"));
                }
            }
        }
        let mut folders = Folders { live: "C:\\Game".into(), test: "D:\\Test".into(), rc: "c:/GAME-test/".into() };
        let before = folders.clone();
        assert!(change_folder(&mut folders, Channel::Test, String::new(), "", "C:\\Default", true).is_err());
        assert_eq!(folders, before);
    }

    #[test]
    fn channel_feeds_sit_beside_the_live_manifest() {
        assert_eq!(channel_feed(LIVE, Channel::Live), LIVE);
        assert_eq!(channel_feed(LIVE, Channel::Test), "https://slumspatch.asslorde.com/launcher-test/manifest.json");
        assert_eq!(channel_feed(LIVE, Channel::Rc), "https://slumspatch.asslorde.com/launcher-rc/manifest.json");
        assert_eq!(channel_of_feed("https://slumspatch.asslorde.com/launcher-rc/manifest.json", LIVE), Some(Channel::Rc));
        assert_eq!(channel_of_feed("https://elsewhere.example/manifest.json", LIVE), None);
        assert_eq!(update_manifest_url(&channel_feed(LIVE, Channel::Test)), "https://slumspatch.asslorde.com/launcher-test/tauri/launcher.json");
        assert_eq!(update_manifest_url(LIVE), "https://slumspatch.asslorde.com/tauri/launcher.json");
        assert_eq!(channel_feed("http://127.0.0.1:9/feed/manifest.json", Channel::Rc), "http://127.0.0.1:9/feed/launcher-rc/manifest.json");
    }

    #[test]
    fn a_player_key_opens_live_only_and_the_dev_key_opens_all_three() {
        let player = probes(&[(Channel::Live, ok("1.4.1", "a")), (Channel::Test, denied()), (Channel::Rc, denied())]);
        assert_eq!(accessible_channels(&player), vec![Channel::Live]);
        assert!(!show_channel_picker(&player));
        let dev = probes(&[(Channel::Live, ok("1.4.1", "a")), (Channel::Test, ok("1.4.2", "b")), (Channel::Rc, ok("1.4.2", "c"))]);
        assert_eq!(accessible_channels(&dev), CHANNELS.to_vec());
        assert!(show_channel_picker(&dev));
        // Live stays listed even when the live probe itself fails (offline).
        assert_eq!(accessible_channels(&probes(&[(Channel::Live, Available::Offline { message: String::new() })])), vec![Channel::Live]);
    }

    #[test]
    fn a_refused_channel_falls_back_to_live_while_offline_keeps_the_choice() {
        assert_eq!(effective_channel(Channel::Rc, &probes(&[(Channel::Rc, denied())])), Channel::Live);
        assert_eq!(effective_channel(Channel::Rc, &probes(&[(Channel::Rc, Available::Error { message: "404".into() })])), Channel::Live);
        assert_eq!(effective_channel(Channel::Rc, &probes(&[(Channel::Rc, Available::Offline { message: String::new() })])), Channel::Rc);
        assert_eq!(effective_channel(Channel::Test, &Probes::new()), Channel::Test);
    }

    #[test]
    fn per_channel_folders_default_beside_live_and_never_share() {
        let standalone = "C:\\Users\\p\\AppData\\Local\\SlumsMS";
        let none = Folders::default();
        assert_eq!(channel_install_dir(Channel::Live, &none, "", standalone), standalone);
        assert_eq!(channel_install_dir(Channel::Test, &none, "", standalone), format!("{standalone}-test"));
        let saved = Folders { live: "D:\\Maple\\".into(), ..Default::default() };
        assert_eq!(channel_install_dir(Channel::Rc, &saved, "", standalone), "D:\\Maple-rc");
        assert_eq!(channel_install_dir(Channel::Live, &none, "E:\\Bundled", standalone), "E:\\Bundled");
        let dirs: BTreeMap<Channel, String> = [(Channel::Live, "D:\\Maple".to_string())].into_iter().collect();
        assert_eq!(folder_owner("d:\\maple\\", Channel::Rc, &dirs, true), Some(Channel::Live));
        assert_eq!(folder_owner("d:\\maple", Channel::Live, &dirs, true), None);
    }

    #[test]
    fn folder_channel_exact_manifest_then_unique_name_then_hint() {
        let p = probes(&[(Channel::Live, ok("1.4.1", "L")), (Channel::Rc, ok("1.4.1", "R"))]);
        let rec = |release: &str, sha: &str| InstalledRecord { release: release.into(), manifest_sha256: sha.into(), layers: vec![], verified_at: String::new(), launch: None };
        assert_eq!(folder_channel(Some(&rec("1.4.1", "R")), &p), Some(Channel::Rc));
        assert_eq!(folder_channel(Some(&rec("1.4.1", "X")), &p), None);
        assert_eq!(folder_channel(Some(&rec("1.4.2-rc1", "X")), &p), Some(Channel::Rc));
        assert_eq!(folder_channel(Some(&rec("1.4.1-test", "X")), &p), Some(Channel::Test));
        assert_eq!(folder_channel(Some(&rec("source", "X")), &p), None, "'rc' inside a word is no hint");
        assert_eq!(folder_channel(None, &p), None);
    }
}

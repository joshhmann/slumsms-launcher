//! launcher.config.json (built in, optionally overridden beside the exe), feed URL and access-key
//! rules, bundled-client detection and the standalone default folder. Port of launcher-config.mjs.

use crate::error::{Error, Result};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const DEFAULT_DOWNLOAD_CONCURRENCY: usize = 12;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LauncherConfig {
    pub feed_url: String,
    pub client_executable: String,
    pub download_concurrency: usize,
    pub access_key: String,
}

impl Default for LauncherConfig {
    fn default() -> Self {
        LauncherConfig { feed_url: String::new(), client_executable: String::new(), download_concurrency: DEFAULT_DOWNLOAD_CONCURRENCY, access_key: String::new() }
    }
}

/// Normalize a release feed URL; only HTTPS, or HTTP on localhost for development.
pub fn validate_feed_url(value: &str) -> Result<String> {
    let url = url::Url::parse(value).map_err(|_| Error::permanent("Use a complete HTTPS URL, or localhost HTTP for development."))?;
    let local = matches!(url.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]"));
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        return Err(Error::permanent("Use HTTPS, or HTTP on localhost for development."));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Error::permanent("The update server URL cannot contain a user name or key; enter the key under Access key."));
    }
    Ok(url.to_string())
}

/// An access key is the HTTP Basic password; empty means none.
pub fn valid_access_key(value: &str) -> bool {
    crate::manifest::js_len(value) <= 256 && !value.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f)
}

/// The player's saved key wins; otherwise the built-in key, but only while the feed is on the
/// built-in feed's origin, so a custom server never receives the shipped key.
pub fn effective_access_key(saved: &str, default_key: &str, feed_url: &str, default_feed_url: &str) -> String {
    if !saved.is_empty() {
        return saved.to_string();
    }
    if default_key.is_empty() || feed_url.is_empty() || default_feed_url.is_empty() {
        return String::new();
    }
    match (url::Url::parse(feed_url), url::Url::parse(default_feed_url)) {
        (Ok(a), Ok(b)) if a.origin() == b.origin() => default_key.to_string(),
        _ => String::new(),
    }
}

/// Apply config files in order (later override earlier); `None` text means the file is missing.
pub fn read_launcher_config(files: &[(String, Option<String>)]) -> Result<LauncherConfig> {
    let mut config = LauncherConfig::default();
    for (label, text) in files {
        let Some(text) = text else { continue };
        let value: Value = serde_json::from_str(text).map_err(|_| Error::permanent(format!("Launcher config is not valid JSON: {label}")))?;
        if !value.is_object() {
            return Err(Error::permanent(format!("Launcher config must be a JSON object: {label}")));
        }
        if let Some(feed) = value.get("feedUrl").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            config.feed_url = validate_feed_url(feed).map_err(|e| Error::permanent(format!("Launcher config feedUrl is invalid in {label}: {}", e.message)))?;
        }
        if let Some(name) = value.get("clientExecutable").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            if name == "." || name == ".." || name.contains('/') || name.contains('\\') {
                return Err(Error::permanent(format!("Launcher config clientExecutable must be a file name in {label}.")));
            }
            config.client_executable = name.to_string();
        }
        if let Some(key) = value.get("accessKey") {
            match key.as_str() {
                Some(k) if valid_access_key(k) => config.access_key = k.to_string(),
                _ => return Err(Error::permanent(format!("Launcher config accessKey must be a string without control characters in {label}."))),
            }
        }
        if let Some(count) = value.get("downloadConcurrency") {
            match crate::manifest::safe_integer(count) {
                Some(n) if (1..=32).contains(&n) => config.download_concurrency = n as usize,
                _ => return Err(Error::permanent(format!("Launcher config downloadConcurrency must be an integer from 1 to 32 in {label}."))),
            }
        }
    }
    Ok(config)
}

/// A client shipped with the launcher: the launcher's own folder, or its parent when shipped in a subfolder.
pub fn detect_bundled_client(launcher_dir: &Path, client_executable: &str) -> Option<PathBuf> {
    if client_executable.is_empty() {
        return None;
    }
    [Some(launcher_dir), launcher_dir.parent()].into_iter().flatten().find(|dir| dir.join(client_executable).is_file()).map(Path::to_path_buf)
}

/// Default folder for a standalone install; per-user so it never needs elevation.
pub fn standalone_install_dir(home: &Path, local_app_data: Option<&Path>) -> PathBuf {
    local_app_data.unwrap_or(home).join("SlumsMS")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(label: &str, text: Option<&str>) -> (String, Option<String>) {
        (label.into(), text.map(str::to_string))
    }

    #[test]
    fn config_files_layer_in_order_skip_missing_and_validate() {
        let config = read_launcher_config(&[
            file("built-in", Some(r#"{ "feedUrl": "https://slumspatch.asslorde.com/manifest.json", "clientExecutable": "SlumsMS.exe", "downloadConcurrency": 12, "accessKey": "" }"#)),
            file("missing", None),
            file("beside", Some(r#"{ "downloadConcurrency": 4, "accessKey": "k" }"#)),
        ])
        .unwrap();
        assert_eq!(config, LauncherConfig { feed_url: "https://slumspatch.asslorde.com/manifest.json".into(), client_executable: "SlumsMS.exe".into(), download_concurrency: 4, access_key: "k".into() });
        for bad in [r#"{ "feedUrl": "http://example.com/m.json" }"#, r#"{ "clientExecutable": "a/b.exe" }"#, r#"{ "downloadConcurrency": 33 }"#, r#"{ "accessKey": "a\u0001" }"#, "[]", "{"] {
            assert!(read_launcher_config(&[file("x", Some(bad))]).is_err(), "{bad}");
        }
    }

    #[test]
    fn feed_urls_require_https_except_localhost_and_never_carry_credentials() {
        assert_eq!(validate_feed_url("https://slumspatch.asslorde.com/manifest.json").unwrap(), "https://slumspatch.asslorde.com/manifest.json");
        assert!(validate_feed_url("http://localhost:8080/m.json").is_ok());
        assert!(validate_feed_url("http://127.0.0.1/m.json").is_ok());
        assert!(validate_feed_url("http://example.com/m.json").is_err());
        assert!(validate_feed_url("https://slums:key@example.com/m.json").is_err());
        assert!(validate_feed_url("not a url").is_err());
    }

    #[test]
    fn saved_key_overrides_and_the_built_in_key_only_goes_to_the_built_in_origin() {
        let live = "https://slumspatch.asslorde.com/manifest.json";
        assert_eq!(effective_access_key("mine", "built", live, live), "mine");
        assert_eq!(effective_access_key("", "built", live, live), "built");
        assert_eq!(effective_access_key("", "built", "https://slumspatch.asslorde.com/launcher-rc/manifest.json", live), "built");
        assert_eq!(effective_access_key("", "built", "https://elsewhere.example/manifest.json", live), "");
        assert_eq!(effective_access_key("", "", live, live), "");
    }

    #[test]
    fn bundled_client_beside_or_above_and_standalone_default() {
        let dir = std::env::temp_dir().join(format!("slums-bundled-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("Launcher")).unwrap();
        assert_eq!(detect_bundled_client(&dir.join("Launcher"), "SlumsMS.exe"), None);
        std::fs::write(dir.join("SlumsMS.exe"), b"x").unwrap();
        assert_eq!(detect_bundled_client(&dir.join("Launcher"), "SlumsMS.exe"), Some(dir.clone()));
        assert_eq!(detect_bundled_client(&dir, "SlumsMS.exe"), Some(dir.clone()));
        assert_eq!(detect_bundled_client(&dir, ""), None);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(standalone_install_dir(Path::new("/home/p"), Some(Path::new("/l"))), PathBuf::from("/l/SlumsMS"));
        assert_eq!(standalone_install_dir(Path::new("/home/p"), None), PathBuf::from("/home/p/SlumsMS"));
    }

    #[test]
    fn shipped_defaults_point_at_the_live_https_feed_without_a_key() {
        let text = include_str!("../../launcher.config.json");
        let config = read_launcher_config(&[file("built-in", Some(text))]).unwrap();
        assert_eq!(config.feed_url, "https://slumspatch.asslorde.com/manifest.json");
        assert_eq!(config.client_executable, "SlumsMS.exe");
        assert_eq!(config.access_key, "", "players enter the key in Settings; none is built in");
    }
}

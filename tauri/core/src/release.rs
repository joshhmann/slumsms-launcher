//! Loading releases (top-level manifest + verified layer manifests, with a per-install layer cache),
//! the availability check, and the two bookkeeping files: state.json (hash cache) and
//! installed.json (what this folder last fully verified as). Formats are identical to the Electron
//! launcher's, so an existing install keeps its fast verify and its "installed" version.

use crate::error::{Error, Result, ACCESS_KEY_REQUIRED};
use crate::fsutil::{read_small_file, sha256_hex, write_small_file};
use crate::http::{network_url, parse_json, read_bytes, FeedAccess, ACCESS_KEY_MESSAGE};
use crate::manifest::{merge_layers, validate_launch, validate_layer_manifest, validate_manifest, FileEntry, Launch, News, STATE_DIRECTORY};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub const STATE_FILE: &str = ".slumsms-launcher/state.json";
pub const INSTALLED_FILE: &str = ".slumsms-launcher/installed.json";
const LAYER_CACHE: &str = ".slumsms-launcher/layers";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LayerInfo {
    pub name: String,
    pub version: String,
    pub sha256: String,
    pub cached: bool,
}

#[derive(Debug, Clone)]
pub struct LayerSource {
    pub sha256: String,
    pub request_url: String,
    pub final_url: String,
    pub bytes: Vec<u8>,
    pub cached: bool,
}

#[derive(Debug, Clone)]
pub struct PacksSource {
    pub url: String,
    pub sha256: String,
}

/// One layer's files as loaded, for pack planning.
#[derive(Debug, Clone)]
pub struct LayerPart {
    pub layer: String,
    pub version: String,
    pub manifest_sha256: String,
    pub files: Vec<FileEntry>,
    pub packs: Option<PacksSource>,
}

/// A loaded, verified release. `manifest_sha256` is empty for the launcher's own channel.
#[derive(Debug, Clone)]
pub struct Release {
    pub schema_version: u8,
    pub version: String,
    pub manifest_sha256: String,
    pub launch: Launch,
    pub player_owned: Vec<String>,
    pub news: Option<Vec<News>>,
    pub layers: Vec<LayerInfo>,
    pub files: Vec<FileEntry>,
    pub layer_sources: Vec<LayerSource>,
    pub layer_parts: Vec<LayerPart>,
    pub access: FeedAccess,
}

#[derive(Serialize, Deserialize)]
struct CachedLayer {
    #[serde(rename = "requestUrl")]
    request_url: String,
    #[serde(rename = "finalUrl")]
    final_url: String,
    body: String,
}

fn layer_cache_path(digest: &str) -> String {
    format!("{LAYER_CACHE}/{digest}.json")
}

fn cached_layer(install_dir: Option<&str>, sha256: &str, request_url: &str) -> Option<(Vec<u8>, String)> {
    let bytes = read_small_file(install_dir?, &layer_cache_path(sha256)).ok()??;
    let value: CachedLayer = serde_json::from_slice(&bytes).ok()?;
    if value.request_url != request_url {
        return None;
    }
    let body = value.body.into_bytes();
    if sha256_hex(&body) != sha256 {
        return None;
    }
    network_url(&value.final_url).ok()?;
    Some((body, value.final_url))
}

/// Keep verified layer manifests so unchanged layers are not downloaded again; drop stale ones.
pub fn write_layer_cache(root: &Path, release: &Release) -> Result<()> {
    if release.layer_sources.is_empty() {
        return Ok(());
    }
    let mut keep = std::collections::HashSet::new();
    for source in &release.layer_sources {
        keep.insert(format!("{}.json", source.sha256));
        if source.cached {
            continue;
        }
        let body = String::from_utf8(source.bytes.clone()).map_err(|_| Error::permanent("Layer manifest is not UTF-8."))?;
        let value = CachedLayer { request_url: source.request_url.clone(), final_url: source.final_url.clone(), body };
        write_small_file(root, &layer_cache_path(&source.sha256), &serde_json::to_vec(&value).expect("json"))?;
    }
    let directory = root.join(STATE_DIRECTORY).join("layers");
    if let Ok(list) = std::fs::read_dir(&directory) {
        for entry in list.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".json") && !keep.contains(&name) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

fn resolve(base: &str, relative: &str) -> Result<String> {
    let base = url::Url::parse(base).map_err(|_| Error::permanent("Invalid base URL."))?;
    Ok(base.join(relative).map_err(|_| Error::permanent("Invalid relative URL."))?.to_string())
}

/// Load a release. schemaVersion 2 fetches each layer manifest (verified against the top-level
/// SHA-256) unless an identical layer manifest is cached in `install_dir`.
pub async fn load_release(feed_url: &str, install_dir: Option<&str>, access: &FeedAccess, cancel: &CancellationToken) -> Result<Release> {
    let (top_bytes, top_url) = read_bytes(network_url(feed_url)?.as_str(), "release manifest", Some(access), cancel, None).await?;
    let manifest = validate_manifest(&parse_json(&top_bytes, "release manifest")?)?;
    let top_final = top_url.to_string();
    let mut layers = Vec::new();
    let mut layer_sources = Vec::new();
    let mut layer_parts = Vec::new();
    let files = if manifest.schema_version == 1 {
        let mut out = Vec::new();
        for file in &manifest.files {
            out.push(FileEntry { path: file.path.clone(), size: file.size, sha256: file.sha256.clone(), url: resolve(&top_final, &file.url)?, layer: String::new() });
        }
        out
    } else {
        let mut parts = Vec::new();
        for reference in &manifest.layers {
            let request_url = resolve(&top_final, &reference.manifest_url)?;
            let cached = cached_layer(install_dir, &reference.sha256, &request_url);
            let was_cached = cached.is_some();
            let (bytes, final_url) = match cached {
                Some(found) => found,
                None => {
                    let (bytes, url) = read_bytes(&request_url, &format!("layer manifest {}", reference.name), Some(access), cancel, None).await?;
                    if sha256_hex(&bytes) != reference.sha256 {
                        return Err(Error::permanent(format!("Layer manifest {}@{} failed SHA-256 verification.", reference.name, reference.version)));
                    }
                    (bytes, url.to_string())
                }
            };
            let layer = validate_layer_manifest(&parse_json(&bytes, &format!("layer manifest {}", reference.name))?, Some((&reference.name, &reference.version)))?;
            let mut layer_files = Vec::with_capacity(layer.files.len());
            for file in &layer.files {
                layer_files.push(FileEntry { path: file.path.clone(), size: file.size, sha256: file.sha256.clone(), url: resolve(&final_url, &file.url)?, layer: layer.layer.clone() });
            }
            parts.push((layer.layer.clone(), layer_files.clone()));
            let packs = match &reference.packs {
                Some(p) => Some(PacksSource { url: resolve(&top_final, &p.url)?, sha256: p.sha256.clone() }),
                None => None,
            };
            layer_parts.push(LayerPart { layer: layer.layer.clone(), version: layer.version.clone(), manifest_sha256: reference.sha256.clone(), files: layer_files, packs });
            layers.push(LayerInfo { name: reference.name.clone(), version: reference.version.clone(), sha256: reference.sha256.clone(), cached: was_cached });
            layer_sources.push(LayerSource { sha256: reference.sha256.clone(), request_url, final_url, bytes, cached: was_cached });
        }
        let files = merge_layers(&parts)?;
        if !files.iter().any(|f| f.path == manifest.launch.executable) {
            return Err(Error::permanent("Launch executable must be listed with identical spelling in a release layer."));
        }
        files
    };
    Ok(Release {
        schema_version: manifest.schema_version,
        version: manifest.version,
        manifest_sha256: sha256_hex(&top_bytes),
        launch: manifest.launch,
        player_owned: manifest.player_owned.unwrap_or_default(),
        news: manifest.news,
        layers,
        files,
        layer_sources,
        layer_parts,
        access: access.clone(),
    })
}

/// What the server offers right now, from the top-level manifest only. Never fails.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum Available {
    Ok {
        version: String,
        layers: Vec<NameVersion>,
        #[serde(rename = "manifestSha256")]
        manifest_sha256: String,
    },
    AccessKey { message: String },
    Offline { message: String },
    Error { message: String },
}

impl Available {
    pub fn status(&self) -> &'static str {
        match self {
            Available::Ok { .. } => "ok",
            Available::AccessKey { .. } => "access-key",
            Available::Offline { .. } => "offline",
            Available::Error { .. } => "error",
        }
    }
    pub fn message(&self) -> String {
        match self {
            Available::Ok { version, .. } => version.clone(),
            Available::AccessKey { message } | Available::Offline { message } | Available::Error { message } => message.clone(),
        }
    }
    pub fn is_ok(&self) -> bool {
        matches!(self, Available::Ok { .. })
    }
    pub fn manifest_sha256(&self) -> Option<&str> {
        match self {
            Available::Ok { manifest_sha256, .. } => Some(manifest_sha256),
            _ => None,
        }
    }
    pub fn version(&self) -> Option<&str> {
        match self {
            Available::Ok { version, .. } => Some(version),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NameVersion {
    pub name: String,
    pub version: String,
}

pub const AVAILABLE_TIMEOUT: Duration = Duration::from_secs(15);

pub async fn check_available_release(feed_url: &str, access: Option<&FeedAccess>, timeout: Duration) -> Available {
    let cancel = CancellationToken::new();
    let work = async {
        let url = network_url(feed_url)?;
        let (bytes, _) = read_bytes(url.as_str(), "release manifest", access, &cancel, Some(timeout)).await?;
        let manifest = validate_manifest(&parse_json(&bytes, "release manifest")?)?;
        Ok::<_, Error>(Available::Ok {
            version: manifest.version,
            layers: manifest.layers.iter().map(|l| NameVersion { name: l.name.clone(), version: l.version.clone() }).collect(),
            manifest_sha256: sha256_hex(&bytes),
        })
    };
    match work.await {
        Ok(available) => available,
        Err(error) if error.is(ACCESS_KEY_REQUIRED) => Available::AccessKey { message: ACCESS_KEY_MESSAGE.into() },
        Err(error) if error.network && error.status.is_none() => Available::Offline { message: "Could not reach the update server.".into() },
        Err(error) => Available::Error { message: error.message },
    }
}

// ---------------------------------------------------------------------------------------------
// state.json: { stateVersion: 1, release, layers, files: { path: { size, mtimeMs, sha256 } } }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StateEntry {
    pub size: u64,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: f64,
    pub sha256: String,
}

#[derive(Debug, Default)]
pub struct InstallState {
    pub release: String,
    pub files: HashMap<String, StateEntry>,
}

/// The per-install verification state; a cache, so anything unreadable reads as empty.
pub fn read_install_state(root: &str) -> InstallState {
    let Ok(Some(bytes)) = read_small_file(root, STATE_FILE) else { return InstallState::default() };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else { return InstallState::default() };
    if value.get("stateVersion").and_then(Value::as_i64) != Some(1) || !value.get("files").is_some_and(Value::is_object) {
        return InstallState::default();
    }
    let mut files = HashMap::new();
    for (name, entry) in value["files"].as_object().unwrap() {
        let size = entry.get("size").and_then(crate::manifest::safe_integer);
        let mtime = entry.get("mtimeMs").and_then(Value::as_f64);
        let sha = entry.get("sha256").and_then(Value::as_str);
        if let (Some(size), Some(mtime), Some(sha)) = (size, mtime, sha) {
            if size >= 0 && mtime.is_finite() {
                files.insert(name.clone(), StateEntry { size: size as u64, mtime_ms: mtime, sha256: sha.to_string() });
            }
        }
    }
    InstallState { release: value.get("release").and_then(Value::as_str).unwrap_or("").to_string(), files }
}

pub fn write_install_state(root: &Path, release: &Release, verified: &HashMap<String, StateEntry>) -> Result<()> {
    let mut files = Map::new();
    for file in &release.files {
        if let Some(entry) = verified.get(&file.path) {
            files.insert(file.path.clone(), serde_json::to_value(entry).expect("json"));
        }
    }
    let value = json!({
        "stateVersion": 1,
        "release": release.version,
        "layers": release.layers.iter().map(|l| json!({ "name": l.name, "version": l.version, "sha256": l.sha256 })).collect::<Vec<_>>(),
        "files": files,
    });
    write_small_file(root, STATE_FILE, &serde_json::to_vec(&value).expect("json"))
}

// ---------------------------------------------------------------------------------------------
// installed.json: { recordVersion: 1, release, manifestSha256, layers, verifiedAt, launch? }

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InstalledRecord {
    pub release: String,
    #[serde(rename = "manifestSha256")]
    pub manifest_sha256: String,
    pub layers: Vec<RecordLayer>,
    #[serde(rename = "verifiedAt")]
    pub verified_at: String,
    pub launch: Option<Launch>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RecordLayer {
    pub name: String,
    pub version: String,
    pub sha256: String,
}

/// None when there is no record or it is unreadable, so the launcher shows "Unknown".
pub fn read_installed_record(root: &str) -> Option<InstalledRecord> {
    let bytes = read_small_file(root, INSTALLED_FILE).ok()??;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    let release = value.get("release")?.as_str()?;
    if value.get("recordVersion").and_then(Value::as_i64) != Some(1) || release.is_empty() || crate::manifest::js_len(release) > 128 {
        return None;
    }
    let layers = value.get("layers").and_then(Value::as_array).map(|list| {
        list.iter()
            .filter_map(|l| {
                Some(RecordLayer {
                    name: l.get("name")?.as_str()?.to_string(),
                    version: l.get("version")?.as_str()?.to_string(),
                    sha256: l.get("sha256").and_then(Value::as_str).unwrap_or("").to_string(),
                })
            })
            .collect()
    });
    let launch = match value.get("launch") {
        None | Some(Value::Null) => None,
        Some(l) => validate_launch(l).ok(),
    };
    Some(InstalledRecord {
        release: release.to_string(),
        manifest_sha256: value.get("manifestSha256").and_then(Value::as_str).unwrap_or("").to_string(),
        layers: layers.unwrap_or_default(),
        verified_at: value.get("verifiedAt").and_then(Value::as_str).unwrap_or("").to_string(),
        launch,
    })
}

pub fn iso_now() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs() as i64;
    let millis = now.subsec_millis();
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

pub fn write_installed_record(root: &Path, release: &Release) -> Result<()> {
    let value = json!({
        "recordVersion": 1,
        "release": release.version,
        "manifestSha256": release.manifest_sha256,
        "layers": release.layers.iter().map(|l| json!({ "name": l.name, "version": l.version, "sha256": l.sha256 })).collect::<Vec<_>>(),
        "verifiedAt": iso_now(),
        "launch": { "executable": release.launch.executable, "args": release.launch.args },
    });
    write_small_file(root, INSTALLED_FILE, &serde_json::to_vec(&value).expect("json"))
}

/// Record a fully verified release, skipping the write when the record already says so.
pub fn record_installed(root: &Path, release: &Release) -> Result<()> {
    if release.manifest_sha256.is_empty() {
        return Ok(()); // the launcher's own channel is not a game release
    }
    if let Some(current) = read_installed_record(&root.to_string_lossy()) {
        if current.release == release.version && current.manifest_sha256 == release.manifest_sha256 && current.launch.is_some() {
            return Ok(());
        }
    }
    write_installed_record(root, release)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_dates_look_like_javascript() {
        let now = iso_now();
        assert_eq!(now.len(), 24);
        assert!(now.ends_with('Z') && now.as_bytes()[10] == b'T');
    }

    #[test]
    fn available_serializes_like_the_electron_status_objects() {
        let ok = Available::Ok { version: "1.4.1".into(), layers: vec![NameVersion { name: "base".into(), version: "v83".into() }], manifest_sha256: "ab".into() };
        assert_eq!(serde_json::to_value(&ok).unwrap(), json!({ "status": "ok", "version": "1.4.1", "layers": [{ "name": "base", "version": "v83" }], "manifestSha256": "ab" }));
        assert_eq!(serde_json::to_value(Available::AccessKey { message: "m".into() }).unwrap(), json!({ "status": "access-key", "message": "m" }));
    }
}

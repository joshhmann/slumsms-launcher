//! Release manifest validation: a straight port of updater.mjs (schemaVersion 1 and 2 top-level
//! manifests, layer manifests, launcher channel files), including every path and URL rule.

use crate::error::{Error, Result};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use unicode_normalization::UnicodeNormalization;

/// Launcher bookkeeping inside an installation; manifests may never write here.
pub const STATE_DIRECTORY: &str = ".slumsms-launcher";
pub const STAGE_PREFIX: &str = ".mapleroot-stage-";
pub const MAX_LAYERS: usize = 16;

/// Windows compares names case-insensitively after normalisation.
pub fn windows_key(name: &str) -> String {
    name.nfc().collect::<String>().to_uppercase()
}

/// JavaScript string length (UTF-16 code units), so limits match the Electron launcher exactly.
pub fn js_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// Number.isSafeInteger for a JSON value (accepts 5 and 5.0 like JavaScript does).
pub fn safe_integer(value: &Value) -> Option<i64> {
    const MAX: i64 = 9_007_199_254_740_991;
    if let Some(v) = value.as_i64() {
        return (-MAX..=MAX).contains(&v).then_some(v);
    }
    if let Some(v) = value.as_u64() {
        return (v <= MAX as u64).then_some(v as i64);
    }
    let v = value.as_f64()?;
    (v.fract() == 0.0 && v.abs() <= MAX as f64).then_some(v as i64)
}

fn is_device(part: &str) -> bool {
    let first = part.split('.').next().unwrap_or("");
    let device = first.trim_end_matches(' ').to_uppercase();
    matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$")
        || ((device.starts_with("COM") || device.starts_with("LPT")) && {
            let rest: Vec<char> = device.chars().skip(3).collect();
            rest.len() == 1 && matches!(rest[0], '1'..='9' | '¹' | '²' | '³')
        })
}

/// A nonempty forward-slash relative path whose every component is a safe Windows name.
pub fn relative_path(value: &str, label: &str) -> Result<String> {
    if value.is_empty() || value.contains('\\') {
        return Err(Error::permanent(format!("{label} must be a nonempty, forward-slash relative path.")));
    }
    for part in value.split('/') {
        let bad_char = part.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || (c as u32) < 0x20);
        if part.is_empty() || part == "." || part == ".." || bad_char || part.ends_with('.') || part.ends_with(' ') || is_device(part) {
            return Err(Error::permanent(format!(
                "{label} contains an unsafe Windows path component: {}.",
                serde_json::to_string(part).unwrap_or_default()
            )));
        }
    }
    Ok(value.to_string())
}

/// A managed file path: safe, and outside the launcher's own state and staging directories.
pub fn managed_path(value: &str, label: &str) -> Result<String> {
    relative_path(value, label)?;
    let first = windows_key(value.split('/').next().unwrap_or(""));
    if first == windows_key(STATE_DIRECTORY) || first.starts_with(&windows_key(STAGE_PREFIX)) {
        return Err(Error::permanent(format!("{label} uses a directory reserved for the launcher.")));
    }
    Ok(value.to_string())
}

fn managed_value(value: &Value, label: &str) -> Result<String> {
    match value.as_str() {
        Some(s) => managed_path(s, label),
        None => Err(Error::permanent(format!("{label} must be a nonempty, forward-slash relative path."))),
    }
}

/// A single safe Windows path component (layer versions, release folder names).
pub fn safe_component(value: &Value, label: &str) -> Result<String> {
    match value.as_str() {
        Some(s) if !s.contains('/') => relative_path(s, label),
        _ => Err(Error::permanent(format!("{label} must be a single safe directory name."))),
    }
}

/// Layer names: 1-64 ASCII letters, digits, '-' or '_'.
pub fn layer_name(value: &Value, label: &str) -> Result<String> {
    let ok = value.as_str().filter(|s| {
        let bytes = s.as_bytes();
        !bytes.is_empty()
            && bytes.len() <= 64
            && bytes[0].is_ascii_alphanumeric()
            && bytes.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'-' || *b == b'_')
    });
    ok.map(str::to_string).ok_or_else(|| Error::permanent(format!("{label} must be 1-64 letters, digits, '-' or '_'.")))
}

/// An encoded relative URL without a scheme, fragment or protocol-relative host.
pub fn relative_url(value: &Value, label: &str) -> Result<String> {
    let bad = || Error::permanent(format!("{label} must be an encoded relative URL without a fragment."));
    let s = value.as_str().ok_or_else(bad)?;
    if s.is_empty() || s.starts_with('/') || s.chars().any(|c| c == '\\' || c == '#' || (c as u32) <= 0x20 || c as u32 == 0x7f) {
        return Err(bad());
    }
    // ^[a-z][a-z\d+.-]*:
    let mut chars = s.chars();
    if chars.next().is_some_and(|c| c.is_ascii_alphabetic()) {
        for c in chars {
            if c == ':' {
                return Err(bad());
            }
            if !(c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-') {
                break;
            }
        }
    }
    let base = url::Url::parse("https://manifest.invalid/").expect("static URL");
    match base.join(s) {
        Ok(resolved) if resolved.origin() == base.origin() => Ok(s.to_string()),
        _ => Err(Error::permanent(format!("{label} must be relative."))),
    }
}

pub fn hex_digest(value: &Value, label: &str) -> Result<String> {
    match value.as_str() {
        Some(s) if s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()) => Ok(s.to_ascii_lowercase()),
        _ => Err(Error::permanent(format!("Invalid SHA-256 for {label}."))),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Launch {
    pub executable: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct News {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PacksRef {
    pub url: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayerRef {
    pub name: String,
    pub version: String,
    pub manifest_url: String,
    pub sha256: String,
    pub packs: Option<PacksRef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub schema_version: u8,
    pub version: String,
    pub launch: Launch,
    pub news: Option<Vec<News>>,
    pub player_owned: Option<Vec<String>>,
    /// schemaVersion 1 only.
    pub files: Vec<ManifestFile>,
    /// schemaVersion 2 only.
    pub layers: Vec<LayerRef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayerManifest {
    pub layer: String,
    pub version: String,
    pub files: Vec<ManifestFile>,
}

fn news_text(value: &Value, label: &str, max: usize, multiline: bool) -> Result<String> {
    let s = value.as_str().unwrap_or("");
    let unsafe_char = s.chars().any(|c| {
        let n = c as u32;
        n == 0x7f || (n < 0x20 && !(multiline && n == 0x0a))
    });
    if value.as_str().is_none() || s.trim().is_empty() || js_len(s) > max || unsafe_char {
        return Err(Error::permanent(format!("{label} must be nonempty plain text of at most {max} characters.")));
    }
    Ok(s.to_string())
}

/// Optional release notes shown by the launcher as plain text.
fn validate_news(value: Option<&Value>) -> Result<Option<Vec<News>>> {
    let Some(value) = value else { return Ok(None) };
    let list = value.as_array().filter(|list| list.len() <= 10).ok_or_else(|| Error::permanent("Manifest news must be an array of at most 10 entries."))?;
    let mut news = Vec::new();
    for (index, entry) in list.iter().enumerate() {
        let n = index + 1;
        if !entry.is_object() {
            return Err(Error::permanent(format!("Invalid manifest news entry {n}.")));
        }
        let title = news_text(&entry["title"], &format!("News {n} title"), 120, false)?;
        let date = match entry.get("date") {
            None => None,
            Some(d) => {
                let ok = d.as_str().filter(|s| {
                    let b = s.as_bytes();
                    b.len() == 10 && b[4] == b'-' && b[7] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
                });
                Some(ok.ok_or_else(|| Error::permanent(format!("News {n} date must be YYYY-MM-DD.")))?.to_string())
            }
        };
        let body = match entry.get("body") {
            None => None,
            Some(b) => Some(news_text(b, &format!("News {n} body"), 1000, true)?),
        };
        news.push(News { title, date, body });
    }
    Ok(Some(news))
}

/// Player-owned files are installed only when missing; the player's copy is never replaced.
fn validate_player_owned(value: Option<&Value>) -> Result<Option<Vec<String>>> {
    let Some(value) = value else { return Ok(None) };
    let list = value.as_array().filter(|list| list.len() <= 100).ok_or_else(|| Error::permanent("Manifest playerOwned must be an array of at most 100 paths."))?;
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for (index, entry) in list.iter().enumerate() {
        let name = managed_value(entry, &format!("Player-owned path {}", index + 1))?;
        if !seen.insert(windows_key(&name)) {
            return Err(Error::permanent(format!("Duplicate player-owned path: {name}.")));
        }
        out.push(name);
    }
    Ok(Some(out))
}

pub fn validate_launch(launch: &Value) -> Result<Launch> {
    let bad = || Error::permanent("Manifest launch.args must be an array of strings without NUL characters.");
    let args = launch.get("args").and_then(Value::as_array).ok_or_else(bad)?;
    let mut out = Vec::new();
    for arg in args {
        match arg.as_str() {
            Some(s) if !s.contains('\0') => out.push(s.to_string()),
            _ => return Err(bad()),
        }
    }
    Ok(Launch { executable: managed_value(&launch["executable"], "Launch executable")?, args: out })
}

pub fn validate_files(list: &Value) -> Result<Vec<ManifestFile>> {
    let list = list.as_array().ok_or_else(|| Error::permanent("Manifest files must be an array."))?;
    let mut out = Vec::with_capacity(list.len());
    for (index, file) in list.iter().enumerate() {
        if !file.is_object() {
            return Err(Error::permanent(format!("Invalid manifest file {}.", index + 1)));
        }
        let name = managed_value(&file["path"], &format!("File {}", index + 1))?;
        let size = safe_integer(&file["size"]).filter(|s| *s >= 0).ok_or_else(|| Error::permanent(format!("Invalid size for {name}.")))?;
        out.push(ManifestFile {
            size: size as u64,
            sha256: hex_digest(&file["sha256"], &name)?,
            url: relative_url(&file["url"], &format!("URL for {name}"))?,
            path: name,
        });
    }
    Ok(out)
}

struct TreeNode {
    name: String,
    file: bool,
    children: HashMap<String, TreeNode>,
}

/// Reject Windows case/normalization aliases and file/directory collisions in a complete file set.
pub fn check_tree<'a>(paths: impl IntoIterator<Item = (&'a str, u64)>) -> Result<u64> {
    let mut root: HashMap<String, TreeNode> = HashMap::new();
    let mut total: u64 = 0;
    for (path, size) in paths {
        total = total.checked_add(size).filter(|t| *t <= 9_007_199_254_740_991).ok_or_else(|| Error::permanent("Manifest total size exceeds the supported integer range."))?;
        let parts: Vec<&str> = path.split('/').collect();
        let mut children = &mut root;
        for (depth, part) in parts.iter().enumerate() {
            let key = windows_key(part);
            let last = depth == parts.len() - 1;
            if let Some(previous) = children.get(&key) {
                if previous.name != *part || previous.file || last {
                    return Err(Error::permanent(format!("Windows path collision in manifest: {path}.")));
                }
            }
            children = &mut children.entry(key).or_insert_with(|| TreeNode { name: part.to_string(), file: last, children: HashMap::new() }).children;
        }
    }
    Ok(total)
}

fn validate_layers(value: &Value) -> Result<Vec<LayerRef>> {
    let list = value.as_array().filter(|l| !l.is_empty() && l.len() <= MAX_LAYERS).ok_or_else(|| Error::permanent(format!("Manifest layers must be an array of 1-{MAX_LAYERS} entries.")))?;
    let mut names = HashSet::new();
    let mut out = Vec::new();
    for (index, layer) in list.iter().enumerate() {
        if !layer.is_object() {
            return Err(Error::permanent(format!("Invalid manifest layer {}.", index + 1)));
        }
        let name = layer_name(&layer["name"], &format!("Layer {} name", index + 1))?;
        if !names.insert(name.to_lowercase()) {
            return Err(Error::permanent(format!("Duplicate layer name: {name}.")));
        }
        let version = safe_component(&layer["version"], &format!("Layer {name} version"))?;
        let manifest_url = relative_url(&layer["manifestUrl"], &format!("Layer {name} manifestUrl"))?;
        let sha256 = hex_digest(&layer["sha256"], &format!("layer {name} manifest"))?;
        // Optional packs for the first install (launcher 1.3.3+; older launchers ignore the field).
        let packs = match layer.get("packs") {
            None => None,
            Some(p) => {
                if !p.is_object() {
                    return Err(Error::permanent(format!("Layer {name} packs must be an object.")));
                }
                Some(PacksRef {
                    url: relative_url(&p["url"], &format!("Layer {name} packs url"))?,
                    sha256: hex_digest(&p["sha256"], &format!("layer {name} pack index"))?,
                })
            }
        };
        out.push(LayerRef { name, version, manifest_url, sha256, packs });
    }
    Ok(out)
}

/// Validate a top-level manifest. schemaVersion 1 lists files directly; 2 references layer manifests.
pub fn validate_manifest(value: &Value) -> Result<Manifest> {
    let schema = value.get("schemaVersion").and_then(safe_integer);
    if !value.is_object() || !matches!(schema, Some(1) | Some(2)) {
        return Err(Error::permanent("Unsupported manifest: schemaVersion must be 1 or 2."));
    }
    let version = value.get("version").and_then(Value::as_str).filter(|v| !v.trim().is_empty()).ok_or_else(|| Error::permanent("Manifest version is required."))?;
    let launch = validate_launch(value.get("launch").unwrap_or(&Value::Null))?;
    let news = validate_news(value.get("news"))?;
    let player_owned = validate_player_owned(value.get("playerOwned"))?;
    let mut manifest = Manifest { schema_version: schema.unwrap() as u8, version: version.to_string(), launch, news, player_owned, files: vec![], layers: vec![] };
    if manifest.schema_version == 1 {
        let files = validate_files(value.get("files").unwrap_or(&Value::Null))?;
        check_tree(files.iter().map(|f| (f.path.as_str(), f.size)))?;
        if !files.iter().any(|f| f.path == manifest.launch.executable) {
            return Err(Error::permanent("Launch executable must be listed with identical spelling in manifest files."));
        }
        manifest.files = files;
    } else {
        manifest.layers = validate_layers(value.get("layers").unwrap_or(&Value::Null))?;
    }
    Ok(manifest)
}

/// Validate a layer manifest; `expected` (name, version) binds it to the top-level reference.
pub fn validate_layer_manifest(value: &Value, expected: Option<(&str, &str)>) -> Result<LayerManifest> {
    if !value.is_object() || value.get("schemaVersion").and_then(safe_integer) != Some(2) {
        return Err(Error::permanent("Unsupported layer manifest: schemaVersion must be 2."));
    }
    let name = layer_name(&value["layer"], "Layer manifest name")?;
    let version = safe_component(&value["version"], &format!("Layer {name} version"))?;
    if let Some((en, ev)) = expected {
        if en != name || ev != version {
            return Err(Error::permanent(format!("Layer manifest {name}@{version} does not match the release reference {en}@{ev}.")));
        }
    }
    let files = validate_files(value.get("files").unwrap_or(&Value::Null))?;
    check_tree(files.iter().map(|f| (f.path.as_str(), f.size)))?;
    Ok(LayerManifest { layer: name, version, files })
}

/// A file of a loaded release: absolute URL and the layer it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEntry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub url: String,
    pub layer: String,
}

/// Combine layers in order: a later layer replaces an earlier layer's file at the same path.
pub fn merge_layers(layers: &[(String, Vec<FileEntry>)]) -> Result<Vec<FileEntry>> {
    // Keep insertion order like a JS Map (delete + set moves an overridden path to the end).
    let mut order: Vec<Option<FileEntry>> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for (name, files) in layers {
        for file in files {
            let key = windows_key(&file.path);
            if let Some(&at) = index.get(&key) {
                let previous = order[at].as_ref().expect("indexed entry");
                if previous.path != file.path {
                    return Err(Error::permanent(format!("Windows path alias between layers: {} and {}.", previous.path, file.path)));
                }
                order[at] = None;
            }
            index.insert(key, order.len());
            order.push(Some(FileEntry { layer: name.clone(), ..file.clone() }));
        }
    }
    let files: Vec<FileEntry> = order.into_iter().flatten().collect();
    check_tree(files.iter().map(|f| (f.path.as_str(), f.size)))?;
    Ok(files)
}

/// Launcher versions are plain MAJOR.MINOR.PATCH.
pub fn launcher_version(value: &str) -> Result<(u64, u64, u64)> {
    let bad = || Error::permanent("Launcher version must be MAJOR.MINOR.PATCH.");
    let parts: Vec<&str> = value.split('.').collect();
    if parts.len() != 3 {
        return Err(bad());
    }
    let mut out = [0u64; 3];
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() || part.len() > 9 || !part.bytes().all(|b| b.is_ascii_digit()) || (part.len() > 1 && part.starts_with('0')) {
            return Err(bad());
        }
        out[i] = part.parse().map_err(|_| bad())?;
    }
    Ok((out[0], out[1], out[2]))
}

/// Compare MAJOR.MINOR.PATCH versions.
pub fn compare_versions(left: &str, right: &str) -> Result<std::cmp::Ordering> {
    Ok(launcher_version(left)?.cmp(&launcher_version(right)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn v2(layers: Value) -> Value {
        json!({ "schemaVersion": 2, "version": "1.0", "launch": { "executable": "SlumsMS.exe", "args": [] }, "layers": layers })
    }

    #[test]
    fn unsafe_paths_are_rejected() {
        for bad in ["../x", "/abs", "a\\b", "C:/x", "a//b", "CON", "con.txt", "COM1.log", "LPT²", "x.", "x ", "a/./b", "a?b", ".slumsms-launcher/state.json", ".mapleroot-stage-x/y", ".SLUMSMS-LAUNCHER/x"] {
            assert!(managed_path(bad, "p").is_err(), "{bad} should be rejected");
        }
        for good in ["Data/Mob/0100100.img", "config.ini", "COM10", "CONSOLE.txt", "a b/c"] {
            assert!(managed_path(good, "p").is_ok(), "{good} should be accepted");
        }
    }

    #[test]
    fn relative_urls_only() {
        for bad in ["https://x/y", "//evil/x", "/abs", "a#frag", "a b", "javascript:x", "", "a\\b"] {
            assert!(relative_url(&json!(bad), "u").is_err(), "{bad}");
        }
        for good in ["files/Data/a%20b.img", "../layers/base/v1/manifest.json", "a?x=1"] {
            assert!(relative_url(&json!(good), "u").is_ok(), "{good}");
        }
    }

    #[test]
    fn manifests_validate_layers_packs_news_and_player_owned() {
        let m = validate_manifest(&v2(json!([{ "name": "base", "version": "v83", "manifestUrl": "layers/base/v83/manifest.json", "sha256": SHA.to_uppercase(),
            "packs": { "url": "layers/base/v83/packs/index.json", "sha256": SHA } }]))).unwrap();
        assert_eq!(m.layers[0].sha256, SHA);
        assert!(m.layers[0].packs.is_some());
        assert!(validate_manifest(&v2(json!([{ "name": "base", "version": "v83", "manifestUrl": "x.json", "sha256": SHA, "packs": 3 }]))).is_err());
        assert!(validate_manifest(&v2(json!([]))).is_err());
        assert!(validate_manifest(&v2(json!([{ "name": "a", "version": "1", "manifestUrl": "x", "sha256": SHA }, { "name": "A", "version": "1", "manifestUrl": "x", "sha256": SHA }]))).is_err());
        let mut with_news = v2(json!([{ "name": "a", "version": "1", "manifestUrl": "x", "sha256": SHA }]));
        with_news["news"] = json!([{ "title": "Hi", "date": "2026-10-18", "body": "a\nb" }]);
        with_news["playerOwned"] = json!(["config.ini"]);
        let m = validate_manifest(&with_news).unwrap();
        assert_eq!(m.news.unwrap()[0].body.as_deref(), Some("a\nb"));
        with_news["news"] = json!([{ "title": "a\nb" }]);
        assert!(validate_manifest(&with_news).is_err());
        with_news["news"] = json!([{ "title": "ok" }]);
        with_news["playerOwned"] = json!(["config.ini", "CONFIG.INI"]);
        assert!(validate_manifest(&with_news).is_err());
    }

    #[test]
    fn schema_one_requires_the_executable_with_identical_spelling() {
        let file = |p: &str| json!({ "path": p, "size": 1, "sha256": SHA, "url": "f" });
        let mut m = json!({ "schemaVersion": 1, "version": "1", "launch": { "executable": "SlumsMS.exe", "args": ["a b"] }, "files": [file("slumsms.exe")] });
        assert!(validate_manifest(&m).is_err());
        m["files"] = json!([file("SlumsMS.exe"), file("Data/x.img")]);
        assert_eq!(validate_manifest(&m).unwrap().launch.args, vec!["a b"]);
        m["files"] = json!([file("SlumsMS.exe"), file("data/x.img"), file("Data/y.img")]);
        assert!(validate_manifest(&m).is_err(), "case alias between directories");
    }

    #[test]
    fn merge_overrides_and_rejects_aliases() {
        let f = |p: &str, sha: &str| FileEntry { path: p.into(), size: 1, sha256: sha.into(), url: String::new(), layer: String::new() };
        let merged = merge_layers(&[("base".into(), vec![f("a", "1"), f("b", "1")]), ("client".into(), vec![f("a", "2")])]).unwrap();
        assert_eq!(merged.iter().map(|x| (x.path.as_str(), x.sha256.as_str(), x.layer.as_str())).collect::<Vec<_>>(), vec![("b", "1", "base"), ("a", "2", "client")]);
        assert!(merge_layers(&[("base".into(), vec![f("a", "1")]), ("client".into(), vec![f("A", "2")])]).is_err());
    }

    #[test]
    fn versions_compare_numerically() {
        assert_eq!(compare_versions("1.10.0", "1.9.9").unwrap(), std::cmp::Ordering::Greater);
        assert!(launcher_version("1.2").is_err());
        assert!(launcher_version("01.2.3").is_err());
        assert!(launcher_version("1.2.3-rc").is_err());
    }
}

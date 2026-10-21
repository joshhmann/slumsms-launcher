//! Test support: a fake patch feed in the publisher's exact format (tools/publish.mjs), served by a
//! tiny HTTP/1.1 server with optional Basic auth, Range support and fault injection.
#![allow(dead_code)]

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub fn sha(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn basic(user: &str, key: &str) -> String {
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{user}:{key}")))
}

/// What the server does with one request.
#[derive(Clone, Debug)]
pub enum Action {
    Serve,
    Status(u16),
    Redirect(String),
    /// Send headers for the full body, then only this many bytes, then drop the connection.
    CutAfter(usize),
    /// Send this many bytes, then go silent while keeping the connection open.
    StallAfter(usize),
    /// Ignore Range and send the whole file with 200.
    NoRange,
    /// Answer with these bytes instead of the stored ones.
    Body(Vec<u8>),
}

#[derive(Clone, Debug)]
pub struct Logged {
    pub path: String,
    pub authorization: Option<String>,
    pub range: Option<String>,
}

type Hook = Arc<dyn Fn(&Logged, usize) -> Action + Send + Sync>;

pub struct Server {
    pub base: String,
    pub files: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    pub log: Arc<Mutex<Vec<Logged>>>,
    pub auth: Arc<Mutex<Option<Vec<String>>>>,
    hook: Arc<Mutex<Hook>>,
}

impl Server {
    pub async fn start() -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}/", listener.local_addr().unwrap().port());
        let files: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::default();
        let log: Arc<Mutex<Vec<Logged>>> = Arc::default();
        let auth: Arc<Mutex<Option<Vec<String>>>> = Arc::default();
        let hook: Arc<Mutex<Hook>> = Arc::new(Mutex::new(Arc::new(|_, _| Action::Serve)));
        let (f, l, a, h) = (files.clone(), log.clone(), auth.clone(), hook.clone());
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { break };
                let (f, l, a, h) = (f.clone(), l.clone(), a.clone(), h.clone());
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") {
                        match socket.read(&mut byte).await {
                            Ok(1) => head.push(byte[0]),
                            _ => return,
                        }
                    }
                    let text = String::from_utf8_lossy(&head).to_string();
                    let mut lines = text.split("\r\n");
                    let path = lines.next().unwrap_or("").split(' ').nth(1).unwrap_or("/").to_string();
                    let mut headers = HashMap::new();
                    for line in lines {
                        if let Some((k, v)) = line.split_once(':') {
                            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
                        }
                    }
                    let entry = Logged { path: path.clone(), authorization: headers.get("authorization").cloned(), range: headers.get("range").cloned() };
                    let count = {
                        let mut log = l.lock().unwrap();
                        log.push(entry.clone());
                        log.iter().filter(|e| e.path == path).count()
                    };
                    let allowed = a.lock().unwrap().clone();
                    if let Some(allowed) = allowed {
                        if !entry.authorization.as_ref().is_some_and(|h| allowed.contains(h)) {
                            let _ = socket.write_all(b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"x\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                            return;
                        }
                    }
                    let action = { let hook = h.lock().unwrap().clone(); hook(&entry, count) };
                    let key = percent_decode(path.trim_start_matches('/').split('?').next().unwrap_or(""));
                    let stored = f.lock().unwrap().get(&key).cloned();
                    let respond_status = |status: u16| format!("HTTP/1.1 {status} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    let body = match (&action, stored) {
                        (Action::Status(s), _) => {
                            let _ = socket.write_all(respond_status(*s).as_bytes()).await;
                            return;
                        }
                        (Action::Redirect(to), _) => {
                            let _ = socket.write_all(format!("HTTP/1.1 302 Found\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await;
                            return;
                        }
                        (Action::Body(b), _) => b.clone(),
                        (_, Some(b)) => b,
                        (_, None) => {
                            let _ = socket.write_all(respond_status(404).as_bytes()).await;
                            return;
                        }
                    };
                    let total = body.len();
                    let range = match (&action, &entry.range) {
                        (Action::NoRange, _) | (_, None) => None,
                        (_, Some(r)) => r.strip_prefix("bytes=").and_then(|r| {
                            let (a, b) = r.split_once('-')?;
                            let start: usize = a.parse().ok()?;
                            let end: usize = if b.is_empty() { total - 1 } else { b.parse::<usize>().ok()?.min(total - 1) };
                            Some((start, end))
                        }),
                    };
                    let (status, slice, extra) = match range {
                        Some((s, e)) => ("206 Partial Content", &body[s..=e], format!("Content-Range: bytes {s}-{e}/{total}\r\n")),
                        None => ("200 OK", &body[..], String::new()),
                    };
                    let header = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\n{extra}Accept-Ranges: bytes\r\nConnection: close\r\n\r\n", slice.len());
                    if socket.write_all(header.as_bytes()).await.is_err() {
                        return;
                    }
                    match action {
                        Action::CutAfter(n) => {
                            let _ = socket.write_all(&slice[..n.min(slice.len())]).await;
                            let _ = socket.flush().await;
                        }
                        Action::StallAfter(n) => {
                            let _ = socket.write_all(&slice[..n.min(slice.len())]).await;
                            let _ = socket.flush().await;
                            tokio::time::sleep(Duration::from_secs(3600)).await;
                        }
                        _ => {
                            let _ = socket.write_all(slice).await;
                        }
                    }
                });
            }
        });
        Server { base, files, log, auth, hook }
    }
    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }
    pub fn put(&self, path: &str, bytes: impl Into<Vec<u8>>) {
        self.files.lock().unwrap().insert(path.to_string(), bytes.into());
    }
    pub fn put_all(&self, files: HashMap<String, Vec<u8>>) {
        self.files.lock().unwrap().extend(files);
    }
    pub fn require(&self, headers: &[String]) {
        *self.auth.lock().unwrap() = Some(headers.to_vec());
    }
    pub fn hook(&self, hook: impl Fn(&Logged, usize) -> Action + Send + Sync + 'static) {
        *self.hook.lock().unwrap() = Arc::new(hook);
    }
    pub fn requests(&self) -> Vec<Logged> {
        self.log.lock().unwrap().clone()
    }
    pub fn clear_log(&self) {
        self.log.lock().unwrap().clear();
    }
    pub fn count(&self, predicate: impl Fn(&Logged) -> bool) -> usize {
        self.log.lock().unwrap().iter().filter(|l| predicate(l)).count()
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&value[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn encode_path(path: &str) -> String {
    path.split('/')
        .map(|part| {
            part.bytes()
                .map(|b| if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// One layer of a fake release.
#[derive(Clone)]
pub struct Layer {
    pub name: String,
    pub version: String,
    pub files: Vec<(String, Vec<u8>)>,
    pub pack_size: Option<usize>,
}

impl Layer {
    pub fn new(name: &str, version: &str, files: &[(&str, &[u8])]) -> Layer {
        Layer { name: name.into(), version: version.into(), files: files.iter().map(|(p, b)| (p.to_string(), b.to_vec())).collect(), pack_size: None }
    }
    pub fn packed(mut self, pack_size: usize) -> Layer {
        self.pack_size = Some(pack_size);
        self
    }
}

pub struct Published {
    pub files: HashMap<String, Vec<u8>>,
    pub manifest: Value,
}

/// Build feed files exactly like `publish.mjs --layer/--packs/--release` lay them out.
pub fn publish(prefix: &str, version: &str, executable: &str, layers: &[Layer], player_owned: &[&str], news: Option<Value>) -> Published {
    let mut files = HashMap::new();
    let mut refs = Vec::new();
    for layer in layers {
        let dir = format!("{prefix}layers/{}/{}/", layer.name, layer.version);
        let entries: Vec<Value> = layer.files.iter().map(|(p, b)| json!({ "path": p, "size": b.len(), "sha256": sha(b), "url": format!("files/{}", encode_path(p)) })).collect();
        for (p, b) in &layer.files {
            files.insert(format!("{dir}files/{p}"), b.clone());
        }
        let manifest = serde_json::to_vec(&json!({ "schemaVersion": 2, "layer": layer.name, "version": layer.version, "files": entries })).unwrap();
        let manifest_sha = sha(&manifest);
        files.insert(format!("{dir}manifest.json"), manifest);
        let mut reference = json!({ "name": layer.name, "version": layer.version, "manifestUrl": format!("layers/{}/{}/manifest.json", layer.name, layer.version), "sha256": manifest_sha });
        if let Some(pack_size) = layer.pack_size {
            // Deterministic: manifest order, each distinct content once.
            let mut seen = std::collections::HashSet::new();
            let mut groups: Vec<Vec<usize>> = Vec::new();
            let mut current: Vec<usize> = Vec::new();
            let mut bytes = 0;
            for (i, (_, b)) in layer.files.iter().enumerate() {
                if !seen.insert((sha(b), b.len())) {
                    continue;
                }
                if !current.is_empty() && bytes + b.len() > pack_size {
                    groups.push(std::mem::take(&mut current));
                    bytes = 0;
                }
                current.push(i);
                bytes += b.len();
            }
            if !current.is_empty() {
                groups.push(current);
            }
            let mut packs = Vec::new();
            for (n, group) in groups.iter().enumerate() {
                let data: Vec<u8> = group.iter().flat_map(|&i| layer.files[i].1.clone()).collect();
                let name = format!("{:04}.pack", n + 1);
                packs.push(json!({ "url": name, "size": data.len(), "sha256": sha(&data), "files": group }));
                files.insert(format!("{dir}packs/{name}"), data);
            }
            let index = serde_json::to_vec(&json!({ "schemaVersion": 1, "layer": layer.name, "version": layer.version, "manifestSha256": manifest_sha, "packs": packs })).unwrap();
            reference["packs"] = json!({ "url": format!("layers/{}/{}/packs/index.json", layer.name, layer.version), "sha256": sha(&index) });
            files.insert(format!("{dir}packs/index.json"), index);
        }
        refs.push(reference);
    }
    let mut manifest = json!({ "schemaVersion": 2, "version": version, "launch": { "executable": executable, "args": [] }, "playerOwned": player_owned, "layers": refs });
    if let Some(news) = news {
        manifest["news"] = news;
    }
    files.insert(format!("{prefix}manifest.json"), serde_json::to_vec_pretty(&manifest).unwrap());
    Published { files, manifest }
}

pub fn temp_dir(label: &str) -> std::path::PathBuf {
    // Under target/tmp: its parents list quickly (the installer reads every parent folder once).
    let dir = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("slums-test-{label}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

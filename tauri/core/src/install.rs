//! Verify and install a release into a game folder. Port of inspect/inspectRelease/installRelease
//! from updater.mjs: fast verify (size + mtime against state.json) or full SHA-256 Repair,
//! verified staging, new files committed as they verify, replaced files committed only after every
//! download verified, packs with HTTP Range resume and per-file fallback, retries with backoff,
//! stall detection, a disk-space check and resumable first installs.

use crate::error::{Error, Result, ACCESS_KEY_REQUIRED, DISK_FULL};
use crate::fsutil::{destination, digest, free_disk_bytes, installation_root, lstat_or_missing, mtime_ms, note_created, DirCache};
use crate::http::{network_url, parse_json, read_bytes, request, FeedAccess};
use crate::manifest::{windows_key, FileEntry, STAGE_PREFIX};
use crate::packs::{download_message, plan_packs, resume_message, validate_pack_index, PackLayer, PackSource, Plan, PlannedEntry, RateMeter, Span, Unit, DEFAULT_REQUEST_COST};
use crate::release::{read_install_state, read_installed_record, record_installed, write_install_state, write_layer_cache, Release, StateEntry};
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

pub const DEFAULT_CONCURRENCY: usize = 12;
pub const MAX_CONCURRENCY: usize = 32;
pub const DEFAULT_STALL_MS: u64 = 60_000;
pub const DEFAULT_PACK_CONCURRENCY: usize = 4;
/// Below this many pending files the pack index is not even fetched: small updates stay per-file.
pub const PACK_MIN_FILES: usize = 32;
const STALE_STAGE: Duration = Duration::from_secs(60 * 60);
/// Short, so a launcher killed mid-install re-hashes only a few seconds of files.
const STATE_CHECKPOINT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub message: String,
    pub files_done: u64,
    pub files_total: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub bytes_per_second: Option<u64>,
    pub eta_seconds: Option<u64>,
    pub resumed: bool,
    pub kept_bytes: u64,
}

pub type ProgressFn = Arc<dyn Fn(Progress) + Send + Sync>;

pub fn no_progress() -> ProgressFn {
    Arc::new(|_| {})
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Play/Update: trust files whose size and mtime match the install state.
    Fast,
    /// Repair: hash every present file of the right size.
    Full,
}

struct Inspection {
    files: Vec<FileEntry>,
    bytes: u64,
    hashed: usize,
    verified: HashMap<String, StateEntry>,
    existing: HashSet<String>,
    root: PathBuf,
    exists: bool,
    kept_bytes: u64,
    state_changed: bool,
}

fn inspect(root: &str, release: &Release, on_progress: &ProgressFn, mode: Mode, cancel: &CancellationToken) -> Result<Inspection> {
    let mut cache = DirCache::new();
    let installation = installation_root(root, false, &mut cache)?;
    let state = if installation.exists { read_install_state(&installation.root.to_string_lossy()) } else { Default::default() };
    let owned: HashSet<String> = release.player_owned.iter().map(|p| windows_key(p)).collect();
    let mut verified = HashMap::new();
    let mut pending = HashSet::new();
    let mut existing = HashSet::new();
    let mut to_hash: Vec<(&FileEntry, PathBuf)> = Vec::new();
    let files_total = release.files.len() as u64;
    let report = |message: String, files_done: u64, bytes_done: u64, bytes_total: u64| {
        on_progress(Progress { message, files_done, files_total, bytes_done, bytes_total, ..Default::default() })
    };
    report("Checking installed files…".into(), 0, 0, 0);
    for (i, file) in release.files.iter().enumerate() {
        if cancel.is_cancelled() {
            return Err(Error::aborted("The check was stopped."));
        }
        let current = if installation.exists { Some(destination(&installation.root, &file.path, false, &mut cache)?) } else { None };
        let meta = current.as_ref().and_then(|c| c.meta.as_ref());
        let entry = state.files.get(&file.path);
        match meta {
            None => {
                pending.insert(file.path.clone());
            }
            Some(meta) => {
                existing.insert(file.path.clone());
                if owned.contains(&windows_key(&file.path)) {
                    // the player's copy is kept as-is
                } else if meta.len() != file.size {
                    pending.insert(file.path.clone());
                } else if let Some(entry) = entry.filter(|e| mode == Mode::Fast && e.size == meta.len() && e.mtime_ms == mtime_ms(meta)) {
                    if entry.sha256 == file.sha256 {
                        verified.insert(file.path.clone(), entry.clone());
                    } else {
                        pending.insert(file.path.clone());
                    }
                } else {
                    to_hash.push((file, current.as_ref().unwrap().filename.clone()));
                }
            }
        }
        if (i + 1) % 500 == 0 {
            report("Checking installed files…".into(), i as u64 + 1, 0, 0);
        }
    }
    let bytes_total: u64 = to_hash.iter().map(|(f, _)| f.size).sum();
    let bytes_done = AtomicU64::new(0);
    let files_done = AtomicU64::new(files_total - to_hash.len() as u64);
    let next = AtomicU64::new(0);
    let results: Mutex<Vec<(String, Option<StateEntry>)>> = Mutex::new(Vec::new());
    let failure: Mutex<Option<Error>> = Mutex::new(None);
    std::thread::scope(|scope| {
        for _ in 0..4.min(to_hash.len()) {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::SeqCst) as usize;
                if index >= to_hash.len() || cancel.is_cancelled() || failure.lock().unwrap().is_some() {
                    break;
                }
                let (file, filename) = &to_hash[index];
                let message = format!("Verifying {}", file.path);
                let result = digest(filename, |n| {
                    let done = bytes_done.fetch_add(n, Ordering::SeqCst) + n;
                    report(message.clone(), files_done.load(Ordering::SeqCst), done, bytes_total);
                });
                let entry = match result {
                    Ok(Some(d)) if d.sha256 == file.sha256 => Some(StateEntry { size: d.size, mtime_ms: d.mtime_ms, sha256: file.sha256.clone() }),
                    Ok(_) => None,
                    Err(error) => {
                        failure.lock().unwrap().get_or_insert(error);
                        break;
                    }
                };
                results.lock().unwrap().push((file.path.clone(), entry));
                let done = files_done.fetch_add(1, Ordering::SeqCst) + 1;
                report(format!("Verified {}", file.path), done, bytes_done.load(Ordering::SeqCst), bytes_total);
            });
        }
    });
    if let Some(error) = failure.into_inner().unwrap() {
        return Err(error);
    }
    if cancel.is_cancelled() {
        return Err(Error::aborted("The check was stopped."));
    }
    for (path, entry) in results.into_inner().unwrap() {
        match entry {
            Some(entry) => {
                verified.insert(path, entry);
            }
            None => {
                pending.insert(path);
            }
        }
    }
    let files: Vec<FileEntry> = release.files.iter().filter(|f| pending.contains(&f.path)).cloned().collect();
    let bytes: u64 = files.iter().map(|f| f.size).sum();
    let all: u64 = release.files.iter().map(|f| f.size).sum();
    Ok(Inspection {
        bytes,
        hashed: to_hash.len(),
        verified,
        existing,
        root: installation.root,
        exists: installation.exists,
        // Bytes already in place and verified (or trusted by size and mtime): what a resumed install keeps.
        kept_bytes: all - bytes,
        state_changed: !to_hash.is_empty() || state.release != release.version,
        files,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectResult {
    #[serde(skip)]
    pub files: Vec<FileEntry>,
    pub pending_files: usize,
    pub bytes: u64,
    pub hashed: usize,
    pub kept_bytes: u64,
}

/// Compare the installation with a release; records newly hashed files and, when nothing is
/// pending, the installed record.
pub async fn inspect_release(root: &str, release: Arc<Release>, on_progress: ProgressFn, mode: Mode, cancel: CancellationToken) -> Result<InspectResult> {
    let root = root.to_string();
    tokio::task::spawn_blocking(move || {
        let result = inspect(&root, &release, &on_progress, mode, &cancel)?;
        if result.exists && result.state_changed {
            // Recording newly hashed files keeps the next Play fast; the state is only a cache.
            let _ = write_install_state(&result.root, &release, &result.verified);
        }
        if result.exists && result.files.is_empty() {
            let _ = record_installed(&result.root, &release);
        }
        Ok(InspectResult { pending_files: result.files.len(), bytes: result.bytes, hashed: result.hashed, kept_bytes: result.kept_bytes, files: result.files })
    })
    .await
    .map_err(|e| Error::new(format!("Verification stopped unexpectedly: {e}")))?
}

pub type FreeSpaceFn = Arc<dyn Fn(&Path) -> Option<u64> + Send + Sync>;

#[derive(Clone)]
pub struct InstallOptions {
    pub mode: Mode,
    pub concurrency: usize,
    pub retries: u32,
    pub retry_delay_ms: u64,
    pub pack_concurrency: usize,
    pub pack_retries: u32,
    pub stall_ms: u64,
    pub packs: bool,
    pub free_space: Option<FreeSpaceFn>,
    pub cancel: CancellationToken,
}

impl Default for InstallOptions {
    fn default() -> Self {
        InstallOptions {
            mode: Mode::Fast,
            concurrency: DEFAULT_CONCURRENCY,
            retries: 4,
            retry_delay_ms: 500,
            pack_concurrency: DEFAULT_PACK_CONCURRENCY,
            pack_retries: 8,
            stall_ms: DEFAULT_STALL_MS,
            packs: true,
            free_space: None,
            cancel: CancellationToken::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub files: usize,
    pub bytes: u64,
    pub hashed: usize,
    pub packs: usize,
    pub kept_bytes: u64,
    pub resumed: bool,
}

/// Exponential backoff with jitter, capped so a long outage is retried about every 30 seconds.
fn backoff(base_ms: u64, attempt: u32) -> Duration {
    let exp = base_ms.saturating_mul(1u64 << attempt.min(20)).min(30_000);
    Duration::from_millis(exp + (fastrand::f64() * base_ms as f64) as u64)
}

async fn sleep(duration: Duration, cancel: &CancellationToken) -> Result<()> {
    tokio::select! {
        _ = cancel.cancelled() => Err(Error::aborted("The download was stopped.")),
        _ = tokio::time::sleep(duration) => Ok(()),
    }
}

fn stalled() -> Error {
    Error { message: "The download stalled: no data for a while.".into(), stalled: true, network: true, ..Default::default() }
}

/// Next body chunk, failing when no data arrives for `stall`.
async fn next_chunk(response: &mut reqwest::Response, stall: Duration, cancel: &CancellationToken) -> Result<Option<bytes::Bytes>> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(Error::aborted("The download was stopped.")),
        r = tokio::time::timeout(stall, response.chunk()) => match r {
            Err(_) => Err(stalled()),
            Ok(Err(e)) => Err(Error { message: format!("The download was interrupted ({e})."), network: true, ..Default::default() }),
            Ok(Ok(chunk)) => Ok(chunk),
        },
    }
}

async fn start(url: &str, cancel: &CancellationToken, access: &FeedAccess, extra: &[(&str, String)], stall: Duration) -> Result<reqwest::Response> {
    match tokio::time::timeout(stall, request(url, cancel, Some(access), extra)).await {
        Err(_) => Err(stalled()),
        Ok(r) => r.map(|(response, _)| response),
    }
}

/// Download one file into `target`, verifying size and SHA-256 as it streams.
async fn download(file: &FileEntry, target: &Path, on_bytes: &(dyn Fn(i64) + Sync), cancel: &CancellationToken, access: &FeedAccess, stall: Duration) -> Result<()> {
    let mut response = start(&file.url, cancel, access, &[], stall).await?;
    let mut out = fs::OpenOptions::new().write(true).create_new(true).open(target).map_err(|e| Error::io(e, target.display()))?;
    let mut hash = Sha256::new();
    let mut size = 0u64;
    while let Some(chunk) = next_chunk(&mut response, stall, cancel).await? {
        size += chunk.len() as u64;
        if size > file.size {
            return Err(Error::permanent(format!("Download exceeds declared size: {}.", file.path)));
        }
        hash.update(&chunk);
        out.write_all(&chunk).map_err(|e| Error::io(e, target.display()))?;
        on_bytes(chunk.len() as i64);
    }
    drop(out);
    // A short body is usually a dropped connection and is retried; a full-size mismatch is not.
    if size < file.size {
        return Err(Error::new(format!("Download ended early: {}.", file.path)));
    }
    if hex::encode(hash.finalize()) != file.sha256 {
        return Err(Error::permanent(format!("Downloaded file failed size/SHA-256 verification: {}.", file.path)));
    }
    Ok(())
}

/// Where a range response's body starts within the pack.
fn range_start(response: &reqwest::Response, start: u64, end: u64, total: u64) -> Result<u64> {
    match response.status().as_u16() {
        206 => {
            let header = response.headers().get("content-range").and_then(|v| v.to_str().ok()).unwrap_or("");
            let parsed = header.strip_prefix("bytes ").and_then(|rest| {
                let (range, size) = rest.split_once('/')?;
                let (a, b) = range.split_once('-')?;
                Some((a.parse::<u64>().ok()?, b.parse::<u64>().ok()?, size))
            });
            match parsed {
                Some((a, b, size)) if a == start && b < end && (size == "*" || size.parse::<u64>().ok() == Some(total)) => Ok(start),
                _ => Err(Error::permanent("The pack server answered with an unexpected byte range.")),
            }
        }
        200 => {
            // A server without range support sends the whole pack; the bytes before `start` are skipped.
            if let Some(length) = response.content_length() {
                if length != total {
                    return Err(Error::permanent("A pack on the server does not match its index."));
                }
            }
            Ok(0)
        }
        status => Err(Error::permanent(format!("Unexpected pack response: HTTP {status}."))),
    }
}

struct OpenFile {
    file: std::io::BufWriter<fs::File>,
    hash: Sha256,
    temporary: PathBuf,
    entry: usize,
}

struct SpanContext<'a> {
    stage: &'a Path,
    cancel: &'a CancellationToken,
    access: &'a FeedAccess,
    retries: u32,
    retry_delay_ms: u64,
    stall: Duration,
    on_bytes: &'a (dyn Fn(u64) + Sync),
    on_retry: &'a (dyn Fn() + Sync),
    on_file: &'a (dyn Fn(&PlannedEntry, PathBuf) -> Result<()> + Sync),
}

/// Download one byte range of a pack and split it into files. Each file is hashed while it streams
/// and handed to on_file only after its SHA-256 matches. A dropped or stalled connection resumes at
/// the exact byte with a Range request; the retry budget refills whenever an attempt made progress.
/// Returns how many entries of the span were completed (also on error).
async fn fetch_span(pack: &PackSource, span: &Span, cx: &SpanContext<'_>, completed: &mut usize) -> Result<()> {
    let mut pos = span.start;
    let mut current: Option<OpenFile> = None;
    let mut attempt: u32 = 0;
    let open = |entry: usize| -> Result<OpenFile> {
        let temporary = cx.stage.join(uuid::Uuid::new_v4().to_string());
        let file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|e| Error::io(e, temporary.display()))?;
        Ok(OpenFile { file: std::io::BufWriter::with_capacity(256 * 1024, file), hash: Sha256::new(), temporary, entry })
    };
    let finish = |open_file: OpenFile, completed: &mut usize| -> Result<()> {
        let OpenFile { file, hash, temporary, entry } = open_file;
        if let Err(e) = file.into_inner().map_err(|e| e.into_error()) {
            let _ = fs::remove_file(&temporary);
            return Err(Error::io(e, temporary.display()));
        }
        if hex::encode(hash.finalize()) != span.entries[entry].sha256 {
            let _ = fs::remove_file(&temporary);
            return Err(Error::permanent(format!("A file in pack {} failed SHA-256 verification.", pack.url)));
        }
        *completed += 1;
        // Installing is local work: a failure there is never retried as network trouble.
        (cx.on_file)(&span.entries[entry], temporary).map_err(Error::make_local)
    };
    let result: Result<()> = async {
        // Zero-byte files complete as soon as the position reaches them.
        let settle = |pos: u64, completed: &mut usize| -> Result<()> {
            while *completed < span.entries.len() && span.entries[*completed].size == 0 && span.entries[*completed].offset <= pos {
                let f = open(*completed)?;
                finish(f, completed)?;
            }
            Ok(())
        };
        loop {
            let before = pos;
            let attempt_result: Result<bool> = async {
                settle(pos, completed)?;
                if pos >= span.end {
                    return Ok(true);
                }
                let mut response = start(&pack.url, cx.cancel, cx.access, &[("Range", format!("bytes={}-{}", pos, span.end - 1))], cx.stall).await?;
                let mut at = range_start(&response, pos, span.end, pack.size)?;
                while let Some(chunk) = next_chunk(&mut response, cx.stall, cx.cancel).await? {
                    let chunk_len = chunk.len() as u64;
                    let mut offset = if at < pos { chunk_len.min(pos - at) } else { 0 };
                    at += chunk_len;
                    while offset < chunk_len && pos < span.end {
                        let entry = &span.entries[*completed];
                        if pos < entry.offset {
                            let skip = (entry.offset - pos).min(chunk_len - offset);
                            offset += skip;
                            pos += skip;
                            (cx.on_bytes)(skip);
                            continue;
                        }
                        if current.is_none() {
                            current = Some(open(*completed)?);
                        }
                        let take = (entry.offset + entry.size - pos).min(chunk_len - offset);
                        let piece = &chunk[offset as usize..(offset + take) as usize];
                        let cur = current.as_mut().unwrap();
                        cur.file.write_all(piece).map_err(|e| Error::io(e, cur.temporary.display()))?;
                        cur.hash.update(piece);
                        offset += take;
                        pos += take;
                        (cx.on_bytes)(take);
                        if pos == entry.offset + entry.size {
                            finish(current.take().unwrap(), completed)?;
                            settle(pos, completed)?;
                        }
                    }
                    if pos >= span.end {
                        break;
                    }
                }
                if pos < span.end {
                    return Err(Error::new(format!("Pack download ended early: {}.", pack.url)));
                }
                settle(pos, completed)?;
                Ok(true)
            }
            .await;
            match attempt_result {
                Ok(_) => return Ok(()),
                Err(error) => {
                    if cx.cancel.is_cancelled() || error.permanent || error.local {
                        return Err(error);
                    }
                    attempt = if pos - before >= 1024 * 1024 { 1 } else { attempt + 1 };
                    if attempt > cx.retries {
                        return Err(error);
                    }
                    (cx.on_retry)();
                    sleep(backoff(cx.retry_delay_ms, attempt - 1), cx.cancel).await?;
                }
            }
        }
    }
    .await;
    if let Some(open_file) = current.take() {
        drop(open_file.file);
        let _ = fs::remove_file(&open_file.temporary);
    }
    result
}

/// Mutable install bookkeeping shared by the parallel workers (never held across an await).
struct Shared {
    cache: DirCache,
    verified: HashMap<String, StateEntry>,
    deferred: Vec<(FileEntry, PathBuf)>,
    bytes_done: i64,
    bytes_total: u64,
    files_done: u64,
    last_checkpoint: Instant,
    meter: RateMeter,
    phase: Option<(Unit, u64, u64)>,
    single: Vec<FileEntry>,
    failure: Option<Error>,
}

struct Installer<'a> {
    root: PathBuf,
    release: &'a Release,
    shared: Mutex<Shared>,
    existing: HashSet<String>,
    on_progress: ProgressFn,
    offset: u64,
    files_total: u64,
    resumed: bool,
    kept_bytes: u64,
    started: Instant,
}

impl Installer<'_> {
    fn progress_locked(&self, s: &mut Shared, message: Option<String>) {
        let done = (self.offset as i64 + s.bytes_done).max(0) as u64;
        let total = self.offset + s.bytes_total;
        s.meter.add(self.started.elapsed().as_millis() as u64, done);
        let (bps, eta) = s.meter.estimate(total);
        let text = message.unwrap_or_else(|| match s.phase {
            Some((unit, d, t)) => download_message(unit, d, t, done, total, bps, eta),
            None => "Installing files…".into(),
        });
        (self.on_progress)(Progress { message: text, files_done: s.files_done, files_total: self.files_total, bytes_done: done, bytes_total: total, bytes_per_second: bps, eta_seconds: eta, resumed: self.resumed, kept_bytes: self.kept_bytes });
    }
    fn progress(&self, message: Option<String>) {
        let mut s = self.shared.lock().unwrap();
        self.progress_locked(&mut s, message);
    }
    fn phase_message(&self, suffix: &str) -> String {
        let s = self.shared.lock().unwrap();
        let (unit, d, t) = s.phase.unwrap_or((Unit::Files, 0, 0));
        let done = (self.offset as i64 + s.bytes_done).max(0) as u64;
        format!("{}{suffix}", download_message(unit, d, t, done, self.offset + s.bytes_total, None, None))
    }
    fn add_bytes(&self, count: i64) {
        let mut s = self.shared.lock().unwrap();
        s.bytes_done += count;
        self.progress_locked(&mut s, None);
    }
    fn commit_locked(&self, s: &mut Shared, file: &FileEntry, temporary: &Path) -> Result<()> {
        let target = destination(&self.root, &file.path, true, &mut s.cache)?;
        fs::rename(temporary, &target.filename).map_err(|e| Error::io(e, target.filename.display()))?;
        note_created(&mut s.cache, &target.filename);
        let meta = lstat_or_missing(&target.filename)?.ok_or_else(|| Error::new(format!("{} vanished after install.", file.path)).make_local())?;
        s.verified.insert(file.path.clone(), StateEntry { size: meta.len(), mtime_ms: mtime_ms(&meta), sha256: file.sha256.clone() });
        Ok(())
    }
    /// Install one verified download (or defer it when it replaces an existing file).
    fn place(&self, file: &FileEntry, temporary: PathBuf) -> Result<()> {
        let mut s = self.shared.lock().unwrap();
        if self.existing.contains(&file.path) {
            s.deferred.push((file.clone(), temporary));
        } else {
            self.commit_locked(&mut s, file, &temporary)?;
        }
        s.files_done += 1;
        self.progress_locked(&mut s, None);
        if s.last_checkpoint.elapsed() > STATE_CHECKPOINT {
            s.last_checkpoint = Instant::now();
            let _ = write_install_state(&self.root, self.release, &s.verified);
        }
        Ok(())
    }
    fn save_state(&self) -> Result<()> {
        let s = self.shared.lock().unwrap();
        write_install_state(&self.root, self.release, &s.verified)
    }
    fn fail(&self, error: Error, internal: &CancellationToken) {
        let mut s = self.shared.lock().unwrap();
        if s.failure.is_none() {
            s.failure = Some(error);
            internal.cancel();
        }
    }
}

/// Fetch and verify the pack indexes of a loaded release; a layer whose index is unusable just has no packs.
async fn load_pack_sources(release: &Release, cancel: &CancellationToken, note: &(dyn Fn(String) + Sync)) -> Result<Vec<PackSource>> {
    let mut sources = Vec::new();
    for part in &release.layer_parts {
        let Some(packs) = &part.packs else { continue };
        let attempt: Result<Vec<PackSource>> = async {
            let (bytes, final_url) = read_bytes(&packs.url, &format!("pack index {}", part.layer), Some(&release.access), cancel, None).await?;
            if crate::fsutil::sha256_hex(&bytes) != packs.sha256 {
                return Err(Error::permanent(format!("Pack index for {}@{} failed SHA-256 verification.", part.layer, part.version)));
            }
            let layer = PackLayer { layer: &part.layer, version: &part.version, manifest_sha256: Some(&part.manifest_sha256), files: &part.files };
            let mut out = Vec::new();
            for mut pack in validate_pack_index(&parse_json(&bytes, &format!("pack index {}", part.layer))?, &layer)? {
                pack.url = network_url(final_url.join(&pack.url).map_err(|_| Error::permanent("Invalid pack URL."))?.as_str())?.to_string();
                out.push(pack);
            }
            Ok(out)
        }
        .await;
        match attempt {
            Ok(list) => sources.extend(list),
            Err(error) if error.is(ACCESS_KEY_REQUIRED) || cancel.is_cancelled() => return Err(error),
            Err(error) => note(format!("Packs for {} are unavailable ({}); downloading its files one by one.", part.layer, error.message)),
        }
    }
    Ok(sources)
}

fn gigabytes(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / 1024f64.powi(3))
}

/// Refuse to start a download that cannot fit, instead of failing hours in with a full disk.
fn ensure_disk_space(root: &Path, bytes: u64, free: Option<u64>) -> Result<()> {
    let Some(free) = free else { return Ok(()) };
    let needed = bytes + bytes.min(512 * 1024 * 1024);
    if free < needed {
        return Err(Error::permanent(format!(
            "Not enough disk space: this download needs about {} free in {}, but only {} is free. Free up space or choose another game folder in Settings.",
            gigabytes(needed),
            root.display(),
            gigabytes(free)
        ))
        .with_code(DISK_FULL));
    }
    Ok(())
}

/// Staging folders left by a launcher that was killed mid-install hold partial downloads; drop old ones.
fn remove_stale_stages(root: &Path) {
    let Ok(list) = fs::read_dir(root) else { return };
    for entry in list.flatten() {
        if !entry.file_name().to_string_lossy().starts_with(STAGE_PREFIX) {
            continue;
        }
        if let Ok(meta) = fs::symlink_metadata(entry.path()) {
            let old = meta.modified().ok().and_then(|m| m.elapsed().ok()).is_some_and(|age| age > STALE_STAGE);
            if meta.is_dir() && old {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
}

/// Download and install missing or changed files (mode Full hashes every file first, for Repair).
pub async fn install_release(root: &str, release: Arc<Release>, on_progress: ProgressFn, options: InstallOptions) -> Result<InstallResult> {
    if options.concurrency < 1 || options.concurrency > MAX_CONCURRENCY {
        return Err(Error::permanent(format!("Concurrency must be 1-{MAX_CONCURRENCY}.")));
    }
    if options.pack_concurrency < 1 || options.pack_concurrency > MAX_CONCURRENCY {
        return Err(Error::permanent(format!("Pack concurrency must be 1-{MAX_CONCURRENCY}.")));
    }
    let pending = {
        let (root, release, progress, mode, cancel) = (root.to_string(), release.clone(), on_progress.clone(), options.mode, options.cancel.clone());
        tokio::task::spawn_blocking(move || inspect(&root, &release, &progress, mode, &cancel)).await.map_err(|e| Error::new(e.to_string()))??
    };
    let installation = installation_root(root, true, &mut DirCache::new())?;
    let root_path = installation.root.clone();
    // A folder that never finished installing (no installed.json yet) but already holds verified
    // files is a resumed first install: say so, and count from what is there instead of from zero.
    let resumed = !pending.files.is_empty() && pending.kept_bytes > 0 && read_installed_record(&root_path.to_string_lossy()).is_none();
    let mut result = InstallResult { files: pending.files.len(), bytes: pending.bytes, hashed: pending.hashed, packs: 0, kept_bytes: pending.kept_bytes, resumed };
    if pending.files.is_empty() {
        write_install_state(&root_path, &release, &pending.verified)?;
        write_layer_cache(&root_path, &release)?;
        let _ = record_installed(&root_path, &release);
        return Ok(result);
    }
    let free = match &options.free_space {
        Some(f) => f(&root_path),
        None => free_disk_bytes(&root_path),
    };
    ensure_disk_space(&root_path, pending.bytes, free)?;
    remove_stale_stages(&root_path);
    let stage = root_path.join(format!("{STAGE_PREFIX}{}", &uuid::Uuid::new_v4().simple().to_string()[..6]));
    fs::create_dir(&stage).map_err(|e| Error::io(e, stage.display()))?;
    let mut cache = DirCache::new();
    installation_root(&root_path.to_string_lossy(), false, &mut cache)?;
    let installer = Installer {
        root: root_path.clone(),
        release: &release,
        shared: Mutex::new(Shared {
            cache,
            verified: pending.verified,
            deferred: Vec::new(),
            bytes_done: 0,
            bytes_total: pending.bytes,
            files_done: 0,
            last_checkpoint: Instant::now(),
            meter: RateMeter::new(20_000),
            phase: None,
            single: Vec::new(),
            failure: None,
        }),
        existing: pending.existing,
        on_progress: on_progress.clone(),
        offset: if resumed { pending.kept_bytes } else { 0 },
        files_total: pending.files.len() as u64,
        resumed,
        kept_bytes: pending.kept_bytes,
        started: Instant::now(),
    };
    let internal = options.cancel.child_token();
    let stall = Duration::from_millis(options.stall_ms);
    let access = release.access.clone();
    let outcome: Result<()> = async {
        if resumed {
            installer.progress(Some(resume_message(pending.kept_bytes)));
        }
        let mut plan = Plan { packs: vec![], files: (0..pending.files.len()).collect(), bytes: pending.bytes };
        let mut sources = Vec::new();
        if options.packs && pending.files.len() >= PACK_MIN_FILES && release.layer_parts.iter().any(|p| p.packs.is_some()) {
            if !resumed {
                installer.progress(Some("Planning the download…".into()));
            }
            sources = load_pack_sources(&release, &internal, &|note| installer.progress(Some(note))).await?;
            if !sources.is_empty() {
                plan = plan_packs(&pending.files, &sources, DEFAULT_REQUEST_COST);
            }
        }
        {
            let mut s = installer.shared.lock().unwrap();
            s.bytes_total = plan.bytes;
            s.single = plan.files.iter().map(|&i| pending.files[i].clone()).collect();
        }
        result.packs = plan.packs.len();
        if !plan.packs.is_empty() {
            installer.shared.lock().unwrap().phase = Some((Unit::Packs, 0, plan.packs.len() as u64));
            installer.progress(None);
            futures_util::stream::iter(plan.packs.iter())
                .for_each_concurrent(options.pack_concurrency, |planned| {
                    let (installer, internal, access, sources, pending_files, stage) = (&installer, &internal, &access, &sources, &pending.files, &stage);
                    async move {
                        if internal.is_cancelled() {
                            return;
                        }
                        let source = &sources[planned.source];
                        let span_received = AtomicU64::new(0);
                        let mut done_entries: Vec<usize> = vec![0; planned.spans.len()];
                        let on_bytes = |n: u64| {
                            span_received.fetch_add(n, Ordering::SeqCst);
                            installer.add_bytes(n as i64);
                        };
                        let on_retry = || installer.progress(Some(installer.phase_message(" (connection lost, resuming)")));
                        let on_file = |entry: &PlannedEntry, temporary: PathBuf| -> Result<()> {
                            let (first, copies) = entry.targets.split_first().expect("targets");
                            // Identical files share one copy in the pack.
                            for &copy in copies {
                                let duplicate = stage.join(uuid::Uuid::new_v4().to_string());
                                fs::copy(&temporary, &duplicate).map_err(|e| Error::io(e, duplicate.display()))?;
                                installer.place(&pending_files[copy], duplicate)?;
                            }
                            installer.place(&pending_files[*first], temporary)
                        };
                        let cx = SpanContext { stage, cancel: internal, access, retries: options.pack_retries, retry_delay_ms: options.retry_delay_ms, stall, on_bytes: &on_bytes, on_retry: &on_retry, on_file: &on_file };
                        let mut span_index = 0;
                        let mut failure = None;
                        while span_index < planned.spans.len() {
                            span_received.store(0, Ordering::SeqCst);
                            if let Err(error) = fetch_span(source, &planned.spans[span_index], &cx, &mut done_entries[span_index]).await {
                                failure = Some(error);
                                break;
                            }
                            span_index += 1;
                        }
                        if let Some(error) = failure {
                            if internal.is_cancelled() || !error.permanent || error.is(ACCESS_KEY_REQUIRED) || (error.local && !error.message.contains("failed SHA-256")) {
                                installer.fail(error, internal);
                            } else {
                                // A missing or damaged pack: download what it still owed one file at a time.
                                let mut owed = Vec::new();
                                for (i, span) in planned.spans.iter().enumerate().skip(span_index) {
                                    for entry in span.entries.iter().skip(done_entries[i]) {
                                        owed.extend(entry.targets.iter().map(|&t| pending_files[t].clone()));
                                    }
                                }
                                let unread: u64 = planned.spans[span_index..].iter().map(|s| s.end - s.start).sum::<u64>() - span_received.load(Ordering::SeqCst);
                                let mut s = installer.shared.lock().unwrap();
                                s.bytes_total = (s.bytes_total + owed.iter().map(|f| f.size).sum::<u64>()).saturating_sub(unread);
                                s.single.extend(owed);
                                installer.progress_locked(&mut s, Some(format!("A pack could not be used ({}); downloading its files one by one.", error.message)));
                            }
                        }
                        if let Some((_, done, _)) = installer.shared.lock().unwrap().phase.as_mut() {
                            *done += 1;
                        }
                    }
                })
                .await;
            if let Some(error) = installer.shared.lock().unwrap().failure.clone() {
                return Err(error);
            }
        }
        let single = installer.shared.lock().unwrap().single.clone();
        if !single.is_empty() {
            installer.shared.lock().unwrap().phase = Some((Unit::Files, 0, single.len() as u64));
            installer.progress(None);
            futures_util::stream::iter(single.iter())
                .for_each_concurrent(options.concurrency, |file| {
                    let (installer, internal, access, stage) = (&installer, &internal, &access, &stage);
                    async move {
                        if internal.is_cancelled() {
                            return;
                        }
                        let mut attempt = 0;
                        let temporary = loop {
                            let temporary = stage.join(uuid::Uuid::new_v4().to_string());
                            let received = std::sync::atomic::AtomicI64::new(0);
                            let on_bytes = |n: i64| {
                                received.fetch_add(n, Ordering::SeqCst);
                                installer.add_bytes(n);
                            };
                            match download(file, &temporary, &on_bytes, internal, access, stall).await {
                                Ok(()) => break temporary,
                                Err(error) => {
                                    installer.add_bytes(-received.load(Ordering::SeqCst));
                                    let _ = fs::remove_file(&temporary);
                                    if internal.is_cancelled() || error.permanent || attempt >= options.retries {
                                        installer.fail(error, internal);
                                        return;
                                    }
                                    installer.progress(Some(installer.phase_message(" (retrying a file)")));
                                    if sleep(backoff(options.retry_delay_ms, attempt), internal).await.is_err() {
                                        return;
                                    }
                                    attempt += 1;
                                }
                            }
                        };
                        if let Err(error) = installer.place(file, temporary) {
                            installer.fail(error, internal);
                            return;
                        }
                        if let Some((_, done, _)) = installer.shared.lock().unwrap().phase.as_mut() {
                            *done += 1;
                        }
                    }
                })
                .await;
        }
        if let Some(error) = installer.shared.lock().unwrap().failure.clone() {
            return Err(error);
        }
        if options.cancel.is_cancelled() || internal.is_cancelled() {
            return Err(Error::aborted("The download was stopped."));
        }
        // No existing file is replaced until every download has passed verification.
        let deferred = std::mem::take(&mut installer.shared.lock().unwrap().deferred);
        for (file, temporary) in deferred {
            let mut s = installer.shared.lock().unwrap();
            installer.commit_locked(&mut s, &file, &temporary)?;
            installer.progress_locked(&mut s, Some("Installing updated files…".into()));
        }
        installer.save_state()?;
        write_layer_cache(&root_path, &release)?;
        let _ = record_installed(&root_path, &release);
        Ok(())
    }
    .await;
    if outcome.is_err() {
        // Record files committed before a failure so a resumed install need not hash them again.
        let _ = installer.save_state();
    }
    let _ = fs::remove_dir_all(&stage);
    outcome.map(|_| result)
}

//! The launcher's state machine: a port of the Electron main process (src/main.mjs) onto Tauri
//! commands and the "launcher:state" event, plus channels, settings migration and self-update.
//! The access key never leaves this process: the page only learns whether one is saved.

use crate::platform;
use crate::VERSION;
use serde_json::{json, Map, Value};
use slums_core::channels::{accessible_channels, channel_feed, channel_install_dir, effective_channel, folder_owner, probe_channels, show_channel_picker, update_manifest_url, Channel, Probes, CHANNELS};
use slums_core::config::{detect_bundled_client, effective_access_key, read_launcher_config, standalone_install_dir, valid_access_key, validate_feed_url, LauncherConfig};
use slums_core::error::{ACCESS_KEY_REQUIRED, CONFIG_MISSING, GAME_RUNNING};
use slums_core::game_config::{game_running, read_game_config, write_game_config};
use slums_core::game_options::{default_values, validate_changes};
use slums_core::http::{FeedAccess, ACCESS_KEY_USER};
use slums_core::install::{inspect_release, install_release, InspectResult, InstallOptions, Mode, Progress, ProgressFn};
use slums_core::play::{play_plan, reuse_verified, PlayPlan, RecentVerify, VERIFIED_REUSE_MS};
use slums_core::release::{check_available_release, load_release, read_installed_record, Available, Release, AVAILABLE_TIMEOUT};
use slums_core::selfupdate;
use slums_core::settings::{apply_migration_answer, migrate_legacy_settings, read_asar_file, read_settings, write_settings, LegacyFolder, PendingGameOptions, Settings};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

const BUILTIN_CONFIG: &str = include_str!("../../launcher.config.json");
const AVAILABLE_INTERVAL: Duration = Duration::from_secs(10 * 60);
type Cmd<T> = Result<T, String>;

/// Command-line switches (none of them carries a key).
#[derive(Clone, Debug, Default)]
pub struct Args {
    pub version: bool,
    pub self_test: Option<PathBuf>,
    pub self_test_install: bool,
    pub self_updated: Option<String>,
    pub self_update_failed: Option<String>,
    pub handover_from: Option<String>,
    pub no_self_update: bool,
    pub feed_url: Option<String>,
    pub install_dir: Option<String>,
    pub data_dir: Option<PathBuf>,
    pub legacy_dir: Option<PathBuf>,
}

impl Args {
    pub fn parse(list: Vec<String>) -> Args {
        let value = |flag: &str| list.iter().find_map(|a| a.strip_prefix(flag).map(str::to_string));
        Args {
            version: list.iter().any(|a| a == "--version" || a == "-V"),
            self_test: value("--self-test=").map(PathBuf::from),
            self_test_install: list.iter().any(|a| a == "--self-test-install"),
            self_updated: value("--self-updated="),
            self_update_failed: value("--self-update-failed="),
            handover_from: value("--handover-from="),
            no_self_update: list.iter().any(|a| a == "--no-self-update") || std::env::var("SLUMSMS_NO_SELF_UPDATE").as_deref() == Ok("1"),
            feed_url: value("--feed-url="),
            install_dir: value("--install-dir="),
            data_dir: value("--data-dir=").map(PathBuf::from),
            legacy_dir: value("--legacy-dir=").map(PathBuf::from),
        }
    }
    /// What a relaunch after a self-update keeps.
    fn passthrough(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(v) = &self.feed_url {
            out.push(format!("--feed-url={v}"));
        }
        if let Some(v) = &self.install_dir {
            out.push(format!("--install-dir={v}"));
        }
        if let Some(v) = &self.data_dir {
            out.push(format!("--data-dir={}", v.display()));
        }
        out
    }
}

struct Inner {
    settings: Settings,
    probes: Probes,
    state: Map<String, Value>,
    last_verified: Option<(RecentVerify, Arc<Release>)>,
    self_update_checked: bool,
    skip_version: Option<String>,
    page_ready_ms: Option<u128>,
    first_check_ms: Option<u128>,
}

struct Effective {
    live_feed: String,
    feed_url: String,
    install_dir: String,
    channel: Channel,
    key: String,
    user: String,
}

pub struct Launcher {
    app: AppHandle,
    args: Args,
    started: Instant,
    config: LauncherConfig,
    bundled_dir: String,
    standalone_dir: String,
    settings_file: PathBuf,
    legacy_file: Option<PathBuf>,
    log_file: PathBuf,
    exe: PathBuf,
    inner: Mutex<Inner>,
    busy: AtomicBool,
    quitting: AtomicBool,
    install_cancel: Mutex<Option<CancellationToken>>,
    available_request: AtomicU64,
    options_lock: tokio::sync::Mutex<()>,
    last_progress: Mutex<Instant>,
    ready: tokio::sync::watch::Receiver<bool>,
    ready_tx: tokio::sync::watch::Sender<bool>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn exists(path: &Path) -> bool {
    std::fs::metadata(path).is_ok()
}

fn executable_path(install_dir: &str, executable: &str) -> PathBuf {
    let mut path = PathBuf::from(install_dir);
    path.extend(executable.split('/'));
    path
}

fn label(channel: Channel) -> &'static str {
    channel.label()
}

impl Launcher {
    pub fn new(app: AppHandle, args: Args, started: Instant) -> Result<Launcher, Box<dyn std::error::Error>> {
        let exe = std::env::current_exe()?;
        let exe_dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();
        let packaged = !cfg!(debug_assertions);
        let data_dir = match &args.data_dir {
            Some(dir) => dir.clone(),
            None => app.path().app_config_dir()?,
        };
        let settings_file = data_dir.join("settings.json");
        let log_file = data_dir.join("launcher.log");
        // The Electron launcher's per-user folder (Electron userData = %APPDATA%\mapleroot-launcher).
        let legacy_file = match (&args.legacy_dir, &args.self_test) {
            (Some(dir), _) => Some(dir.join("settings.json")),
            (None, Some(_)) => None,
            (None, None) => app.path().config_dir().ok().map(|d| d.join("mapleroot-launcher").join("settings.json")),
        };
        // Built-in defaults ship in the exe; an optional launcher.config.json beside it overrides them.
        let mut sources = vec![("built-in launcher.config.json".to_string(), Some(BUILTIN_CONFIG.to_string()))];
        if packaged {
            let beside = exe_dir.join("launcher.config.json");
            sources.push((beside.display().to_string(), std::fs::read_to_string(&beside).ok()));
        }
        let (config, config_error) = match read_launcher_config(&sources) {
            Ok(config) => (config, None),
            Err(error) => (read_launcher_config(&sources[..1]).unwrap_or_default(), Some(error.message)),
        };
        let bundled_dir = if packaged { detect_bundled_client(&exe_dir, &config.client_executable).map(|p| p.display().to_string()).unwrap_or_default() } else { String::new() };
        let home = app.path().home_dir().unwrap_or_default();
        let local = std::env::var_os("LOCALAPPDATA").filter(|_| cfg!(windows)).map(PathBuf::from);
        let standalone_dir = standalone_install_dir(&home, local.as_deref()).display().to_string();
        let stored = std::fs::read_to_string(&settings_file).ok();
        let needs_migration = stored.is_none();
        let mut settings = stored.as_deref().map(read_settings).unwrap_or_default();
        if let Some(feed) = &args.feed_url {
            settings.feed_url = feed.clone();
        }
        if let Some(dir) = &args.install_dir {
            settings.folders.live = dir.clone();
            settings.channel = Channel::Live;
        }
        let mut state = Map::new();
        state.insert("phase".into(), json!(if config_error.is_some() { "error" } else { "idle" }));
        state.insert("message".into(), json!(config_error.clone().unwrap_or_else(|| "Checking for updates…".into())));
        state.insert("canPlay".into(), json!(false));
        state.insert("installed".into(), json!({ "status": "unknown" }));
        state.insert("available".into(), json!({ "status": "checking" }));
        state.insert("migrationQuestion".into(), serde_json::to_value(&settings.migration_question).unwrap_or(Value::Null));
        let (ready_tx, ready) = tokio::sync::watch::channel(false);
        let launcher = Launcher {
            app,
            args,
            started,
            config,
            bundled_dir,
            standalone_dir,
            settings_file,
            legacy_file,
            log_file,
            exe,
            inner: Mutex::new(Inner { settings, probes: Probes::new(), state, last_verified: None, self_update_checked: false, skip_version: None, page_ready_ms: None, first_check_ms: None }),
            busy: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
            install_cancel: Mutex::new(None),
            available_request: AtomicU64::new(0),
            options_lock: tokio::sync::Mutex::new(()),
            last_progress: Mutex::new(Instant::now() - Duration::from_secs(1)),
            ready,
            ready_tx,
        };
        launcher.log(&format!("SlumsMS Launcher {VERSION} starting ({}).", launcher.exe.display()));
        if let Some(error) = &config_error {
            launcher.log(&format!("Launcher config: {error}"));
        }
        for note in selfupdate::cleanup(&launcher.exe, VERSION) {
            launcher.log(&format!("Self-update: {note}"));
        }
        let handle = launcher.app.clone();
        tauri::async_runtime::spawn(async move {
            let launcher = loop {
                if let Some(state) = handle.try_state::<Arc<Launcher>>() {
                    break state.inner().clone();
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            };
            launcher.startup(needs_migration).await;
        });
        Ok(launcher)
    }

    /// Append to launcher.log (rotated at 1 MiB). Never log the access key.
    fn log(&self, message: &str) {
        eprintln!("{message}");
        let _ = (|| -> std::io::Result<()> {
            if let Some(parent) = self.log_file.parent() {
                std::fs::create_dir_all(parent)?;
            }
            if std::fs::metadata(&self.log_file).map(|m| m.len() > 1024 * 1024).unwrap_or(false) {
                std::fs::rename(&self.log_file, self.log_file.with_extension("log.old"))?;
            }
            let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&self.log_file)?;
            writeln!(file, "{} {message}", slums_core::release::iso_now())
        })();
    }

    fn persist(&self, settings: &Settings) {
        if let Err(error) = write_settings(&self.settings_file, settings) {
            self.log(&format!("Could not save settings: {}", error.message));
        }
    }

    fn effective_of(&self, inner: &Inner) -> Effective {
        let s = &inner.settings;
        let live_feed = if s.feed_url.is_empty() { self.config.feed_url.clone() } else { s.feed_url.clone() };
        let channel = effective_channel(s.channel, &inner.probes);
        Effective {
            feed_url: channel_feed(&live_feed, channel),
            install_dir: channel_install_dir(channel, &s.folders, &self.bundled_dir, &self.standalone_dir),
            channel,
            key: effective_access_key(&s.access_key, &self.config.access_key, &live_feed, &self.config.feed_url),
            user: if s.access_user.is_empty() { ACCESS_KEY_USER.to_string() } else { s.access_user.clone() },
            live_feed,
        }
    }

    fn effective(&self) -> Effective {
        self.effective_of(&self.inner.lock().unwrap())
    }

    fn access(e: &Effective) -> slums_core::Result<FeedAccess> {
        FeedAccess::new(&e.feed_url, &e.key, &e.user)
    }

    fn effective_json(&self, inner: &Inner) -> Map<String, Value> {
        let e = self.effective_of(inner);
        let s = &inner.settings;
        let source = if !s.folders.get(e.channel).is_empty() {
            "saved"
        } else if e.channel == Channel::Live && !self.bundled_dir.is_empty() {
            "bundled"
        } else {
            "default"
        };
        let key_source = if !s.access_key.is_empty() {
            "saved"
        } else if !e.key.is_empty() {
            "built-in"
        } else {
            "none"
        };
        let mut channel_label = label(e.channel).to_string();
        if e.channel != s.channel {
            channel_label = format!("Live · {} is not open for this key", label(s.channel));
        }
        let channels: Vec<Value> = accessible_channels(&inner.probes).into_iter().map(|c| json!({ "id": c.id(), "label": label(c) })).collect();
        let mut map = Map::new();
        map.insert("feedUrl".into(), json!(e.feed_url));
        map.insert("liveFeedUrl".into(), json!(e.live_feed));
        map.insert("installDir".into(), json!(e.install_dir));
        map.insert("defaultFeedUrl".into(), json!(self.config.feed_url));
        map.insert("feedOverridden".into(), json!(!s.feed_url.is_empty()));
        map.insert("installDirSource".into(), json!(source));
        map.insert("accessKeySource".into(), json!(key_source));
        map.insert("appVersion".into(), json!(VERSION));
        map.insert("channel".into(), json!(e.channel.id()));
        map.insert("channelLabel".into(), json!(channel_label));
        map.insert("channels".into(), json!(channels));
        map.insert("showChannelPicker".into(), json!(show_channel_picker(&inner.probes)));
        map
    }

    /// Merge a patch into the page state and broadcast it (only counts and short messages cross).
    fn send(&self, patch: Value) {
        let snapshot = {
            let mut inner = self.inner.lock().unwrap();
            let effective = self.effective_json(&inner);
            for (k, v) in effective {
                inner.state.insert(k, v);
            }
            if let Value::Object(patch) = patch {
                for (k, v) in patch {
                    inner.state.insert(k, v);
                }
            }
            Value::Object(inner.state.clone())
        };
        let _ = self.app.emit("launcher:state", snapshot);
    }

    fn settings_json(&self) -> Value {
        Value::Object(self.effective_json(&self.inner.lock().unwrap()))
    }

    async fn wait_ready(&self) {
        let mut ready = self.ready.clone();
        let _ = ready.wait_for(|r| *r).await;
    }

    // -----------------------------------------------------------------------------------------
    // Start-up: one-time migration, channel probes, versions, the periodic availability check.

    async fn startup(self: Arc<Self>, needs_migration: bool) {
        if needs_migration {
            self.migrate().await;
        }
        let _ = self.ready_tx.send(true);
        self.refresh_channels().await;
        self.refresh_versions(false).await;
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(AVAILABLE_INTERVAL).await;
                if !me.busy.load(Ordering::SeqCst) {
                    me.refresh_channels().await;
                    me.refresh_available(false).await;
                }
            }
        });
    }

    /// Carry the Electron launcher's settings over once. Its file is only read; the game folder
    /// stays exactly where it is.
    async fn migrate(&self) {
        let legacy_text = self.legacy_file.as_ref().and_then(|f| std::fs::read_to_string(f).ok());
        let Some(text) = legacy_text else {
            let mut inner = self.inner.lock().unwrap();
            inner.settings.migrated_from = "new".into();
            let settings = inner.settings.clone();
            drop(inner);
            self.persist(&settings);
            self.log("Settings: no earlier launcher settings found; starting fresh.");
            return;
        };
        let mut legacy: Value = serde_json::from_str(&text).unwrap_or(json!({}));
        // A friends build of the Electron launcher had its key built into resources/app.asar beside
        // its exe; this exe replaces it in the same folder, so carry that key over (never shown or logged).
        if legacy.get("accessKey").and_then(Value::as_str).unwrap_or("").is_empty() {
            let asar = self.exe.parent().unwrap_or(Path::new(".")).join("resources").join("app.asar");
            if let Some(bytes) = read_asar_file(&asar, "src/launcher.config.json") {
                if let Ok(old) = serde_json::from_slice::<Value>(&bytes) {
                    let key = old.get("accessKey").and_then(Value::as_str).unwrap_or("");
                    let old_feed = old.get("feedUrl").and_then(Value::as_str).unwrap_or("");
                    let used_feed = legacy.get("feedUrl").and_then(Value::as_str).filter(|f| !f.is_empty()).unwrap_or(old_feed).to_string();
                    let carried = effective_access_key("", key, &used_feed, old_feed);
                    if !carried.is_empty() && valid_access_key(&carried) {
                        legacy["accessKey"] = json!(carried);
                        self.log("Settings: carried over the access key built into the previous launcher.");
                    }
                }
            }
        }
        let live_feed = self.config.feed_url.clone();
        let key = legacy.get("accessKey").and_then(Value::as_str).unwrap_or("").to_string();
        let (probes, user) = probe_channels(&live_feed, &key, ACCESS_KEY_USER).await;
        let dir = legacy.get("installDir").and_then(Value::as_str).unwrap_or("").to_string();
        let record = if dir.is_empty() { None } else { read_installed_record(&dir) };
        let holds_game = !dir.is_empty() && (record.is_some() || exists(&Path::new(&dir).join(&self.config.client_executable)));
        let folder = (!dir.is_empty()).then(|| LegacyFolder { holds_game, record: record.as_ref() });
        let migration = migrate_legacy_settings(&legacy, &live_feed, folder, &probes);
        let mut settings = migration.settings;
        settings.access_user = user;
        settings.migration_question = migration.question.clone();
        for note in &migration.notes {
            self.log(&format!("Settings: {note}"));
        }
        self.log(&format!("Settings: migrated from the Electron launcher ({}), channel {}.", self.legacy_file.as_ref().map(|f| f.display().to_string()).unwrap_or_default(), settings.channel.id()));
        self.persist(&settings);
        let mut inner = self.inner.lock().unwrap();
        inner.settings = settings;
        inner.probes = probes;
        inner.state.insert("migrationQuestion".into(), serde_json::to_value(&migration.question).unwrap_or(Value::Null));
    }

    async fn refresh_channels(&self) {
        let (live, key, preferred) = {
            let e = self.effective();
            (e.live_feed, e.key, e.user)
        };
        if live.is_empty() {
            return;
        }
        let (probes, user) = probe_channels(&live, &key, &preferred).await;
        let changed_user = {
            let mut inner = self.inner.lock().unwrap();
            inner.probes = probes;
            if !key.is_empty() && inner.settings.access_user != user && inner.probes.get(&Channel::Live).is_some_and(Available::is_ok) {
                inner.settings.access_user = user.clone();
                Some(inner.settings.clone())
            } else {
                None
            }
        };
        if let Some(settings) = changed_user {
            self.log(&format!("Access key: the server accepts it as user \"{user}\"."));
            self.persist(&settings);
        }
        self.send(json!({}));
    }

    async fn refresh_installed(&self) {
        let dir = self.effective().install_dir;
        let installed = if dir.is_empty() {
            json!({ "status": "not-installed" })
        } else if let Some(record) = read_installed_record(&dir) {
            json!({ "status": "installed", "version": record.release, "layers": record.layers.iter().map(|l| json!({ "name": l.name, "version": l.version })).collect::<Vec<_>>() })
        } else if exists(&Path::new(&dir).join(if self.config.client_executable.is_empty() { "SlumsMS.exe" } else { &self.config.client_executable })) {
            json!({ "status": "unknown" })
        } else {
            json!({ "status": "not-installed" })
        };
        self.send(json!({ "installed": installed }));
    }

    async fn refresh_available(&self, reset: bool) {
        let e = self.effective();
        let request = self.available_request.fetch_add(1, Ordering::SeqCst) + 1;
        let current_ok = self.inner.lock().unwrap().state.get("available").and_then(|a| a.get("status")).and_then(Value::as_str) == Some("ok");
        if reset || !current_ok {
            self.send(json!({ "available": { "status": "checking" } }));
        }
        if e.feed_url.is_empty() {
            self.send(json!({ "available": { "status": "error" } }));
            return;
        }
        let result = match Self::access(&e) {
            Ok(access) => check_available_release(&e.feed_url, Some(&access), AVAILABLE_TIMEOUT).await,
            Err(error) => Available::Error { message: error.message },
        };
        if request != self.available_request.load(Ordering::SeqCst) {
            return; // the server or key changed meanwhile
        }
        if !result.is_ok() {
            self.log(&format!("Version check: {}: {}", result.status(), result.message()));
        }
        self.send(json!({ "available": available_json(&result) }));
    }

    async fn refresh_versions(&self, reset: bool) {
        self.refresh_installed().await;
        self.refresh_available(reset).await;
    }

    // -----------------------------------------------------------------------------------------
    // Operations

    fn begin(&self, phase: &str) -> Cmd<()> {
        if self.busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return Err("A launcher operation is already running.".into());
        }
        self.send(json!({ "phase": phase, "canPlay": false, "accessKeyNeeded": false, "offlinePlay": false, "filesDone": 0, "filesTotal": 0, "bytesDone": 0, "bytesTotal": 0, "bytesPerSecond": null, "etaSeconds": null }));
        Ok(())
    }

    fn end<T>(&self, result: slums_core::Result<T>) -> Cmd<T> {
        self.busy.store(false, Ordering::SeqCst);
        result.map_err(|error| {
            let denied = error.is(ACCESS_KEY_REQUIRED);
            let mut patch = json!({ "phase": "error", "message": error.message, "accessKeyNeeded": denied, "canPlay": false });
            if denied {
                patch["available"] = json!({ "status": "access-key" });
            }
            self.send(patch);
            error.message
        })
    }

    fn progress_fn(self: &Arc<Self>, fixed_message: Option<String>) -> ProgressFn {
        let me = self.clone();
        Arc::new(move |p: Progress| me.progress(p, fixed_message.as_deref()))
    }

    /// Progress arrives per chunk; forward at most ~10 updates a second.
    fn progress(&self, p: Progress, fixed_message: Option<&str>) {
        {
            let mut last = self.last_progress.lock().unwrap();
            if last.elapsed() < Duration::from_millis(100) && p.files_done != p.files_total {
                return;
            }
            *last = Instant::now();
        }
        self.send(json!({ "message": fixed_message.unwrap_or(&p.message), "filesDone": p.files_done, "filesTotal": p.files_total, "bytesDone": p.bytes_done, "bytesTotal": p.bytes_total,
            "bytesPerSecond": p.bytes_per_second, "etaSeconds": p.eta_seconds, "resumed": p.resumed }));
    }

    fn require_settings(&self) -> slums_core::Result<Effective> {
        let e = self.effective();
        if e.feed_url.is_empty() || e.install_dir.is_empty() {
            return Err(slums_core::Error::permanent("Set an update server in Settings first."));
        }
        Ok(e)
    }

    fn mark_verified(&self, release: &Arc<Release>, e: &Effective) {
        let recent = RecentVerify { install_dir: e.install_dir.clone(), feed_url: e.feed_url.clone(), manifest_sha256: release.manifest_sha256.clone(), at_ms: now_ms() };
        self.inner.lock().unwrap().last_verified = Some((recent, release.clone()));
    }

    /// mode Fast trusts files whose size and mtime match the install state; Full (Repair) hashes everything.
    async fn check_release(self: &Arc<Self>, mode: Mode) -> slums_core::Result<(Arc<Release>, InspectResult)> {
        let e = self.require_settings()?;
        let access = Self::access(&e)?;
        let release = Arc::new(load_release(&e.feed_url, Some(&e.install_dir), &access, &CancellationToken::new()).await?);
        self.send(json!({ "version": release.version, "news": release.news.clone().unwrap_or_default(), "available": available_from(&release), "message": "Checking installed game files." }));
        let fresh = !exists(&executable_path(&e.install_dir, &release.launch.executable));
        let pending = inspect_release(&e.install_dir, release.clone(), self.progress_fn(None), mode, CancellationToken::new()).await?;
        self.refresh_installed().await;
        if pending.pending_files == 0 {
            self.mark_verified(&release, &e);
        }
        let count = pending.pending_files;
        self.send(json!({ "phase": if count > 0 { "needs-update" } else { "ready" }, "canPlay": count == 0, "fresh": fresh && count > 0,
            "pendingFiles": count, "pendingBytes": pending.bytes, "keptBytes": pending.kept_bytes,
            "message": if count > 0 { format!("{count} files need installing or repair.") } else { "All release files verified. Ready to play.".into() } }));
        Ok((release, pending))
    }

    /// Download and verify what the folder lacks; also the first half of Play when a new release is out.
    async fn install_files(self: &Arc<Self>, mode: Mode, message: Option<String>) -> slums_core::Result<Arc<Release>> {
        let e = self.require_settings()?;
        let access = Self::access(&e)?;
        let release = Arc::new(load_release(&e.feed_url, Some(&e.install_dir), &access, &CancellationToken::new()).await?);
        let default_message = if mode == Mode::Full { "Verifying every file and repairing damage." } else { "Checking what is already installed." };
        self.send(json!({ "phase": "updating", "version": release.version, "news": release.news.clone().unwrap_or_default(), "available": available_from(&release),
            "message": message.clone().unwrap_or_else(|| default_message.into()) }));
        let cancel = CancellationToken::new();
        *self.install_cancel.lock().unwrap() = Some(cancel.clone());
        let options = InstallOptions { mode, concurrency: self.config.download_concurrency, cancel, ..Default::default() };
        let result = install_release(&e.install_dir, release.clone(), self.progress_fn(None), options).await;
        *self.install_cancel.lock().unwrap() = None;
        result.map_err(|mut error| {
            if error.is(slums_core::error::ABORTED) {
                error.message = "The download was stopped. Everything finished so far is kept; the next install continues from there.".into();
            }
            error
        })?;
        // install_release verified every file it kept or wrote; no second pass over the folder.
        self.mark_verified(&release, &e);
        self.refresh_installed().await;
        self.send(json!({ "phase": "ready", "canPlay": true, "fresh": false, "pendingFiles": 0, "pendingBytes": 0, "message": "All release files verified. Ready to play." }));
        let me = self.clone();
        tauri::async_runtime::spawn(async move { me.flush_pending_game_options().await });
        Ok(release)
    }

    /// The release this session last verified, if Play may reuse it.
    async fn recently_verified(&self, e: &Effective) -> Option<Arc<Release>> {
        let (recent, release) = self.inner.lock().unwrap().last_verified.clone()?;
        let present = exists(&executable_path(&e.install_dir, &release.launch.executable));
        let offered = if present { check_available_release(&e.feed_url, Self::access(e).ok().as_ref(), AVAILABLE_TIMEOUT).await } else { Available::Offline { message: String::new() } };
        reuse_verified(Some(&recent), &e.install_dir, &e.feed_url, now_ms(), VERIFIED_REUSE_MS, present, &offered).then_some(release)
    }

    /// Play always asks the server first: a release that went out while the launcher sat open is
    /// installed before the game starts. Only when the server cannot be asked does Play start the
    /// installed client as-is ("Couldn't check for updates").
    async fn play_flow(self: &Arc<Self>) -> slums_core::Result<()> {
        let e = self.require_settings()?;
        self.send(json!({ "message": "Checking for updates…" }));
        let access = Self::access(&e)?;
        let offered = check_available_release(&e.feed_url, Some(&access), AVAILABLE_TIMEOUT).await;
        let record = read_installed_record(&e.install_dir);
        let plan = play_plan(&offered, record.as_ref());
        let (launch, offline) = match plan {
            PlayPlan::Offline => {
                self.log(&format!("Play: could not check for updates ({}: {}); starting the installed client.", offered.status(), offered.message()));
                let from_session = self.inner.lock().unwrap().last_verified.as_ref().filter(|(r, _)| r.install_dir == e.install_dir).map(|(_, rel)| rel.launch.clone());
                let launch = from_session.or_else(|| record.as_ref().and_then(|r| r.launch.clone())).unwrap_or(slums_core::manifest::Launch {
                    executable: if self.config.client_executable.is_empty() { "SlumsMS.exe".into() } else { self.config.client_executable.clone() },
                    args: vec![],
                });
                if !exists(&executable_path(&e.install_dir, &launch.executable)) {
                    return Err(slums_core::Error::new(format!("Couldn't check for updates ({}) and the game is not installed in this folder yet.", offered.message())));
                }
                self.send(json!({ "available": { "status": offered.status() } }));
                (launch, true)
            }
            _ => {
                self.send(json!({ "available": available_json(&offered) }));
                let release = if plan == PlayPlan::Update {
                    self.log(&format!("Play: {} is out (installed: {}); updating before launch.", offered.version().unwrap_or(""), record.as_ref().map(|r| r.release.as_str()).unwrap_or("unknown")));
                    self.install_files(Mode::Fast, Some(format!("Updating to {} before starting the game…", offered.version().unwrap_or("the new release")))).await?
                } else {
                    match self.recently_verified(&e).await {
                        Some(release) => release,
                        None => {
                            let (release, pending) = self.check_release(Mode::Fast).await?;
                            if pending.pending_files > 0 {
                                self.install_files(Mode::Fast, Some("Repairing changed files before starting the game…".into())).await?
                            } else {
                                release
                            }
                        }
                    }
                };
                (release.launch.clone(), false)
            }
        };
        self.flush_pending_game_options().await;
        self.send(json!({ "phase": "launching", "message": "Starting the client. Accept its Windows prompt if shown.", "canPlay": false }));
        self.inner.lock().unwrap().last_verified = None;
        let dir = e.install_dir.clone();
        tokio::task::spawn_blocking(move || slums_core::play::launch(&dir, &launch.executable, &launch.args))
            .await
            .map_err(|e| slums_core::Error::new(e.to_string()))??;
        self.send(json!({ "phase": "ready", "canPlay": true, "offlinePlay": offline,
            "message": if offline { "Couldn’t check for updates. Started the installed version." } else { "Client process started." } }));
        Ok(())
    }

    // -----------------------------------------------------------------------------------------
    // Self-update (signed, through the Tauri updater plugin), once before the first game check.

    async fn self_update(self: &Arc<Self>) -> bool {
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.self_update_checked {
                return false;
            }
            inner.self_update_checked = true;
        }
        if cfg!(debug_assertions) || self.args.no_self_update || self.args.self_test.is_some() {
            return false;
        }
        if let Some(updated) = &self.args.self_updated {
            if updated != VERSION {
                self.log(&format!("Self-update: started as {updated} but this build reports {VERSION}; skipping launcher updates this session."));
                return false;
            }
        }
        let e = self.effective();
        if e.feed_url.is_empty() {
            return false;
        }
        match self.try_self_update(&e).await {
            Ok(done) => done,
            Err(error) => {
                self.log(&format!("Self-update failed; keeping launcher {VERSION}: {error}"));
                if error.contains("401") || error.contains("403") {
                    self.inner.lock().unwrap().self_update_checked = false; // retried after a key change
                }
                self.send(json!({ "phase": "checking", "message": "Checking for updates…", "filesDone": 0, "filesTotal": 0, "bytesDone": 0, "bytesTotal": 0 }));
                false
            }
        }
    }

    async fn try_self_update(self: &Arc<Self>, e: &Effective) -> Result<bool, String> {
        use tauri_plugin_updater::UpdaterExt;
        let access = Self::access(e).map_err(|e| e.message)?;
        let endpoint = url::Url::parse(&update_manifest_url(&e.feed_url)).map_err(|e| e.to_string())?;
        let mut builder = self.app.updater_builder().endpoints(vec![endpoint]).map_err(|e| e.to_string())?.timeout(Duration::from_secs(60));
        if !access.authorization().is_empty() {
            builder = builder.header("Authorization", access.authorization()).map_err(|e| e.to_string())?;
        }
        let Some(update) = builder.build().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())? else {
            self.log("Self-update: no newer launcher on this channel.");
            return Ok(false);
        };
        let skip = self.inner.lock().unwrap().skip_version.clone().or(self.args.self_update_failed.clone());
        if let Err(reason) = selfupdate::update_decision(&update.version, VERSION, skip.as_deref()) {
            self.log(&format!("Self-update: {reason}."));
            return Ok(false);
        }
        // The key goes only to the patch server: the build must be served from the feed's own origin.
        if !access.same_origin(&update.download_url) {
            return Err(format!("the update {} is not on the patch server ({}); refusing it", update.version, update.download_url));
        }
        self.log(&format!("Self-update: downloading launcher {} (running {VERSION}).", update.version));
        let message = format!("Updating launcher to {}…", update.version);
        self.send(json!({ "phase": "self-updating", "message": message, "filesDone": 0, "filesTotal": 1, "bytesDone": 0, "bytesTotal": 0 }));
        let me = self.clone();
        let mut done = 0u64;
        let progress_message = message.clone();
        let bytes = update
            .download(
                move |chunk, total| {
                    done += chunk as u64;
                    me.progress(Progress { message: progress_message.clone(), files_done: 0, files_total: 1, bytes_done: done, bytes_total: total.unwrap_or(0), ..Default::default() }, None);
                },
                || {},
            )
            .await
            .map_err(|e| e.to_string())?; // signature and signed version verified by the plugin
        if !selfupdate::looks_like_exe(&bytes) {
            return Err("the downloaded launcher is not a Windows program".into());
        }
        let staged = selfupdate::stage(&self.exe, &update.version, &bytes).map_err(|e| e.message)?;
        let rollback = selfupdate::swap_in(&self.exe, &staged, VERSION).map_err(|e| e.message)?;
        self.send(json!({ "message": "Restarting the launcher…" }));
        if let Some(window) = self.app.get_webview_window("main") {
            let _ = window.hide();
        }
        let (version, args) = (update.version.clone(), self.args.passthrough());
        let outcome = tokio::task::spawn_blocking(move || selfupdate::start_and_confirm(&rollback, &version, &args, Duration::from_secs(90))).await.map_err(|e| e.to_string())?;
        match outcome {
            selfupdate::Outcome::Healthy => {
                self.log(&format!("Self-update: launcher {} started; this one exits.", update.version));
                self.app.exit(0);
                Ok(true)
            }
            selfupdate::Outcome::RolledBack(reason) => {
                if let Some(window) = self.app.get_webview_window("main") {
                    let _ = window.show();
                }
                self.inner.lock().unwrap().skip_version = Some(update.version.clone());
                Err(format!("launcher {} was rolled back: {reason}", update.version))
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // Game options (config.ini). Writes are serialized; while the game runs, changes wait in the
    // settings (per game folder) and are written when the panel is opened later, or at Play.

    fn pending_for(&self, dir: &str) -> Option<BTreeMap<String, bool>> {
        self.inner.lock().unwrap().settings.pending_game_options.as_ref().filter(|p| p.install_dir == dir).map(|p| p.changes.clone())
    }

    fn set_pending(&self, value: Option<PendingGameOptions>) {
        let settings = {
            let mut inner = self.inner.lock().unwrap();
            inner.settings.pending_game_options = value;
            inner.settings.clone()
        };
        self.persist(&settings);
    }

    fn game_options_state(&self, extra: Value) -> Cmd<Value> {
        let dir = self.effective().install_dir;
        let current = read_game_config(&dir).map_err(|e| e.message)?;
        let pending = self.pending_for(&dir);
        let mut value = serde_json::to_value(&current).map_err(|e| e.to_string())?;
        if current.is_ok() {
            if let Some(pending) = &pending {
                let mut values = current.values.clone();
                values.extend(pending.clone());
                value["values"] = json!(values);
            }
        }
        value["defaults"] = json!(default_values());
        value["running"] = json!(game_running());
        value["pending"] = json!(pending.is_some());
        if let (Value::Object(target), Value::Object(extra)) = (&mut value, extra) {
            target.extend(extra);
        }
        Ok(value)
    }

    async fn flush_pending_game_options(&self) {
        let _guard = self.options_lock.lock().await;
        let dir = self.effective().install_dir;
        let Some(pending) = self.pending_for(&dir) else { return };
        match write_game_config(&dir, &pending, game_running) {
            Ok(_) => {
                self.set_pending(None);
                self.log("Game options: applied changes saved while the game was running.");
            }
            Err(error) => {
                if error.is(CONFIG_MISSING) {
                    self.set_pending(None);
                }
                if !error.is(GAME_RUNNING) {
                    self.log(&format!("Game options: could not apply saved changes: {}", error.message));
                }
            }
        }
    }

    async fn save_game_options(&self, changes: BTreeMap<String, bool>) -> Cmd<Value> {
        let _guard = self.options_lock.lock().await;
        let dir = self.effective().install_dir;
        let mut merged = self.pending_for(&dir).unwrap_or_default();
        merged.extend(changes);
        match write_game_config(&dir, &merged, game_running) {
            Ok(_) => {
                if self.pending_for(&dir).is_some() {
                    self.set_pending(None);
                }
                self.game_options_state(json!({ "saved": "written" }))
            }
            Err(error) if error.is(GAME_RUNNING) => {
                self.set_pending(Some(PendingGameOptions { install_dir: dir, changes: merged }));
                self.game_options_state(json!({ "saved": "pending" }))
            }
            Err(error) => Err(error.message),
        }
    }

    // -----------------------------------------------------------------------------------------
    // Settings changes

    fn update_settings(&self, change: impl FnOnce(&mut Settings)) -> Settings {
        let settings = {
            let mut inner = self.inner.lock().unwrap();
            change(&mut inner.settings);
            inner.last_verified = None;
            inner.settings.clone()
        };
        self.persist(&settings);
        settings
    }

    fn require_idle(&self) -> Cmd<()> {
        if self.busy.load(Ordering::SeqCst) {
            return Err("Wait for the current operation to finish.".into());
        }
        Ok(())
    }

    /// Ask before quitting mid-operation; true when the close must wait for the answer.
    pub fn confirm_close(self: &Arc<Self>) -> bool {
        if !self.busy.load(Ordering::SeqCst) || self.quitting.load(Ordering::SeqCst) {
            return false;
        }
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        let me = self.clone();
        self.app
            .dialog()
            .message("Everything already downloaded is kept. The next install checks it and continues from there.")
            .title("Quit before this operation finishes?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Quit".into(), "Keep working".into()))
            .show(move |quit| {
                if !quit {
                    return;
                }
                // Stop the install cleanly so it records what it finished, then quit (at most a few seconds).
                me.quitting.store(true, Ordering::SeqCst);
                if let Some(cancel) = me.install_cancel.lock().unwrap().as_ref() {
                    cancel.cancel();
                }
                let me = me.clone();
                std::thread::spawn(move || {
                    let stopped = Instant::now();
                    while me.busy.load(Ordering::SeqCst) && stopped.elapsed() < Duration::from_secs(5) {
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    me.app.exit(0);
                });
            });
        true
    }

    /// Self-test: report start-up time and the first check, then exit.
    fn finish_self_test(&self, error: Option<String>) {
        let Some(report) = &self.args.self_test else { return };
        let (state, page_ready, first_check) = {
            let mut inner = self.inner.lock().unwrap();
            inner.first_check_ms = Some(self.started.elapsed().as_millis());
            (Value::Object(inner.state.clone()), inner.page_ready_ms, inner.first_check_ms)
        };
        let value = json!({
            "ok": error.is_none(),
            "version": VERSION,
            "exe": self.exe.display().to_string(),
            "webview2": platform::webview2_version(),
            "pageReadyMs": page_ready,
            "firstCheckDoneMs": first_check,
            "error": error,
            "phase": state.get("phase"),
            "message": state.get("message"),
            "installed": state.get("installed"),
            "available": state.get("available"),
            "channel": state.get("channel"),
            "channels": state.get("channels"),
            "installDir": state.get("installDir"),
            "feedUrl": state.get("feedUrl"),
            "pendingFiles": state.get("pendingFiles"),
        });
        let _ = std::fs::write(report, serde_json::to_vec_pretty(&value).unwrap_or_default());
        self.app.exit(0);
    }
}

fn available_from(release: &Release) -> Value {
    json!({ "status": "ok", "version": release.version, "layers": release.layers.iter().map(|l| json!({ "name": l.name, "version": l.version })).collect::<Vec<_>>() })
}

fn available_json(available: &Available) -> Value {
    match available {
        Available::Ok { version, layers, .. } => json!({ "status": "ok", "version": version, "layers": layers }),
        other => json!({ "status": other.status() }),
    }
}

type L<'a> = State<'a, Arc<Launcher>>;

#[tauri::command]
pub async fn settings(launcher: L<'_>) -> Cmd<Value> {
    let l = launcher.inner().clone();
    l.wait_ready().await;
    let first = {
        let mut inner = l.inner.lock().unwrap();
        let first = inner.page_ready_ms.is_none();
        if first {
            inner.page_ready_ms = Some(l.started.elapsed().as_millis());
        }
        first
    };
    if first {
        l.log(&format!("Window ready after {} ms.", l.started.elapsed().as_millis()));
        // Tell whoever started this build (an older launcher or the Electron hand-over) that it works.
        if l.args.self_updated.as_deref() == Some(VERSION) || l.args.handover_from.is_some() {
            let marker = selfupdate::healthy_marker(&l.exe, VERSION);
            let written = marker.parent().map(std::fs::create_dir_all).and_then(Result::ok).map(|_| std::fs::write(&marker, std::process::id().to_string()));
            match written {
                Some(Ok(())) => l.log(&format!("Self-update: now running launcher {VERSION}{}.", l.args.handover_from.as_ref().map(|f| format!(" (handed over from {f})")).unwrap_or_default())),
                _ => l.log("Self-update: could not confirm start."),
            }
        }
    }
    l.send(json!({}));
    Ok(l.settings_json())
}

#[tauri::command]
pub async fn save_feed(launcher: L<'_>, value: String) -> Cmd<Value> {
    let l = launcher.inner().clone();
    l.require_idle()?;
    let href = validate_feed_url(value.trim()).map_err(|e| e.message)?;
    let default = l.config.feed_url.clone();
    l.update_settings(|s| s.feed_url = if href == default { String::new() } else { href });
    l.send(json!({ "phase": "idle", "message": "Update server saved.", "canPlay": false, "version": null, "news": [] }));
    let me = l.clone();
    tauri::async_runtime::spawn(async move {
        me.refresh_channels().await;
        me.refresh_versions(true).await;
    });
    Ok(l.settings_json())
}

#[tauri::command]
pub async fn reset_feed(launcher: L<'_>) -> Cmd<Value> {
    let l = launcher.inner().clone();
    l.require_idle()?;
    l.update_settings(|s| s.feed_url.clear());
    l.send(json!({ "phase": "idle", "message": "Update server reset to the default.", "canPlay": false, "version": null, "news": [] }));
    let me = l.clone();
    tauri::async_runtime::spawn(async move {
        me.refresh_channels().await;
        me.refresh_versions(true).await;
    });
    Ok(l.settings_json())
}

async fn save_key(l: Arc<Launcher>, key: String, message: &str) -> Cmd<Value> {
    l.require_idle()?;
    if !valid_access_key(&key) {
        return Err("The access key cannot contain control characters or exceed 256 characters.".into());
    }
    l.update_settings(|s| {
        s.access_key = key;
        s.access_user.clear(); // the server says again which user this key belongs to
    });
    l.inner.lock().unwrap().self_update_checked = false;
    l.send(json!({ "phase": "idle", "message": message, "canPlay": false, "version": null, "news": [] }));
    // Probe before returning so the page's re-check uses the right user and channel.
    l.refresh_channels().await;
    let me = l.clone();
    tauri::async_runtime::spawn(async move { me.refresh_versions(true).await });
    Ok(l.settings_json())
}

#[tauri::command]
pub async fn save_access_key(launcher: L<'_>, value: String) -> Cmd<Value> {
    let key = value.trim().to_string();
    let message = if key.is_empty() { "Saved access key cleared." } else { "Access key saved." };
    save_key(launcher.inner().clone(), key, message).await
}

#[tauri::command]
pub async fn clear_access_key(launcher: L<'_>) -> Cmd<Value> {
    save_key(launcher.inner().clone(), String::new(), "Saved access key cleared.").await
}

fn channel_dirs(l: &Launcher) -> BTreeMap<Channel, String> {
    let inner = l.inner.lock().unwrap();
    CHANNELS.into_iter().map(|c| (c, channel_install_dir(c, &inner.settings.folders, &l.bundled_dir, &l.standalone_dir))).collect()
}

#[tauri::command]
pub async fn choose_folder(launcher: L<'_>) -> Cmd<Value> {
    use tauri_plugin_dialog::DialogExt;
    let l = launcher.inner().clone();
    l.require_idle()?;
    let e = l.effective();
    let app = l.app.clone();
    let current = e.install_dir.clone();
    let picked = tokio::task::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_title("Choose SlumsMS game folder");
        if Path::new(&current).is_dir() {
            dialog = dialog.set_directory(&current);
        }
        dialog.blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Some(picked) = picked.and_then(|p| p.into_path().ok()) {
        let dir = picked.display().to_string();
        if let Some(owner) = folder_owner(&dir, e.channel, &channel_dirs(&l), cfg!(windows)) {
            return Err(format!("That folder is the {} game folder. Each channel needs its own folder.", label(owner)));
        }
        let channel = e.channel;
        l.update_settings(|s| s.folders.set(channel, dir));
        l.send(json!({ "phase": "idle", "message": "Game folder saved.", "canPlay": false }));
        l.refresh_installed().await;
    }
    Ok(l.settings_json())
}

#[tauri::command]
pub async fn reset_folder(launcher: L<'_>) -> Cmd<Value> {
    let l = launcher.inner().clone();
    l.require_idle()?;
    let channel = l.effective().channel;
    l.update_settings(|s| s.folders.set(channel, String::new()));
    l.send(json!({ "phase": "idle", "message": "Game folder reset to the default.", "canPlay": false }));
    l.refresh_installed().await;
    Ok(l.settings_json())
}

#[tauri::command]
pub async fn open_folder(launcher: L<'_>) -> Cmd<()> {
    let dir = launcher.effective().install_dir;
    if !Path::new(&dir).is_dir() {
        return Err("The game folder does not exist yet. Install the game first.".into());
    }
    if !platform::open_path(&dir) {
        return Err("Could not open the game folder.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn check(launcher: L<'_>) -> Cmd<()> {
    let l = launcher.inner().clone();
    l.wait_ready().await;
    l.begin("checking")?;
    let me = l.clone();
    let result = async move {
        if !me.self_update().await {
            me.check_release(Mode::Fast).await?;
        }
        Ok(())
    }
    .await;
    let outcome = l.end(result);
    if l.args.self_test.is_some() {
        if l.args.self_test_install && outcome.is_ok() && l.inner.lock().unwrap().state.get("phase").and_then(Value::as_str) == Some("needs-update") {
            let result = update(launcher).await;
            l.finish_self_test(result.err());
        } else {
            l.finish_self_test(outcome.clone().err());
        }
    }
    outcome
}

#[tauri::command]
pub async fn update(launcher: L<'_>) -> Cmd<()> {
    let l = launcher.inner().clone();
    l.begin("updating")?;
    let result = l.install_files(Mode::Fast, None).await.map(|_| ());
    l.end(result)
}

#[tauri::command]
pub async fn repair(launcher: L<'_>) -> Cmd<()> {
    let l = launcher.inner().clone();
    l.begin("updating")?;
    let result = l.install_files(Mode::Full, None).await.map(|_| ());
    l.end(result)
}

#[tauri::command]
pub async fn play(launcher: L<'_>) -> Cmd<()> {
    let l = launcher.inner().clone();
    l.begin("checking")?;
    let result = l.play_flow().await;
    l.end(result)
}

#[tauri::command]
pub async fn game_options(launcher: L<'_>) -> Cmd<Value> {
    let l = launcher.inner().clone();
    l.flush_pending_game_options().await;
    l.game_options_state(json!({}))
}

#[tauri::command]
pub async fn save_game_options(launcher: L<'_>, value: Value) -> Cmd<Value> {
    let changes = validate_changes(&value).map_err(|e| e.message)?;
    launcher.inner().clone().save_game_options(changes).await
}

#[tauri::command]
pub async fn reset_game_options(launcher: L<'_>) -> Cmd<Value> {
    launcher.inner().clone().save_game_options(default_values()).await
}

#[tauri::command]
pub async fn set_channel(launcher: L<'_>, value: String) -> Cmd<Value> {
    let l = launcher.inner().clone();
    l.require_idle()?;
    let channel = Channel::parse(&value).ok_or("Unknown channel.")?;
    let open = accessible_channels(&l.inner.lock().unwrap().probes);
    if !open.contains(&channel) {
        return Err(format!("The {} channel needs the developer access key.", label(channel)));
    }
    // Test and RC get their own folder the first time they are used; Live never moves.
    let dirs = channel_dirs(&l);
    let dir = dirs[&channel].clone();
    if let Some(owner) = folder_owner(&dir, channel, &dirs, cfg!(windows)) {
        return Err(format!("The {} folder would be the {} game folder. Choose another folder for {} in Settings first.", label(channel), label(owner), label(channel)));
    }
    let first_use = channel != Channel::Live && l.inner.lock().unwrap().settings.folders.get(channel).is_empty();
    l.update_settings(|s| {
        s.channel = channel;
        if first_use {
            s.folders.set(channel, dir.clone());
        }
    });
    l.log(&format!("Channel: switched to {}{}.", channel.id(), if first_use { format!(" (its own folder: {dir})") } else { String::new() }));
    let message = if first_use { format!("{} channel. It installs into its own folder: {dir}", label(channel)) } else { format!("{} channel.", label(channel)) };
    l.send(json!({ "phase": "idle", "message": message, "canPlay": false, "version": null, "news": [], "installed": { "status": "unknown" }, "available": { "status": "checking" } }));
    l.refresh_installed().await;
    let me = l.clone();
    tauri::async_runtime::spawn(async move { me.refresh_available(true).await });
    Ok(l.settings_json())
}

#[tauri::command]
pub async fn answer_migration(launcher: L<'_>, value: Option<String>) -> Cmd<Value> {
    let l = launcher.inner().clone();
    l.require_idle()?;
    let channel = value.as_deref().and_then(Channel::parse);
    let question = l.inner.lock().unwrap().settings.migration_question.clone();
    if let Some(question) = question {
        if let Some(channel) = channel {
            if let Some(owner) = folder_owner(&question.dir, channel, &channel_dirs(&l), cfg!(windows)) {
                return Err(format!("That folder is already the {} game folder.", label(owner)));
            }
        }
        l.update_settings(|s| apply_migration_answer(s, &question, channel));
        l.log(&format!("Settings: old folder {} -> {}.", question.dir, channel.map(|c| c.id()).unwrap_or("left alone")));
    }
    l.send(json!({ "migrationQuestion": null, "phase": "idle", "canPlay": false }));
    l.refresh_installed().await;
    Ok(l.settings_json())
}

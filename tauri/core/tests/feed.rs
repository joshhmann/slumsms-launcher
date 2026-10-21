//! Behavioural tests for the feed protocol and the installer, ported from the Electron launcher's
//! test/layers, packs, access-key, versions and releases suites. Real HTTP against a local server.

mod support;

use serde_json::json;
use slums_core::error::{ACCESS_KEY_REQUIRED, DISK_FULL};
use slums_core::http::{FeedAccess, ACCESS_KEY_USER, DEV_ACCESS_USER};
use slums_core::install::{inspect_release, install_release, no_progress, InstallOptions, Mode, Progress, ProgressFn};
use slums_core::release::{check_available_release, load_release, read_installed_record, Available, Release, AVAILABLE_TIMEOUT};
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use support::*;
use tokio_util::sync::CancellationToken;

fn access(server: &Server, key: &str) -> FeedAccess {
    FeedAccess::new(&server.url("manifest.json"), key, ACCESS_KEY_USER).unwrap()
}

async fn load(server: &Server, dir: &Path, key: &str) -> slums_core::Result<Arc<Release>> {
    load_release(&server.url("manifest.json"), Some(dir.to_str().unwrap()), &access(server, key), &CancellationToken::new()).await.map(Arc::new)
}

fn fast() -> InstallOptions {
    InstallOptions { retry_delay_ms: 5, stall_ms: 2_000, ..Default::default() }
}

async fn install(dir: &Path, release: &Arc<Release>, options: InstallOptions) -> slums_core::Result<slums_core::install::InstallResult> {
    install_release(dir.to_str().unwrap(), release.clone(), no_progress(), options).await
}

async fn pending(dir: &Path, release: &Arc<Release>, mode: Mode) -> usize {
    inspect_release(dir.to_str().unwrap(), release.clone(), no_progress(), mode, CancellationToken::new()).await.unwrap().pending_files
}

fn base_layer() -> Layer {
    Layer::new("base", "v83", &[("Data/Mob/0100100.img", b"mob one"), ("Data/Map/Map0.img", b"map zero"), ("Data/empty.img", b"")])
}
fn client_layer(version: &str, exe: &[u8]) -> Layer {
    Layer::new("client", version, &[("SlumsMS.exe", exe), ("slums.dll", b"dll"), ("config.ini", b"[config]\r\nhost=a\r\n")])
}

async fn serve(layers: &[Layer], version: &str) -> Server {
    let server = Server::start().await;
    server.put_all(publish("", version, "SlumsMS.exe", layers, &["config.ini"], None).files);
    server
}

#[tokio::test]
async fn first_install_layers_override_and_record_installed() {
    let mut base = base_layer();
    base.files.push(("slums.dll".into(), b"old dll from base".to_vec()));
    let server = serve(&[base, client_layer("1.0", b"exe")], "1.0").await;
    let dir = temp_dir("install");
    let release = load(&server, &dir, "").await.unwrap();
    assert_eq!(release.files.iter().find(|f| f.path == "slums.dll").unwrap().layer, "client", "a later layer overrides");
    let result = install(&dir, &release, fast()).await.unwrap();
    assert_eq!(result.files, 6);
    assert_eq!(fs::read(dir.join("slums.dll")).unwrap(), b"dll");
    assert_eq!(fs::read(dir.join("Data/empty.img")).unwrap(), b"");
    let record = read_installed_record(dir.to_str().unwrap()).unwrap();
    assert_eq!(record.release, "1.0");
    assert_eq!(record.manifest_sha256, release.manifest_sha256);
    assert_eq!(record.launch.unwrap().executable, "SlumsMS.exe");
    let check = inspect_release(dir.to_str().unwrap(), release.clone(), no_progress(), Mode::Fast, CancellationToken::new()).await.unwrap();
    assert_eq!((check.pending_files, check.hashed), (0, 0), "state.json mtimes read back bit-exact: nothing is re-hashed");
    assert!(fs::read_dir(&dir).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with(".mapleroot-stage-")), "staging removed");
}

#[tokio::test]
async fn only_layers_whose_version_changed_are_downloaded() {
    let server = serve(&[base_layer(), client_layer("1.0", b"exe")], "1.0").await;
    let dir = temp_dir("layers");
    install(&dir, &load(&server, &dir, "").await.unwrap(), fast()).await.unwrap();
    server.put_all(publish("", "1.1", "SlumsMS.exe", &[base_layer(), client_layer("1.1", b"exe two")], &["config.ini"], None).files);
    server.clear_log();
    let release = load(&server, &dir, "").await.unwrap();
    assert!(release.layers.iter().find(|l| l.name == "base").unwrap().cached, "unchanged base manifest comes from the cache");
    install(&dir, &release, fast()).await.unwrap();
    let paths: Vec<String> = server.requests().into_iter().map(|l| l.path).collect();
    assert!(paths.iter().all(|p| !p.contains("/base/")), "base layer untouched: {paths:?}");
    assert!(paths.contains(&"/layers/client/1.1/files/SlumsMS.exe".to_string()));
    assert_eq!(paths.iter().filter(|p| p.contains("/files/")).count(), 1, "only the changed file: {paths:?}");
    assert_eq!(read_installed_record(dir.to_str().unwrap()).unwrap().release, "1.1");
}

#[tokio::test]
async fn fast_verify_trusts_size_and_mtime_and_repair_hashes_everything() {
    let server = serve(&[base_layer(), client_layer("1.0", b"exe")], "1.0").await;
    let dir = temp_dir("verify");
    let release = load(&server, &dir, "").await.unwrap();
    install(&dir, &release, fast()).await.unwrap();
    // A same-size tamper with a new mtime is hashed and caught.
    let mob = dir.join("Data/Mob/0100100.img");
    let installed_at = fs::metadata(&mob).unwrap().modified().unwrap();
    fs::write(&mob, b"mob ONE").unwrap();
    // Filesystem clocks are coarse: make the new mtime visibly different.
    fs::File::options().write(true).open(&mob).unwrap().set_modified(installed_at + Duration::from_secs(2)).unwrap();
    assert_eq!(pending(&dir, &release, Mode::Fast).await, 1);
    // A size change is caught without hashing; a missing file too.
    fs::write(&mob, b"mob one!").unwrap();
    fs::remove_file(dir.join("slums.dll")).unwrap();
    assert_eq!(pending(&dir, &release, Mode::Fast).await, 2);
    install(&dir, &release, fast()).await.unwrap();
    assert_eq!(fs::read(&mob).unwrap(), b"mob one");
    // Same size AND restored mtime: only Repair sees it.
    let mtime = fs::metadata(&mob).unwrap().modified().unwrap();
    fs::write(&mob, b"mob 1ne").unwrap();
    fs::File::options().write(true).open(&mob).unwrap().set_modified(mtime).unwrap();
    assert_eq!(pending(&dir, &release, Mode::Fast).await, 0, "the documented fast-verify limit");
    assert_eq!(pending(&dir, &release, Mode::Full).await, 1);
    let result = install(&dir, &release, InstallOptions { mode: Mode::Full, ..fast() }).await.unwrap();
    assert_eq!(result.files, 1);
    assert_eq!(fs::read(&mob).unwrap(), b"mob one");
}

#[tokio::test]
async fn player_owned_config_installs_once_survives_updates_and_repair() {
    let server = serve(&[base_layer(), client_layer("1.0", b"exe")], "1.0").await;
    let dir = temp_dir("owned");
    let release = load(&server, &dir, "").await.unwrap();
    install(&dir, &release, fast()).await.unwrap();
    fs::write(dir.join("config.ini"), b"[config]\r\nhost=mine\r\n; longer than before").unwrap();
    assert_eq!(pending(&dir, &release, Mode::Full).await, 0);
    install(&dir, &release, InstallOptions { mode: Mode::Full, ..fast() }).await.unwrap();
    assert!(String::from_utf8(fs::read(dir.join("config.ini")).unwrap()).unwrap().contains("host=mine"));
    fs::remove_file(dir.join("config.ini")).unwrap();
    install(&dir, &release, fast()).await.unwrap();
    assert_eq!(fs::read(dir.join("config.ini")).unwrap(), b"[config]\r\nhost=a\r\n");
}

#[tokio::test]
async fn schema_one_manifests_still_install() {
    let server = Server::start().await;
    let files = [("SlumsMS.exe", b"exe".as_slice()), ("Data/a b.img", b"space")];
    let entries: Vec<_> = files.iter().map(|(p, b)| json!({ "path": p, "size": b.len(), "sha256": sha(b), "url": format!("1.0/{}", p.replace(' ', "%20")) })).collect();
    for (p, b) in files {
        server.put(&format!("1.0/{p}"), b);
    }
    server.put("manifest.json", serde_json::to_vec(&json!({ "schemaVersion": 1, "version": "1.0", "launch": { "executable": "SlumsMS.exe", "args": [] }, "files": entries })).unwrap());
    let dir = temp_dir("schema1");
    let release = load(&server, &dir, "").await.unwrap();
    install(&dir, &release, fast()).await.unwrap();
    assert_eq!(fs::read(dir.join("Data/a b.img")).unwrap(), b"space");
    assert_eq!(pending(&dir, &release, Mode::Fast).await, 0);
}

#[tokio::test]
async fn hosted_layers_with_unsafe_or_reserved_paths_are_refused() {
    for bad in ["../evil.dll", ".slumsms-launcher/state.json", "Data/CON.img", ".mapleroot-stage-x/a"] {
        let server = serve(&[Layer::new("client", "1", &[("SlumsMS.exe", b"x"), (bad, b"y")])], "1").await;
        let dir = temp_dir("unsafe");
        assert!(load(&server, &dir, "").await.is_err(), "{bad}");
    }
}

#[tokio::test]
async fn a_tampered_layer_manifest_is_refused() {
    let server = serve(&[base_layer(), client_layer("1.0", b"exe")], "1.0").await;
    server.put("layers/client/1.0/manifest.json", br#"{"schemaVersion":2,"layer":"client","version":"1.0","files":[]}"#.to_vec());
    let error = load(&server, &temp_dir("tamper"), "").await.unwrap_err();
    assert!(error.message.contains("failed SHA-256 verification"), "{}", error.message);
}

#[tokio::test]
async fn per_file_downloads_retry_transient_failures_and_stop_on_404() {
    let server = serve(&[base_layer(), client_layer("1.0", b"exe")], "1.0").await;
    server.hook(|l, n| if l.path.ends_with("Map0.img") && n <= 2 { Action::Status(503) } else if l.path.ends_with("slums.dll") && n == 1 { Action::CutAfter(1) } else { Action::Serve });
    let dir = temp_dir("retry");
    let seen = Arc::new(Mutex::new(Vec::<Progress>::new()));
    let sink = seen.clone();
    let progress: ProgressFn = Arc::new(move |p| sink.lock().unwrap().push(p));
    let release = load(&server, &dir, "").await.unwrap();
    install_release(dir.to_str().unwrap(), release.clone(), progress, InstallOptions { concurrency: 2, ..fast() }).await.unwrap();
    assert_eq!(server.count(|l| l.path.ends_with("Map0.img")), 3);
    let last = seen.lock().unwrap().last().cloned().unwrap();
    assert_eq!(last.bytes_done, last.bytes_total, "byte progress completes");
    // A permanent 404 fails at once, without retries.
    let server = serve(&[base_layer(), client_layer("1.0", b"exe")], "1.0").await;
    server.hook(|l, _| if l.path.ends_with("slums.dll") { Action::Status(404) } else { Action::Serve });
    let dir = temp_dir("404");
    let release = load(&server, &dir, "").await.unwrap();
    let error = install(&dir, &release, fast()).await.unwrap_err();
    assert!(error.message.contains("HTTP 404"), "{}", error.message);
    assert_eq!(server.count(|l| l.path.ends_with("slums.dll")), 1);
    // Files that verified before the failure are kept; the next run only fetches the rest.
    server.hook(|_, _| Action::Serve);
    server.clear_log();
    install(&dir, &release, fast()).await.unwrap();
    assert!(server.count(|l| l.path.contains("/files/")) < 6);
}

#[tokio::test]
async fn a_corrupt_payload_never_replaces_an_existing_file() {
    let server = serve(&[base_layer(), client_layer("1.0", b"exe")], "1.0").await;
    let dir = temp_dir("corrupt");
    install(&dir, &load(&server, &dir, "").await.unwrap(), fast()).await.unwrap();
    server.put_all(publish("", "1.1", "SlumsMS.exe", &[base_layer(), Layer::new("client", "1.1", &[("SlumsMS.exe", b"new exe"), ("slums.dll", b"new dll"), ("config.ini", b"x")])], &["config.ini"], None).files);
    server.hook(|l, _| if l.path.ends_with("slums.dll") { Action::Body(b"bad dll".to_vec()) } else { Action::Serve });
    let release = load(&server, &dir, "").await.unwrap();
    assert!(install(&dir, &release, fast()).await.is_err());
    assert_eq!(fs::read(dir.join("SlumsMS.exe")).unwrap(), b"exe", "replacements wait until every download verified");
    assert_eq!(fs::read(dir.join("slums.dll")).unwrap(), b"dll");
}

#[tokio::test]
async fn redirected_feeds_resolve_relative_to_the_final_manifest() {
    let server = Server::start().await;
    server.put_all(publish("real/", "1.0", "SlumsMS.exe", &[client_layer("1.0", b"exe")], &[], None).files);
    let target = server.url("real/manifest.json");
    server.hook(move |l, _| if l.path == "/manifest.json" { Action::Redirect(target.clone()) } else { Action::Serve });
    let dir = temp_dir("redirect");
    let release = load(&server, &dir, "").await.unwrap();
    install(&dir, &release, fast()).await.unwrap();
    assert_eq!(fs::read(dir.join("SlumsMS.exe")).unwrap(), b"exe");
}

#[tokio::test]
async fn news_round_trips_and_bad_news_is_refused() {
    let server = Server::start().await;
    server.put_all(publish("", "1.0", "SlumsMS.exe", &[client_layer("1.0", b"exe")], &[], Some(json!([{ "title": "Henesys festival", "date": "2026-10-18", "body": "Double EXP.\nSee you." }]))).files);
    let release = load(&server, &temp_dir("news"), "").await.unwrap();
    assert_eq!(release.news.as_ref().unwrap()[0].title, "Henesys festival");
    server.put_all(publish("", "1.0", "SlumsMS.exe", &[client_layer("1.0", b"exe")], &[], Some(json!([{ "title": "<b>x</b>\u{0007}" }]))).files);
    assert!(load(&server, &temp_dir("news2"), "").await.is_err());
}

// ---------------------------------------------------------------------------------------------
// Access key

#[tokio::test]
async fn the_key_is_sent_on_every_feed_request_and_never_without_one() {
    let server = serve(&[base_layer(), client_layer("1.0", b"exe")], "1.0").await;
    server.require(&[basic("slums", "k3y")]);
    let dir = temp_dir("key");
    install(&dir, &load(&server, &dir, "k3y").await.unwrap(), fast()).await.unwrap();
    assert!(server.requests().iter().all(|l| l.authorization.as_deref() == Some(basic("slums", "k3y").as_str())));
    let open = serve(&[client_layer("1.0", b"exe")], "1.0").await;
    let dir = temp_dir("nokey");
    install(&dir, &load(&open, &dir, "").await.unwrap(), fast()).await.unwrap();
    assert!(open.requests().iter().all(|l| l.authorization.is_none()));
}

#[tokio::test]
async fn the_dev_user_is_just_another_basic_user() {
    let server = serve(&[client_layer("1.0", b"exe")], "1.0").await;
    server.require(&[basic("slums", "player"), basic("slumsdev", "dev")]);
    let dev = FeedAccess::new(&server.url("manifest.json"), "dev", DEV_ACCESS_USER).unwrap();
    assert!(check_available_release(&server.url("manifest.json"), Some(&dev), AVAILABLE_TIMEOUT).await.is_ok());
    let wrong = FeedAccess::new(&server.url("manifest.json"), "dev", ACCESS_KEY_USER).unwrap();
    assert_eq!(check_available_release(&server.url("manifest.json"), Some(&wrong), AVAILABLE_TIMEOUT).await.status(), "access-key");
}

#[tokio::test]
async fn a_cross_origin_redirect_drops_the_key_even_when_it_bounces_back() {
    let feed = serve(&[client_layer("1.0", b"exe")], "1.0").await;
    let cdn = Server::start().await;
    cdn.put_all(feed.files.lock().unwrap().clone());
    let cdn_base = cdn.base.clone();
    feed.hook(move |l, _| if l.path.contains("/files/") { Action::Redirect(format!("{cdn_base}{}", &l.path[1..])) } else { Action::Serve });
    let dir = temp_dir("cdn");
    install(&dir, &load(&feed, &dir, "k").await.unwrap(), fast()).await.unwrap();
    assert!(cdn.requests().iter().all(|l| l.authorization.is_none()), "the CDN never sees the key");
    assert!(feed.requests().iter().all(|l| l.authorization.is_some()));
    // feed -> cdn -> feed again: the last hop stays without the key.
    let feed_base = feed.base.clone();
    cdn.hook(move |l, _| if l.path == "/bounce" { Action::Redirect(format!("{feed_base}manifest.json")) } else { Action::Serve });
    let cdn_bounce = cdn.url("bounce");
    feed.hook(move |l, _| if l.path == "/start" { Action::Redirect(cdn_bounce.clone()) } else { Action::Serve });
    feed.clear_log();
    let a = access(&feed, "k");
    slums_core::http::read_bytes(&feed.url("start"), "x", Some(&a), &CancellationToken::new(), None).await.unwrap();
    let log = feed.requests();
    assert_eq!(log.len(), 2);
    assert!(log[0].authorization.is_some() && log[1].authorization.is_none());
}

#[tokio::test]
async fn http_401_is_the_access_key_error_and_is_never_retried() {
    let server = serve(&[client_layer("1.0", b"exe")], "1.0").await;
    server.require(&[basic("slums", "right")]);
    let error = load(&server, &temp_dir("401"), "wrong").await.unwrap_err();
    assert!(error.is(ACCESS_KEY_REQUIRED));
    assert_eq!(error.message, "This server needs an access key - enter it in Settings");
    assert_eq!(server.requests().len(), 1);
    // Revoked mid-install: stops at once.
    let server = serve(&[base_layer(), client_layer("1.0", b"exe")], "1.0").await;
    let dir = temp_dir("revoked");
    let release = load(&server, &dir, "k").await.unwrap();
    server.hook(|l, _| if l.path.ends_with("slums.dll") { Action::Status(401) } else { Action::Serve });
    let error = install(&dir, &release, InstallOptions { concurrency: 1, ..fast() }).await.unwrap_err();
    assert!(error.is(ACCESS_KEY_REQUIRED));
    assert_eq!(server.count(|l| l.path.ends_with("slums.dll")), 1);
}

// ---------------------------------------------------------------------------------------------
// Versions

#[tokio::test]
async fn availability_reads_only_the_top_manifest_and_never_fails() {
    let server = serve(&[base_layer(), client_layer("1.0", b"exe")], "1.0").await;
    let a = access(&server, "");
    match check_available_release(&server.url("manifest.json"), Some(&a), AVAILABLE_TIMEOUT).await {
        Available::Ok { version, layers, .. } => {
            assert_eq!(version, "1.0");
            assert_eq!(layers.len(), 2);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(server.requests().len(), 1);
    assert_eq!(check_available_release(&server.url("missing.json"), Some(&a), AVAILABLE_TIMEOUT).await.status(), "error");
    server.put("bad.json", b"{not json".to_vec());
    assert_eq!(check_available_release(&server.url("bad.json"), Some(&a), AVAILABLE_TIMEOUT).await.status(), "error");
    let closed = format!("http://127.0.0.1:{}/manifest.json", { let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); l.local_addr().unwrap().port() });
    assert_eq!(check_available_release(&closed, None, AVAILABLE_TIMEOUT).await.status(), "offline");
    server.hook(|_, _| Action::StallAfter(0));
    assert_eq!(check_available_release(&server.url("manifest.json"), Some(&a), Duration::from_millis(300)).await.status(), "offline");
}

#[tokio::test]
async fn installed_record_is_written_only_by_a_clean_install_or_verify() {
    let dir = temp_dir("record");
    assert!(read_installed_record(dir.to_str().unwrap()).is_none());
    assert!(read_installed_record(dir.join("nope").to_str().unwrap()).is_none());
    fs::create_dir_all(dir.join(".slumsms-launcher")).unwrap();
    fs::write(dir.join(".slumsms-launcher/installed.json"), b"{broken").unwrap();
    assert!(read_installed_record(dir.to_str().unwrap()).is_none());
    let server = serve(&[base_layer(), client_layer("1.0", b"exe")], "1.0").await;
    let release = load(&server, &dir, "").await.unwrap();
    install(&dir, &release, fast()).await.unwrap();
    assert_eq!(read_installed_record(dir.to_str().unwrap()).unwrap().release, "1.0");
    server.put_all(publish("", "1.1", "SlumsMS.exe", &[base_layer(), client_layer("1.1", b"exe 2")], &[], None).files);
    let next = load(&server, &dir, "").await.unwrap();
    assert_eq!(pending(&dir, &next, Mode::Fast).await, 1);
    assert_eq!(read_installed_record(dir.to_str().unwrap()).unwrap().release, "1.0", "a verify with pending files leaves the record");
    install(&dir, &next, fast()).await.unwrap();
    assert_eq!(read_installed_record(dir.to_str().unwrap()).unwrap().release, "1.1");
    // An install the launcher never recorded is recovered by the next clean verify.
    fs::remove_file(dir.join(".slumsms-launcher/installed.json")).unwrap();
    assert_eq!(pending(&dir, &next, Mode::Fast).await, 0);
    assert_eq!(read_installed_record(dir.to_str().unwrap()).unwrap().release, "1.1");
}

// ---------------------------------------------------------------------------------------------
// Packs

fn many_files(count: usize, size: usize) -> Vec<(String, Vec<u8>)> {
    (0..count).map(|i| (format!("Data/Mob/{i:07}.img"), (0..size).map(|b| ((b * 31 + i * 7) % 251) as u8).collect())).collect()
}

fn big_base(count: usize, size: usize, pack: usize) -> Layer {
    let mut files = many_files(count, size);
    files.push(("Data/dup-a.img".into(), b"same bytes".to_vec()));
    files.push(("Data/dup-b.img".into(), b"same bytes".to_vec()));
    files.push(("Data/zero.img".into(), vec![]));
    Layer { name: "base".into(), version: "v83".into(), files, pack_size: Some(pack) }
}

#[tokio::test]
async fn a_first_install_takes_packs_with_duplicates_and_empty_files() {
    let server = serve(&[big_base(60, 3000, 50_000), client_layer("1.0", b"exe")], "1.0").await;
    let dir = temp_dir("packs");
    let release = load(&server, &dir, "").await.unwrap();
    let result = install(&dir, &release, fast()).await.unwrap();
    assert!(result.packs >= 3, "{result:?}");
    let file_requests = server.count(|l| l.path.contains("/files/"));
    assert!(file_requests <= 3, "client files only, {file_requests}");
    assert_eq!(fs::read(dir.join("Data/dup-b.img")).unwrap(), b"same bytes");
    assert_eq!(fs::read(dir.join("Data/zero.img")).unwrap(), b"");
    assert_eq!(pending(&dir, &release, Mode::Full).await, 0);
}

#[tokio::test]
async fn a_dropped_pack_connection_resumes_at_the_exact_byte() {
    let server = serve(&[big_base(40, 4000, 1_000_000), client_layer("1.0", b"exe")], "1.0").await;
    server.hook(|l, n| if l.path.ends_with("0001.pack") && n == 1 { Action::CutAfter(50_001) } else { Action::Serve });
    let dir = temp_dir("cut");
    let release = load(&server, &dir, "").await.unwrap();
    install(&dir, &release, fast()).await.unwrap();
    let ranges: Vec<String> = server.requests().into_iter().filter(|l| l.path.ends_with("0001.pack")).map(|l| l.range.unwrap()).collect();
    assert_eq!(ranges.len(), 2);
    assert!(ranges[1].starts_with("bytes=50001-"), "{ranges:?}");
    assert_eq!(pending(&dir, &release, Mode::Full).await, 0);
}

#[tokio::test]
async fn a_stalled_pack_is_resumed_after_the_stall_timeout() {
    let server = serve(&[big_base(40, 4000, 1_000_000), client_layer("1.0", b"exe")], "1.0").await;
    server.hook(|l, n| if l.path.ends_with("0001.pack") && n == 1 { Action::StallAfter(10_000) } else { Action::Serve });
    let dir = temp_dir("stall");
    let release = load(&server, &dir, "").await.unwrap();
    install(&dir, &release, InstallOptions { stall_ms: 300, ..fast() }).await.unwrap();
    let ranges: Vec<String> = server.requests().into_iter().filter(|l| l.path.ends_with("0001.pack")).map(|l| l.range.unwrap()).collect();
    assert!(ranges[1].starts_with("bytes=10000-"), "{ranges:?}");
}

#[tokio::test]
async fn a_server_without_range_support_still_works() {
    let server = serve(&[big_base(40, 2000, 30_000), client_layer("1.0", b"exe")], "1.0").await;
    server.hook(|_, _| Action::NoRange);
    let dir = temp_dir("norange");
    let release = load(&server, &dir, "").await.unwrap();
    install(&dir, &release, fast()).await.unwrap();
    assert_eq!(pending(&dir, &release, Mode::Full).await, 0);
}

#[tokio::test]
async fn damaged_and_missing_packs_fall_back_to_per_file() {
    let server = serve(&[big_base(40, 2000, 30_000), client_layer("1.0", b"exe")], "1.0").await;
    server.hook(|l, _| {
        if l.path.ends_with("0001.pack") {
            Action::Status(404)
        } else if l.path.ends_with("0002.pack") {
            // Same length, one flipped byte in the middle: a file fails its SHA-256.
            Action::CutAfter(usize::MAX)
        } else {
            Action::Serve
        }
    });
    let pack2 = server.files.lock().unwrap().get("layers/base/v83/packs/0002.pack").cloned().unwrap();
    let mut damaged = pack2.clone();
    damaged[pack2.len() / 2] ^= 0xff;
    server.hook(move |l, _| {
        if l.path.ends_with("0001.pack") {
            Action::Status(404)
        } else if l.path.ends_with("0002.pack") {
            Action::Body(damaged.clone())
        } else {
            Action::Serve
        }
    });
    let dir = temp_dir("damaged");
    let release = load(&server, &dir, "").await.unwrap();
    install(&dir, &release, fast()).await.unwrap();
    assert!(server.count(|l| l.path.contains("/base/v83/files/")) > 10);
    assert_eq!(pending(&dir, &release, Mode::Full).await, 0);
}

#[tokio::test]
async fn an_interrupted_first_install_resumes_without_downloading_committed_files() {
    let server = serve(&[big_base(60, 3000, 40_000), client_layer("1.0", b"exe")], "1.0").await;
    server.hook(|l, _| if l.path.ends_with("0003.pack") { Action::Status(401) } else { Action::Serve });
    let dir = temp_dir("resume");
    let release = load(&server, &dir, "").await.unwrap();
    assert!(install(&dir, &release, InstallOptions { pack_concurrency: 1, ..fast() }).await.is_err());
    let kept = 60 + 3 - pending(&dir, &release, Mode::Fast).await;
    assert!(kept >= 20, "files from the finished packs stay: {kept}");
    server.hook(|_, _| Action::Serve);
    server.clear_log();
    let seen = Arc::new(Mutex::new(Vec::<Progress>::new()));
    let sink = seen.clone();
    let result = install_release(dir.to_str().unwrap(), release.clone(), Arc::new(move |p| sink.lock().unwrap().push(p)), fast()).await.unwrap();
    assert!(result.resumed);
    assert!(server.count(|l| l.path.ends_with("0001.pack")) == 0, "finished packs are not fetched again");
    let seen = seen.lock().unwrap();
    assert!(seen.iter().any(|p| p.message.starts_with("Checked ") && p.message.ends_with("already downloaded, continuing.")));
    assert!(seen.windows(2).all(|w| w[1].bytes_done >= w[0].bytes_done || w[1].message.contains("Installing")), "never backwards");
    assert!(seen.iter().all(|p| p.bytes_done >= result.kept_bytes || p.message.starts_with("Checking") || p.message.starts_with("Verif")));
}

#[tokio::test]
async fn the_disk_space_check_refuses_before_downloading_anything() {
    let server = serve(&[big_base(40, 2000, 30_000), client_layer("1.0", b"exe")], "1.0").await;
    let dir = temp_dir("disk");
    let release = load(&server, &dir, "").await.unwrap();
    server.clear_log();
    let error = install(&dir, &release, InstallOptions { free_space: Some(Arc::new(|_| Some(1000))), ..fast() }).await.unwrap_err();
    assert!(error.is(DISK_FULL));
    assert!(error.message.starts_with("Not enough disk space"));
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn a_small_update_stays_per_file_and_shadowed_base_content_comes_from_base_packs() {
    let server = serve(&[big_base(40, 2000, 30_000), client_layer("1.0", b"exe")], "1.0").await;
    let dir = temp_dir("small");
    install(&dir, &load(&server, &dir, "").await.unwrap(), fast()).await.unwrap();
    server.put_all(publish("", "1.1", "SlumsMS.exe", &[big_base(40, 2000, 30_000), client_layer("1.1", b"exe 2")], &[], None).files);
    server.clear_log();
    install(&dir, &load(&server, &dir, "").await.unwrap(), fast()).await.unwrap();
    assert_eq!(server.count(|l| l.path.contains("packs/")), 0, "under 32 files: no pack index");
    // A client layer that shadows base files with identical bytes, and has no packs itself.
    let mut client = Layer { name: "client".into(), version: "2.0".into(), files: many_files(40, 2000), pack_size: None };
    client.files.push(("SlumsMS.exe".into(), b"exe".to_vec()));
    let server = serve(&[big_base(40, 2000, 30_000), client], "2.0").await;
    let dir = temp_dir("shadow");
    let release = load(&server, &dir, "").await.unwrap();
    install(&dir, &release, fast()).await.unwrap();
    assert!(server.count(|l| l.path.contains("/client/2.0/files/Data")) == 0, "shadowed content came from base packs");
    assert_eq!(pending(&dir, &release, Mode::Full).await, 0);
}

#[tokio::test]
async fn cancelling_stops_cleanly_and_keeps_finished_files() {
    let server = serve(&[big_base(60, 3000, 40_000), client_layer("1.0", b"exe")], "1.0").await;
    server.hook(|l, _| if l.path.ends_with("0002.pack") { Action::StallAfter(5000) } else { Action::Serve });
    let dir = temp_dir("cancel");
    let release = load(&server, &dir, "").await.unwrap();
    let cancel = CancellationToken::new();
    let stopper = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        stopper.cancel();
    });
    let error = install(&dir, &release, InstallOptions { cancel, stall_ms: 30_000, pack_concurrency: 1, ..fast() }).await.unwrap_err();
    assert!(error.is(slums_core::error::ABORTED), "{error:?}");
    let left = pending(&dir, &release, Mode::Fast).await;
    let on_disk = walk(&dir);
    assert!(left + 5 < release.files.len(), "the first pack files were kept: {left} of {} pending; disk {on_disk:?}", release.files.len());
}

fn walk(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(dir).unwrap().flatten() {
        if entry.file_type().unwrap().is_dir() {
            out.extend(walk(&entry.path()));
        } else {
            out.push(entry.path().display().to_string());
        }
    }
    out
}

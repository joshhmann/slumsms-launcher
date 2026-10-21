//! Dev CLI for the launcher core (no window): check a feed, probe channels, install into a folder.
//! The access key comes from the SLUMS_KEY environment variable, never the command line.
//!
//!   cargo run -p slums-core --example cli -- probe   --feed URL
//!   cargo run -p slums-core --example cli -- status  --feed URL --dir DIR
//!   cargo run -p slums-core --example cli -- install --feed URL --dir DIR [--repair] [--user slumsdev]

use slums_core::channels::{probe_channels, Channel};
use slums_core::http::FeedAccess;
use slums_core::install::{inspect_release, install_release, InstallOptions, Mode, ProgressFn};
use slums_core::release::{check_available_release, load_release, read_installed_record, AVAILABLE_TIMEOUT};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio_util::sync::CancellationToken;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().cloned().unwrap_or_default();
    let feed = arg(&args, "--feed").expect("--feed URL");
    let key = std::env::var("SLUMS_KEY").unwrap_or_default();
    let user = arg(&args, "--user").unwrap_or_else(|| "slums".into());
    let access = FeedAccess::new(&feed, &key, &user).expect("feed URL");
    match command.as_str() {
        "probe" => {
            let (probes, user) = probe_channels(&feed, &key, &user).await;
            println!("user that opened Live: {user}");
            for channel in [Channel::Live, Channel::Test, Channel::Rc] {
                println!("{:5} {}", channel.label(), serde_json::to_string(&probes[&channel]).unwrap());
            }
        }
        "status" => {
            let dir = arg(&args, "--dir").expect("--dir DIR");
            println!("available: {}", serde_json::to_string(&check_available_release(&feed, Some(&access), AVAILABLE_TIMEOUT).await).unwrap());
            println!("installed: {}", serde_json::to_string(&read_installed_record(&dir)).unwrap());
            let release = Arc::new(load_release(&feed, Some(&dir), &access, &CancellationToken::new()).await.expect("load"));
            let result = inspect_release(&dir, release, Arc::new(|_| {}), Mode::Fast, CancellationToken::new()).await.expect("inspect");
            println!("pending: {} files, {} bytes (kept {} bytes, hashed {})", result.pending_files, result.bytes, result.kept_bytes, result.hashed);
        }
        "install" => {
            let dir = arg(&args, "--dir").expect("--dir DIR");
            let started = Instant::now();
            let release = Arc::new(load_release(&feed, Some(&dir), &access, &CancellationToken::new()).await.expect("load"));
            println!("release {} ({} files, layers {:?})", release.version, release.files.len(), release.layers.iter().map(|l| format!("{}@{}", l.name, l.version)).collect::<Vec<_>>());
            let last = Arc::new(Mutex::new((Instant::now(), String::new())));
            let progress: ProgressFn = Arc::new(move |p| {
                let mut last = last.lock().unwrap();
                if last.0.elapsed().as_millis() >= 250 && p.message != last.1 {
                    println!("  {} [{} / {} files, {} / {} bytes]", p.message, p.files_done, p.files_total, p.bytes_done, p.bytes_total);
                    *last = (Instant::now(), p.message);
                }
            });
            let mode = if args.iter().any(|a| a == "--repair") { Mode::Full } else { Mode::Fast };
            match install_release(&dir, release, progress, InstallOptions { mode, ..Default::default() }).await {
                Ok(result) => println!("done in {:.1}s: {}", started.elapsed().as_secs_f64(), serde_json::to_string(&result).unwrap()),
                Err(error) => {
                    eprintln!("failed: {} (code {:?})", error.message, error.code);
                    std::process::exit(1);
                }
            }
        }
        _ => eprintln!("commands: probe | status | install"),
    }
}

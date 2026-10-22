// The release exe is a Windows GUI program (no console window); debug builds keep the console.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod launcher;
mod platform;
mod single_instance;

use launcher::{Args, Launcher};
use std::sync::Arc;
use tauri::{Manager, WindowEvent};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    let started = std::time::Instant::now();
    let args = Args::parse(std::env::args().skip(1).collect());
    // The release build aborts on panic; leave a note where support can find it.
    let crash_dir = args.data_dir.clone().unwrap_or_else(std::env::temp_dir);
    #[cfg(windows)]
    let quiet = args.self_test.is_some();
    std::panic::set_hook(Box::new(move |info| {
        let text = format!("{} SlumsMS Launcher {VERSION} crashed: {info}\n", slums_core::release::iso_now());
        eprintln!("{text}");
        let _ = std::fs::OpenOptions::new().create(true).append(true).open(crash_dir.join("slumsms-launcher-crash.log")).and_then(|mut f| std::io::Write::write_all(&mut f, text.as_bytes()));
        // A WebView2 that is missing, broken or blocked is the one start-up failure players can fix.
        #[cfg(windows)]
        if !quiet && text.contains("WebView2") {
            platform::explain_missing_webview2();
        }
    }));
    if args.version {
        platform::print_out(&format!("SlumsMS Launcher {VERSION}"));
        return;
    }
    #[cfg(windows)]
    if platform::webview2_version().is_none() {
        if let Some(report) = &args.self_test {
            let _ = std::fs::write(report, format!("{{\"version\":\"{VERSION}\",\"ok\":false,\"error\":\"WebView2 runtime missing\"}}"));
        } else {
            platform::explain_missing_webview2();
        }
        return;
    }
    let mut builder = tauri::Builder::default();
    // Updated children register after reporting healthy and waiting for the old owner.
    if args.self_updated.is_none() && args.self_test.is_none() {
        builder = builder.plugin(single_instance::plugin());
    }
    let setup_args = args.clone();
    let result = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            let launcher = Launcher::new(app.handle().clone(), setup_args.clone(), started)?;
            app.manage(Arc::new(launcher));
            // The window is created hidden (no white flash); a self-test never shows it.
            if setup_args.self_test.is_none() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            launcher::settings,
            launcher::save_feed,
            launcher::reset_feed,
            launcher::save_access_key,
            launcher::clear_access_key,
            launcher::choose_folder,
            launcher::open_folder,
            launcher::reset_folder,
            launcher::check,
            launcher::update,
            launcher::repair,
            launcher::play,
            launcher::game_options,
            launcher::save_game_options,
            launcher::reset_game_options,
            launcher::set_channel,
            launcher::answer_migration,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let launcher = window.state::<Arc<Launcher>>().inner().clone();
                if launcher.confirm_close() {
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!());
    if let Err(error) = result {
        #[cfg(windows)]
        {
            use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
            let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
            let (text, title) = (wide(&format!("SlumsMS Launcher could not start:\n{error}")), wide("SlumsMS Launcher"));
            // SAFETY: valid NUL-terminated strings.
            unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR) };
        }
        eprintln!("SlumsMS Launcher could not start: {error}");
        std::process::exit(1);
    }
}

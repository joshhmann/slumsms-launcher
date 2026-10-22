//! Keep the update health handshake independent from single-instance ownership.
use tauri::{AppHandle, Manager};

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    })
}

#[cfg(windows)]
fn owner_present(app: &AppHandle, _parent: Option<u32>) -> slums_core::Result<bool> {
    windows_owner_present(&app.config().identifier)
}

#[cfg(windows)]
fn windows_owner_present(identifier: &str) -> slums_core::Result<bool> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_FILE_NOT_FOUND},
        System::Threading::{OpenMutexW, SYNCHRONIZATION_SYNCHRONIZE},
    };
    // The name is the pinned single-instance plugin's bundle-identifier mutex.
    // Probe and immediately close: retaining a handle would prevent release.
    let name: Vec<u16> = format!("{identifier}-sim").encode_utf16().chain(Some(0)).collect();
    // SAFETY: valid NUL-terminated mutex name; each successful open is closed once.
    unsafe {
        let handle = OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, 0, name.as_ptr());
        if !handle.is_null() {
            CloseHandle(handle);
            Ok(true)
        } else if GetLastError() == ERROR_FILE_NOT_FOUND {
            Ok(false)
        } else {
            Err(slums_core::Error::new("Could not check the previous launcher's single-instance ownership."))
        }
    }
}

#[cfg(not(windows))]
fn owner_present(_app: &AppHandle, parent: Option<u32>) -> slums_core::Result<bool> {
    parent.map(slums_core::instance::parent_present).unwrap_or(Ok(false))
}

pub fn after_update(app: AppHandle, parent: Option<u32>) {
    tauri::async_runtime::spawn(async move {
        let register_app = app.clone();
        let result = slums_core::instance::reacquire(
            || owner_present(&app, parent),
            || {
                // The Windows single-instance message window belongs on the UI thread.
                register_app
                    .run_on_main_thread({
                        let app = register_app.clone();
                        move || {
                            // Without the lock this window still works; only a second
                            // launch would open a second window. Never quit a healthy launcher.
                            if let Err(error) = app.plugin(plugin()) {
                                eprintln!("Could not register updated launcher: {error}");
                            }
                        }
                    })
                    .map_err(|e| slums_core::Error::new(e.to_string()))
            },
            std::time::Duration::from_secs(120),
        )
        .await;
        if let Err(error) = result {
            // The old launcher is slow to exit: keep running without single-instance ownership.
            eprintln!("{}", error.message);
        }
    });
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS},
        System::Threading::CreateMutexW,
    };

    #[tokio::test]
    async fn updated_child_takes_the_native_mutex_and_a_later_launch_finds_it_owned() {
        let id = format!(
            "slums-instance-test-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        );
        let name: Vec<u16> = format!("{id}-sim").encode_utf16().chain(Some(0)).collect();
        // SAFETY: valid NUL-terminated names; no initial thread ownership, and all handles close below.
        let parent = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        assert!(!parent.is_null());
        assert!(windows_owner_present(&id).unwrap());
        let child_id = id.clone();
        let child_name = name.clone();
        let child = tokio::spawn(async move {
            let handle = std::sync::atomic::AtomicIsize::new(0);
            slums_core::instance::reacquire(
                || windows_owner_present(&child_id),
                || {
                    let mutex = unsafe { CreateMutexW(std::ptr::null(), 0, child_name.as_ptr()) };
                    assert!(!mutex.is_null());
                    assert_ne!(unsafe { GetLastError() }, ERROR_ALREADY_EXISTS);
                    handle.store(mutex as isize, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                },
                Duration::from_secs(2),
            )
            .await
            .unwrap();
            handle.load(std::sync::atomic::Ordering::SeqCst)
        });
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(!child.is_finished(), "the updated child must wait for the old owner");
        unsafe { CloseHandle(parent) };
        let child_handle = child.await.unwrap();
        assert!(windows_owner_present(&id).unwrap());
        let later = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        assert!(!later.is_null());
        assert_eq!(unsafe { GetLastError() }, ERROR_ALREADY_EXISTS, "a later launch is secondary");
        unsafe {
            CloseHandle(later);
            CloseHandle(child_handle as _);
        }
        assert!(!windows_owner_present(&id).unwrap());
    }
}

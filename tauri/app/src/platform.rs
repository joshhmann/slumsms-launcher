//! Small OS helpers: console output for `--version`, the WebView2 runtime check, opening a folder.

/// Print to the console that started us (the release exe is a GUI-subsystem program).
pub fn print_out(text: &str) {
    #[cfg(windows)]
    unsafe {
        // SAFETY: plain Win32 call; failure only means there is no parent console.
        windows_sys::Win32::System::Console::AttachConsole(windows_sys::Win32::System::Console::ATTACH_PARENT_PROCESS);
    }
    use std::io::Write;
    let mut out = std::io::stdout();
    let _ = writeln!(out, "{text}");
    let _ = out.flush();
}

pub const WEBVIEW2_DOWNLOAD: &str = "https://developer.microsoft.com/microsoft-edge/webview2/#download-section";

/// The installed WebView2 runtime version, from the registry keys Microsoft documents for this check.
#[cfg(windows)]
pub fn webview2_version() -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let client = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    let keys = [
        (HKEY_LOCAL_MACHINE, format!("SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{client}")),
        (HKEY_LOCAL_MACHINE, format!("SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{client}")),
        (HKEY_CURRENT_USER, format!("Software\\Microsoft\\EdgeUpdate\\Clients\\{client}")),
    ];
    for (root, key) in keys {
        let (key, value) = (wide(&key), wide("pv"));
        let mut buffer = [0u16; 128];
        let mut size = (buffer.len() * 2) as u32;
        // SAFETY: valid NUL-terminated strings and a buffer of `size` bytes.
        let status = unsafe { RegGetValueW(root, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buffer.as_mut_ptr().cast(), &mut size) };
        if status == 0 {
            let len = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
            let version = String::from_utf16_lossy(&buffer[..len]);
            if !version.is_empty() && version != "0.0.0.0" {
                return Some(version);
            }
        }
    }
    None
}

#[cfg(not(windows))]
pub fn webview2_version() -> Option<String> {
    Some("not-windows".into())
}

/// Without WebView2 the window cannot open: say so plainly and offer Microsoft's download page.
#[cfg(windows)]
pub fn explain_missing_webview2() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_ICONWARNING, MB_YESNO};
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let text = wide(
        "SlumsMS Launcher needs the Microsoft Edge WebView2 Runtime, which is missing or not working on this PC.\n\n\
         It is free and comes from Microsoft (Windows 11 and up-to-date Windows 10 already have it).\n\n\
         Open the download page now? Install (or repair) the \"Evergreen\" runtime, then start the launcher again.",
    );
    let title = wide("SlumsMS Launcher");
    // SAFETY: valid NUL-terminated strings; no owner window.
    let answer = unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_YESNO | MB_ICONWARNING) };
    if answer == IDYES {
        open_path(WEBVIEW2_DOWNLOAD);
    }
}

/// Open a folder in Explorer (or a URL in the browser).
pub fn open_path(target: &str) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let (verb, file) = (wide("open"), wide(target));
        // SAFETY: valid NUL-terminated strings.
        let result = unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
        result as usize > 32
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open").arg(target).spawn().is_ok()
    }
}

//! Test helper only (used by tests/selfupdate.rs): stands in for a launcher build.
//! Without --self-updated it idles like a running launcher. With --self-updated=VERSION it acts out
//! --fake-mode=MODE: "healthy" (default) writes the health marker beside its exe, "exit" quits at once,
//! "hang" never reports.
fn main() {
    let updated = std::env::args().find_map(|a| a.strip_prefix("--self-updated=").map(str::to_string));
    let Some(version) = updated else {
        std::thread::sleep(std::time::Duration::from_secs(60));
        return;
    };
    let mode = std::env::args().find_map(|a| a.strip_prefix("--fake-mode=").map(str::to_string));
    match mode.as_deref() {
        Some("exit") => std::process::exit(3),
        Some("hang") => std::thread::sleep(std::time::Duration::from_secs(60)),
        _ => {
            let exe = std::env::current_exe().expect("exe");
            let marker = slums_core::selfupdate::healthy_marker(&exe, &version);
            std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
            std::fs::write(marker, std::process::id().to_string()).unwrap();
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    }
}

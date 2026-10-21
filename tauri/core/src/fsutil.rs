//! Installation-folder file access that never follows symlinks and refuses Windows case aliases.
//! Port of installationRoot/destination/checkSpelling/digest/readSmallFile/writeSmallFile.

use crate::error::{Error, Result};
use crate::manifest::windows_key;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

/// What a directory listing says about each Windows-equivalent name (None when two entries alias).
#[derive(Default)]
pub struct DirCache {
    entries: HashMap<PathBuf, HashMap<String, Option<String>>>,
    verified: HashSet<PathBuf>,
}

impl DirCache {
    pub fn new() -> Self {
        Self::default()
    }
    fn note(&mut self, parent: &Path, name: &str) {
        if let Some(map) = self.entries.get_mut(parent) {
            map.insert(windows_key(name), Some(name.to_string()));
        }
    }
}

/// Modification time in milliseconds, computed exactly like Node's `stat.mtimeMs`
/// (sec * 1e3 + nsec / 1e6 in doubles), so state.json written by the Electron launcher stays valid.
pub fn mtime_ms(meta: &fs::Metadata) -> f64 {
    match meta.modified() {
        Ok(time) => match time.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_secs() as f64 * 1e3 + d.subsec_nanos() as f64 / 1e6,
            Err(e) => {
                let d = e.duration();
                // Before 1970: Node gives a negative sec with a positive nsec.
                let secs = -(d.as_secs() as f64) - if d.subsec_nanos() > 0 { 1.0 } else { 0.0 };
                let nanos = if d.subsec_nanos() > 0 { 1_000_000_000 - d.subsec_nanos() } else { 0 };
                secs * 1e3 + nanos as f64 / 1e6
            }
        },
        Err(_) => 0.0,
    }
}

pub fn lstat_or_missing(path: &Path) -> Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Ok(Some(meta)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(Error::io(error, path.display())),
    }
}

fn is_link(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Junctions and other reparse points are not real directories either.
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

fn check_spelling(directory: &Path, name: &str, cache: &mut DirCache) -> Result<()> {
    if !cache.entries.contains_key(directory) {
        let mut entries: HashMap<String, Option<String>> = HashMap::new();
        let list = fs::read_dir(directory).map_err(|e| Error::io(e, directory.display()))?;
        for entry in list {
            let entry = entry.map_err(|e| Error::io(e, directory.display()))?;
            let entry_name = entry.file_name().to_string_lossy().to_string();
            let key = windows_key(&entry_name);
            let value = if entries.contains_key(&key) { None } else { Some(entry_name) };
            entries.insert(key, value);
        }
        cache.entries.insert(directory.to_path_buf(), entries);
    }
    let entries = &cache.entries[directory];
    match entries.get(&windows_key(name)) {
        Some(Some(existing)) if existing == name => Ok(()),
        None => Ok(()),
        _ => Err(Error::permanent(format!("Existing Windows path alias conflicts with {}.", directory.join(name).display())).make_local()),
    }
}

fn directory_child(parent: &Path, name: &str, create: bool, cache: &mut DirCache) -> Result<bool> {
    let target = parent.join(name);
    // Within one operation, a directory already checked is not re-checked for every file it holds.
    if cache.verified.contains(&target) {
        return Ok(true);
    }
    check_spelling(parent, name, cache)?;
    let mut meta = lstat_or_missing(&target)?;
    if meta.is_none() && create {
        match fs::create_dir(&target) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(Error::io(e, target.display())),
        }
        cache.note(parent, name);
        meta = lstat_or_missing(&target)?;
    }
    let Some(meta) = meta else { return Ok(false) };
    if is_link(&meta) || !meta.is_dir() {
        return Err(Error::permanent(format!("Not a real directory (symlinks are forbidden): {}", target.display())).make_local());
    }
    cache.verified.insert(target);
    Ok(true)
}

pub struct Installation {
    pub root: PathBuf,
    pub exists: bool,
}

/// Walk to the installation folder from its drive/root, refusing symlinks and aliases; optionally create it.
pub fn installation_root(input: &str, create: bool, cache: &mut DirCache) -> Result<Installation> {
    if input.trim().is_empty() {
        return Err(Error::permanent("Choose an installation directory first."));
    }
    let root = std::path::absolute(input).map_err(|e| Error::io(e, input))?;
    let mut current = PathBuf::new();
    let mut names = Vec::new();
    for component in root.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => current.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                names.pop();
            }
            Component::Normal(name) => names.push(name.to_string_lossy().to_string()),
        }
    }
    let mut resolved = current.clone();
    for name in &names {
        resolved.push(name);
    }
    for name in &names {
        if !directory_child(&current, name, create, cache)? {
            return Ok(Installation { root: resolved, exists: false });
        }
        current.push(name);
    }
    Ok(Installation { root: resolved, exists: true })
}

pub struct Destination {
    pub filename: PathBuf,
    pub meta: Option<fs::Metadata>,
}

/// The local path of a managed file; parents are created when `create`. Never a symlink or a directory.
pub fn destination(root: &Path, relative: &str, create: bool, cache: &mut DirCache) -> Result<Destination> {
    let parts: Vec<&str> = relative.split('/').collect();
    let mut parent = root.to_path_buf();
    for part in &parts[..parts.len() - 1] {
        if !directory_child(&parent, part, create, cache)? {
            let mut filename = root.to_path_buf();
            filename.extend(&parts);
            return Ok(Destination { filename, meta: None });
        }
        parent.push(part);
    }
    let name = parts[parts.len() - 1];
    check_spelling(&parent, name, cache)?;
    let filename = parent.join(name);
    let meta = lstat_or_missing(&filename)?;
    if let Some(meta) = &meta {
        if is_link(meta) || !meta.is_file() {
            return Err(Error::permanent(format!("Not a regular file (symlinks are forbidden): {}", filename.display())).make_local());
        }
    }
    Ok(Destination { filename, meta })
}

/// Record that `filename` now exists, so later spelling checks in the same operation know it.
pub fn note_created(cache: &mut DirCache, filename: &Path) {
    if let (Some(parent), Some(name)) = (filename.parent(), filename.file_name()) {
        cache.note(parent, &name.to_string_lossy());
    }
}

pub struct Digest256 {
    pub sha256: String,
    pub size: u64,
    pub mtime_ms: f64,
}

/// Hash a regular file; None when it changed while being read.
pub fn digest(filename: &Path, mut on_bytes: impl FnMut(u64)) -> Result<Option<Digest256>> {
    let mut file = fs::File::open(filename).map_err(|e| Error::io(e, filename.display()))?;
    let before = file.metadata().map_err(|e| Error::io(e, filename.display()))?;
    if !before.is_file() {
        return Err(Error::permanent(format!("Not a regular file: {}", filename.display())).make_local());
    }
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buffer).map_err(|e| Error::io(e, filename.display()))?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
        on_bytes(n as u64);
    }
    let after = fs::metadata(filename).map_err(|e| Error::io(e, filename.display()))?;
    if after.len() != before.len() || mtime_ms(&after) != mtime_ms(&before) {
        return Ok(None);
    }
    Ok(Some(Digest256 { sha256: hex::encode(hash.finalize()), size: before.len(), mtime_ms: mtime_ms(&before) }))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Read launcher bookkeeping (`.slumsms-launcher/...`) from an installation; None when absent.
pub fn read_small_file(root: &str, relative: &str) -> Result<Option<Vec<u8>>> {
    let mut cache = DirCache::new();
    let installation = installation_root(root, false, &mut cache)?;
    if !installation.exists {
        return Ok(None);
    }
    let target = destination(&installation.root, relative, false, &mut cache)?;
    if target.meta.is_none() {
        return Ok(None);
    }
    fs::read(&target.filename).map(Some).map_err(|e| Error::io(e, target.filename.display()))
}

/// Atomically write launcher bookkeeping under the installation, never through symlinks.
pub fn write_small_file(root: &Path, relative: &str, contents: &[u8]) -> Result<()> {
    let mut cache = DirCache::new();
    let target = destination(root, relative, true, &mut cache)?;
    let temporary = PathBuf::from(format!("{}.{}.tmp", target.filename.display(), uuid::Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        file.write_all(contents)?;
        drop(file);
        fs::rename(&temporary, &target.filename)
    })();
    let _ = fs::remove_file(&temporary);
    result.map_err(|e| Error::io(e, target.filename.display()))
}

/// Free bytes for `directory` (or its nearest existing parent); None when the platform cannot say.
pub fn free_disk_bytes(directory: &Path) -> Option<u64> {
    let mut current = std::path::absolute(directory).ok()?;
    loop {
        if current.exists() {
            return free_bytes(&current);
        }
        current = current.parent()?.to_path_buf();
    }
}

#[cfg(windows)]
fn free_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut available: u64 = 0;
    // SAFETY: valid NUL-terminated path; out pointers are valid or null.
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(available)
}

#[cfg(not(windows))]
fn free_bytes(path: &Path) -> Option<u64> {
    // `df` keeps the test suite free of libc bindings; tests inject their own free-space function.
    let output = std::process::Command::new("df").arg("-Pk").arg(path).output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().nth(1)?;
    let available: u64 = line.split_whitespace().nth(3)?.parse().ok()?;
    Some(available * 1024)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spelling_aliases_and_symlinks_are_refused() {
        let dir = std::env::temp_dir().join(format!("slums-fsutil-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("Data")).unwrap();
        fs::write(dir.join("Data/a.img"), b"x").unwrap();
        let mut cache = DirCache::new();
        let root = installation_root(dir.to_str().unwrap(), false, &mut cache).unwrap();
        assert!(root.exists);
        assert!(destination(&root.root, "Data/a.img", false, &mut cache).unwrap().meta.is_some());
        assert!(destination(&root.root, "data/b.img", false, &mut DirCache::new()).is_err());
        assert!(destination(&root.root, "Data/A.img", false, &mut DirCache::new()).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("Data"), dir.join("Link")).unwrap();
            assert!(destination(&root.root, "Link/a.img", false, &mut DirCache::new()).is_err());
            std::os::unix::fs::symlink(dir.join("Data/a.img"), dir.join("l.img")).unwrap();
            assert!(destination(&root.root, "l.img", false, &mut DirCache::new()).is_err());
        }
        let missing = installation_root(dir.join("nope/deeper").to_str().unwrap(), false, &mut DirCache::new()).unwrap();
        assert!(!missing.exists);
        write_small_file(&root.root, ".slumsms-launcher/x.json", b"{}").unwrap();
        assert_eq!(read_small_file(dir.to_str().unwrap(), ".slumsms-launcher/x.json").unwrap().unwrap(), b"{}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn mtime_matches_node_formula() {
        let file = std::env::temp_dir().join(format!("slums-mtime-{}", uuid::Uuid::new_v4()));
        fs::write(&file, b"x").unwrap();
        let meta = fs::metadata(&file).unwrap();
        let d = meta.modified().unwrap().duration_since(UNIX_EPOCH).unwrap();
        assert_eq!(mtime_ms(&meta), d.as_secs() as f64 * 1e3 + d.subsec_nanos() as f64 / 1e6);
        fs::remove_file(file).unwrap();
    }
}

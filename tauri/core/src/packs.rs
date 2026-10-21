//! Packs: a layer's files concatenated into a few large, immutable archives for the first install.
//! Port of packs.mjs (index validation, the pack/range planner, speed/ETA and the progress line).

use crate::error::{Error, Result};
use crate::manifest::{hex_digest, safe_integer, FileEntry};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub const DEFAULT_PACK_SIZE: u64 = 256 * 1024 * 1024;
/// Bytes a separate HTTP request is "worth" when choosing between packs and per-file downloads.
pub const DEFAULT_REQUEST_COST: u64 = 128 * 1024;
const MAX_PACKS: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackEntry {
    pub offset: u64,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackSource {
    /// Absolute URL once resolved against the index; the bare file name from validate_pack_index.
    pub url: String,
    pub size: u64,
    pub sha256: String,
    pub entries: Vec<PackEntry>,
}

/// The layer a pack index belongs to.
pub struct PackLayer<'a> {
    pub layer: &'a str,
    pub version: &'a str,
    pub manifest_sha256: Option<&'a str>,
    pub files: &'a [FileEntry],
}

fn pack_name(value: &Value, label: &str) -> Result<String> {
    let ok = value.as_str().filter(|s| {
        let b = s.as_bytes();
        !b.is_empty() && b.len() <= 64 && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-')) && !s.ends_with('.')
    });
    ok.map(str::to_string).ok_or_else(|| Error::permanent(format!("{label} must be a plain file name.")))
}

/// Validate a pack index against its layer manifest; offsets are resolved from the file order.
pub fn validate_pack_index(value: &Value, layer: &PackLayer) -> Result<Vec<PackSource>> {
    if !value.is_object() || value.get("schemaVersion").and_then(safe_integer) != Some(1) {
        return Err(Error::permanent("Unsupported pack index: schemaVersion must be 1."));
    }
    let (il, iv) = (value.get("layer").and_then(Value::as_str), value.get("version").and_then(Value::as_str));
    if il != Some(layer.layer) || iv != Some(layer.version) {
        return Err(Error::permanent(format!("Pack index {}@{} does not match layer {}@{}.", il.unwrap_or("undefined"), iv.unwrap_or("undefined"), layer.layer, layer.version)));
    }
    if let Some(expected) = layer.manifest_sha256 {
        if value.get("manifestSha256").and_then(Value::as_str) != Some(expected) {
            return Err(Error::permanent(format!("Pack index was built for a different {}@{} manifest.", layer.layer, layer.version)));
        }
    }
    let packs = value.get("packs").and_then(Value::as_array).filter(|p| p.len() <= MAX_PACKS).ok_or_else(|| Error::permanent(format!("Pack index must list at most {MAX_PACKS} packs.")))?;
    let mut used = vec![false; layer.files.len()];
    let mut names = HashSet::new();
    let mut out = Vec::new();
    for (number, pack) in packs.iter().enumerate() {
        let label = format!("pack {}", number + 1);
        let files = pack.get("files").and_then(Value::as_array).filter(|f| !f.is_empty()).ok_or_else(|| Error::permanent(format!("Invalid {label}.")))?;
        let url = pack_name(&pack["url"], &format!("{label} url"))?;
        if !names.insert(url.to_uppercase()) {
            return Err(Error::permanent(format!("Duplicate pack url: {url}.")));
        }
        let mut offset = 0u64;
        let mut entries = Vec::with_capacity(files.len());
        for index in files {
            let i = safe_integer(index).filter(|i| *i >= 0 && (*i as usize) < layer.files.len() && !used[*i as usize]);
            let Some(i) = i else { return Err(Error::permanent(format!("{label} lists an invalid or repeated file index."))) };
            used[i as usize] = true;
            let file = &layer.files[i as usize];
            entries.push(PackEntry { offset, size: file.size, sha256: file.sha256.clone() });
            offset += file.size;
        }
        if pack.get("size").and_then(safe_integer) != Some(offset as i64) {
            return Err(Error::permanent(format!("{label} size does not match its files.")));
        }
        out.push(PackSource { url, size: offset, sha256: hex_digest(&pack["sha256"], &label)?, entries });
    }
    Ok(out)
}

fn content_key(sha256: &str, size: u64) -> String {
    format!("{sha256}:{size}")
}

/// A planned entry: where it sits in the pack and which pending files (indexes) take its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedEntry {
    pub offset: u64,
    pub size: u64,
    pub sha256: String,
    pub targets: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
    pub start: u64,
    pub end: u64,
    pub entries: Vec<PlannedEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedPack {
    /// Index into the `sources` given to plan_packs.
    pub source: usize,
    pub spans: Vec<Span>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub packs: Vec<PlannedPack>,
    /// Indexes of pending files that stay per-file.
    pub files: Vec<usize>,
    pub bytes: u64,
}

/// (start, end, indexes of the candidate entries it covers)
type RawSpan = (u64, u64, Vec<usize>);

/// Merge the useful entries of one pack into byte ranges; a gap smaller than one request is downloaded and discarded.
fn spans_for(entries: &[&PackEntry], request_cost: u64) -> Vec<RawSpan> {
    let mut spans: Vec<RawSpan> = Vec::new();
    for (i, entry) in entries.iter().enumerate() {
        if let Some(last) = spans.last_mut() {
            if entry.offset.saturating_sub(last.1) <= request_cost && entry.offset >= last.1 {
                last.1 = entry.offset + entry.size;
                last.2.push(i);
                continue;
            }
        }
        spans.push((entry.offset, entry.offset + entry.size, vec![i]));
    }
    spans
}

/// Choose packs for the files that need downloading. A pack (or ranges of it) is used only when it
/// costs less than fetching the same files one by one, counting each request as `request_cost`.
pub fn plan_packs(pending: &[FileEntry], sources: &[PackSource], request_cost: u64) -> Plan {
    let mut needed: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, file) in pending.iter().enumerate() {
        needed.entry(content_key(&file.sha256, file.size)).or_default().push(i);
    }
    struct Candidate<'a> {
        source: usize,
        entries: Vec<&'a PackEntry>,
    }
    let mut candidates: Vec<Candidate> = sources
        .iter()
        .enumerate()
        .map(|(source, s)| Candidate { source, entries: s.entries.iter().filter(|e| needed.contains_key(&content_key(&e.sha256, e.size))).collect() })
        .filter(|c| !c.entries.is_empty())
        .collect();
    let mut covered: HashSet<String> = HashSet::new();
    let mut packs = Vec::new();
    loop {
        let mut best: Option<(usize, Vec<RawSpan>, i128)> = None;
        for (ci, candidate) in candidates.iter_mut().enumerate() {
            // An entry is offered once per content key, even if a pack (unusually) repeats it.
            let mut seen = HashSet::new();
            candidate.entries.retain(|e| {
                let key = content_key(&e.sha256, e.size);
                !covered.contains(&key) && seen.insert(key)
            });
            if candidate.entries.is_empty() {
                continue;
            }
            let spans = spans_for(&candidate.entries, request_cost);
            let cost: i128 = spans.iter().map(|(s, e, _)| (e - s + request_cost) as i128).sum();
            let saved: i128 = candidate.entries.iter().map(|e| needed[&content_key(&e.sha256, e.size)].len() as i128 * (e.size + request_cost) as i128).sum();
            let benefit = saved - cost;
            if benefit > 0 && best.as_ref().is_none_or(|b| benefit > b.2) {
                best = Some((ci, spans, benefit));
            }
        }
        let Some((ci, spans, _)) = best else { break };
        let candidate = candidates.remove(ci);
        for e in &candidate.entries {
            covered.insert(content_key(&e.sha256, e.size));
        }
        let spans = spans
            .into_iter()
            .map(|(start, end, idx)| Span {
                start,
                end,
                entries: idx
                    .into_iter()
                    .map(|i| {
                        let e = candidate.entries[i];
                        PlannedEntry { offset: e.offset, size: e.size, sha256: e.sha256.clone(), targets: needed[&content_key(&e.sha256, e.size)].clone() }
                    })
                    .collect(),
            })
            .collect();
        packs.push(PlannedPack { source: candidate.source, spans });
    }
    // Download packs in their natural order (layer, then pack) so the install fills in predictably.
    packs.sort_by_key(|p| p.source);
    let files: Vec<usize> = (0..pending.len()).filter(|&i| !covered.contains(&content_key(&pending[i].sha256, pending[i].size))).collect();
    let bytes = packs.iter().map(|p| p.spans.iter().map(|s| s.end - s.start).sum::<u64>()).sum::<u64>() + files.iter().map(|&i| pending[i].size).sum::<u64>();
    Plan { packs, files, bytes }
}

/// Group a layer's files into packs (deterministic: manifest order, first copy of each content).
pub fn group_packs(files: &[FileEntry], pack_size: u64) -> Vec<Vec<usize>> {
    let mut seen = HashSet::new();
    let mut groups = Vec::new();
    let mut current = Vec::new();
    let mut bytes = 0u64;
    for (index, file) in files.iter().enumerate() {
        if !seen.insert(content_key(&file.sha256, file.size)) {
            continue;
        }
        if !current.is_empty() && bytes + file.size > pack_size {
            groups.push(std::mem::take(&mut current));
            bytes = 0;
        }
        current.push(index);
        bytes += file.size;
    }
    if !current.is_empty() {
        groups.push(current);
    }
    groups
}

/// Transfer rate and time left from recent progress, measured over the last `window_ms`.
pub struct RateMeter {
    window_ms: u64,
    samples: Vec<(u64, u64)>,
}

impl RateMeter {
    pub fn new(window_ms: u64) -> Self {
        RateMeter { window_ms, samples: Vec::new() }
    }
    pub fn add(&mut self, now_ms: u64, bytes_done: u64) {
        match self.samples.last_mut() {
            Some(last) if now_ms.saturating_sub(last.0) < 250 => last.1 = bytes_done,
            _ => self.samples.push((now_ms, bytes_done)),
        }
        while self.samples.len() > 2 && now_ms.saturating_sub(self.samples[1].0) > self.window_ms {
            self.samples.remove(0);
        }
    }
    /// (bytes per second, seconds left) once a few seconds were measured.
    pub fn estimate(&self, bytes_total: u64) -> (Option<u64>, Option<u64>) {
        if self.samples.len() < 2 {
            return (None, None);
        }
        let (t0, b0) = self.samples[0];
        let (t1, b1) = *self.samples.last().unwrap();
        let elapsed = (t1 - t0) as f64 / 1000.0;
        if elapsed < 2.0 {
            return (None, None);
        }
        let rate = (b1 as f64 - b0 as f64).max(0.0) / elapsed;
        let left = bytes_total.saturating_sub(b1) as f64;
        (Some(rate.round() as u64), if rate > 0.0 { Some((left / rate).ceil() as u64) } else { None })
    }
}

fn gb(bytes: u64) -> String {
    format!("{:.1}", bytes as f64 / 1024f64.powi(3))
}

/// 12345 -> "12,345" (toLocaleString('en-US')).
pub fn thousands(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn speed(bps: u64) -> String {
    let bps = bps as f64;
    if bps >= 1024f64.powi(3) {
        format!("{:.1} GB/s", bps / 1024f64.powi(3))
    } else if bps >= 1024f64.powi(2) {
        format!("{} MB/s", (bps / 1024f64.powi(2)).round())
    } else {
        format!("{} KB/s", ((bps / 1024.0).round()).max(1.0))
    }
}

pub fn time_left(seconds: u64) -> String {
    if seconds < 60 {
        return "less than a minute left".into();
    }
    let minutes = (seconds as f64 / 60.0).round() as u64;
    if minutes < 60 {
        format!("about {minutes} min left")
    } else {
        format!("about {} h {} min left", minutes / 60, minutes % 60)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unit {
    Packs,
    Files,
}

/// "Downloading 12 of 91 packs, 3.4 of 21.7 GB, 45 MB/s, about 6 min left", from aggregate counters only.
pub fn download_message(unit: Unit, done: u64, total: u64, bytes_done: u64, bytes_total: u64, bps: Option<u64>, eta: Option<u64>) -> String {
    let noun = match (unit, total == 1) {
        (Unit::Files, true) => "file",
        (Unit::Files, false) => "files",
        (Unit::Packs, true) => "pack",
        (Unit::Packs, false) => "packs",
    };
    let mut parts = vec![format!("Downloading {} of {} {noun}", thousands((done + 1).min(total.max(1))), thousands(total))];
    if bytes_total > 0 {
        parts.push(format!("{} of {} GB", gb(bytes_done.min(bytes_total)), gb(bytes_total)));
    }
    if let Some(bps) = bps.filter(|b| *b > 0) {
        parts.push(speed(bps));
        if let Some(eta) = eta {
            parts.push(time_left(eta));
        }
    }
    parts.join(", ")
}

/// "Checked 8.2 GB already downloaded, continuing." for a resumed install.
pub fn resume_message(kept_bytes: u64) -> String {
    format!("Checked {} GB already downloaded, continuing.", gb(kept_bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn file(i: usize, size: u64, sha: &str) -> FileEntry {
        FileEntry { path: format!("Data/f{i}.img"), size, sha256: sha.repeat(64 / sha.len()), url: String::new(), layer: "base".into() }
    }

    #[test]
    fn group_packs_is_deterministic_dedupes_and_isolates_big_files() {
        let files = vec![file(0, 10, "a"), file(1, 10, "b"), file(2, 10, "a"), file(3, 100, "c"), file(4, 5, "d")];
        assert_eq!(group_packs(&files, 25), vec![vec![0, 1], vec![3], vec![4]]);
    }

    #[test]
    fn index_validation_binds_to_the_layer() {
        let files = vec![file(0, 3, "a"), file(1, 4, "b")];
        let layer = PackLayer { layer: "base", version: "v1", manifest_sha256: Some("m"), files: &files };
        let sha = "f".repeat(64);
        let good = json!({ "schemaVersion": 1, "layer": "base", "version": "v1", "manifestSha256": "m", "packs": [{ "url": "0001.pack", "size": 7, "sha256": sha, "files": [1, 0] }] });
        let packs = validate_pack_index(&good, &layer).unwrap();
        assert_eq!(packs[0].entries, vec![PackEntry { offset: 0, size: 4, sha256: files[1].sha256.clone() }, PackEntry { offset: 4, size: 3, sha256: files[0].sha256.clone() }]);
        for bad in [
            json!({ "schemaVersion": 1, "layer": "client", "version": "v1", "manifestSha256": "m", "packs": [] }),
            json!({ "schemaVersion": 1, "layer": "base", "version": "v1", "manifestSha256": "other", "packs": [] }),
            json!({ "schemaVersion": 1, "layer": "base", "version": "v1", "manifestSha256": "m", "packs": [{ "url": "0001.pack", "size": 8, "sha256": sha, "files": [1, 0] }] }),
            json!({ "schemaVersion": 1, "layer": "base", "version": "v1", "manifestSha256": "m", "packs": [{ "url": "0001.pack", "size": 8, "sha256": sha, "files": [1, 1] }] }),
            json!({ "schemaVersion": 1, "layer": "base", "version": "v1", "manifestSha256": "m", "packs": [{ "url": "../x", "size": 7, "sha256": sha, "files": [1, 0] }] }),
            json!({ "schemaVersion": 1, "layer": "base", "version": "v1", "manifestSha256": "m", "packs": [{ "url": "a", "size": 3, "sha256": sha, "files": [0] }, { "url": "A", "size": 4, "sha256": sha, "files": [1] }] }),
            json!({ "schemaVersion": 1, "layer": "base", "version": "v1", "manifestSha256": "m", "packs": [{ "url": "a", "size": 3, "sha256": sha, "files": [2] }] }),
        ] {
            assert!(validate_pack_index(&bad, &layer).is_err(), "{bad}");
        }
    }

    fn source(sizes: &[(u64, &str)]) -> PackSource {
        let mut offset = 0;
        let entries = sizes
            .iter()
            .map(|(size, sha)| {
                let e = PackEntry { offset, size: *size, sha256: sha.repeat(64 / sha.len()) };
                offset += size;
                e
            })
            .collect();
        PackSource { url: "p".into(), size: offset, sha256: String::new(), entries }
    }

    #[test]
    fn planner_takes_whole_packs_for_a_first_install_and_per_file_for_small_updates() {
        let shas: Vec<String> = (0..100).map(|i| format!("{i:02}")).collect();
        let pending: Vec<FileEntry> = (0..100).map(|i| file(i, 1000, &shas[i])).collect();
        let pack = source(&shas.iter().map(|s| (1000u64, s.as_str())).collect::<Vec<_>>());
        let plan = plan_packs(&pending, std::slice::from_ref(&pack), DEFAULT_REQUEST_COST);
        assert_eq!(plan.packs.len(), 1);
        assert_eq!(plan.packs[0].spans.len(), 1);
        assert!(plan.files.is_empty());
        assert_eq!(plan.bytes, 100_000);
        // Two files: one request each is cheaper than a pack range of the size between them.
        let small = vec![pending[3].clone()];
        let plan = plan_packs(&small, std::slice::from_ref(&pack), DEFAULT_REQUEST_COST);
        assert!(plan.packs.is_empty());
        assert_eq!(plan.files, vec![0]);
    }

    #[test]
    fn planner_splits_ranges_at_big_gaps_and_takes_shadowed_content_once() {
        let big = 1024 * 1024;
        let shas = ["aa", "bb", "cc", "dd"];
        let pack = source(&[(big, shas[0]), (big, shas[1]), (10 * big, shas[2]), (big, shas[3])]);
        let mut pending = vec![file(0, big, "aa"), file(1, big, "bb"), file(3, big, "dd")];
        pending.push(FileEntry { path: "copy.img".into(), ..file(9, big, "aa") });
        let plan = plan_packs(&pending, std::slice::from_ref(&pack), 4096);
        assert_eq!(plan.packs.len(), 1);
        let spans = &plan.packs[0].spans;
        assert_eq!(spans.len(), 2, "the 10 MiB gap is skipped with a second range");
        assert_eq!((spans[0].start, spans[0].end), (0, 2 * big));
        assert_eq!(spans[0].entries[0].targets, vec![0, 3], "duplicate content feeds both targets");
        assert_eq!(plan.bytes, 3 * big);
    }

    #[test]
    fn rate_meter_and_messages() {
        let mut meter = RateMeter::new(20_000);
        meter.add(0, 0);
        assert_eq!(meter.estimate(100), (None, None));
        meter.add(1000, 1000);
        assert_eq!(meter.estimate(100_000), (None, None), "under two seconds is not measured");
        meter.add(4000, 4000);
        assert_eq!(meter.estimate(10_000), (Some(1000), Some(6)));
        meter.add(30_000, 4000);
        meter.add(40_000, 4000);
        assert_eq!(meter.estimate(10_000).0, Some(0), "a stall shows quickly");
        assert_eq!(time_left(30), "less than a minute left");
        assert_eq!(time_left(6 * 60), "about 6 min left");
        assert_eq!(time_left(65 * 60), "about 1 h 5 min left");
        let gib = 1024 * 1024 * 1024;
        assert_eq!(download_message(Unit::Packs, 11, 91, 34 * gib / 10, 217 * gib / 10, Some(45 * 1024 * 1024), Some(360)), "Downloading 12 of 91 packs, 3.4 of 21.7 GB, 45 MB/s, about 6 min left");
        assert_eq!(download_message(Unit::Files, 0, 1, 0, 0, None, None), "Downloading 1 of 1 file");
        assert_eq!(download_message(Unit::Files, 1233, 1234, 0, 0, None, None), "Downloading 1,234 of 1,234 files");
        assert_eq!(download_message(Unit::Packs, 91, 91, 0, 0, None, None), "Downloading 91 of 91 packs");
        assert_eq!(resume_message(8_804_682_956), "Checked 8.2 GB already downloaded, continuing.");
    }
}

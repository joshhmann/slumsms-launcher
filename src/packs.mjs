/**
 * Packs: a layer's files concatenated into a few large, immutable archives for the first install.
 *
 * LAYER/VERSION/packs/index.json lists each pack as { url, size, sha256, files: [i, ...] }, where
 * each i indexes the layer manifest's `files`. A pack is the files' bytes back to back, with no
 * headers and no compression (the client's IMG files compress only 2-5%). Offsets are implied by the
 * order, so a byte range of a pack is a run of whole files. Each file's content appears once per
 * layer (duplicates are written once and copied on install).
 *
 * The index is only a download plan. Every file taken from a pack is still verified against the
 * size and SHA-256 in the layer manifest, which the release manifest pins.
 */
export const PACK_INDEX_FILE = 'index.json';
export const DEFAULT_PACK_SIZE = 256 * 1024 * 1024;
/** Bytes a separate HTTP request is "worth" when choosing between packs and per-file downloads. */
export const DEFAULT_REQUEST_COST = 128 * 1024;
const MAX_PACKS = 10_000;

const packName = (value, label) => {
  if (typeof value !== 'string' || !/^[A-Za-z\d][A-Za-z\d._-]{0,63}$/u.test(value) || value.endsWith('.')) {
    throw new Error(`${label} must be a plain file name.`);
  }
  return value;
};
const hex = (value, label) => {
  if (typeof value !== 'string' || !/^[a-f\d]{64}$/iu.test(value)) throw new Error(`Invalid SHA-256 for ${label}.`);
  return value.toLowerCase();
};

/**
 * Validate a pack index against its layer manifest ({ layer, version, files, manifestSha256? }). Returns
 * [{ url, size, sha256, entries: [{ offset, size, sha256 }] }] with offsets resolved.
 */
export function validatePackIndex(value, layer) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1) throw new Error('Unsupported pack index: schemaVersion must be 1.');
  if (value.layer !== layer.layer || value.version !== layer.version) {
    throw new Error(`Pack index ${value.layer}@${value.version} does not match layer ${layer.layer}@${layer.version}.`);
  }
  if (layer.manifestSha256 !== undefined && value.manifestSha256 !== layer.manifestSha256) throw new Error(`Pack index was built for a different ${layer.layer}@${layer.version} manifest.`);
  if (!Array.isArray(value.packs) || value.packs.length > MAX_PACKS) throw new Error(`Pack index must list at most ${MAX_PACKS} packs.`);
  const used = new Uint8Array(layer.files.length);
  const names = new Set();
  return value.packs.map((pack, number) => {
    const label = `pack ${number + 1}`;
    if (!pack || typeof pack !== 'object' || !Array.isArray(pack.files) || !pack.files.length) throw new Error(`Invalid ${label}.`);
    const url = packName(pack.url, `${label} url`);
    if (names.has(url.toUpperCase())) throw new Error(`Duplicate pack url: ${url}.`);
    names.add(url.toUpperCase());
    let offset = 0;
    const entries = pack.files.map((index) => {
      if (!Number.isSafeInteger(index) || index < 0 || index >= layer.files.length || used[index]) throw new Error(`${label} lists an invalid or repeated file index.`);
      used[index] = 1;
      const file = layer.files[index];
      const entry = { offset, size: file.size, sha256: file.sha256 };
      offset += file.size;
      return entry;
    });
    if (!Number.isSafeInteger(pack.size) || pack.size !== offset) throw new Error(`${label} size does not match its files.`);
    return { url, size: pack.size, sha256: hex(pack.sha256, label), entries };
  });
}

/**
 * Group a layer's files into packs (deterministic: manifest order, first copy of each content).
 * Returns [[index, ...], ...]; a file larger than `packSize` gets a pack of its own.
 */
export function groupPacks(files, packSize = DEFAULT_PACK_SIZE) {
  if (!Number.isSafeInteger(packSize) || packSize < 1) throw new Error('Pack size must be a positive integer.');
  const seen = new Set();
  const groups = [];
  let current = [];
  let bytes = 0;
  files.forEach((file, index) => {
    const key = `${file.sha256}:${file.size}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (current.length && bytes + file.size > packSize) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(index);
    bytes += file.size;
  });
  if (current.length) groups.push(current);
  return groups;
}

const contentKey = (file) => `${file.sha256}:${file.size}`;

/** Merge the useful entries of one pack into byte ranges; a gap smaller than one request is downloaded and discarded. */
function spansFor(entries, requestCost) {
  const spans = [];
  for (const entry of entries) {
    const last = spans.at(-1);
    if (last && entry.offset - last.end <= requestCost) {
      last.end = entry.offset + entry.size;
      last.entries.push(entry);
    } else spans.push({ start: entry.offset, end: entry.offset + entry.size, entries: [entry] });
  }
  return spans;
}

/**
 * Choose packs for the files that need downloading. A pack (or part of one, via HTTP ranges) is
 * used only when it costs less than fetching the same files one by one, counting each request as
 * `requestCost` bytes: a first install takes whole packs, a small update stays per-file.
 * `sources` is [{ url, size, entries: [{ offset, size, sha256 }] }] (any layer: content is matched
 * by SHA-256 and size, so a file shadowed by a later layer can come from an earlier layer's pack).
 * Returns { packs: [{ source, spans: [{ start, end, entries: [{ offset, size, sha256, targets }] }] }],
 * files, bytes } where `files` stay per-file and `bytes` is the total to download.
 */
export function planPacks(pending, sources, { requestCost = DEFAULT_REQUEST_COST } = {}) {
  const needed = new Map();
  for (const file of pending) {
    const key = contentKey(file);
    const list = needed.get(key);
    if (list) list.push(file); else needed.set(key, [file]);
  }
  let candidates = sources.map((source) => ({ source, entries: source.entries.filter((entry) => needed.has(contentKey(entry))) }))
    .filter((candidate) => candidate.entries.length);
  const covered = new Set();
  const packs = [];
  for (;;) {
    let best = null;
    for (const candidate of candidates) {
      // An entry is offered once per content key, even if a pack (unusually) repeats it.
      const seen = new Set();
      candidate.entries = candidate.entries.filter((entry) => {
        const key = contentKey(entry);
        if (covered.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (!candidate.entries.length) continue;
      const spans = spansFor(candidate.entries, requestCost);
      const cost = spans.reduce((sum, span) => sum + span.end - span.start + requestCost, 0);
      const saved = candidate.entries.reduce((sum, entry) => sum + needed.get(contentKey(entry)).length * (entry.size + requestCost), 0);
      if (saved - cost > 0 && (!best || saved - cost > best.benefit)) best = { candidate, spans, benefit: saved - cost };
    }
    if (!best) break;
    for (const entry of best.candidate.entries) covered.add(contentKey(entry));
    packs.push({
      source: best.candidate.source,
      spans: best.spans.map((span) => ({ ...span, entries: span.entries.map((entry) => ({ ...entry, targets: needed.get(contentKey(entry)) })) })),
    });
    candidates = candidates.filter((candidate) => candidate !== best.candidate);
  }
  // Download packs in their natural order (layer, then pack) so the install fills in predictably.
  const order = new Map(sources.map((source, index) => [source, index]));
  packs.sort((left, right) => order.get(left.source) - order.get(right.source));
  const files = pending.filter((file) => !covered.has(contentKey(file)));
  const bytes = packs.reduce((sum, pack) => sum + pack.spans.reduce((total, span) => total + span.end - span.start, 0), 0)
    + files.reduce((sum, file) => sum + file.size, 0);
  return { packs, files, bytes };
}

/**
 * Transfer rate and time left from recent progress. `add(bytesDone)` records a sample; the rate is
 * measured over the last `windowMs`, so a stall shows up quickly and a burst does not dominate.
 */
export function rateMeter({ windowMs = 20_000, now = () => Date.now() } = {}) {
  const samples = [];
  return {
    add(bytesDone) {
      const time = now();
      if (samples.length && time - samples.at(-1).time < 250) samples.at(-1).bytes = bytesDone;
      else samples.push({ time, bytes: bytesDone });
      while (samples.length > 2 && time - samples[1].time > windowMs) samples.shift();
    },
    /** { bytesPerSecond, etaSeconds } once a few seconds were measured, otherwise nulls. */
    estimate(bytesTotal) {
      if (samples.length < 2) return { bytesPerSecond: null, etaSeconds: null };
      const first = samples[0];
      const last = samples.at(-1);
      const elapsed = (last.time - first.time) / 1000;
      if (elapsed < 2) return { bytesPerSecond: null, etaSeconds: null };
      const rate = Math.max(0, (last.bytes - first.bytes) / elapsed);
      const left = Math.max(0, bytesTotal - last.bytes);
      return { bytesPerSecond: Math.round(rate), etaSeconds: rate > 0 ? Math.ceil(left / rate) : null };
    },
  };
}

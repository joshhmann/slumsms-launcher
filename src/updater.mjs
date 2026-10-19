import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Launcher bookkeeping inside an installation; manifests may never write here. */
export const STATE_DIRECTORY = '.slumsms-launcher';
const STATE_FILE = `${STATE_DIRECTORY}/state.json`;
const LAYER_CACHE = `${STATE_DIRECTORY}/layers`;
const STAGE_PREFIX = '.mapleroot-stage-';
const MAX_MANIFEST_BYTES = 128 * 1024 * 1024;
const MAX_LAYERS = 16;
export const DEFAULT_CONCURRENCY = 12;
export const MAX_CONCURRENCY = 32;
const STATE_CHECKPOINT_MS = 15_000;

const loaded = new WeakMap();
const validated = new WeakSet();
const windowsKey = (name) => name.normalize('NFC').toUpperCase();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function relativePath(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\')) {
    throw new Error(`${label} must be a nonempty, forward-slash relative path.`);
  }
  for (const part of value.split('/')) {
    const device = part.split('.')[0].replace(/ +$/u, '');
    if (!part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/u.test(part)
      || /[. ]$/u.test(part)
      || /^(CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/iu.test(device)) {
      throw new Error(`${label} contains an unsafe Windows path component: ${JSON.stringify(part)}.`);
    }
  }
  return value;
}

/** A managed file path: safe, and outside the launcher's own state and staging directories. */
function managedPath(value, label) {
  relativePath(value, label);
  const first = windowsKey(value.split('/')[0]);
  if (first === windowsKey(STATE_DIRECTORY) || first.startsWith(windowsKey(STAGE_PREFIX))) {
    throw new Error(`${label} uses a directory reserved for the launcher.`);
  }
  return value;
}

/** A single safe Windows path component (layer versions, release folder names). */
export function safeComponent(value, label) {
  if (typeof value !== 'string' || value.includes('/')) throw new Error(`${label} must be a single safe directory name.`);
  return relativePath(value, label);
}

/** Layer names: 1-64 ASCII letters, digits, '-' or '_'. */
export function layerName(value, label = 'Layer name') {
  if (typeof value !== 'string' || !/^[a-z\d][a-z\d_-]{0,63}$/iu.test(value)) {
    throw new Error(`${label} must be 1-64 letters, digits, '-' or '_'.`);
  }
  return value;
}

function relativeURL(value, label) {
  if (typeof value !== 'string' || !value || /^[a-z][a-z\d+.-]*:/iu.test(value)
    || value.startsWith('/') || /[\\#\x00-\x20\x7f]/u.test(value)) {
    throw new Error(`${label} must be an encoded relative URL without a fragment.`);
  }
  const resolved = new URL(value, 'https://manifest.invalid/');
  if (resolved.origin !== 'https://manifest.invalid') throw new Error(`${label} must be relative.`);
  return value;
}

function hexDigest(value, label) {
  if (typeof value !== 'string' || !/^[a-f\d]{64}$/iu.test(value)) throw new Error(`Invalid SHA-256 for ${label}.`);
  return value.toLowerCase();
}

function newsText(value, label, max, multiline) {
  const unsafe = multiline ? /[\x00-\x09\x0b-\x1f\x7f]/u : /[\x00-\x1f\x7f]/u;
  if (typeof value !== 'string' || !value.trim() || value.length > max || unsafe.test(value)) {
    throw new Error(`${label} must be nonempty plain text of at most ${max} characters.`);
  }
  return value;
}

/** Optional release notes shown by the launcher as plain text. */
function validateNews(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10) throw new Error('Manifest news must be an array of at most 10 entries.');
  return Object.freeze(value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`Invalid manifest news entry ${index + 1}.`);
    const item = { title: newsText(entry.title, `News ${index + 1} title`, 120, false) };
    if (entry.date !== undefined) {
      if (typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(entry.date)) throw new Error(`News ${index + 1} date must be YYYY-MM-DD.`);
      item.date = entry.date;
    }
    if (entry.body !== undefined) item.body = newsText(entry.body, `News ${index + 1} body`, 1000, true);
    return Object.freeze(item);
  }));
}

/** Player-owned files are installed only when missing; the player's copy is never replaced. */
function validatePlayerOwned(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) throw new Error('Manifest playerOwned must be an array of at most 100 paths.');
  const seen = new Set();
  return Object.freeze(value.map((entry, index) => {
    const name = managedPath(entry, `Player-owned path ${index + 1}`);
    if (seen.has(windowsKey(name))) throw new Error(`Duplicate player-owned path: ${name}.`);
    seen.add(windowsKey(name));
    return name;
  }));
}

function validateLaunch(launch) {
  if (!launch || typeof launch !== 'object' || !Array.isArray(launch.args)
    || launch.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('Manifest launch.args must be an array of strings without NUL characters.');
  }
  return Object.freeze({ executable: managedPath(launch.executable, 'Launch executable'), args: Object.freeze([...launch.args]) });
}

function validateFiles(list) {
  if (!Array.isArray(list)) throw new Error('Manifest files must be an array.');
  return list.map((file, index) => {
    if (!file || typeof file !== 'object') throw new Error(`Invalid manifest file ${index + 1}.`);
    const name = managedPath(file.path, `File ${index + 1}`);
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error(`Invalid size for ${name}.`);
    return Object.freeze({ path: name, size: file.size, sha256: hexDigest(file.sha256, name), url: relativeURL(file.url, `URL for ${name}`) });
  });
}

/** Reject Windows case/normalization aliases and file/directory collisions in a complete file set. */
function checkTree(files) {
  const tree = new Map();
  let total = 0;
  for (const file of files) {
    total += file.size;
    if (!Number.isSafeInteger(total)) throw new Error('Manifest total size exceeds the supported integer range.');
    let children = tree;
    const parts = file.path.split('/');
    for (let depth = 0; depth < parts.length; depth += 1) {
      const part = parts[depth];
      const key = windowsKey(part);
      const last = depth === parts.length - 1;
      const previous = children.get(key);
      if (previous && (previous.name !== part || previous.file || last)) {
        throw new Error(`Windows path collision in manifest: ${file.path}.`);
      }
      const node = previous ?? { name: part, file: last, children: new Map() };
      children.set(key, node);
      children = node.children;
    }
  }
  return total;
}

function validateLayers(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_LAYERS) throw new Error(`Manifest layers must be an array of 1-${MAX_LAYERS} entries.`);
  const names = new Set();
  return Object.freeze(value.map((layer, index) => {
    if (!layer || typeof layer !== 'object') throw new Error(`Invalid manifest layer ${index + 1}.`);
    const name = layerName(layer.name, `Layer ${index + 1} name`);
    if (names.has(name.toLowerCase())) throw new Error(`Duplicate layer name: ${name}.`);
    names.add(name.toLowerCase());
    return Object.freeze({
      name,
      version: safeComponent(layer.version, `Layer ${name} version`),
      manifestUrl: relativeURL(layer.manifestUrl, `Layer ${name} manifestUrl`),
      sha256: hexDigest(layer.sha256, `layer ${name} manifest`),
    });
  }));
}

/**
 * Validate and copy a top-level manifest; the result is deeply frozen.
 * schemaVersion 1 lists files directly; schemaVersion 2 references layer manifests.
 */
export function validateManifest(value) {
  if (!value || typeof value !== 'object' || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) {
    throw new Error('Unsupported manifest: schemaVersion must be 1 or 2.');
  }
  if (typeof value.version !== 'string' || !value.version.trim()) throw new Error('Manifest version is required.');
  const launch = validateLaunch(value.launch);
  const news = validateNews(value.news);
  const playerOwned = validatePlayerOwned(value.playerOwned);
  let manifest;
  if (value.schemaVersion === 1) {
    const files = validateFiles(value.files);
    checkTree(files);
    if (!files.some((file) => file.path === launch.executable)) throw new Error('Launch executable must be listed with identical spelling in manifest files.');
    manifest = { schemaVersion: 1, version: value.version, launch, files: Object.freeze(files) };
  } else {
    manifest = { schemaVersion: 2, version: value.version, launch, layers: validateLayers(value.layers) };
  }
  if (news) manifest.news = news;
  if (playerOwned) manifest.playerOwned = playerOwned;
  Object.freeze(manifest);
  validated.add(manifest);
  return manifest;
}

/** Validate a layer manifest; `expected` binds it to the top-level reference. */
export function validateLayerManifest(value, expected = {}) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 2) throw new Error('Unsupported layer manifest: schemaVersion must be 2.');
  const name = layerName(value.layer, 'Layer manifest name');
  const version = safeComponent(value.version, `Layer ${name} version`);
  if ((expected.name !== undefined && expected.name !== name) || (expected.version !== undefined && expected.version !== version)) {
    throw new Error(`Layer manifest ${name}@${version} does not match the release reference ${expected.name}@${expected.version}.`);
  }
  const files = validateFiles(value.files);
  checkTree(files);
  return Object.freeze({ schemaVersion: 2, layer: name, version, files: Object.freeze(files) });
}

/** Combine layers in order: a later layer replaces an earlier layer's file at the same path. */
export function mergeLayers(layers) {
  const merged = new Map();
  for (const { name, files } of layers) {
    for (const file of files) {
      const key = windowsKey(file.path);
      const previous = merged.get(key);
      if (previous && previous.path !== file.path) throw new Error(`Windows path alias between layers: ${previous.path} and ${file.path}.`);
      if (previous) merged.delete(key);
      merged.set(key, { ...file, layer: name });
    }
  }
  const files = [...merged.values()];
  checkTree(files);
  return files;
}

function networkURL(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('Enter an absolute HTTPS manifest URL.'); }
  const local = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/u.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('Release URLs must use HTTPS (HTTP is allowed only on loopback for local verification).');
  }
  if (url.username || url.password || url.hash) throw new Error('Release URLs cannot contain credentials or fragments.');
  return url;
}

function permanent(error) {
  error.permanent = true;
  return error;
}

export const ACCESS_KEY_USER = 'slums';
export const ACCESS_KEY_MESSAGE = 'This server needs an access key - enter it in Settings';

/**
 * Bind an optional access key to the feed's origin. The Authorization header is only ever attached
 * to requests whose origin equals that origin; an empty key yields no header at all.
 */
export function feedAccess(feedUrl, accessKey = '') {
  const key = typeof accessKey === 'string' ? accessKey : '';
  return Object.freeze({
    origin: networkURL(feedUrl).origin,
    authorization: key ? `Basic ${Buffer.from(`${ACCESS_KEY_USER}:${key}`, 'utf8').toString('base64')}` : '',
  });
}

function accessDenied(status) {
  const error = permanent(new Error(ACCESS_KEY_MESSAGE));
  error.status = status;
  error.code = 'ACCESS_KEY_REQUIRED';
  return error;
}

async function request(input, signal, access = null) {
  let url = networkURL(input);
  const secure = url.protocol === 'https:';
  // The key is sent only while the chain stays on the feed's origin. A redirect to any other origin
  // drops it for the rest of the chain, even if a later hop points back, so no other host sees it.
  let trusted = Boolean(access?.authorization);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (secure && url.protocol !== 'https:') throw permanent(new Error('An HTTPS release cannot redirect to HTTP.'));
    if (url.origin !== access?.origin) trusted = false;
    const headers = { 'Accept-Encoding': 'identity' };
    if (trusted) headers.Authorization = access.authorization;
    const response = await fetch(url, { redirect: 'manual', signal, headers });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirects === 5) throw permanent(new Error('Release request has an invalid or excessive redirect chain.'));
      url = networkURL(new URL(location, url));
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      // 401/403 from the feed means a missing or wrong key; it is permanent, so never retried.
      if ((response.status === 401 || response.status === 403) && access && url.origin === access.origin) throw accessDenied(response.status);
      const error = new Error(`Release request failed: HTTP ${response.status} ${response.statusText}.`);
      error.status = response.status;
      if (response.status < 500 && ![408, 425, 429].includes(response.status)) permanent(error);
      throw error;
    }
    return { response, url };
  }
  throw permanent(new Error('Release request exceeded the redirect limit.'));
}

async function readJSON(input, label, access) {
  const { response, url } = await request(input, undefined, access);
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_MANIFEST_BYTES) throw new Error(`${label} is too large.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error(`${label} is too large.`);
  return { bytes, finalUrl: url.href };
}

function parseJSON(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); } catch (error) { throw new Error(`Cannot read ${label}: ${error.message}`, { cause: error }); }
}

async function statOrMissing(filename) {
  try { return await fs.lstat(filename); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function checkSpelling(directory, name, cache) {
  let entries = cache.get(directory);
  if (!entries) {
    entries = new Map();
    for (const entry of await fs.readdir(directory)) {
      const key = windowsKey(entry);
      entries.set(key, entries.has(key) ? null : entry);
    }
    cache.set(directory, entries);
  }
  const key = windowsKey(name);
  if (entries.has(key) && entries.get(key) !== name) {
    throw new Error(`Existing Windows path alias conflicts with ${path.join(directory, name)}.`);
  }
}

const VERIFIED_DIRECTORIES = Symbol('verified directories');

async function directoryChild(parent, name, create, cache) {
  const target = path.join(parent, name);
  // Within one operation, a directory already checked is not re-checked for every file it holds.
  let known = cache.get(VERIFIED_DIRECTORIES);
  if (!known) cache.set(VERIFIED_DIRECTORIES, known = new Set());
  if (known.has(target)) return true;
  await checkSpelling(parent, name, cache);
  let stat = await statOrMissing(target);
  if (!stat && create) {
    // Parallel workers may create the same directory; the lstat below still rejects non-directories.
    try { await fs.mkdir(target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    cache.get(parent)?.set(windowsKey(name), name);
    stat = await fs.lstat(target);
  }
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Not a real directory (symlinks are forbidden): ${target}`);
  known.add(target);
  return true;
}

async function installationRoot(input, create, cache = new Map()) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Choose an installation directory first.');
  const root = path.resolve(input);
  const anchor = path.parse(root).root;
  let current = anchor;
  for (const name of root.slice(anchor.length).split(path.sep).filter(Boolean)) {
    if (!await directoryChild(current, name, create, cache)) return { root, exists: false };
    current = path.join(current, name);
  }
  return { root, exists: true };
}

async function destination(root, relative, create, cache) {
  const parts = relative.split('/');
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    if (!await directoryChild(parent, part, create, cache)) return { filename: path.join(root, ...parts), stat: null };
    parent = path.join(parent, part);
  }
  const name = parts.at(-1);
  await checkSpelling(parent, name, cache);
  const filename = path.join(parent, name);
  const stat = await statOrMissing(filename);
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error(`Not a regular file (symlinks are forbidden): ${filename}`);
  return { filename, stat };
}

/** Hash a regular file; returns null when it changed while being read. */
async function digest(filename, onBytes) {
  const hash = createHash('sha256');
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Not a regular file: ${filename}`);
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      onBytes(chunk.length);
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return null;
    return { sha256: hash.digest('hex'), stat };
  } finally { await handle.close(); }
}

async function readSmallFile(root, relative) {
  const installation = await installationRoot(root, false);
  if (!installation.exists) return null;
  const target = await destination(installation.root, relative, false, new Map());
  if (!target.stat) return null;
  return fs.readFile(target.filename);
}

/** Atomically write launcher bookkeeping under the installation, never through symlinks. */
async function writeSmallFile(root, relative, contents) {
  const target = await destination(root, relative, true, new Map());
  const temporary = `${target.filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, target.filename);
  } finally { await fs.rm(temporary, { force: true }); }
}

function emptyState() {
  return { release: '', layers: [], files: new Map() };
}

/**
 * Per-install verification state: { path: { size, mtimeMs, sha256 } } for files the launcher installed
 * or hashed. A matching size and mtime lets Play trust the recorded hash without re-reading the file.
 * The state is a cache: when it is missing or unreadable, files are hashed again.
 */
export async function readInstallState(root) {
  try {
    const bytes = await readSmallFile(root, STATE_FILE);
    const value = bytes && JSON.parse(bytes.toString('utf8'));
    if (!value || value.stateVersion !== 1 || !value.files || typeof value.files !== 'object') return emptyState();
    const files = new Map();
    for (const [name, entry] of Object.entries(value.files)) {
      if (entry && Number.isSafeInteger(entry.size) && Number.isFinite(entry.mtimeMs) && typeof entry.sha256 === 'string') {
        files.set(name, { size: entry.size, mtimeMs: entry.mtimeMs, sha256: entry.sha256 });
      }
    }
    return { release: typeof value.release === 'string' ? value.release : '', layers: Array.isArray(value.layers) ? value.layers : [], files };
  } catch {
    return emptyState();
  }
}

async function writeInstallState(root, release, files) {
  const value = {
    stateVersion: 1,
    release: release.version,
    layers: release.layers.map(({ name, version, sha256: digestValue }) => ({ name, version, sha256: digestValue })),
    files: Object.fromEntries(release.files.filter((file) => files.has(file.path)).map((file) => [file.path, files.get(file.path)])),
  };
  await writeSmallFile(root, STATE_FILE, JSON.stringify(value));
}

const layerCachePath = (digestValue) => `${LAYER_CACHE}/${digestValue}.json`;

async function cachedLayer(installDir, reference, requestUrl) {
  if (!installDir) return null;
  try {
    const bytes = await readSmallFile(installDir, layerCachePath(reference.sha256));
    if (!bytes) return null;
    const value = JSON.parse(bytes.toString('utf8'));
    if (value?.requestUrl !== requestUrl || typeof value.finalUrl !== 'string' || typeof value.body !== 'string') return null;
    const body = Buffer.from(value.body, 'utf8');
    if (sha256(body) !== reference.sha256) return null;
    networkURL(value.finalUrl);
    return { bytes: body, finalUrl: value.finalUrl };
  } catch { return null; }
}

/** Keep verified layer manifests so unchanged layers are not downloaded again; drop stale ones. */
async function writeLayerCache(root, release) {
  const info = loaded.get(release);
  if (!info?.layerSources.length) return;
  const keep = new Set();
  for (const source of info.layerSources) {
    keep.add(`${source.sha256}.json`);
    if (source.cached) continue;
    await writeSmallFile(root, layerCachePath(source.sha256), JSON.stringify({ requestUrl: source.requestUrl, finalUrl: source.finalUrl, body: source.bytes.toString('utf8') }));
  }
  const directory = path.join(root, ...LAYER_CACHE.split('/'));
  for (const entry of await fs.readdir(directory)) {
    if (!keep.has(entry) && entry.endsWith('.json')) await fs.rm(path.join(directory, entry), { force: true });
  }
}

/**
 * Load a release. schemaVersion 2 releases fetch each layer manifest (verified against the
 * top-level SHA-256) unless an identical layer manifest is cached in `installDir`.
 */
export async function loadRelease(feedUrl, { installDir, accessKey = '' } = {}) {
  const access = feedAccess(feedUrl, accessKey);
  const top = await readJSON(networkURL(feedUrl), 'release manifest', access);
  const manifest = validateManifest(parseJSON(top.bytes, 'release manifest'));
  let files;
  const layers = [];
  const layerSources = [];
  if (manifest.schemaVersion === 1) {
    files = manifest.files.map((file) => ({ ...file, url: new URL(file.url, top.finalUrl).href, layer: '' }));
  } else {
    const parts = [];
    for (const reference of manifest.layers) {
      const requestUrl = new URL(reference.manifestUrl, top.finalUrl).href;
      let source = await cachedLayer(installDir, reference, requestUrl);
      const cached = Boolean(source);
      if (!source) {
        source = await readJSON(requestUrl, `layer manifest ${reference.name}`, access);
        if (sha256(source.bytes) !== reference.sha256) throw new Error(`Layer manifest ${reference.name}@${reference.version} failed SHA-256 verification.`);
      }
      const layer = validateLayerManifest(parseJSON(source.bytes, `layer manifest ${reference.name}`), reference);
      parts.push({ name: layer.layer, files: layer.files.map((file) => ({ ...file, url: new URL(file.url, source.finalUrl).href })) });
      layers.push(Object.freeze({ name: reference.name, version: reference.version, sha256: reference.sha256, cached }));
      layerSources.push({ sha256: reference.sha256, requestUrl, finalUrl: source.finalUrl, bytes: source.bytes, cached });
    }
    files = mergeLayers(parts);
    if (!files.some((file) => file.path === manifest.launch.executable)) throw new Error('Launch executable must be listed with identical spelling in a release layer.');
  }
  const release = Object.freeze({
    schemaVersion: manifest.schemaVersion,
    version: manifest.version,
    launch: manifest.launch,
    playerOwned: manifest.playerOwned ?? Object.freeze([]),
    ...(manifest.news ? { news: manifest.news } : {}),
    layers: Object.freeze(layers),
    files: Object.freeze(files.map((file) => Object.freeze(file))),
  });
  loaded.set(release, { layerSources, access });
  return release;
}

/** Accept loaded releases, or a raw schemaVersion 1 manifest for inspection only. */
function knownRelease(release) {
  if (loaded.has(release)) return release;
  const manifest = validated.has(release) ? release : validateManifest(release);
  if (manifest.schemaVersion !== 1) throw new Error('Load a layered release with loadRelease before inspecting it.');
  return { ...manifest, playerOwned: manifest.playerOwned ?? [], layers: [], files: manifest.files.map((file) => ({ ...file, layer: '' })) };
}

async function pool(count, limit, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, count) }, async () => {
    while (next < count) await worker(next++);
  }));
}

/**
 * Compare the installation with a release.
 * mode 'fast' (Play/Update): files whose size and mtime match the install state are trusted without hashing.
 * mode 'full' (Repair): every present file of the right size is SHA-256 hashed.
 * Player-owned files only need to exist in either mode.
 */
async function inspect(root, release, onProgress, mode) {
  if (mode !== 'fast' && mode !== 'full') throw new Error(`Unknown verification mode: ${mode}`);
  const cache = new Map();
  const installation = await installationRoot(root, false, cache);
  const state = installation.exists ? await readInstallState(installation.root) : emptyState();
  const owned = new Set(release.playerOwned.map(windowsKey));
  const verified = new Map();
  const pending = new Set();
  const existing = new Set();
  const toHash = [];
  let filesDone = 0;
  const filesTotal = release.files.length;
  const report = (message, bytesDone = 0, bytesTotal = 0) => onProgress({ message, filesDone, filesTotal, bytesDone, bytesTotal });
  report('Checking installed files…');
  for (const file of release.files) {
    const current = installation.exists ? await destination(installation.root, file.path, false, cache) : null;
    const stat = current?.stat;
    const entry = state.files.get(file.path);
    if (stat) existing.add(file.path);
    if (!stat) pending.add(file.path);
    else if (owned.has(windowsKey(file.path))) { /* the player's copy is kept as-is */ }
    else if (stat.size !== file.size) pending.add(file.path);
    else if (mode === 'fast' && entry && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs) {
      if (entry.sha256 === file.sha256) verified.set(file.path, entry);
      else pending.add(file.path);
    } else toHash.push({ file, filename: current.filename });
    filesDone += 1;
    if (filesDone % 500 === 0) report('Checking installed files…');
  }
  const bytesTotal = toHash.reduce((sum, item) => sum + item.file.size, 0);
  let bytesDone = 0;
  filesDone = filesTotal - toHash.length;
  await pool(toHash.length, 4, async (index) => {
    const { file, filename } = toHash[index];
    const result = await digest(filename, (count) => { bytesDone += count; report(`Verifying ${file.path}`, bytesDone, bytesTotal); });
    if (result?.sha256 === file.sha256) verified.set(file.path, { size: result.stat.size, mtimeMs: result.stat.mtimeMs, sha256: file.sha256 });
    else pending.add(file.path);
    filesDone += 1;
    report(`Verified ${file.path}`, bytesDone, bytesTotal);
  });
  const files = release.files.filter((file) => pending.has(file.path));
  return {
    files, bytes: files.reduce((sum, file) => sum + file.size, 0), hashed: toHash.length, verified, existing, installation,
    stateChanged: toHash.length > 0 || state.release !== release.version,
  };
}

/** Returns { files, bytes, hashed }: the files that need downloading and how many files were hashed. */
export async function inspectRelease(root, release, onProgress = () => {}, { mode = 'fast' } = {}) {
  const known = knownRelease(release);
  const result = await inspect(root, known, onProgress, mode);
  if (result.installation.exists && result.stateChanged && loaded.has(known)) {
    // Recording newly hashed files keeps the next Play fast; the state is only a cache.
    try { await writeInstallState(result.installation.root, known, result.verified); } catch { /* the next check hashes again */ }
  }
  return { files: result.files, bytes: result.bytes, hashed: result.hashed };
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true });
});

async function download(file, target, onBytes, signal, access) {
  const { response } = await request(file.url, signal, access);
  const hash = createHash('sha256');
  let size = 0;
  const verify = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > file.size) return callback(permanent(new Error(`Download exceeds declared size: ${file.path}.`)));
      hash.update(chunk);
      try { onBytes(chunk.length); } catch (error) { callback(error); return; }
      callback(null, chunk);
    },
  });
  const body = response.body ? Readable.fromWeb(response.body) : Readable.from([]);
  await pipeline(body, verify, createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal });
  // A short body is usually a dropped connection and is retried; a full-size mismatch is not.
  if (size < file.size) throw new Error(`Download ended early: ${file.path}.`);
  if (hash.digest('hex') !== file.sha256) throw permanent(new Error(`Downloaded file failed size/SHA-256 verification: ${file.path}.`));
}

/**
 * Download and install missing or changed files (mode 'full' hashes every file first, for Repair).
 * Every download is verified in staging before it is moved into place. Files that did not exist are
 * committed as soon as they verify, so an interrupted first install resumes where it stopped; files
 * that replace existing ones are committed only after every download has verified.
 */
export async function installRelease(root, release, onProgress = () => {}, options = {}) {
  const { mode = 'fast', concurrency = DEFAULT_CONCURRENCY, retries = 4, retryDelayMs = 500 } = options;
  if (!loaded.has(release)) throw new Error('Load the release from its manifest URL before downloading files.');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) throw new Error(`Concurrency must be 1-${MAX_CONCURRENCY}.`);
  const { access } = loaded.get(release);
  const pending = await inspect(root, release, onProgress, mode);
  const result = { files: pending.files, bytes: pending.bytes, hashed: pending.hashed };
  const installation = await installationRoot(root, true);
  const verified = pending.verified;
  const saveState = () => writeInstallState(installation.root, release, verified);
  if (!pending.files.length) {
    await saveState();
    await writeLayerCache(installation.root, release);
    return result;
  }
  const stage = await fs.mkdtemp(path.join(installation.root, STAGE_PREFIX));
  const cache = new Map();
  await installationRoot(installation.root, false, cache);
  const deferred = [];
  let bytesDone = 0;
  let filesDone = 0;
  let lastCheckpoint = Date.now();
  let checkpoint = Promise.resolve();
  let complete = false;
  const progress = (message) => onProgress({ message, filesDone, filesTotal: pending.files.length, bytesDone, bytesTotal: pending.bytes });
  async function commit(file, temporary) {
    const target = await destination(installation.root, file.path, true, cache);
    await fs.rename(temporary, target.filename);
    cache.get(path.dirname(target.filename))?.set(windowsKey(path.basename(target.filename)), path.basename(target.filename));
    const stat = await fs.lstat(target.filename);
    verified.set(file.path, { size: stat.size, mtimeMs: stat.mtimeMs, sha256: file.sha256 });
  }
  const controller = new AbortController();
  async function transfer(file) {
    let temporary;
    for (let attempt = 0; ; attempt += 1) {
      temporary = path.join(stage, randomUUID());
      let received = 0;
      try {
        await download(file, temporary, (count) => {
          received += count;
          bytesDone += count;
          progress(`Downloading ${file.path}`);
        }, controller.signal, access);
        break;
      } catch (error) {
        bytesDone -= received;
        await fs.rm(temporary, { force: true });
        if (controller.signal.aborted || error.permanent || attempt >= retries) throw error;
        progress(`Retrying ${file.path}`);
        await sleep(retryDelayMs * 2 ** attempt + Math.random() * retryDelayMs, controller.signal);
      }
    }
    if (pending.existing.has(file.path)) deferred.push({ file, temporary });
    else await commit(file, temporary);
    filesDone += 1;
    progress(`Verified ${file.path}`);
    if (Date.now() - lastCheckpoint > STATE_CHECKPOINT_MS) {
      lastCheckpoint = Date.now();
      checkpoint = checkpoint.then(saveState, saveState);
    }
  }
  try {
    progress('Downloading verified update files…');
    let failure;
    await pool(pending.files.length, concurrency, async (index) => {
      if (controller.signal.aborted) return;
      try { await transfer(pending.files[index]); } catch (error) {
        if (!failure) { failure = error; controller.abort(); }
      }
    });
    if (failure) throw failure;
    // No existing file is replaced until every download has passed verification.
    for (const { file, temporary } of deferred) {
      await commit(file, temporary);
      progress(`Installed ${file.path}`);
    }
    await checkpoint.catch(() => {});
    await saveState();
    await writeLayerCache(installation.root, release);
    complete = true;
    return result;
  } finally {
    await checkpoint.catch(() => {});
    // Record files committed before a failure so a resumed install need not hash them again.
    if (!complete) await saveState().catch(() => {});
    await fs.rm(stage, { recursive: true, force: true });
  }
}

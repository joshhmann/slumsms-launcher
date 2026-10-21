import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { validatePackIndex, planPacks, rateMeter, downloadMessage, resumeMessage, DEFAULT_REQUEST_COST } from './packs.mjs';

/** Launcher bookkeeping inside an installation; manifests may never write here. */
export const STATE_DIRECTORY = '.slumsms-launcher';
const STATE_FILE = `${STATE_DIRECTORY}/state.json`;
const INSTALLED_FILE = `${STATE_DIRECTORY}/installed.json`;
const LAYER_CACHE = `${STATE_DIRECTORY}/layers`;
const STAGE_PREFIX = '.mapleroot-stage-';
const MAX_MANIFEST_BYTES = 128 * 1024 * 1024;
const MAX_LAYERS = 16;
export const DEFAULT_CONCURRENCY = 12;
export const MAX_CONCURRENCY = 32;
// Short, so a launcher killed mid-install (no time for its final save) re-hashes only a few seconds of files.
const STATE_CHECKPOINT_MS = 5_000;

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
    const reference = {
      name,
      version: safeComponent(layer.version, `Layer ${name} version`),
      manifestUrl: relativeURL(layer.manifestUrl, `Layer ${name} manifestUrl`),
      sha256: hexDigest(layer.sha256, `layer ${name} manifest`),
    };
    // Optional packs for the first install (launcher 1.3.3+; older launchers ignore the field).
    if (layer.packs !== undefined) {
      if (!layer.packs || typeof layer.packs !== 'object') throw new Error(`Layer ${name} packs must be an object.`);
      reference.packs = Object.freeze({ url: relativeURL(layer.packs.url, `Layer ${name} packs url`), sha256: hexDigest(layer.packs.sha256, `layer ${name} pack index`) });
    }
    return Object.freeze(reference);
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

async function request(input, signal, access = null, extraHeaders = {}) {
  let url = networkURL(input);
  const secure = url.protocol === 'https:';
  // The key is sent only while the chain stays on the feed's origin. A redirect to any other origin
  // drops it for the rest of the chain, even if a later hop points back, so no other host sees it.
  let trusted = Boolean(access?.authorization);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (secure && url.protocol !== 'https:') throw permanent(new Error('An HTTPS release cannot redirect to HTTP.'));
    if (url.origin !== access?.origin) trusted = false;
    const headers = { 'Accept-Encoding': 'identity', ...extraHeaders };
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

async function readJSON(input, label, access, signal) {
  const { response, url } = await request(input, signal, access);
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

/**
 * The release this folder last fully verified as: written only after a verify or install that left
 * nothing pending, unlike state.json, which is a hash cache checkpointed mid-install.
 * { recordVersion: 1, release, manifestSha256, layers: [{ name, version, sha256 }], verifiedAt, launch? }.
 * `launch` ({ executable, args }, from 1.3.3) lets Play start the installed client when the update
 * server cannot be reached; older records have none (null). Returns null when there is no record or it is unreadable, so the launcher shows "Unknown".
 */
export async function readInstalledRecord(root) {
  try {
    const bytes = await readSmallFile(root, INSTALLED_FILE);
    if (!bytes) return null;
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || value.recordVersion !== 1 || typeof value.release !== 'string' || !value.release || value.release.length > 128) return null;
    const layers = Array.isArray(value.layers) ? value.layers.filter((layer) => layer && typeof layer.name === 'string' && typeof layer.version === 'string')
      .map(({ name, version, sha256: digestValue }) => ({ name, version, sha256: typeof digestValue === 'string' ? digestValue : '' })) : [];
    return {
      release: value.release,
      manifestSha256: typeof value.manifestSha256 === 'string' ? value.manifestSha256 : '',
      layers,
      verifiedAt: typeof value.verifiedAt === 'string' ? value.verifiedAt : '',
      launch: recordedLaunch(value.launch),
    };
  } catch {
    return null;
  }
}

function recordedLaunch(value) {
  if (value === undefined || value === null) return null;
  try { return validateLaunch(value); } catch { return null; }
}

export async function writeInstalledRecord(root, release, { now = new Date() } = {}) {
  const value = {
    recordVersion: 1,
    release: release.version,
    manifestSha256: release.manifestSha256 ?? '',
    layers: (release.layers ?? []).map(({ name, version, sha256: digestValue }) => ({ name, version, sha256: digestValue })),
    verifiedAt: now.toISOString(),
    ...(release.launch ? { launch: { executable: release.launch.executable, args: [...release.launch.args] } } : {}),
  };
  await writeSmallFile(root, INSTALLED_FILE, JSON.stringify(value));
  return value;
}

/** Record a fully verified release, skipping the write when the record already says so. */
async function recordInstalled(root, release) {
  if (!release.manifestSha256) return; // the launcher's own channel stages through here too; it is not a game release
  const current = await readInstalledRecord(root);
  if (current?.release === release.version && current.manifestSha256 === (release.manifestSha256 ?? '') && current.launch) return;
  await writeInstalledRecord(root, release);
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
  const layerParts = [];
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
      const layerFiles = layer.files.map((file) => ({ ...file, url: new URL(file.url, source.finalUrl).href }));
      parts.push({ name: layer.layer, files: layerFiles });
      layerParts.push({ layer: layer.layer, version: layer.version, manifestSha256: reference.sha256, files: layerFiles,
        packs: reference.packs ? { url: new URL(reference.packs.url, top.finalUrl).href, sha256: reference.packs.sha256 } : null });
      layers.push(Object.freeze({ name: reference.name, version: reference.version, sha256: reference.sha256, cached }));
      layerSources.push({ sha256: reference.sha256, requestUrl, finalUrl: source.finalUrl, bytes: source.bytes, cached });
    }
    files = mergeLayers(parts);
    if (!files.some((file) => file.path === manifest.launch.executable)) throw new Error('Launch executable must be listed with identical spelling in a release layer.');
  }
  const release = Object.freeze({
    schemaVersion: manifest.schemaVersion,
    version: manifest.version,
    manifestSha256: sha256(top.bytes),
    launch: manifest.launch,
    playerOwned: manifest.playerOwned ?? Object.freeze([]),
    ...(manifest.news ? { news: manifest.news } : {}),
    layers: Object.freeze(layers),
    files: Object.freeze(files.map((file) => Object.freeze(file))),
  });
  loaded.set(release, { layerSources, layerParts, access });
  return release;
}

/**
 * What the server offers right now, from the top-level manifest only: no layer manifests, no files.
 * Never throws. status: 'ok' { version, layers, manifestSha256 } | 'access-key' (401/403) |
 * 'offline' (no connection or timeout) | 'error' (bad response or manifest), each with a message.
 */
export async function checkAvailableRelease(feedUrl, { accessKey = '', signal } = {}) {
  try {
    const access = feedAccess(feedUrl, accessKey);
    const top = await readJSON(networkURL(feedUrl), 'release manifest', access, signal ?? AbortSignal.timeout(15_000));
    const manifest = validateManifest(parseJSON(top.bytes, 'release manifest'));
    return {
      status: 'ok',
      version: manifest.version,
      layers: (manifest.layers ?? []).map(({ name, version }) => ({ name, version })),
      manifestSha256: sha256(top.bytes),
    };
  } catch (error) {
    if (error?.code === 'ACCESS_KEY_REQUIRED') return { status: 'access-key', message: ACCESS_KEY_MESSAGE };
    if (error?.status === undefined && (error?.name === 'TypeError' || error?.name === 'TimeoutError' || error?.name === 'AbortError')) {
      return { status: 'offline', message: 'Could not reach the update server.' };
    }
    return { status: 'error', message: typeof error?.message === 'string' ? error.message : 'The update server sent an unreadable answer.' };
  }
}

/** The launcher's own update channel. It sits beside the game manifest and is never a game release layer. */
export const LAUNCHER_CHANNEL_FILE = 'launcher.json';
export const LAUNCHER_PLATFORMS = Object.freeze(['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']);

/** Launcher versions are plain MAJOR.MINOR.PATCH, as in package.json. */
export function launcherVersion(value, label = 'Launcher version') {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/u.test(value)) {
    throw new Error(`${label} must be MAJOR.MINOR.PATCH.`);
  }
  return value;
}

export const launcherLayerName = (platform) => `launcher-${platform}`;

/**
 * Validate launcher.json: { schemaVersion: 1, version, platform, executable, manifestUrl, sha256 }.
 * manifestUrl names a per-file manifest in the layer format; sha256 pins its exact bytes.
 */
export function validateLauncherChannel(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1) throw new Error('Unsupported launcher channel: schemaVersion must be 1.');
  if (!LAUNCHER_PLATFORMS.includes(value.platform)) throw new Error('Launcher channel platform is not supported.');
  return Object.freeze({
    schemaVersion: 1,
    version: launcherVersion(value.version),
    platform: value.platform,
    executable: managedPath(value.executable, 'Launcher executable'),
    manifestUrl: relativeURL(value.manifestUrl, 'Launcher manifestUrl'),
    sha256: hexDigest(value.sha256, 'launcher manifest'),
  });
}

/**
 * Load the launcher channel beside `feedUrl`, with the same access key and verification as game layers.
 * Returns null when the server publishes no launcher.json (404). The result's `release` is a loaded
 * release, so inspectRelease/installRelease stage it exactly like a game install.
 */
export async function loadLauncherChannel(feedUrl, { accessKey = '', signal } = {}) {
  const access = feedAccess(feedUrl, accessKey);
  let top;
  try { top = await readJSON(new URL(LAUNCHER_CHANNEL_FILE, networkURL(feedUrl)).href, 'launcher channel', access, signal); } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
  const channel = validateLauncherChannel(parseJSON(top.bytes, 'launcher channel'));
  const requestUrl = new URL(channel.manifestUrl, top.finalUrl).href;
  const source = await readJSON(requestUrl, 'launcher manifest', access, signal);
  if (sha256(source.bytes) !== channel.sha256) throw new Error(`Launcher manifest ${channel.version} failed SHA-256 verification.`);
  const layer = validateLayerManifest(parseJSON(source.bytes, 'launcher manifest'), { name: launcherLayerName(channel.platform), version: channel.version });
  if (!layer.files.some((file) => file.path === channel.executable)) throw new Error('Launcher executable must be listed with identical spelling in the launcher manifest.');
  const release = Object.freeze({
    schemaVersion: 2,
    version: channel.version,
    launch: Object.freeze({ executable: channel.executable, args: Object.freeze([]) }),
    playerOwned: Object.freeze([]),
    layers: Object.freeze([]),
    files: Object.freeze(layer.files.map((file) => Object.freeze({ ...file, url: new URL(file.url, source.finalUrl).href, layer: layer.layer }))),
  });
  loaded.set(release, { layerSources: [], access });
  return { ...channel, release };
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
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  return {
    files, bytes, hashed: toHash.length, verified, existing, installation,
    // Bytes already in place and verified (or trusted by size and mtime): what a resumed install keeps.
    keptBytes: release.files.reduce((sum, file) => sum + file.size, 0) - bytes,
    stateChanged: toHash.length > 0 || state.release !== release.version,
  };
}

/** Returns { files, bytes, hashed, keptBytes }: the files that need downloading, how many files were hashed, and the bytes already in place. */
export async function inspectRelease(root, release, onProgress = () => {}, { mode = 'fast' } = {}) {
  const known = knownRelease(release);
  const result = await inspect(root, known, onProgress, mode);
  if (result.installation.exists && result.stateChanged && loaded.has(known)) {
    // Recording newly hashed files keeps the next Play fast; the state is only a cache.
    try { await writeInstallState(result.installation.root, known, result.verified); } catch { /* the next check hashes again */ }
  }
  if (result.installation.exists && !result.files.length && loaded.has(known)) {
    try { await recordInstalled(result.installation.root, known); } catch { /* shown as Unknown until the next verify */ }
  }
  return { files: result.files, bytes: result.bytes, hashed: result.hashed, keptBytes: result.keptBytes };
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true });
});

/** Exponential backoff with jitter, capped so a long outage is retried about every 30 seconds. */
const backoff = (base, attempt) => Math.min(base * 2 ** attempt, 30_000) + Math.random() * base;

export const DEFAULT_STALL_MS = 60_000;
export const DEFAULT_PACK_CONCURRENCY = 4;
/** Below this many pending files the pack index is not even fetched: small updates stay per-file. */
export const PACK_MIN_FILES = 32;
const STALE_STAGE_MS = 60 * 60 * 1000;

/**
 * A per-request signal that also aborts when no data arrives for `stallMs`: a dead home connection
 * can hang without ever erroring. touch() on every chunk; done() when the request is over.
 */
function stallGuard(parent, stallMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort(); else parent.addEventListener('abort', abort, { once: true });
  let timer;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(Object.assign(new Error('The download stalled: no data for a while.'), { stalled: true })), stallMs);
  };
  touch();
  return { signal: controller.signal, touch, done() { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
}

async function download(file, target, onBytes, signal, access, stallMs = DEFAULT_STALL_MS) {
  const guard = stallGuard(signal, stallMs);
  try {
    const { response } = await request(file.url, guard.signal, access);
    const hash = createHash('sha256');
    let size = 0;
    const verify = new Transform({
      transform(chunk, encoding, callback) {
        guard.touch();
        size += chunk.length;
        if (size > file.size) return callback(permanent(new Error(`Download exceeds declared size: ${file.path}.`)));
        hash.update(chunk);
        try { onBytes(chunk.length); } catch (error) { callback(error); return; }
        callback(null, chunk);
      },
    });
    const body = response.body ? Readable.fromWeb(response.body) : Readable.from([]);
    await pipeline(body, verify, createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal: guard.signal });
    // A short body is usually a dropped connection and is retried; a full-size mismatch is not.
    if (size < file.size) throw new Error(`Download ended early: ${file.path}.`);
    if (hash.digest('hex') !== file.sha256) throw permanent(new Error(`Downloaded file failed size/SHA-256 verification: ${file.path}.`));
  } finally { guard.done(); }
}

const LOCAL_ERRORS = new Set(['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'EMFILE', 'ENFILE', 'EBUSY']);
/** Disk errors are not network trouble: never retry them. */
function local(error) {
  if (LOCAL_ERRORS.has(error?.code)) error.local = true;
  return error;
}

/** Free bytes for `directory` (or its nearest existing parent); null when the platform cannot say. */
export async function freeDiskBytes(directory) {
  let current = path.resolve(directory);
  for (;;) {
    try {
      const stats = await fs.statfs(current);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch (error) {
      const parent = path.dirname(current);
      if (error.code !== 'ENOENT' || parent === current) return null;
      current = parent;
    }
  }
}

const gigabytes = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** Refuse to start a download that cannot fit, instead of failing hours in with a full disk. */
async function ensureDiskSpace(root, bytes, freeSpace) {
  let free;
  try { free = await freeSpace(root); } catch { free = null; }
  if (free === null || !Number.isFinite(free)) return;
  const needed = bytes + Math.min(bytes, 512 * 1024 * 1024);
  if (free < needed) {
    const error = permanent(new Error(`Not enough disk space: this download needs about ${gigabytes(needed)} free in ${root}, but only ${gigabytes(free)} is free. Free up space or choose another game folder in Settings.`));
    error.code = 'DISK_FULL';
    throw error;
  }
}

/** Staging folders left by a launcher that was killed mid-install hold partial downloads; drop old ones. */
async function removeStaleStages(root) {
  let entries;
  try { entries = await fs.readdir(root); } catch { return; }
  for (const entry of entries) {
    if (!entry.startsWith(STAGE_PREFIX)) continue;
    const full = path.join(root, entry);
    const stat = await statOrMissing(full).catch(() => null);
    if (stat?.isDirectory() && Date.now() - stat.mtimeMs > STALE_STAGE_MS) await fs.rm(full, { recursive: true, force: true }).catch(() => {});
  }
}

/** Fetch and verify the pack indexes of a loaded release; a layer whose index is unusable just has no packs. */
async function loadPackSources(layerParts, access, signal, note) {
  const sources = [];
  for (const part of layerParts) {
    if (!part.packs) continue;
    try {
      const { bytes, finalUrl } = await readJSON(part.packs.url, `pack index ${part.layer}`, access, signal);
      if (sha256(bytes) !== part.packs.sha256) throw new Error(`Pack index for ${part.layer}@${part.version} failed SHA-256 verification.`);
      for (const pack of validatePackIndex(parseJSON(bytes, `pack index ${part.layer}`), part)) {
        sources.push({ ...pack, url: networkURL(new URL(pack.url, finalUrl)).href });
      }
    } catch (error) {
      if (error.code === 'ACCESS_KEY_REQUIRED' || signal.aborted) throw error;
      note(`Packs for ${part.layer} are unavailable (${error.message}); downloading its files one by one.`);
    }
  }
  return sources;
}

/** Where a range response's body starts within the pack. */
function rangeStart(response, start, end, total) {
  if (response.status === 206) {
    const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(response.headers.get('content-range') ?? '');
    if (!match || Number(match[1]) !== start || Number(match[2]) > end - 1 || (match[3] !== '*' && Number(match[3]) !== total)) {
      throw permanent(new Error('The pack server answered with an unexpected byte range.'));
    }
    return start;
  }
  if (response.status === 200) {
    // A server without range support sends the whole pack; the bytes before `start` are skipped.
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== total) throw permanent(new Error('A pack on the server does not match its index.'));
    return 0;
  }
  throw permanent(new Error(`Unexpected pack response: HTTP ${response.status}.`));
}

/**
 * Download one byte range of a pack and split it into files. Each file is hashed while it streams
 * and handed to onFile(entry, temporary) only after its SHA-256 matches. A dropped or stalled
 * connection resumes at the exact byte with an HTTP Range request (the partial file and its hash
 * carry on); the retry budget refills whenever an attempt made progress.
 */
async function fetchSpan(pack, span, { stage, signal, access, onBytes, onFile, onRetry, retries, retryDelayMs, stallMs }) {
  let pos = span.start;
  let index = 0;
  let current = null;
  let attempt = 0;
  const open = async (entry) => {
    const temporary = path.join(stage, randomUUID());
    try { current = { handle: await fs.open(temporary, 'wx', 0o600), hash: createHash('sha256'), temporary, entry }; } catch (error) { throw local(error); }
  };
  const finish = async () => {
    const { handle, hash, temporary, entry } = current;
    current = null;
    try { await handle.close(); } catch (error) { await fs.rm(temporary, { force: true }); throw local(error); }
    if (hash.digest('hex') !== entry.sha256) {
      await fs.rm(temporary, { force: true });
      throw permanent(new Error(`A file in pack ${pack.url} failed SHA-256 verification.`));
    }
    index += 1;
    // Installing is local work (rename, copy, path checks): a failure there is never retried as network trouble.
    try { await onFile(entry, temporary); } catch (error) { error.local = true; throw error; }
  };
  // Zero-byte files complete as soon as the position reaches them.
  const settle = async () => {
    while (index < span.entries.length && span.entries[index].size === 0 && span.entries[index].offset <= pos) {
      await open(span.entries[index]);
      await finish();
    }
  };
  try {
    for (;;) {
      const before = pos;
      const guard = stallGuard(signal, stallMs);
      try {
        await settle();
        if (pos >= span.end) return;
        const { response } = await request(pack.url, guard.signal, access, { Range: `bytes=${pos}-${span.end - 1}` });
        let at = rangeStart(response, pos, span.end, pack.size);
        const body = response.body ? Readable.fromWeb(response.body) : Readable.from([]);
        try {
          for await (const chunk of body) {
            guard.touch();
            let offset = at < pos ? Math.min(chunk.length, pos - at) : 0;
            at += chunk.length;
            while (offset < chunk.length && pos < span.end) {
              const entry = span.entries[index];
              if (pos < entry.offset) {
                const skip = Math.min(entry.offset - pos, chunk.length - offset);
                offset += skip;
                pos += skip;
                onBytes(skip);
                continue;
              }
              if (!current) await open(entry);
              const take = Math.min(entry.offset + entry.size - pos, chunk.length - offset);
              const piece = chunk.subarray(offset, offset + take);
              try { await current.handle.write(piece); } catch (error) { throw local(error); }
              current.hash.update(piece);
              offset += take;
              pos += take;
              onBytes(take);
              if (pos === entry.offset + entry.size) {
                await finish();
                await settle();
              }
            }
            if (pos >= span.end) break;
          }
        } finally { body.destroy(); }
        if (pos < span.end) throw new Error(`Pack download ended early: ${pack.url}.`);
        await settle();
        return;
      } catch (error) {
        if (signal.aborted || error.permanent || error.local) throw error;
        attempt = pos - before >= 1024 * 1024 ? 1 : attempt + 1;
        if (attempt > retries) throw error;
        onRetry(error);
        await sleep(backoff(retryDelayMs, attempt - 1), signal);
      } finally { guard.done(); }
    }
  } finally {
    if (current) {
      await current.handle.close().catch(() => {});
      await fs.rm(current.temporary, { force: true });
    }
  }
}

/**
 * Download and install missing or changed files (mode 'full' hashes every file first, for Repair).
 * Every download is verified in staging before it is moved into place. Files that did not exist are
 * committed as soon as they verify, so an interrupted first install resumes where it stopped; files
 * that replace existing ones are committed only after every download has verified.
 *
 * Big downloads (a first install) take whole packs or ranges of packs when the release publishes
 * them and that is cheaper than one request per file; everything else, and anything a broken pack
 * still owed, is downloaded per file. options: packs (default true), packConcurrency, packRetries,
 * stallMs, freeSpace (a free-bytes function, for tests).
 */
export async function installRelease(root, release, onProgress = () => {}, options = {}) {
  const { mode = 'fast', concurrency = DEFAULT_CONCURRENCY, retries = 4 } = options;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const packConcurrency = options.packConcurrency ?? DEFAULT_PACK_CONCURRENCY;
  const packRetries = options.packRetries ?? 8;
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  if (!loaded.has(release)) throw new Error('Load the release from its manifest URL before downloading files.');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) throw new Error(`Concurrency must be 1-${MAX_CONCURRENCY}.`);
  if (!Number.isSafeInteger(packConcurrency) || packConcurrency < 1 || packConcurrency > MAX_CONCURRENCY) throw new Error(`Pack concurrency must be 1-${MAX_CONCURRENCY}.`);
  const { access, layerParts = [] } = loaded.get(release);
  const pending = await inspect(root, release, onProgress, mode);
  const installation = await installationRoot(root, true);
  // A folder that never finished installing (no installed.json yet) but already holds verified files
  // is a resumed first install: say so, and count from what is there instead of from zero.
  const resumed = pending.files.length > 0 && pending.keptBytes > 0 && !(await readInstalledRecord(installation.root));
  const result = { files: pending.files, bytes: pending.bytes, hashed: pending.hashed, packs: 0, keptBytes: pending.keptBytes, resumed };
  const verified = pending.verified;
  const saveState = () => writeInstallState(installation.root, release, verified);
  if (!pending.files.length) {
    await saveState();
    await writeLayerCache(installation.root, release);
    await recordInstalled(installation.root, release).catch(() => {});
    return result;
  }
  await ensureDiskSpace(installation.root, pending.bytes, options.freeSpace ?? freeDiskBytes);
  await removeStaleStages(installation.root);
  const stage = await fs.mkdtemp(path.join(installation.root, STAGE_PREFIX));
  const cache = new Map();
  await installationRoot(installation.root, false, cache);
  const deferred = [];
  let bytesDone = 0;
  let bytesTotal = pending.bytes;
  let filesDone = 0;
  let lastCheckpoint = Date.now();
  let checkpoint = Promise.resolve();
  let complete = false;
  const meter = rateMeter();
  const offset = resumed ? pending.keptBytes : 0;
  // What is downloading now, counted in aggregate: parallel packs or files never fight over the line.
  let phase = null;
  const progress = (message) => {
    meter.add(offset + bytesDone);
    const estimate = meter.estimate(offset + bytesTotal);
    const counts = { bytesDone: offset + bytesDone, bytesTotal: offset + bytesTotal, ...estimate };
    const text = message ?? (phase ? downloadMessage({ ...phase, ...counts }) : 'Installing files…');
    onProgress({ message: text, filesDone, filesTotal: pending.files.length, ...counts, resumed, keptBytes: pending.keptBytes });
  };
  async function commit(file, temporary) {
    const target = await destination(installation.root, file.path, true, cache);
    await fs.rename(temporary, target.filename);
    cache.get(path.dirname(target.filename))?.set(windowsKey(path.basename(target.filename)), path.basename(target.filename));
    const stat = await fs.lstat(target.filename);
    verified.set(file.path, { size: stat.size, mtimeMs: stat.mtimeMs, sha256: file.sha256 });
  }
  /** Install one verified download (or defer it when it replaces an existing file). */
  async function place(file, temporary) {
    if (pending.existing.has(file.path)) deferred.push({ file, temporary });
    else await commit(file, temporary);
    filesDone += 1;
    progress();
    if (Date.now() - lastCheckpoint > STATE_CHECKPOINT_MS) {
      lastCheckpoint = Date.now();
      checkpoint = checkpoint.then(saveState, saveState);
    }
  }
  const controller = new AbortController();
  // An optional caller signal (the launcher self-update's stall watchdog) cancels the whole install.
  if (options.signal?.aborted) controller.abort(options.signal.reason);
  options.signal?.addEventListener('abort', () => controller.abort(options.signal.reason), { once: true });
  async function transfer(file) {
    let temporary;
    for (let attempt = 0; ; attempt += 1) {
      temporary = path.join(stage, randomUUID());
      let received = 0;
      try {
        await download(file, temporary, (count) => {
          received += count;
          bytesDone += count;
          progress();
        }, controller.signal, access, stallMs);
        break;
      } catch (error) {
        bytesDone -= received;
        await fs.rm(temporary, { force: true });
        if (controller.signal.aborted || error.permanent || attempt >= retries) throw error;
        progress(`${downloadMessage({ ...phase, bytesDone: offset + bytesDone, bytesTotal: offset + bytesTotal })} (retrying a file)`);
        await sleep(backoff(retryDelayMs, attempt), controller.signal);
      }
    }
    await place(file, temporary);
    phase.done += 1;
  }
  let failure;
  const fail = (error) => { if (!failure) { failure = error; controller.abort(); } };
  try {
    if (resumed) progress(resumeMessage(pending.keptBytes));
    let plan = { packs: [], files: pending.files, bytes: pending.bytes };
    if (options.packs !== false && pending.files.length >= PACK_MIN_FILES && layerParts.some((part) => part.packs)) {
      if (!resumed) progress('Planning the download…');
      const sources = await loadPackSources(layerParts, access, controller.signal, progress);
      if (sources.length) plan = planPacks(pending.files, sources);
    }
    bytesTotal = plan.bytes;
    result.packs = plan.packs.length;
    const single = [...plan.files];
    if (plan.packs.length) {
      phase = { unit: 'packs', done: 0, total: plan.packs.length };
      progress();
      await pool(plan.packs.length, packConcurrency, async (number) => {
        if (controller.signal.aborted) return;
        const { source, spans } = plan.packs[number];
        const done = new Set();
        let spanIndex = 0;
        let spanReceived = 0;
        const context = {
          stage, signal: controller.signal, access, retries: packRetries, retryDelayMs, stallMs,
          onBytes: (count) => { spanReceived += count; bytesDone += count; progress(); },
          onRetry: () => progress(`${downloadMessage({ ...phase, bytesDone: offset + bytesDone, bytesTotal: offset + bytesTotal })} (connection lost, resuming)`),
          onFile: async (entry, temporary) => {
            const [first, ...copies] = entry.targets;
            // Identical files share one copy in the pack.
            for (const file of copies) {
              const copy = path.join(stage, randomUUID());
              try { await fs.copyFile(temporary, copy, constants.COPYFILE_EXCL); } catch (error) { throw local(error); }
              await place(file, copy);
            }
            await place(first, temporary);
            done.add(entry);
          },
        };
        try {
          for (; spanIndex < spans.length; spanIndex += 1) {
            spanReceived = 0;
            await fetchSpan(source, spans[spanIndex], context);
          }
        } catch (error) {
          if (controller.signal.aborted || !error.permanent || error.code === 'ACCESS_KEY_REQUIRED') { fail(error); return; }
          // A missing or damaged pack: download what it still owed one file at a time.
          const owed = spans.slice(spanIndex).flatMap((span) => span.entries).filter((entry) => !done.has(entry)).flatMap((entry) => entry.targets);
          const unread = spans.slice(spanIndex).reduce((sum, span) => sum + span.end - span.start, 0) - spanReceived;
          bytesTotal += owed.reduce((sum, file) => sum + file.size, 0) - unread;
          single.push(...owed);
          progress(`A pack could not be used (${error.message}); downloading its files one by one.`);
        } finally { phase.done += 1; }
      });
      if (failure) throw failure;
    }
    if (single.length) {
      phase = { unit: 'files', done: 0, total: single.length };
      progress();
      await pool(single.length, concurrency, async (index) => {
        if (controller.signal.aborted) return;
        try { await transfer(single[index]); } catch (error) { fail(error); }
      });
    }
    if (failure) throw failure;
    if (controller.signal.aborted) throw controller.signal.reason ?? new Error('Install cancelled.');
    // No existing file is replaced until every download has passed verification.
    for (const { file, temporary } of deferred) {
      await commit(file, temporary);
      progress('Installing updated files…');
    }
    await checkpoint.catch(() => {});
    await saveState();
    await writeLayerCache(installation.root, release);
    await recordInstalled(installation.root, release).catch(() => {});
    complete = true;
    return result;
  } finally {
    await checkpoint.catch(() => {});
    // Record files committed before a failure so a resumed install need not hash them again.
    if (!complete) await saveState().catch(() => {});
    await fs.rm(stage, { recursive: true, force: true });
  }
}

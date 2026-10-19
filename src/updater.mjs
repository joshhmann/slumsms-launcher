import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const origins = new WeakMap();
const validated = new WeakSet();
const windowsKey = (name) => name.normalize('NFC').toUpperCase();

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

function relativeURL(value, label) {
  if (typeof value !== 'string' || !value || /^[a-z][a-z\d+.-]*:/iu.test(value)
    || value.startsWith('/') || /[\\#\x00-\x20\x7f]/u.test(value)) {
    throw new Error(`${label} must be an encoded relative URL without a fragment.`);
  }
  const resolved = new URL(value, 'https://manifest.invalid/');
  if (resolved.origin !== 'https://manifest.invalid') throw new Error(`${label} must be relative.`);
  return value;
}

/** Validate and copy the public manifest; the result is deeply frozen. */
export function validateManifest(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1) {
    throw new Error('Unsupported manifest: schemaVersion must be 1.');
  }
  if (typeof value.version !== 'string' || !value.version.trim()) throw new Error('Manifest version is required.');
  if (!value.launch || typeof value.launch !== 'object' || !Array.isArray(value.launch.args)
    || value.launch.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('Manifest launch.args must be an array of strings without NUL characters.');
  }
  const executable = relativePath(value.launch.executable, 'Launch executable');
  if (!Array.isArray(value.files)) throw new Error('Manifest files must be an array.');
  const tree = new Map();
  let total = 0;
  const files = value.files.map((file, index) => {
    if (!file || typeof file !== 'object') throw new Error(`Invalid manifest file ${index + 1}.`);
    const name = relativePath(file.path, `File ${index + 1}`);
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error(`Invalid size for ${name}.`);
    total += file.size;
    if (!Number.isSafeInteger(total)) throw new Error('Manifest total size exceeds the supported integer range.');
    if (typeof file.sha256 !== 'string' || !/^[a-f\d]{64}$/iu.test(file.sha256)) {
      throw new Error(`Invalid SHA-256 for ${name}.`);
    }
    let children = tree;
    const parts = name.split('/');
    for (let depth = 0; depth < parts.length; depth += 1) {
      const part = parts[depth];
      const key = windowsKey(part);
      const last = depth === parts.length - 1;
      const previous = children.get(key);
      if (previous && (previous.name !== part || previous.file || last)) {
        throw new Error(`Windows path collision in manifest: ${name}.`);
      }
      const node = previous ?? { name: part, file: last, children: new Map() };
      children.set(key, node);
      children = node.children;
    }
    return Object.freeze({ path: name, size: file.size, sha256: file.sha256.toLowerCase(), url: relativeURL(file.url, `URL for ${name}`) });
  });
  if (!files.some((file) => file.path === executable)) throw new Error('Launch executable must be listed with identical spelling in manifest files.');
  const manifest = Object.freeze({
    schemaVersion: 1,
    version: value.version,
    launch: Object.freeze({ executable, args: Object.freeze([...value.launch.args]) }),
    files: Object.freeze(files),
  });
  validated.add(manifest);
  return manifest;
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

async function request(input, signal) {
  let url = networkURL(input);
  const secure = url.protocol === 'https:';
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (secure && url.protocol !== 'https:') throw new Error('An HTTPS release cannot redirect to HTTP.');
    const response = await fetch(url, { redirect: 'manual', signal, headers: { 'Accept-Encoding': 'identity' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirects === 5) throw new Error('Release request has an invalid or excessive redirect chain.');
      url = networkURL(new URL(location, url));
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Release request failed: HTTP ${response.status} ${response.statusText}.`);
    }
    return response;
  }
  throw new Error('Release request exceeded the redirect limit.');
}

export async function loadRelease(feedUrl) {
  const url = networkURL(feedUrl);
  const response = await request(url);
  let value;
  try { value = await response.json(); } catch (error) { throw new Error(`Cannot read release manifest: ${error.message}`, { cause: error }); }
  const manifest = validateManifest(value);
  origins.set(manifest, response.url);
  return manifest;
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

async function directoryChild(parent, name, create, cache) {
  await checkSpelling(parent, name, cache);
  const target = path.join(parent, name);
  let stat = await statOrMissing(target);
  if (!stat && create) {
    await fs.mkdir(target);
    cache.get(parent)?.set(windowsKey(name), name);
    stat = await fs.lstat(target);
  }
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Not a real directory (symlinks are forbidden): ${target}`);
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
    return hash.digest('hex');
  } finally { await handle.close(); }
}

function knownManifest(release) {
  return validated.has(release) ? release : validateManifest(release);
}

export async function inspectRelease(root, release, onProgress = () => {}) {
  const manifest = knownManifest(release);
  const cache = new Map();
  const installation = await installationRoot(root, false, cache);
  const files = [];
  let bytes = 0;
  let bytesDone = 0;
  let filesDone = 0;
  const bytesTotal = manifest.files.reduce((sum, file) => sum + file.size, 0);
  const progress = (message) => onProgress({ message, filesDone, filesTotal: manifest.files.length, bytesDone, bytesTotal });
  progress('Checking installed files…');
  for (const file of manifest.files) {
    const current = installation.exists ? await destination(installation.root, file.path, false, cache) : null;
    let matches = false;
    if (current?.stat?.size === file.size) {
      const checksum = await digest(current.filename, (count) => {
        bytesDone += count;
        progress(`Checking ${file.path}`);
      });
      matches = checksum === file.sha256;
    }
    if (!matches) { files.push(file); bytes += file.size; }
    filesDone += 1;
    progress(`Checked ${file.path}`);
  }
  return { files, bytes };
}

async function download(file, url, target, onBytes, signal) {
  const response = await request(url, signal);
  const hash = createHash('sha256');
  let size = 0;
  const verify = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > file.size) return callback(new Error(`Download exceeds declared size: ${file.path}.`));
      hash.update(chunk);
      try { onBytes(chunk.length); } catch (error) { callback(error); return; }
      callback(null, chunk);
    },
  });
  const body = response.body ? Readable.fromWeb(response.body) : Readable.from([]);
  await pipeline(body, verify, createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal });
  if (size !== file.size || hash.digest('hex') !== file.sha256) throw new Error(`Downloaded file failed size/SHA-256 verification: ${file.path}.`);
}

export async function installRelease(root, release, onProgress = () => {}) {
  const manifest = knownManifest(release);
  const pending = await inspectRelease(root, manifest, onProgress);
  if (!pending.files.length) return pending;
  const base = origins.get(release);
  if (!base) throw new Error('Load the release from its manifest URL before downloading files.');
  const installation = await installationRoot(root, true);
  const stage = await fs.mkdtemp(path.join(installation.root, '.mapleroot-stage-'));
  const staged = [];
  let bytesDone = 0;
  let filesDone = 0;
  const progress = (message) => onProgress({ message, filesDone, filesTotal: pending.files.length, bytesDone, bytesTotal: pending.bytes });
  try {
    progress('Downloading verified update files…');
    const controller = new AbortController();
    let next = 0;
    let failure;
    async function transferFiles() {
      while (!controller.signal.aborted) {
        const index = next++;
        if (index >= pending.files.length) return;
        const file = pending.files[index];
        const temporary = path.join(stage, randomUUID());
        try {
          await download(file, new URL(file.url, base), temporary, (count) => {
            bytesDone += count;
            progress(`Downloading ${file.path}`);
          }, controller.signal);
          staged[index] = { file, temporary };
          filesDone += 1;
          progress(`Verified ${file.path}`);
        } catch (error) {
          if (!failure) { failure = error; controller.abort(); }
          return;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, pending.files.length) }, transferFiles));
    if (failure) throw failure;
    // No destination is replaced until every download has passed verification.
    const cache = new Map();
    await installationRoot(installation.root, false, cache);
    for (const { file, temporary } of staged) {
      const target = await destination(installation.root, file.path, true, cache);
      await fs.rename(temporary, target.filename);
      cache.get(path.dirname(target.filename))?.set(windowsKey(path.basename(target.filename)), path.basename(target.filename));
      progress(`Installed ${file.path}`);
    }
    return pending;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

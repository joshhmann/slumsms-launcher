import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { validateManifest, validateLayerManifest, mergeLayers, layerName, safeComponent } from '../src/updater.mjs';

const encodeSegment = (segment) => encodeURIComponent(segment).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
export const DEFAULT_EXECUTABLE = 'SlumsMS.exe';
export const DEFAULT_PLAYER_OWNED = Object.freeze(['config.ini']);
const LOCK = '.mapleroot-publish.lock';
const encodePath = (filename) => filename.split('/').map(encodeSegment).join('/');

async function statOrMissing(filename) {
  try { return await fs.lstat(filename); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function directoryWithoutSymlinks(input, create = false) {
  const absolute = path.resolve(input);
  const anchor = path.parse(absolute).root;
  let current = anchor;
  for (const component of absolute.slice(anchor.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat = await statOrMissing(current);
    if (!stat && create) {
      try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      stat = await fs.lstat(current);
    }
    if (!stat) return { absolute, exists: false };
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Publisher requires real directories, not symlinks: ${current}`);
  }
  return { absolute, exists: true };
}

async function collectFiles(directory, prefix = '', files = []) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const stat = await fs.lstat(filename);
    if (stat.isSymbolicLink()) throw new Error(`Source symlinks are forbidden: ${relative}`);
    if (stat.isDirectory()) await collectFiles(filename, relative, files);
    else if (stat.isFile()) files.push({ path: relative, size: stat.size, stat });
    else throw new Error(`Source contains a non-regular file: ${relative}`);
  }
  return files;
}

// Windows path-based lstat reports dev 0 while handle stat reports the volume serial; compare dev only when both are known.
function unchanged(before, after) {
  const sameDevice = before.dev === after.dev || before.dev === 0 || after.dev === 0;
  return sameDevice && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function copyAndHash(source, target, expected) {
  const handle = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || !unchanged(expected, before)) throw new Error(`Source changed while preparing release: ${source}`);
    const hash = createHash('sha256');
    let size = 0;
    const hashing = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > expected.size) return callback(new Error(`Source grew while publishing: ${source}`));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(handle.createReadStream({ autoClose: false }), hashing, createWriteStream(target, { flags: 'wx' }));
    if (size !== expected.size || !unchanged(before, await handle.stat())) throw new Error(`Source changed while publishing: ${source}`);
    return hash.digest('hex');
  } finally { await handle.close(); }
}

/** Publish an explicitly approved staging tree. Existing version directories are never reused. */
export async function publishRelease({ source, output, version, executable = DEFAULT_EXECUTABLE, args = [], news } = {}) {
  if (typeof source !== 'string' || !source.trim() || typeof output !== 'string' || !output.trim()) {
    throw new Error('Both source and output directories are required.');
  }
  if (typeof version !== 'string' || !version || version.includes('/') || version.includes('\\')
    || version.normalize('NFC').toUpperCase() === 'MANIFEST.JSON') {
    throw new Error('Version must be a single safe directory name other than manifest.json.');
  }
  const sourceInfo = await directoryWithoutSymlinks(source);
  if (!sourceInfo.exists) throw new Error(`Source directory does not exist: ${sourceInfo.absolute}`);
  const outputInfo = await directoryWithoutSymlinks(output);
  const approvedSource = sourceInfo.absolute;
  const destination = outputInfo.absolute;
  const relative = path.relative(approvedSource, destination);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Publisher output must not equal or be nested inside the approved source directory.');
  }
  // Validate the version as a Windows component as well as validating source filenames.
  validateManifest({ schemaVersion: 1, version, launch: { executable: version, args: [] }, files: [{ path: version, size: 0, sha256: '0'.repeat(64), url: encodeSegment(version) }] });
  const sourceFiles = await collectFiles(approvedSource);
  const publicFiles = sourceFiles.map((file) => ({
    path: file.path,
    size: file.size,
    sha256: '0'.repeat(64),
    url: `${encodeSegment(version)}/${encodePath(file.path)}`,
  }));
  validateManifest({ schemaVersion: 1, version, launch: { executable, args }, files: publicFiles, news });
  await directoryWithoutSymlinks(destination, true);
  const versionDirectory = path.join(destination, version);
  const lockDirectory = path.join(destination, '.mapleroot-publish.lock');
  try { await fs.mkdir(lockDirectory); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Publication is locked. Stop any other publisher, or remove a stale .mapleroot-publish.lock directory after confirming none is running.');
    throw error;
  }
  let temporary;
  const manifestTemporary = path.join(destination, `.mapleroot-manifest-${randomUUID()}.tmp`);
  let reserved = false;
  let published = false;
  try {
    // The output lock serializes alias checks and publication across publishers.
    const versionKey = version.normalize('NFC').toUpperCase();
    for (const entry of await fs.readdir(destination)) {
      if (entry.normalize('NFC').toUpperCase() === versionKey) throw new Error(`Release version already exists and is immutable: ${version}`);
      if (entry.normalize('NFC').toUpperCase() === 'MANIFEST.JSON' && entry !== 'manifest.json') {
        throw new Error(`Output contains a Windows alias for manifest.json: ${entry}`);
      }
    }
    const manifestPath = path.join(destination, 'manifest.json');
    const currentManifest = await statOrMissing(manifestPath);
    if (currentManifest && (!currentManifest.isFile() || currentManifest.isSymbolicLink())) throw new Error('Output manifest.json must be a regular file, not a symlink.');
    temporary = await fs.mkdtemp(path.join(destination, '.mapleroot-publish-'));
    for (let index = 0; index < sourceFiles.length; index += 1) {
      const file = sourceFiles[index];
      const target = path.join(temporary, ...file.path.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      // Recheck source parents before opening; never follow a source symlink.
      await directoryWithoutSymlinks(path.dirname(path.join(approvedSource, ...file.path.split('/'))));
      publicFiles[index].sha256 = await copyAndHash(path.join(approvedSource, ...file.path.split('/')), target, file.stat);
    }
    const manifest = validateManifest({ schemaVersion: 1, version, launch: { executable, args }, files: publicFiles, news });
    await fs.writeFile(manifestTemporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    // Exclusive mkdir reserves the immutable version name. Moving its already complete
    // children is portable to Windows, where rename cannot replace an empty directory.
    await fs.mkdir(versionDirectory);
    reserved = true;
    for (const entry of await fs.readdir(temporary)) {
      await fs.rename(path.join(temporary, entry), path.join(versionDirectory, entry));
    }
    const latest = await statOrMissing(manifestPath);
    if (latest && (!latest.isFile() || latest.isSymbolicLink())) throw new Error('Output manifest.json changed to a non-regular file.');
    await fs.rename(manifestTemporary, manifestPath);
    published = true;
    return manifest;
  } finally {
    try {
      if (temporary) await fs.rm(temporary, { recursive: true, force: true });
      await fs.rm(manifestTemporary, { force: true });
      if (reserved && !published) await fs.rm(versionDirectory, { recursive: true, force: true });
    } finally {
      await fs.rmdir(lockDirectory);
    }
  }
}


const digestBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function approvedDirectories(source, output) {
  if (typeof source !== 'string' || !source.trim() || typeof output !== 'string' || !output.trim()) {
    throw new Error('Both source and output directories are required.');
  }
  const sourceInfo = await directoryWithoutSymlinks(source);
  if (!sourceInfo.exists) throw new Error(`Source directory does not exist: ${sourceInfo.absolute}`);
  const outputInfo = await directoryWithoutSymlinks(output);
  const relative = path.relative(sourceInfo.absolute, outputInfo.absolute);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Publisher output must not equal or be nested inside the approved source directory.');
  }
  return { approvedSource: sourceInfo.absolute, destination: outputInfo.absolute };
}

/** Serialize publishers on one output directory. */
async function withLock(destination, action) {
  await directoryWithoutSymlinks(destination, true);
  const lockDirectory = path.join(destination, LOCK);
  try { await fs.mkdir(lockDirectory); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Publication is locked. Stop any other publisher, or remove a stale ${LOCK} directory after confirming none is running.`);
    throw error;
  }
  try { return await action(); } finally { await fs.rmdir(lockDirectory); }
}

async function assertNoAlias(directory, name, label) {
  const key = name.normalize('NFC').toUpperCase();
  for (const entry of await fs.readdir(directory)) {
    if (entry.normalize('NFC').toUpperCase() === key) throw new Error(`${label} already exists and is immutable: ${name}`);
  }
}

const layerManifestUrl = (name, version) => `layers/${encodeSegment(name)}/${encodeSegment(version)}/manifest.json`;

/**
 * Publish one layer from an approved source tree into
 * OUTPUT/layers/NAME/VERSION/{files/..., manifest.json}. The version folder is immutable and its
 * manifest.json is written last. The top-level manifest is not changed.
 */
export async function publishLayer({ source, output, layer, version } = {}) {
  layerName(layer, 'Layer name');
  safeComponent(version, 'Layer version');
  const { approvedSource, destination } = await approvedDirectories(source, output);
  const sourceFiles = await collectFiles(approvedSource);
  const files = sourceFiles.map((file) => ({ path: file.path, size: file.size, sha256: '0'.repeat(64), url: `files/${encodePath(file.path)}` }));
  validateLayerManifest({ schemaVersion: 2, layer, version, files });
  return withLock(destination, async () => {
    const layerDirectory = path.join(destination, 'layers', layer);
    await directoryWithoutSymlinks(layerDirectory, true);
    await assertNoAlias(layerDirectory, version, `Layer ${layer} version`);
    const versionDirectory = path.join(layerDirectory, version);
    const temporary = await fs.mkdtemp(path.join(layerDirectory, '.mapleroot-publish-'));
    let reserved = false;
    let published = false;
    try {
      await fs.mkdir(path.join(temporary, 'files'));
      for (let index = 0; index < sourceFiles.length; index += 1) {
        const file = sourceFiles[index];
        const target = path.join(temporary, 'files', ...file.path.split('/'));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await directoryWithoutSymlinks(path.dirname(path.join(approvedSource, ...file.path.split('/'))));
        files[index].sha256 = await copyAndHash(path.join(approvedSource, ...file.path.split('/')), target, file.stat);
      }
      const manifest = validateLayerManifest({ schemaVersion: 2, layer, version, files });
      const body = `${JSON.stringify(manifest, null, 2)}\n`;
      await fs.writeFile(path.join(temporary, 'manifest.json'), body, { flag: 'wx' });
      await fs.mkdir(versionDirectory);
      reserved = true;
      await fs.rename(path.join(temporary, 'files'), path.join(versionDirectory, 'files'));
      await fs.rename(path.join(temporary, 'manifest.json'), path.join(versionDirectory, 'manifest.json'));
      published = true;
      return { manifest, sha256: digestBytes(body), manifestUrl: layerManifestUrl(layer, version) };
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
      if (reserved && !published) await fs.rm(versionDirectory, { recursive: true, force: true });
    }
  });
}

/**
 * Write OUTPUT/manifest.json (schemaVersion 2) referencing already published layer versions, in
 * override order (later layers win). Nothing else is changed; publish layers first.
 */
export async function publishLayeredRelease({ output, version, executable = DEFAULT_EXECUTABLE, args = [], news, playerOwned = DEFAULT_PLAYER_OWNED, layers } = {}) {
  if (typeof output !== 'string' || !output.trim()) throw new Error('An output directory is required.');
  if (!Array.isArray(layers) || !layers.length) throw new Error('Name at least one published layer (NAME@VERSION).');
  const destination = path.resolve(output);
  return withLock(destination, async () => {
    const references = [];
    const parts = [];
    for (const { name, version: layerVersion } of layers) {
      layerName(name, 'Layer name');
      safeComponent(layerVersion, `Layer ${name} version`);
      const versionDirectory = path.join(destination, 'layers', name, layerVersion);
      if (!(await directoryWithoutSymlinks(versionDirectory)).exists) throw new Error(`Layer ${name}@${layerVersion} has not been published to ${destination}.`);
      const manifestFile = path.join(versionDirectory, 'manifest.json');
      const stat = await statOrMissing(manifestFile);
      if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`Layer ${name}@${layerVersion} has no regular manifest.json (incomplete publication?).`);
      const body = await fs.readFile(manifestFile);
      const manifest = validateLayerManifest(JSON.parse(body.toString('utf8')), { name, version: layerVersion });
      references.push({ name, version: layerVersion, manifestUrl: layerManifestUrl(name, layerVersion), sha256: digestBytes(body) });
      parts.push({ name, files: manifest.files });
    }
    const merged = mergeLayers(parts);
    const top = validateManifest({ schemaVersion: 2, version, launch: { executable, args }, news, playerOwned, layers: references });
    if (!merged.some((file) => file.path === top.launch.executable)) throw new Error(`Launch executable ${top.launch.executable} is not in any listed layer.`);
    for (const entry of await fs.readdir(destination)) {
      if (entry.normalize('NFC').toUpperCase() === 'MANIFEST.JSON' && entry !== 'manifest.json') throw new Error(`Output contains a Windows alias for manifest.json: ${entry}`);
    }
    const manifestPath = path.join(destination, 'manifest.json');
    const current = await statOrMissing(manifestPath);
    if (current && (!current.isFile() || current.isSymbolicLink())) throw new Error('Output manifest.json must be a regular file, not a symlink.');
    if (current) {
      let previous;
      try { previous = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch { previous = null; }
      if (previous?.version === version) throw new Error(`Release version ${version} is already the published manifest; use a new release version.`);
    }
    const temporary = path.join(destination, `.mapleroot-manifest-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, `${JSON.stringify(top, null, 2)}\n`, { flag: 'wx' });
      await fs.rename(temporary, manifestPath);
    } finally { await fs.rm(temporary, { force: true }); }
    return top;
  });
}

const usage = `Usage:
  Publish a layer (immutable OUT/layers/NAME/VERSION/):
    node tools/publish.mjs --layer NAME --source DIR --out DIR --version VERSION
  Point the release at published layers (writes OUT/manifest.json last; later layers override earlier):
    node tools/publish.mjs --release VERSION --out DIR --use base@BASE_VERSION --use client@CLIENT_VERSION
      [--exe SlumsMS.exe] [--arg VALUE ...] [--news FILE.json] [--player-owned PATH ...] [--no-player-owned]
  Legacy single-folder release (schemaVersion 1):
    node tools/publish.mjs --source DIR --out DIR --version VERSION [--exe SlumsMS.exe] [--arg VALUE ...] [--news FILE.json]`;

async function cli(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { console.log(usage); return; }
  const options = { args: [], use: [], playerOwned: [] };
  const names = new Map([['--source', 'source'], ['--out', 'output'], ['--version', 'version'], ['--exe', 'executable'], ['--news', 'news'],
    ['--layer', 'layer'], ['--release', 'release']]);
  const repeated = new Map([['--arg', 'args'], ['--use', 'use'], ['--player-owned', 'playerOwned']]);
  let noPlayerOwned = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--no-player-owned') { noPlayerOwned = true; continue; }
    const key = names.get(flag) ?? repeated.get(flag);
    if (!key) throw new Error(`Unknown option: ${flag}\n${usage}`);
    if (index + 1 >= argv.length) throw new Error(`Missing value for ${flag}\n${usage}`);
    const value = argv[++index];
    if (repeated.has(flag)) options[key].push(value);
    else {
      if (Object.hasOwn(options, key)) throw new Error(`Duplicate option: ${flag}`);
      options[key] = value;
    }
  }
  const require = (...keys) => {
    for (const key of keys) if (!Object.hasOwn(options, key)) throw new Error(`Missing required option: ${key}\n${usage}`);
  };
  if (Object.hasOwn(options, 'news')) {
    try { options.news = JSON.parse(await fs.readFile(options.news, 'utf8')); } catch (error) {
      throw new Error(`Cannot read news file ${options.news}: ${error.message}`);
    }
  }
  if (Object.hasOwn(options, 'layer')) {
    require('source', 'output', 'version');
    if (Object.hasOwn(options, 'release') || options.use.length || options.args.length || options.executable || options.news || options.playerOwned.length) {
      throw new Error('--layer publishes files only; run --release separately to update manifest.json.');
    }
    const result = await publishLayer({ source: options.source, output: options.output, layer: options.layer, version: options.version });
    console.log(`Published layer ${options.layer}@${options.version}: ${result.manifest.files.length} files to ${path.resolve(options.output, ...result.manifestUrl.split('/').slice(0, -1))}`);
    console.log(`Layer manifest SHA-256: ${result.sha256}`);
    return;
  }
  if (Object.hasOwn(options, 'release')) {
    require('output');
    if (Object.hasOwn(options, 'source') || Object.hasOwn(options, 'version')) throw new Error('--release takes --use NAME@VERSION, not --source/--version.');
    const layers = options.use.map((value) => {
      const at = value.indexOf('@');
      if (at < 1 || at === value.length - 1) throw new Error(`--use expects NAME@VERSION, got ${value}`);
      return { name: value.slice(0, at), version: value.slice(at + 1) };
    });
    const playerOwned = noPlayerOwned ? [] : options.playerOwned.length ? options.playerOwned : DEFAULT_PLAYER_OWNED;
    const manifest = await publishLayeredRelease({ output: options.output, version: options.release, executable: options.executable, args: options.args,
      news: options.news, playerOwned, layers });
    console.log(`Published release ${manifest.version}: ${manifest.layers.map((layer) => `${layer.name}@${layer.version}`).join(' + ')} -> ${path.join(path.resolve(options.output), 'manifest.json')}`);
    return;
  }
  require('source', 'output', 'version');
  if (options.use.length || options.playerOwned.length || noPlayerOwned) throw new Error('--use/--player-owned require --release.');
  const manifest = await publishRelease(options);
  console.log(`Published ${manifest.version}: ${manifest.files.length} files to ${path.resolve(options.output)}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  cli(process.argv.slice(2)).catch((error) => { console.error(`Publish failed: ${error.message}`); process.exitCode = 1; });
}

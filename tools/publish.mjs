import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { validateManifest } from '../src/updater.mjs';

const encodeSegment = (segment) => encodeURIComponent(segment).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
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
export async function publishRelease({ source, output, version, executable, args = [] } = {}) {
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
  validateManifest({ schemaVersion: 1, version, launch: { executable, args }, files: publicFiles });
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
    const manifest = validateManifest({ schemaVersion: 1, version, launch: { executable, args }, files: publicFiles });
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

const usage = 'Usage: node tools/publish.mjs --source DIR --out DIR --version VERSION --exe RELATIVE_PATH [--arg VALUE ...]';

async function cli(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { console.log(usage); return; }
  const options = { args: [] };
  const names = new Map([['--source', 'source'], ['--out', 'output'], ['--version', 'version'], ['--exe', 'executable']]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = names.get(flag);
    if (flag !== '--arg' && !key) throw new Error(`Unknown option: ${flag}\n${usage}`);
    if (index + 1 >= argv.length) throw new Error(`Missing value for ${flag}\n${usage}`);
    const value = argv[++index];
    if (flag === '--arg') options.args.push(value);
    else {
      if (Object.hasOwn(options, key)) throw new Error(`Duplicate option: ${flag}`);
      options[key] = value;
    }
  }
  for (const key of ['source', 'output', 'version', 'executable']) {
    if (!Object.hasOwn(options, key)) throw new Error(`Missing required option: ${key}\n${usage}`);
  }
  const manifest = await publishRelease(options);
  console.log(`Published ${manifest.version}: ${manifest.files.length} files to ${path.resolve(options.output)}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  cli(process.argv.slice(2)).catch((error) => { console.error(`Publish failed: ${error.message}`); process.exitCode = 1; });
}

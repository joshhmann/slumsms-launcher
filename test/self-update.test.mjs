import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { publishLauncher, readAsarFile } from '../tools/publish.mjs';
import { loadLauncherChannel, validateLauncherChannel, ACCESS_KEY_MESSAGE } from '../src/updater.mjs';
import { compareVersions, launcherUpdateDecision, prepareLauncherUpdate, startLauncherSwap, cleanupLauncherUpdates, UPDATE_DIRECTORY } from '../src/self-update.mjs';

const KEY = 'friends-only:key';
const EXE = 'SlumsMS Launcher.exe';
const PLATFORM = 'linux-x64';
const basic = (key) => `Basic ${Buffer.from(`slums:${key}`).toString('base64')}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A minimal Electron app.asar: pickled JSON header, then the packed files. */
function asar(files) {
  const tree = { files: {} };
  const bodies = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const bytes = Buffer.from(text);
    let node = tree;
    const parts = name.split('/');
    for (const part of parts.slice(0, -1)) node = (node.files[part] ??= { files: {} });
    node.files[parts.at(-1)] = { size: bytes.length, offset: String(offset) };
    bodies.push(bytes);
    offset += bytes.length;
  }
  const json = Buffer.from(JSON.stringify(tree));
  const padded = Buffer.alloc(4 + json.length + ((4 - (json.length % 4)) % 4));
  padded.writeUInt32LE(json.length, 0);
  json.copy(padded, 4);
  const header = Buffer.alloc(4 + padded.length);
  header.writeUInt32LE(padded.length, 0);
  padded.copy(header, 4);
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(header.length, 4);
  return Buffer.concat([prefix, header, ...bodies]);
}

// A stand-in launcher executable: records its arguments, "crashes" if its app.asar says so, and
// reports a healthy first start after an update the way main.mjs does once its window loads.
const LAUNCHER_SCRIPT = `#!/bin/sh
cd "$(dirname "$0")"
echo "$@" >> runs.log
if grep -q CRASH resources/app.asar; then exit 1; fi
for a in "$@"; do case "$a" in --self-updated=*) touch "${UPDATE_DIRECTORY}/healthy-\${a#--self-updated=}";; esac; done
`;

async function build(directory, version, { key = KEY, extra = {}, asarExtra = {} } = {}) {
  await mkdir(path.join(directory, 'resources'), { recursive: true });
  await writeFile(path.join(directory, EXE), LAUNCHER_SCRIPT);
  await chmod(path.join(directory, EXE), 0o755);
  await writeFile(path.join(directory, 'ffmpeg.dll'), 'runtime dll, identical in every build');
  await writeFile(path.join(directory, 'resources', 'app.asar'), asar({
    'package.json': JSON.stringify({ name: 'mapleroot-launcher', version }),
    'src/launcher.config.json': JSON.stringify({ feedUrl: 'https://slumspatch.asslorde.com/manifest.json', accessKey: key }),
    'src/main.mjs': `// launcher ${version}`,
    ...asarExtra,
  }));
  for (const [name, text] of Object.entries(extra)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), text);
  }
  return directory;
}

/** A Basic-auth patch server over OUTPUT, plus an installed 1.3.0 launcher folder. */
async function fixture(t, { requireKey = KEY, route = () => null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'slumsms-self-update-'));
  const output = path.join(root, 'public');
  const installed = await build(path.join(root, 'installed'), '1.3.0');
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'manifest.json'), '{"game":"untouched"}\n');
  const requests = [];
  const server = createServer(async (request, response) => {
    const relative = decodeURIComponent(new URL(request.url, 'http://x').pathname).slice(1);
    requests.push({ path: relative, authorization: request.headers.authorization });
    if (requireKey && request.headers.authorization !== basic(requireKey)) { response.writeHead(401); response.end(); return; }
    if (route(relative, response)) return;
    try {
      const bytes = await readFile(path.join(output, relative));
      response.writeHead(200, { 'Content-Length': bytes.length });
      response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const publish = async (version, options = {}) => publishLauncher({ source: await build(path.join(root, `build-${version}`), version, options), output, platform: PLATFORM });
  return { root, output, installed, requests, publish, url: `http://127.0.0.1:${server.address().port}/manifest.json` };
}

async function until(check, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error('Timed out waiting for the swap helper.');
}

const runs = async (directory) => (await readFile(path.join(directory, 'runs.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);

/** A process standing in for the running old launcher; the helper waits for it to exit. */
function oldLauncher(ms = 400) {
  return spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { stdio: 'ignore' });
}

test('versions compare numerically; only a strictly newer build for this platform is an update', () => {
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.ok(compareVersions('1.3.0', '1.3.1') < 0);
  assert.equal(compareVersions('1.3.0', '1.3.0'), 0);
  assert.throws(() => compareVersions('1.3', '1.3.0'), /MAJOR.MINOR.PATCH/);
  assert.throws(() => compareVersions('v1.3.0', '1.3.0'), /MAJOR.MINOR.PATCH/);
  const channel = { version: '1.3.1', platform: 'win32-x64' };
  const decide = (extra) => launcherUpdateDecision({ channel, currentVersion: '1.3.0', platform: 'win32-x64', ...extra });
  assert.equal(decide({}), 'update');
  assert.match(decide({ currentVersion: '1.3.1' }), /already/);
  assert.match(decide({ currentVersion: '1.4.0' }), /never downgrading/);
  assert.match(decide({ platform: 'linux-x64' }), /channel is for win32-x64/);
  assert.match(decide({ skipVersion: '1.3.1' }), /failed to apply/);
  assert.match(launcherUpdateDecision({ channel: null, currentVersion: '1.3.0', platform: 'win32-x64' }), /no launcher channel/);
});

test('launcher.json is validated like game manifests', () => {
  const good = { schemaVersion: 1, version: '1.3.1', platform: 'win32-x64', executable: EXE, manifestUrl: 'launcher/win32-x64/1.3.1/manifest.json', sha256: 'a'.repeat(64) };
  assert.equal(validateLauncherChannel(good).version, '1.3.1');
  for (const [field, value] of [['schemaVersion', 2], ['version', '1.3'], ['platform', 'beos-x64'], ['executable', '../evil.exe'], ['executable', 'C:/evil.exe'],
    ['manifestUrl', 'https://elsewhere.example/manifest.json'], ['manifestUrl', '//elsewhere.example/m.json'], ['sha256', 'nope']]) {
    assert.throws(() => validateLauncherChannel({ ...good, [field]: value }), Error, `${field}=${value}`);
  }
});

test('publishing a launcher build writes its own channel, takes the version from the build and never downgrades', async (t) => {
  const f = await fixture(t);
  const source = await build(path.join(f.root, 'b'), '1.3.1');
  assert.equal(JSON.parse((await readAsarFile(path.join(source, 'resources', 'app.asar'), 'package.json')).toString()).version, '1.3.1');
  await assert.rejects(publishLauncher({ source, output: f.output, platform: PLATFORM, version: '1.3.2' }), /does not match the build's own version 1.3.1/);
  const keyless = await build(path.join(f.root, 'keyless'), '1.3.1', { key: '' });
  await assert.rejects(publishLauncher({ source: keyless, output: f.output, platform: PLATFORM }), /no built-in access key/);
  const withConfig = await build(path.join(f.root, 'with-config'), '1.3.1', { extra: { 'launcher.config.json': '{}' } });
  await assert.rejects(publishLauncher({ source: withConfig, output: f.output, platform: PLATFORM }), /player's override file/);
  const result = await publishLauncher({ source, output: f.output, platform: PLATFORM });
  assert.equal(result.files, 3);
  const channel = JSON.parse(await readFile(path.join(f.output, 'launcher.json'), 'utf8'));
  assert.deepEqual(Object.keys(channel), ['schemaVersion', 'version', 'platform', 'executable', 'manifestUrl', 'sha256']);
  assert.equal(channel.manifestUrl, 'launcher/linux-x64/1.3.1/manifest.json');
  assert.ok((await stat(path.join(f.output, 'launcher', 'linux-x64', '1.3.1', 'files', 'resources', 'app.asar'))).isFile());
  assert.equal(await readFile(path.join(f.output, 'manifest.json'), 'utf8'), '{"game":"untouched"}\n');
  await assert.rejects(publishLauncher({ source, output: f.output, platform: PLATFORM }), /not newer/);
  await assert.rejects(publishLauncher({ source: await build(path.join(f.root, 'old'), '1.3.0'), output: f.output, platform: PLATFORM }), /not newer/);
  await publishLauncher({ source: keyless, output: path.join(f.root, 'open-server'), platform: PLATFORM, allowNoAccessKey: true });
});

test('the channel is fetched beside the game manifest with the access key; no launcher.json means no update', async (t) => {
  const f = await fixture(t);
  assert.equal(await loadLauncherChannel(f.url, { accessKey: KEY }), null);
  await f.publish('1.3.1');
  f.requests.length = 0;
  const channel = await loadLauncherChannel(f.url, { accessKey: KEY });
  assert.equal(channel.version, '1.3.1');
  assert.equal(channel.release.files.length, 3);
  assert.deepEqual(f.requests.map((entry) => entry.path), ['launcher.json', 'launcher/linux-x64/1.3.1/manifest.json']);
  assert.ok(f.requests.every((entry) => entry.authorization === basic(KEY)));
  await assert.rejects(loadLauncherChannel(f.url, { accessKey: 'wrong' }), (error) => error.message === ACCESS_KEY_MESSAGE);
  // A launcher.json whose pinned hash does not match the file manifest is refused.
  const file = path.join(f.output, 'launcher.json');
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), sha256: 'b'.repeat(64) }));
  await assert.rejects(loadLauncherChannel(f.url, { accessKey: KEY }), /failed SHA-256 verification/);
});

test('staging downloads only changed files, verified, into a side folder; the running launcher is untouched', async (t) => {
  const f = await fixture(t);
  await f.publish('1.3.1', { extra: { 'locales/en-US.pak': 'new locale' } });
  const before = await readFile(path.join(f.installed, 'resources', 'app.asar'));
  const channel = await loadLauncherChannel(f.url, { accessKey: KEY });
  f.requests.length = 0;
  const { stage, changed } = await prepareLauncherUpdate({ launcherDir: f.installed, channel });
  assert.deepEqual(changed.sort(), ['locales/en-US.pak', 'resources/app.asar']);
  assert.deepEqual(f.requests.map((entry) => entry.path).sort(), ['launcher/linux-x64/1.3.1/files/locales/en-US.pak', 'launcher/linux-x64/1.3.1/files/resources/app.asar']);
  assert.equal(stage, path.join(f.installed, UPDATE_DIRECTORY, 'stage-1.3.1'));
  assert.equal(await readFile(path.join(stage, 'ffmpeg.dll'), 'utf8'), 'runtime dll, identical in every build');
  assert.match((await readFile(path.join(stage, 'resources', 'app.asar'))).toString(), /1\.3\.1/);
  assert.deepEqual(await readFile(path.join(f.installed, 'resources', 'app.asar')), before);
  // Preparing again resumes from the verified stage without downloading anything.
  f.requests.length = 0;
  await prepareLauncherUpdate({ launcherDir: f.installed, channel });
  assert.equal(f.requests.length, 0);
});

test('a corrupt, truncated or unreachable download fails staging and leaves the launcher folder unchanged', async (t) => {
  let mode = 'corrupt';
  const output = () => f.output;
  const f = await fixture(t, { route: (relative, response) => {
    if (!relative.endsWith('/app.asar')) return false;
    if (mode === 'corrupt') {
      const bytes = readFileSync(path.join(output(), relative));
      bytes[bytes.length - 1] ^= 1;
      response.writeHead(200, { 'Content-Length': bytes.length });
      response.end(bytes);
      return true;
    }
    if (mode === 'truncated') { response.writeHead(200, { 'Content-Length': 100000 }); response.write('short', () => response.socket.destroy()); return true; }
    response.writeHead(503); response.end(); return true;
  } });
  await f.publish('1.3.1');
  const snapshot = async () => Object.fromEntries(await Promise.all(['ffmpeg.dll', EXE, 'resources/app.asar'].map(async (name) => [name, (await readFile(path.join(f.installed, name))).toString('base64')])));
  const before = await snapshot();
  const channel = await loadLauncherChannel(f.url, { accessKey: KEY });
  const options = { launcherDir: f.installed, channel, retryDelayMs: 1 };
  await assert.rejects(prepareLauncherUpdate(options), /failed size\/SHA-256 verification/);
  mode = 'truncated';
  await assert.rejects(prepareLauncherUpdate(options), /terminated|early|socket/i);
  mode = 'unavailable';
  await assert.rejects(prepareLauncherUpdate(options), /HTTP 503/);
  assert.deepEqual(await snapshot(), before);
  // A launcher folder that cannot be written is detected before anything is downloaded.
  await assert.rejects(prepareLauncherUpdate({ launcherDir: path.join(f.root, 'missing'), channel }), /not writable/);
});

test('the helper swaps in the staged build after the old launcher exits, keeps a rollback copy and starts the new build', async (t) => {
  const f = await fixture(t);
  await f.publish('1.3.1', { extra: { 'locales/en-US.pak': 'new locale' } });
  const oldAsar = await readFile(path.join(f.installed, 'resources', 'app.asar'));
  const channel = await loadLauncherChannel(f.url, { accessKey: KEY });
  const { stage, changed } = await prepareLauncherUpdate({ launcherDir: f.installed, channel });
  const old = oldLauncher();
  const logFile = path.join(f.root, 'launcher.log');
  await startLauncherSwap({ launcherDir: f.installed, stage, channel, changed, currentVersion: '1.3.0', pid: old.pid, relaunchArgs: ['--feed-url=x'], logFile, runtime: process.execPath, healthTimeoutMs: 10_000 });
  // Nothing changes while the old launcher is still running.
  assert.deepEqual(await readFile(path.join(f.installed, 'resources', 'app.asar')), oldAsar);
  await until(async () => (await readFile(logFile, 'utf8').catch(() => '')).includes('started; the previous files stay'));
  assert.deepEqual(await runs(f.installed), ['--feed-url=x --self-updated=1.3.1']);
  assert.match((await readFile(path.join(f.installed, 'resources', 'app.asar'))).toString(), /1\.3\.1/);
  assert.equal(await readFile(path.join(f.installed, 'locales', 'en-US.pak'), 'utf8'), 'new locale');
  const rollback = path.join(f.installed, UPDATE_DIRECTORY, 'rollback');
  assert.deepEqual(await readFile(path.join(rollback, 'resources', 'app.asar')), oldAsar);
  assert.equal(JSON.parse(await readFile(path.join(rollback, 'rollback.json'), 'utf8')).state, 'swapped');
  // The next start clears the finished stage but keeps the rollback copy.
  assert.deepEqual(await cleanupLauncherUpdates(f.installed, '1.3.1'), []);
  assert.deepEqual((await readdir(path.join(f.installed, UPDATE_DIRECTORY))).sort(), ['rollback']);
});

test('a new build that exits before its first window is rolled back and the old launcher restarts', async (t) => {
  const f = await fixture(t);
  await f.publish('1.3.1', { asarExtra: { 'src/broken.txt': 'CRASH' } });
  const snapshot = async () => (await readFile(path.join(f.installed, 'resources', 'app.asar'))).toString('base64');
  const before = await snapshot();
  const channel = await loadLauncherChannel(f.url, { accessKey: KEY });
  const { stage, changed } = await prepareLauncherUpdate({ launcherDir: f.installed, channel });
  const logFile = path.join(f.root, 'launcher.log');
  await startLauncherSwap({ launcherDir: f.installed, stage, channel, changed, currentVersion: '1.3.0', pid: oldLauncher().pid, logFile, runtime: process.execPath, healthTimeoutMs: 10_000 });
  await until(async () => (await runs(f.installed)).length === 2);
  assert.deepEqual(await runs(f.installed), ['--self-updated=1.3.1', '--self-update-failed=1.3.1']);
  assert.equal(await snapshot(), before);
  assert.match(await readFile(logFile, 'utf8'), /exited before its first window; restoring 1\.3\.0/);
});

test('a failure in the middle of the swap restores every replaced file', async (t) => {
  const f = await fixture(t);
  await f.publish('1.3.1', { extra: { 'locales/en-US.pak': 'new locale' } });
  const before = await readFile(path.join(f.installed, 'resources', 'app.asar'));
  const channel = await loadLauncherChannel(f.url, { accessKey: KEY });
  const { stage, changed } = await prepareLauncherUpdate({ launcherDir: f.installed, channel });
  // The second staged file vanishes after the first has been swapped in.
  const ordered = ['resources/app.asar', 'locales/en-US.pak'];
  await rm(path.join(stage, 'locales', 'en-US.pak'));
  assert.deepEqual(changed.sort(), [...ordered].sort());
  const logFile = path.join(f.root, 'launcher.log');
  await startLauncherSwap({ launcherDir: f.installed, stage, channel, changed: ordered, currentVersion: '1.3.0', pid: oldLauncher().pid, logFile, runtime: process.execPath });
  await until(async () => (await runs(f.installed)).length === 1);
  assert.deepEqual(await runs(f.installed), ['--self-update-failed=1.3.1']);
  assert.deepEqual(await readFile(path.join(f.installed, 'resources', 'app.asar')), before);
  await assert.rejects(stat(path.join(f.installed, 'locales', 'en-US.pak')));
  assert.match(await readFile(logFile, 'utf8'), /Swap failed .*restoring 1\.3\.0/);
});

test('if the helper cannot start, the caller is told and keeps running; the old launcher must exit before any swap', async (t) => {
  const f = await fixture(t);
  await f.publish('1.3.1');
  const channel = await loadLauncherChannel(f.url, { accessKey: KEY });
  const { stage, changed } = await prepareLauncherUpdate({ launcherDir: f.installed, channel });
  await assert.rejects(startLauncherSwap({ launcherDir: f.installed, stage, channel, changed, currentVersion: '1.3.0', runtime: path.join(f.root, 'no-such-runtime') }), /update helper/);
  await assert.rejects(startLauncherSwap({ launcherDir: f.installed, stage, channel, changed, currentVersion: '1.3.0', runtime: '/bin/false', startTimeoutMs: 2_000 }), /did not start/);
  // A launcher that never exits: the helper gives up and changes nothing.
  const before = await readFile(path.join(f.installed, 'resources', 'app.asar'));
  const logFile = path.join(f.root, 'launcher.log');
  await startLauncherSwap({ launcherDir: f.installed, stage, channel, changed, currentVersion: '1.3.0', pid: process.pid, logFile, runtime: process.execPath, exitTimeoutMs: 500 });
  await until(async () => (await readFile(logFile, 'utf8').catch(() => '')).includes('nothing was changed'));
  assert.deepEqual(await readFile(path.join(f.installed, 'resources', 'app.asar')), before);
  assert.deepEqual(await runs(f.installed), []);
});

test('cleanup keeps a newer partial stage to resume and reports an interrupted swap', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'slumsms-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const updates = path.join(root, UPDATE_DIRECTORY);
  for (const name of ['stage-1.2.9', 'stage-1.3.0', 'stage-1.4.0', 'stage-junk', 'rollback']) await mkdir(path.join(updates, name), { recursive: true });
  await writeFile(path.join(updates, 'swap-job.json'), '{}');
  await writeFile(path.join(updates, 'rollback', 'rollback.json'), JSON.stringify({ state: 'swapping', fromVersion: '1.2.9', toVersion: '1.3.0' }));
  const notes = await cleanupLauncherUpdates(root, '1.3.0');
  assert.deepEqual((await readdir(updates)).sort(), ['rollback', 'stage-1.4.0']);
  assert.match(notes[0], /interrupted/);
  assert.deepEqual(await cleanupLauncherUpdates(path.join(root, 'nothing-here'), '1.3.0'), []);
});
